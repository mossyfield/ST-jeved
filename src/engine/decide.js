import {
    AFTER_REPLY, BEFORE_GENERATION, LIST_ADD, LIST_REMOVE, NUDGE, REROLL, RUN_SCRIPT, actionOf, actionsInPhase,
    replacesReply, ruleAction,
} from '../actions.js';
import { MAX_PENDING_WAIT, PREPASS_TIMEOUT_MS } from '../limits.js';
import { ADD, REMOVE, fillEntries, listResolver, ruleChange } from '../lists.js';
import { fillMacros } from '../macros.js';
import { rerollStarted, runReroll } from '../reroll.js';
import { evaluate } from '../rules.js';
import { firesInPhase, momentOfRule, phaseOfRule } from '../sensors.js';
import { getPreset } from '../settings.js';
import {
    addFired, fired, firedFor, getHistory, getRecord, getScores, isNarrator, lastUserIndex, makeReceipt,
    setFiredValue, sinceRuleIn, stripFiredText, writeDecision,
} from '../store.js';
import { toast } from '../toast.js';
import { hashText, raceTimeout } from '../util.js';
import {
    FAILED, MEASURED, PARTIAL, locate, measure, messageTarget, missingMessageIds, pendingMeasurement, saveChatSoon,
    waitForPending,
} from './measure.js';
import { runScript } from './scripts.js';
import {
    SWIPE_BUSY_ERROR, SWIPE_ERROR, isActive, isRerolling, lastDecision, notify, setError, setErrorText,
    setLastDecision, setRerolling, takeForcedRule,
} from './status.js';

const SKIPPED_TYPES = new Set(['quiet', 'impersonate', 'continue']);
const TIMED_OUT = 'prepass-timeout';

const LATE_TEXT = 'Jev did not answer before the reply, so your message was not measured.';
const SHORT_TEXT = 'Your message was not fully measured before the reply.';

export function historiesFor(chat, count, sensors) {
    const histories = {};
    return rule => {
        const moment = momentOfRule(rule, sensors);
        histories[moment] ??= getHistory(chat, count, moment, sensors);
        return histories[moment];
    };
}

export function evaluationContext(chat, preset) {
    const lookback = Math.max(1, ...preset.rules.filter(rule => rule.enabled).map(rule => rule.window));
    return {
        historyOf: historiesFor(chat, lookback, preset.sensors),
        sensors: preset.sensors,
        sensorIds: preset.sensors.map(sensor => sensor.id),
        sinceRule: sinceRuleIn(chat),
        listEntries: listResolver(preset),
    };
}

function hitsFor(chat, preset, action) {
    return evaluate({ ...evaluationContext(chat, preset), rules: preset.rules, action });
}

function beforeGeneration(chat, preset) {
    return actionsInPhase(BEFORE_GENERATION)
        .flatMap(action => hitsFor(chat, preset, action.id)
            .filter(hit => phaseOfRule(hit.rule, preset.sensors) === BEFORE_GENERATION)
            .map(hit => ({ ...hit, action: action.id })));
}

export function applyListAction(hit, message) {
    const rule = hit.rule;
    const list = String(rule.list ?? '').trim();
    const op = hit.action === LIST_ADD ? ADD : REMOVE;
    const context = SillyTavern.getContext();
    const matched = hit.entries ?? [];
    const wanted = matched.length ? matched : [''];
    for (const one of wanted) {
        const value = context.substituteParams(fillMacros(fillEntries(rule.value, matched, one)));
        ruleChange(message, list, op, value);
    }
}

function decide(context, preset, index, hash) {
    const forcedId = takeForcedRule();
    const forced = forcedId ? preset.rules.find(rule => rule.id === forcedId) : null;
    const hits = forced
        ? [{ rule: forced, action: NUDGE, reason: 'Forced with /jeved-nudge.', entries: [] }]
        : beforeGeneration(context.chat, preset);

    for (const hit of hits) {
        if (actionOf(hit.action)?.usesList) {
            applyListAction(hit, context.chat[index]);
        }
    }
    const entries = hits.map(hit => makeReceipt(hit, hit.action));
    writeDecision(context.chat[index], entries, hash);
    setLastDecision({ index, fired: entries });
    notify({ index });
    return hits;
}

