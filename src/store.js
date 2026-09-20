import { actionOf } from './actions.js';
import { hasValue } from './sensor-types.js';
import { hashText, isRecord } from './util.js';

const KEY = 'jeved';

export function currentChat() {
    return SillyTavern.getContext().chat;
}

export function isNarrator(message) {
    return !!message && !message.is_user && !message.is_system;
}

function isUser(message) {
    return !!message && !!message.is_user && !message.is_system;
}

function ensureExtra(message) {
    if (typeof message.extra !== 'object' || message.extra === null) {
        message.extra = {};
    }
    return message.extra;
}

export function getRecord(message) {
    const record = message?.extra?.[KEY];
    return record && typeof record === 'object' ? record : null;
}

export function firedOf(record) {
    return Array.isArray(record?.fired) ? record.fired : [];
}

export function fired(message) {
    return firedOf(getRecord(message));
}

export function getScores(message) {
    const record = getRecord(message);
    if (!record || !record.scores || record.hash !== hashText(message?.mes)) {
        return null;
    }
    return record;
}

export function writeScores(message, scores, hash = hashText(message.mes), confidence = {}) {
    const extra = ensureExtra(message);
    const current = getRecord(message);
    const fresh = !!current && current.hash === hash;
    const kept = fresh && current.scores ? current.scores : {};
    const levels = fresh && isRecord(current.confidence) ? { ...current.confidence } : {};
    for (const id of Object.keys(scores)) {
        if (typeof confidence?.[id] === 'number' && Number.isFinite(confidence[id])) {
            levels[id] = confidence[id];
        } else {
            delete levels[id];
        }
    }
    extra[KEY] = { ...current, hash, scores: { ...kept, ...scores }, confidence: levels };
    return extra[KEY];
}

export function lastUserIndex(chat, from = chat.length) {
    for (let i = Math.min(from, chat.length) - 1; i >= 0; i--) {
        if (isUser(chat[i])) {
            return i;
        }
    }
    return -1;
}

export function narratorIndices(chat, { from = chat.length, limit = Infinity } = {}) {
    const found = [];
    for (let i = Math.min(from, chat.length) - 1; i >= 0 && found.length < limit; i--) {
        if (isNarrator(chat[i])) {
            found.push(i);
        }
    }
    return found;
}

function measuredPairs(message, sensors) {
    const record = getScores(message);
    if (!record || !isRecord(record.scores)) {
        return { values: null, confidence: {} };
    }
    const values = {};
    const confidence = {};
    for (const [id, value] of Object.entries(record.scores)) {
        if (!hasValue(sensors.find(sensor => sensor?.id === id) ?? null, value)) {
            continue;
        }
        values[id] = value;
        const level = record.confidence?.[id];
        if (typeof level === 'number' && Number.isFinite(level)) {
            confidence[id] = level;
        }
    }
    return { values, confidence };
}

function latestPairs(chat, ids, before, sensors) {
    const values = {};
    const confidence = {};
    for (const index of narratorIndices(chat, { from: before })) {
        const pairs = measuredPairs(chat[index], sensors);
        for (const id of ids) {
            if (values[id] === undefined && pairs.values?.[id] !== undefined) {
                values[id] = pairs.values[id];
                if (pairs.confidence[id] !== undefined) {
                    confidence[id] = pairs.confidence[id];
                }
            }
        }
        if (ids.every(id => values[id] !== undefined)) {
            break;
        }
    }
    return { values, confidence };
}

export function latestScores(chat, ids, before = chat.length, sensors = []) {
    return latestPairs(chat, ids, before, sensors).values;
}

export function getHistory(chat, count, carryForwardIds = [], sensors = []) {
    const indices = narratorIndices(chat, { limit: count }).reverse();
    const history = indices.map(index => {
        const pairs = measuredPairs(chat[index], sensors);
        return { index, scores: pairs.values, own: pairs.values, confidence: pairs.confidence };
    });
    if (!carryForwardIds.length) {
        return history;
    }
    const inherited = latestPairs(chat, carryForwardIds, indices[0] ?? chat.length, sensors);
    for (const entry of history) {
        for (const id of carryForwardIds) {
            const value = entry.own?.[id];
            if (value !== undefined) {
                inherited.values[id] = value;
                inherited.confidence[id] = entry.confidence[id];
            } else if (inherited.values[id] !== undefined) {
                entry.scores = { ...entry.scores, [id]: inherited.values[id] };
                if (inherited.confidence[id] !== undefined) {
                    entry.confidence = { ...entry.confidence, [id]: inherited.confidence[id] };
                }
            }
        }
    }
    return history;
}

export function repliesSince(chat, predicate, limit = Infinity) {
    let found = -1;
    for (let i = chat.length - 1; i >= 0 && found < 0; i--) {
        if (isUser(chat[i]) && predicate(getRecord(chat[i]))) {
            found = i;
        }
    }
    if (found < 0) {
        return Infinity;
    }
    return narratorIndices(chat, { limit }).filter(index => index > found).length;
}

export function nudged(record) {
    return firedOf(record).some(entry => !!actionOf(entry?.action)?.spaced && entry?.text);
}

export function firedRule(id) {
    return record => firedOf(record).some(entry => entry?.rule === id);
}

export function writeDecision(message, decision) {
    const extra = ensureExtra(message);
    extra[KEY] = { ...decision, decided: true, fired: firedOf(decision) };
    return extra[KEY];
}

export function addFired(message, entry) {
    const extra = ensureExtra(message);
    const record = getRecord(message);
    extra[KEY] = { ...record, decided: true, fired: [...firedOf(record), entry] };
    return extra[KEY];
}

export function setFiredValue(message, ruleId, key, value) {
    const entry = fired(message).find(item => item?.rule === ruleId);
    if (!entry) {
        return false;
    }
    entry[key] = value;
    return true;
}

export function stripFiredText(message, ruleId) {
    const entry = fired(message).find(item => item?.rule === ruleId);
    if (!entry || entry.text === undefined) {
        return false;
    }
    delete entry.text;
    return true;
}

export function clearScores(chat) {
    let cleared = 0;
    for (const message of chat) {
        if (isNarrator(message) && message?.extra?.[KEY]) {
            delete message.extra[KEY];
            cleared++;
        }
    }
    return cleared;
}
