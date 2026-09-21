import { afterReply, interceptGeneration, waitsForScripts } from './engine/decide.js';
import { cancelWork, liveTarget, measure, measureMessage, saver } from './engine/measure.js';
import { forgetSession, invalidateMeasured, isActive, isRerolling, notify, setError, setPaused as writePaused } from './engine/status.js';
import { forgetWorldInfo, holdWorldInfo } from './instructions.js';
import { EDIT_DELAY_MS } from './limits.js';
import { getRecord, isNarrator } from './store.js';
import { hashText } from './util.js';

const RELOAD_EVENTS = ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED'];

const EDIT_RETRIES = 5;

const editTimers = new Map();

export function cancelEditTimers() {
    for (const timer of editTimers.values()) {
        clearTimeout(timer);
    }
    editTimers.clear();
}

function startEditTimer(message, chatId, tries = 0) {
    const running = editTimers.get(message);
    if (running) {
        clearTimeout(running);
    }
    editTimers.set(message, setTimeout(() => remeasureEdited(message, chatId, tries), EDIT_DELAY_MS));
}

function remeasureEdited(message, chatId, tries = 0) {
    try {
        editTimers.delete(message);
        const context = SillyTavern.getContext();
        if (!isActive() || context.getCurrentChatId() !== chatId) {
            return;
        }
        if (isRerolling()) {
            if (tries < EDIT_RETRIES) {
                startEditTimer(message, chatId, tries + 1);
            }
            return;
        }
        const index = context.chat.indexOf(message);
        if (index < 0) {
            return;
        }
        if (isNarrator(message)) {
            measure(liveTarget(index));
        } else {
            measureMessage(index);
        }
    } catch (error) {
        setError(error);
        notify();
    }
}

export function onMessageEdited(messageId) {
    try {
        const context = SillyTavern.getContext();
        const message = context.chat[Number(messageId)];
        const record = getRecord(message);
        if (!record?.scores || record.hash === hashText(message.mes)) {
            return;
        }
        startEditTimer(message, context.getCurrentChatId());
    } catch (error) {
        setError(error);
        notify();
    }
}

export function initEngine() {
    const context = SillyTavern.getContext();
    saver();
    globalThis.jeved_interceptGeneration = interceptGeneration;
    for (const name of RELOAD_EVENTS) {
        const event = context.eventTypes?.[name];
        if (event) {
            context.eventSource.on(event, () => {
                invalidateMeasured();
                notify();
            });
        }
    }
    if (context.eventTypes?.MESSAGE_EDITED) {
        context.eventSource.on(context.eventTypes.MESSAGE_EDITED, onMessageEdited);
    }
    if (context.eventTypes?.MESSAGE_DELETED) {
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, cancelEditTimers);
    }
    if (context.eventTypes?.WORLD_INFO_ACTIVATED) {
        context.eventSource.on(context.eventTypes.WORLD_INFO_ACTIVATED, holdWorldInfo);
    }
}

export function onCharacterMessage(messageId, type) {
    try {
        if (!isActive() || type === 'first_message') {
            return;
        }
        const target = liveTarget(Number(messageId), type);
        const task = measure(target);
        if (!task) {
            return;
        }
        const chain = task.then(() => afterReply(target)).catch(error => {
            setError(error);
            notify();
        });
        if (waitsForScripts()) {
            return chain;
        }
    } catch (error) {
        setError(error);
        notify();
    }
    return undefined;
}

export function setPaused(paused) {
    writePaused(paused);
    if (paused) {
        cancelWork();
        cancelEditTimers();
        notify();
    }
}

export function onChatChanged() {
    cancelWork();
    cancelEditTimers();
    invalidateMeasured();
    forgetSession();
    forgetWorldInfo();
    notify();
}

export { evaluationContext, historiesFor, interceptGeneration, rerollOutcome } from './engine/decide.js';
export {
    askOnce, cancelRescan, clearChatScores, isRescanning, nextMessageGroups, nextReplyGroups, planMeasurement,
    plannedCalls, saveChatSoon, settleContextPrompts, targetAt, testConnection, testEntries, testIndices, testSensor,
} from './engine/measure.js';
export { rescan } from './engine/rescan.js';
export { runTarget, scriptParser, scriptRun } from './engine/scripts.js';
export {
    JEVED_UPDATED, chatPreset, describeError, forceRule, forcedRule, historyStamp, invalidateMeasured,
    isActive, isMeasuring, isPaused, lastDecision, lastError, lastErrorKind, measureBlockReason,
    measuredCount, sessionCost, sessionTokens, setErrorText, status,
} from './engine/status.js';