async function prePass(index) {
    const target = messageTarget(index, { missingOnly: true });
    if (!target?.groups.length) {
        return;
    }
    const joined = pendingMeasurement(target);
    const controller = joined ? null : new AbortController();
    const outcome = await raceTimeout(joined ?? measure(target, controller.signal), PREPASS_TIMEOUT_MS, TIMED_OUT);
    if (outcome === TIMED_OUT) {
        controller?.abort();
        setErrorText(LATE_TEXT, 'timeout');
        return;
    }
    if (outcome === FAILED) {
        return;
    }
    const short = outcome === PARTIAL || (locate(target) >= 0
        && (outcome !== MEASURED || missingMessageIds(getPreset(), target.message).length > 0));
    if (short) {
        setErrorText(SHORT_TEXT, 'other');
    }
}

function needsDecision(record, message, chat, index) {
    if (record?.decided) {
        return record.decidedHash !== hashText(message.mes);
    }
    return !chat.slice(index + 1).some(isNarrator);
}

export async function interceptGeneration(chat, _contextSize, _abort, type) {
    try {
        if (!isActive() || SKIPPED_TYPES.has(type)) {
            return;
        }
        const context = SillyTavern.getContext();
        const index = lastUserIndex(context.chat);
        if (index < 0) {
            return;
        }
        const message = context.chat[index];
        if (!String(message.mes ?? '').trim()) {
            return;
        }
        if (needsDecision(getRecord(message), message, context.chat, index)) {
            await Promise.all([waitForPending(MAX_PENDING_WAIT), prePass(index)]);
            if (!isActive() || SillyTavern.getContext().chat[index] !== message) {
                return;
            }
            const hits = decide(SillyTavern.getContext(), getPreset(), index, hashText(message.mes));
            saveChatSoon();
            for (const hit of hits) {
                if (!isActive() || SillyTavern.getContext().chat[index] !== message) {
                    break;
                }
                await runScript(hit, message);
            }
        }
        const texts = firedFor(message)
            .filter(entry => entry?.text)
            .map(entry => fillEntries(entry.text, entry.entries ?? []));
        if (!texts.length || !isActive()) {
            return;
        }
        const copy = lastUserIndex(chat);
        if (copy < 0) {
            return;
        }
        chat[copy].mes = [chat[copy].mes, ...texts.map(text => context.substituteParams(fillMacros(text)))].join('\n\n');
    } catch (error) {
        setError(error);
        notify();
    }
}

export function rerollOutcome(result) {
    const label = result.rule?.label || result.rule?.id || '';
    if (result.status === 'started') {
        return { toast: ['info', `Rerolling (${label})`] };
    }
    if (result.status === 'cancelled') {
        return { toast: ['info', `The reroll in ${label} stopped because ${result.detail}.`] };
    }
    if (result.status === 'done') {
        return {};
    }
    return {
        error: [
            `Reroll failed in ${label}: ${result.detail}.`,
            result.status === 'timeout' ? SWIPE_BUSY_ERROR : SWIPE_ERROR,
        ],
    };
}

function reportReroll(result, index) {
    const outcome = rerollOutcome(result);
    if (outcome.toast) {
        toast(...outcome.toast);
    }
    if (outcome.error) {
        setErrorText(...outcome.error);
    }
    notify({ index });
}

function rerollHost({ preset, message, userMessage, chatId, index, scores }) {
    return {
        isActive,
        getChatId: () => SillyTavern.getContext().getCurrentChatId(),
        isLast: () => SillyTavern.getContext().chat.at(-1) === message,
        onLastSwipe: () => !Array.isArray(message.swipes) || message.swipe_id === message.swipes.length - 1,
        hasSwipeEntry: () => fired(userMessage).some(entry => replacesReply(entry)),
        hash: () => hashText(message.mes),
        swipeId: () => message.swipe_id,
        swipeCount: () => (Array.isArray(message.swipes) ? message.swipes.length : 1),
        evaluate: () => hitsFor(SillyTavern.getContext().chat, preset, REROLL),
        scores: () => scores,
        addFired: entry => addFired(userMessage, entry),
        markSwipe: (ruleId, swipe) => setFiredValue(userMessage, ruleId, 'swipe', swipe),
        stripText: ruleId => stripFiredText(userMessage, ruleId),
        save: () => {
            if (SillyTavern.getContext().getCurrentChatId() === chatId) {
                saveChatSoon();
            }
        },
        runScript: hit => runScript(hit, message),
        isAllowed: () => !!SillyTavern.getContext().swipe?.isAllowed(),
        swipeRight: () => SillyTavern.getContext().swipe.right(),
        inputHasText: () => !!document.getElementById('send_textarea')?.value.trim(),
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        report: result => reportReroll(result, index),
    };
}

function canReroll(rule) {
    const action = ruleAction(rule);
    return !!rule.enabled && !!action?.replacesReply && (action.runsInGroup || !SillyTavern.getContext().groupId);
}

