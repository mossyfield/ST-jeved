import { errorKind } from '../classifier.js';
import { getSettings, schemaProblem } from '../settings.js';
import { getScores, narratorIndices } from '../store.js';

export const JEVED_UPDATED = 'jeved_updated';

const PAUSE_KEY = 'jeved_muted';
const PRESET_KEY = 'jeved_preset';

export const SCRIPT_ERROR = 'script';
export const SWIPE_ERROR = 'swipe';
export const SWIPE_BUSY_ERROR = 'swipeBusy';

const ERROR_TEXT = {
    key: { text: 'Key rejected', next: 'Paste a new key and press Test.' },
    credit: { text: 'No credit', next: 'Add credit to your OpenRouter account.' },
    timeout: { text: 'Timed out', next: 'Jeved measures again on the next reply.' },
    config: { text: 'Not set up', next: 'Check the endpoint and the key.' },
    [SCRIPT_ERROR]: { text: 'Script failed', next: 'Open the rule and fix its script.' },
    [SWIPE_ERROR]: { text: 'Reroll failed', next: 'Turn swipes on in SillyTavern.' },
    [SWIPE_BUSY_ERROR]: { text: 'Reroll timed out', next: 'SillyTavern stayed busy, so Jeved did not reroll the reply.' },
    other: { text: 'Call failed', next: 'Jeved measures again on the next reply.' },
};

const state = {
    lastError: '',
    lastErrorKind: '',
    lastDecision: null,
    sessionCost: 0,
    forcedRule: '',
    rerolling: false,
    measuring: 0,
};

export function notify(detail) {
    SillyTavern.getContext().eventSource.emit(JEVED_UPDATED, detail);
}

export function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}

export function setError(error) {
    state.lastError = describeError(error);
    state.lastErrorKind = errorKind(error);
}

export function setErrorText(message, kind) {
    state.lastError = message;
    state.lastErrorKind = kind;
}

export function clearError() {
    state.lastError = '';
    state.lastErrorKind = '';
}

export const lastError = () => state.lastError;
export const lastErrorKind = () => state.lastErrorKind;
export const lastDecision = () => (state.lastDecision ? structuredClone(state.lastDecision) : null);
export const sessionCost = () => state.sessionCost;
export const forcedRule = () => state.forcedRule;
export const isRerolling = () => state.rerolling;
export const isMeasuring = () => state.measuring > 0;

export function setMeasuring(count) {
    state.measuring = Number(count) || 0;
}

export function addCost(amount) {
    state.sessionCost += Number(amount) || 0;
}

export function forceRule(id) {
    state.forcedRule = String(id ?? '');
}

export function takeForcedRule() {
    const id = state.forcedRule;
    state.forcedRule = '';
    return id;
}

export function setRerolling(busy) {
    state.rerolling = !!busy;
}

export function setLastDecision(decision) {
    state.lastDecision = decision;
}

export function forgetSession() {
    clearError();
    state.forcedRule = '';
    state.lastDecision = null;
    state.rerolling = false;
}

export function isPaused() {
    return !!SillyTavern.getContext().chatMetadata?.[PAUSE_KEY];
}

export function setPaused(paused) {
    const context = SillyTavern.getContext();
    context.chatMetadata[PAUSE_KEY] = !!paused;
    context.saveMetadataDebounced();
    notify();
}

export function chatPreset() {
    return SillyTavern.getContext().chatMetadata?.[PRESET_KEY] ?? '';
}

export function markPreset() {
    const context = SillyTavern.getContext();
    const name = getSettings().activePreset;
    if (context.chatMetadata && context.chatMetadata[PRESET_KEY] !== name) {
        context.chatMetadata[PRESET_KEY] = name;
        context.saveMetadataDebounced();
    }
}

export function measureBlockReason() {
    const problem = schemaProblem();
    if (problem) {
        return problem;
    }
    const settings = getSettings();
    if (isPaused()) {
        return 'This chat is paused, so nothing here is measured.';
    }
    if (!settings.endpoint) {
        return 'No endpoint is set.';
    }
    if (!settings.apiKey) {
        return 'No API key is set.';
    }
    return '';
}

export function isActive() {
    return !!getSettings().enabled && !measureBlockReason();
}

let countCache = { chatId: null, stamp: -1, value: 0 };
let countStamp = 0;

export function invalidateMeasured() {
    countStamp++;
}

export function historyStamp() {
    const context = SillyTavern.getContext();
    return `${countStamp}:${context.getCurrentChatId()}:${context.chat.length}`;
}

export function measuredStamp() {
    return countStamp;
}

export function measuredCount() {
    const context = SillyTavern.getContext();
    const chatId = context.getCurrentChatId();
    if (countCache.chatId === chatId && countCache.stamp === countStamp) {
        return countCache.value;
    }
    const chat = context.chat;
    const value = narratorIndices(chat).filter(index => getScores(chat[index])).length;
    countCache = { chatId, stamp: countStamp, value };
    return value;
}

export function status() {
    const problem = schemaProblem();
    if (problem) {
        return { kind: 'config', text: 'Newer settings', next: problem };
    }
    const settings = getSettings();
    if (!settings.enabled) {
        return { kind: 'off', text: 'Off', next: 'Tick Enabled to start.' };
    }
    if (isPaused()) {
        return { kind: 'paused', text: 'Paused', next: 'Untick Pause for this chat.' };
    }
    if (!settings.endpoint) {
        return { kind: 'config', text: 'No endpoint', next: 'Set an endpoint in Settings.' };
    }
    if (!settings.apiKey) {
        return { kind: 'nokey', text: 'No API key', next: 'Paste an OpenRouter key and press Test.' };
    }
    if (state.lastError) {
        const detail = ERROR_TEXT[state.lastErrorKind] ?? ERROR_TEXT.other;
        return { kind: 'error', text: detail.text, next: `${detail.next} Your chat isn't affected.` };
    }
    if (state.rerolling) {
        return { kind: 'working', text: 'Rerolling', next: '' };
    }
    if (isMeasuring()) {
        return { kind: 'working', text: 'Measuring', next: '' };
    }
    const measured = measuredCount();
    if (!measured) {
        return { kind: 'waiting', text: 'Waiting', next: '' };
    }
    return { kind: 'measured', text: `Measured ${measured} ${measured === 1 ? 'reply' : 'replies'}`, next: '' };
}
