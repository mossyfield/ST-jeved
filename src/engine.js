import { interceptGeneration, maybeReroll } from './engine/decide.js';
import { cancelWork, liveTarget, measure, saver } from './engine/measure.js';
import { forgetSession, invalidateMeasured, isActive, notify, setError, setPaused as writePaused } from './engine/status.js';

const RELOAD_EVENTS = ['MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'MORE_MESSAGES_LOADED'];

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
        task.then(() => maybeReroll(target)).catch(error => {
            setError(error);
            notify();
        });
    } catch (error) {
        setError(error);
        notify();
    }
}

export function setPaused(paused) {
    writePaused(paused);
    if (paused) {
        cancelWork();
        notify();
    }
}

export function onChatChanged() {
    cancelWork();
    invalidateMeasured();
    forgetSession();
    notify();
}

export { evaluationContext, interceptGeneration, rerollOutcome } from './engine/decide.js';
export {
    cancelRescan, clearChatScores, isRescanning, nextReplyGroups, planMeasurement, plannedCalls,
    targetAt, testConnection, testSensor,
} from './engine/measure.js';
export { rescan } from './engine/rescan.js';
export { scriptParser } from './engine/scripts.js';
export {
    JEVED_UPDATED, chatPreset, describeError, forceRule, forcedRule, historyStamp, invalidateMeasured,
    isActive, isMeasuring, isPaused, lastDecision, lastError, lastErrorKind, measureBlockReason,
    measuredCount, sessionCost, sessionTokens, setErrorText, status,
} from './engine/status.js';