async function tryReroll(parts) {
    if (!parts.preset.rules.some(canReroll)) {
        return false;
    }
    setRerolling(true);
    notify({ index: parts.index });
    try {
        return rerollStarted((await runReroll(rerollHost(parts)))?.status);
    } catch (error) {
        setError(error);
        return true;
    } finally {
        setRerolling(false);
        notify({ index: parts.index });
    }
}

function alreadyRan(userMessage, ruleId, action, replyHash) {
    return fired(userMessage)
        .some(entry => entry?.rule === ruleId && entry?.action === action && entry?.reply === replyHash);
}

function recordFired(entry, userMessage, index) {
    addFired(userMessage, entry);
    const last = lastDecision();
    setLastDecision({
        index: last?.index ?? SillyTavern.getContext().chat.indexOf(userMessage),
        fired: [...(last?.fired ?? []).filter(item => item.rule !== entry.rule), entry],
    });
    saveChatSoon();
    notify({ index });
}

function lateHits({ preset, message, userMessage }, action) {
    const replyHash = hashText(message.mes);
    return hitsFor(SillyTavern.getContext().chat, preset, action)
        .filter(hit => firesInPhase(hit.rule, AFTER_REPLY, preset.sensors))
        .filter(hit => !alreadyRan(userMessage, hit.rule.id, action, replyHash));
}

function stillHere({ chatId, index, message }) {
    const current = SillyTavern.getContext();
    return isActive() && current.getCurrentChatId() === chatId && current.chat[index] === message;
}

async function runScriptRules(parts) {
    const replyHash = hashText(parts.message.mes);
    for (const hit of lateHits(parts, RUN_SCRIPT)) {
        if (!stillHere(parts)) {
            break;
        }
        recordFired(makeReceipt(hit, RUN_SCRIPT, { reply: replyHash, scores: parts.scores }), parts.userMessage, parts.index);
        await runScript(hit, parts.message);
    }
    return false;
}

function listRunner(action) {
    return async parts => {
        const replyHash = hashText(parts.message.mes);
        for (const hit of lateHits(parts, action)) {
            if (!stillHere(parts)) {
                break;
            }
            applyListAction({ ...hit, action }, parts.message);
            recordFired(makeReceipt(hit, action, { reply: replyHash, scores: parts.scores }), parts.userMessage, parts.index);
            await runScript(hit, parts.message);
        }
        return false;
    };
}

function partsOf(preset, chatId, index, message, userMessage) {
    return { preset, message, userMessage, chatId, index, scores: { ...(getScores(message)?.scores ?? {}) } };
}

function scriptParts(preset, chatId, index) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    if (context.getCurrentChatId() !== chatId || !isNarrator(message) || !getScores(message)) {
        return null;
    }
    const userIndex = lastUserIndex(context.chat, index);
    if (userIndex < 0) {
        return null;
    }
    return partsOf(preset, chatId, index, message, context.chat[userIndex]);
}

export function waitsForScripts() {
    if (!isActive() || !SillyTavern.getContext().groupId) {
        return false;
    }
    const preset = getPreset();
    return preset.rules.some(rule => rule.enabled
        && firesInPhase(rule, AFTER_REPLY, preset.sensors)
        && ruleAction(rule)?.runsInGroup);
}

const AFTER_REPLY_RUNNERS = new Map([
    [REROLL, tryReroll],
    [LIST_ADD, listRunner(LIST_ADD)],
    [LIST_REMOVE, listRunner(LIST_REMOVE)],
    [RUN_SCRIPT, runScriptRules],
]);

export async function afterReply(target) {
    const context = SillyTavern.getContext();
    const preset = getPreset();
    const message = target.message;
    if (!isActive() || isRerolling()) {
        return;
    }
    if (!preset.rules.some(rule => rule.enabled && firesInPhase(rule, AFTER_REPLY, preset.sensors))) {
        return;
    }
    const index = locate(target);
    if (index < 0 || context.chat.at(-1) !== message) {
        return;
    }
    const userIndex = lastUserIndex(context.chat, index);
    const userMessage = userIndex < 0 ? null : context.chat[userIndex];
    if (!userMessage) {
        return;
    }

    let parts = partsOf(preset, target.chatId, index, message, userMessage);
    try {
        for (const action of actionsInPhase(AFTER_REPLY)) {
            const run = AFTER_REPLY_RUNNERS.get(action.id);
            if (!run || !await run(parts)) {
                continue;
            }
            parts = scriptParts(preset, target.chatId, SillyTavern.getContext().chat.length - 1);
            if (!parts) {
                return;
            }
        }
    } catch (error) {
        setError(error);
        notify({ index });
    }
}
