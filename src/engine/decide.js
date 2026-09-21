import {
    AFTER_REPLY, BEFORE_GENERATION, NUDGE, REROLL, RUN_SCRIPT, actionsInPhase, firesInPhase, replacesReply, ruleAction,
} from '../actions.js';
import { MAX_PENDING_WAIT, PREPASS_TIMEOUT_MS } from '../limits.js';
import { fillMacros } from '../macros.js';
import { rerollStarted, runReroll } from '../reroll.js';
import { evaluate } from '../rules.js';
import { momentOfRule } from '../sensors.js';
import { getPreset } from '../settings.js';
import {
    addFired, fired, firedFor, firedRule, getHistory, getRecord, getScores, isNarrator, isUser, lastUserIndex,
    narratorIndices, repliesSince, replyPosition, setFiredValue, stripFiredText, writeDecision,
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

function sinceRuleIn(chat, preset) {
    const replies = narratorIndices(chat).length;
    const positions = new Map();
    const legacy = new Set();
    for (const message of chat) {
        if (!isUser(message)) {
            continue;
        }
        for (const entry of fired(message)) {
            if (typeof entry?.at === 'number') {
                positions.set(entry.rule, entry.at);
            } else if (entry?.rule !== undefined) {
                legacy.add(entry.rule);
            }
        }
    }
    return id => {
        if (positions.has(id)) {
            return replies - positions.get(id);
        }
        if (!legacy.has(id)) {
            return Infinity;
        }
        return repliesSince(chat, firedRule(id), preset.rules.find(rule => rule.id === id)?.cooldown ?? Infinity);
    };
}

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
        sinceRule: sinceRuleIn(chat, preset),
    };
}

function hitsFor(chat, preset, action) {
    return evaluate({ ...evaluationContext(chat, preset), rules: preset.rules, action });
}

function beforeGeneration(chat, preset) {
    return actionsInPhase(BEFORE_GENERATION)
        .flatMap(action => hitsFor(chat, preset, action.id).map(hit => ({ ...hit, action: action.id })));
}

function decide(context, preset, index, hash) {
    const forcedId = takeForcedRule();
    const forced = forcedId ? preset.rules.find(rule => rule.id === forcedId) : null;
    const hits = forced
        ? [{ rule: forced, action: NUDGE, reason: 'Forced with /jeved-nudge.' }]
        : beforeGeneration(context.chat, preset);

    const entries = hits.map(hit => {
        const entry = { rule: hit.rule.id, action: hit.action, reason: hit.reason };
        if (String(hit.rule.directive ?? '').trim()) {
            entry.text = hit.rule.directive;
        }
        return entry;
    });
    const record = writeDecision(context.chat[index], entries, hash);
    setLastDecision({ index, fired: entries });
    notify({ index });
    return { record, rules: hits.map(hit => hit.rule) };
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
        let record = getRecord(message);
        if (!record?.decided || record.decidedHash !== hashText(message.mes)) {
            if (!record?.decided && context.chat.slice(index + 1).some(isNarrator)) {
                return;
            }
            await Promise.all([waitForPending(MAX_PENDING_WAIT), prePass(index)]);
            if (!isActive() || SillyTavern.getContext().chat[index] !== message) {
                return;
            }
            const made = decide(SillyTavern.getContext(), getPreset(), index, hashText(message.mes));
            record = made.record;
            saveChatSoon();
            for (const rule of made.rules) {
                if (!isActive() || SillyTavern.getContext().chat[index] !== message) {
                    break;
                }
                await runScript(rule);
            }
        }
        const texts = firedFor(message).map(entry => entry?.text).filter(text => text);
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
        runScript,
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

function alreadyRan(userMessage, ruleId, replyHash) {
    return fired(userMessage)
        .some(entry => entry?.rule === ruleId && entry?.action === RUN_SCRIPT && entry?.reply === replyHash);
}

async function runScriptRules({ preset, message, userMessage, chatId, index, scores }) {
    const replyHash = hashText(message.mes);
    const at = replyPosition(SillyTavern.getContext().chat, index);
    const hits = hitsFor(SillyTavern.getContext().chat, preset, RUN_SCRIPT)
        .filter(hit => !alreadyRan(userMessage, hit.rule.id, replyHash));

    for (const hit of hits) {
        const current = SillyTavern.getContext();
        if (!isActive() || current.getCurrentChatId() !== chatId || current.chat[index] !== message) {
            break;
        }
        const entry = { rule: hit.rule.id, action: RUN_SCRIPT, reason: hit.reason, reply: replyHash, at };
        if (Object.keys(scores).length) {
            entry.scores = scores;
        }
        addFired(userMessage, entry);
        const last = lastDecision();
        setLastDecision({
            index: last?.index ?? current.chat.indexOf(userMessage),
            fired: [...(last?.fired ?? []).filter(item => item.rule !== entry.rule), entry],
        });
        saveChatSoon();
        notify({ index });
        await runScript(hit.rule);
    }
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
    return getPreset().rules.some(rule => rule.enabled
        && firesInPhase(rule, AFTER_REPLY)
        && ruleAction(rule)?.runsInGroup);
}

export async function afterReply(target) {
    const context = SillyTavern.getContext();
    const preset = getPreset();
    const message = target.message;
    if (!isActive() || isRerolling()) {
        return;
    }
    if (!preset.rules.some(rule => rule.enabled && firesInPhase(rule, AFTER_REPLY))) {
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

    const parts = partsOf(preset, target.chatId, index, message, userMessage);
    try {
        if (!await tryReroll(parts)) {
            await runScriptRules(parts);
            return;
        }
        const newest = scriptParts(preset, target.chatId, SillyTavern.getContext().chat.length - 1);
        if (newest) {
            await runScriptRules(newest);
        }
    } catch (error) {
        setError(error);
        notify({ index });
    }
}
