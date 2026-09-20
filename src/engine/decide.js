import {
    AFTER_REPLY, BEFORE_GENERATION, NUDGE, REROLL, actionOf, actionsInPhase, firesInPhase, replacesReply,
} from '../actions.js';
import { runReroll } from '../reroll.js';
import { evaluate } from '../rules.js';
import { carryForwardIds } from '../sensors.js';
import { getPreset } from '../settings.js';
import {
    addFired, fired, firedOf, firedRule, getHistory, getRecord, getScores, isNarrator,
    lastUserIndex, nudged, repliesSince, setFiredValue, stripFiredText, writeDecision,
} from '../store.js';
import { toast } from '../toast.js';
import { hashText } from '../util.js';
import { locate, saveChatSoon, waitForPending } from './measure.js';
import { runScript } from './scripts.js';
import {
    SWIPE_BUSY_ERROR, SWIPE_ERROR, isActive, isRerolling, notify, setError, setErrorText, setLastDecision,
    setRerolling, takeForcedRule,
} from './status.js';

const SKIPPED_TYPES = new Set(['quiet', 'impersonate', 'continue']);
const MAX_PENDING_WAIT = 2000;

function sinceRuleIn(chat, preset) {
    return id => repliesSince(chat, firedRule(id), preset.rules.find(rule => rule.id === id)?.cooldown ?? Infinity);
}

export function evaluationContext(chat, preset) {
    const lookback = Math.max(1, ...preset.rules.filter(rule => rule.enabled).map(rule => rule.window));
    const carried = getHistory(chat, lookback, carryForwardIds(preset));
    let plain = null;
    const historyFor = action => {
        if (actionOf(action)?.usesCarriedScores !== false) {
            return carried;
        }
        plain ??= getHistory(chat, lookback);
        return plain;
    };
    return {
        history: carried,
        historyFor,
        sensorIds: preset.sensors.map(sensor => sensor.id),
        gap: preset.gap,
        maxNudges: preset.maxNudges,
        sinceAnyNudge: repliesSince(chat, nudged, preset.gap),
        sinceRule: sinceRuleIn(chat, preset),
    };
}

function beforeGeneration(chat, preset) {
    const built = evaluationContext(chat, preset);
    return actionsInPhase(BEFORE_GENERATION).flatMap(action => evaluate({
        ...built,
        history: built.historyFor(action.id),
        rules: preset.rules,
        action: action.id,
    }).map(hit => ({ ...hit, action: action.id })));
}

function decide(context, preset, index) {
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
    const decision = writeDecision(context.chat[index], { fired: entries });
    setLastDecision({ index, fired: entries });
    notify({ index });
    return { decision, rules: hits.map(hit => hit.rule) };
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
        let decision = getRecord(message);
        if (!decision?.decided) {
            if (context.chat.slice(index + 1).some(isNarrator)) {
                return;
            }
            await waitForPending(MAX_PENDING_WAIT);
            const current = SillyTavern.getContext();
            if (!isActive() || current.chat[index] !== message) {
                return;
            }
            const made = decide(current, getPreset(), index);
            decision = made.decision;
            saveChatSoon();
            for (const rule of made.rules) {
                if (!isActive() || SillyTavern.getContext().chat[index] !== message) {
                    break;
                }
                await runScript(rule);
            }
        }
        const texts = firedOf(decision).map(entry => entry?.text).filter(text => text);
        if (!texts.length || !isActive()) {
            return;
        }
        const copy = lastUserIndex(chat);
        if (copy < 0) {
            return;
        }
        chat[copy].mes = [chat[copy].mes, ...texts.map(text => context.substituteParams(text))].join('\n\n');
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
        isGroup: !!SillyTavern.getContext().groupId,
        isActive,
        getChatId: () => SillyTavern.getContext().getCurrentChatId(),
        isLast: () => SillyTavern.getContext().chat.at(-1) === message,
        onLastSwipe: () => !Array.isArray(message.swipes) || message.swipe_id === message.swipes.length - 1,
        hasSwipeEntry: () => fired(userMessage).some(entry => replacesReply(entry)),
        hash: () => hashText(message.mes),
        swipeId: () => message.swipe_id,
        swipeCount: () => (Array.isArray(message.swipes) ? message.swipes.length : 1),
        evaluate: () => {
            const built = evaluationContext(SillyTavern.getContext().chat, preset);
            return evaluate({ ...built, history: built.historyFor(REROLL), rules: preset.rules, action: REROLL });
        },
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

export async function maybeReroll(target) {
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

    setRerolling(true);
    notify({ index });
    try {
        await runReroll(rerollHost({
            preset,
            message,
            userMessage,
            chatId: target.chatId,
            index,
            scores: { ...(getScores(message)?.scores ?? {}) },
        }));
    } catch (error) {
        setError(error);
    } finally {
        setRerolling(false);
        notify({ index });
    }
}
