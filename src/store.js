import { actionOf } from './actions.js';
import { hashText } from './util.js';

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

export function writeScores(message, scores, hash = hashText(message.mes)) {
    const extra = ensureExtra(message);
    const current = getRecord(message);
    const kept = current && current.hash === hash && current.scores ? current.scores : {};
    extra[KEY] = { ...current, hash, scores: { ...kept, ...scores } };
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

export function latestScores(chat, ids, before = chat.length) {
    const found = {};
    for (const index of narratorIndices(chat, { from: before })) {
        const scores = getScores(chat[index])?.scores;
        for (const id of ids) {
            if (found[id] === undefined && typeof scores?.[id] === 'number') {
                found[id] = scores[id];
            }
        }
        if (ids.every(id => found[id] !== undefined)) {
            break;
        }
    }
    return found;
}

export function getHistory(chat, count, carryForwardIds = []) {
    const indices = narratorIndices(chat, { limit: count }).reverse();
    const history = indices.map(index => {
        const own = getScores(chat[index])?.scores ?? null;
        return { index, scores: own, own };
    });
    if (!carryForwardIds.length) {
        return history;
    }
    const inherited = latestScores(chat, carryForwardIds, indices[0] ?? chat.length);
    for (const entry of history) {
        for (const id of carryForwardIds) {
            const value = entry.own?.[id];
            if (typeof value === 'number') {
                inherited[id] = value;
            } else if (inherited[id] !== undefined) {
                entry.scores = { ...entry.scores, [id]: inherited[id] };
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
