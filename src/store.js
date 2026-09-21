import { hasValue } from './sensor-types.js';
import { hashText, isRecord } from './util.js';

const KEY = 'jeved';

export const MESSAGE_MOMENT = 'message';
export const REPLY_MOMENT = 'reply';

export function currentChat() {
    return SillyTavern.getContext().chat;
}

export function isNarrator(message) {
    return !!message && !message.is_user && !message.is_system;
}

export function isUser(message) {
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

function firedOf(record) {
    return Array.isArray(record?.fired) ? record.fired : [];
}

export function fired(message) {
    return firedOf(getRecord(message));
}

export function firedFor(message) {
    const hash = hashText(message?.mes);
    return fired(message).filter(entry => entry?.hash === hash);
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

function foundIndices(chat, matches, from, limit) {
    const found = [];
    for (let i = Math.min(from, chat.length) - 1; i >= 0 && found.length < limit; i--) {
        if (matches(chat[i])) {
            found.push(i);
        }
    }
    return found;
}

export function narratorIndices(chat, { from = chat.length, limit = Infinity } = {}) {
    return foundIndices(chat, isNarrator, from, limit);
}

export function userIndices(chat, { from = chat.length, limit = Infinity } = {}) {
    return foundIndices(chat, isUser, from, limit);
}

export function lastUserIndex(chat, from = chat.length) {
    const [found] = userIndices(chat, { from, limit: 1 });
    return found === undefined ? -1 : found;
}

function sensorMap(sensors) {
    const byId = new Map();
    for (const sensor of sensors ?? []) {
        if (!byId.has(sensor?.id)) {
            byId.set(sensor?.id, sensor);
        }
    }
    return byId;
}

function answersOf(message, byId) {
    const record = getScores(message);
    if (!record || !isRecord(record.scores)) {
        return null;
    }
    const values = {};
    const confidence = {};
    for (const [id, value] of Object.entries(record.scores)) {
        if (!hasValue(byId.get(id) ?? null, value)) {
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

export function latestScores(chat, ids, before = chat.length, sensors = []) {
    const byId = sensorMap(sensors);
    const wanted = new Set(ids);
    const values = {};
    for (let i = Math.min(before, chat.length) - 1; i >= 0 && wanted.size; i--) {
        const stored = getScores(chat[i])?.scores;
        if (!isRecord(stored)) {
            continue;
        }
        for (const id of wanted) {
            if (hasValue(byId.get(id) ?? null, stored[id])) {
                values[id] = stored[id];
                wanted.delete(id);
            }
        }
    }
    return values;
}

function entryOf({ index, replies, decides, own, shared }) {
    const base = { index, replies, decides };
    if (!own && !shared) {
        return { ...base, scores: null, confidence: {} };
    }
    return {
        ...base,
        scores: { ...(shared?.values ?? {}), ...(own?.values ?? {}) },
        confidence: { ...(shared?.confidence ?? {}), ...(own?.confidence ?? {}) },
    };
}

export function getHistory(chat, count, moment = REPLY_MOMENT, sensors = []) {
    const reply = moment === REPLY_MOMENT;
    const byId = sensorMap(sensors);
    const found = [];
    const awaiting = [];
    let replies = narratorIndices(chat).length;
    let followsReply = false;

    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        const narrator = isNarrator(message);
        if (narrator) {
            replies--;
        }
        if (!narrator && !isUser(message)) {
            continue;
        }
        if (!narrator && awaiting.length) {
            const shared = answersOf(message, byId);
            for (const record of awaiting) {
                record.shared = shared;
            }
            awaiting.length = 0;
        }
        if (narrator === reply && found.length < count) {
            const record = {
                index,
                replies,
                decides: !reply || !followsReply,
                own: answersOf(message, byId),
                shared: null,
            };
            found.push(record);
            if (reply) {
                awaiting.push(record);
            }
        }
        if (found.length >= count && !awaiting.length) {
            break;
        }
        followsReply = narrator;
    }

    return found.reverse().map(record => entryOf(record));
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

export function replyPosition(chat, index) {
    return narratorIndices(chat, { from: index }).length;
}

export function firedRule(id) {
    return record => firedOf(record).some(entry => entry?.rule === id);
}

function asReceipt(entry) {
    if (!entry || entry.text === undefined) {
        return entry;
    }
    const kept = { ...entry };
    delete kept.text;
    return kept;
}

export function writeDecision(message, entries, hash = hashText(message.mes)) {
    const extra = ensureExtra(message);
    const record = getRecord(message);
    extra[KEY] = {
        ...record,
        decided: true,
        decidedHash: hash,
        fired: [...firedOf(record).map(asReceipt), ...entries.map(entry => ({ ...entry, hash }))],
    };
    return extra[KEY];
}

export function addFired(message, entry, hash = hashText(message.mes)) {
    const extra = ensureExtra(message);
    const record = getRecord(message);
    extra[KEY] = {
        ...record,
        decided: true,
        decidedHash: record?.decidedHash ?? hash,
        fired: [...firedOf(record), { ...entry, hash }],
    };
    return extra[KEY];
}

function newestEntry(message, ruleId) {
    return fired(message).findLast(item => item?.rule === ruleId) ?? null;
}

export function setFiredValue(message, ruleId, key, value) {
    const entry = newestEntry(message, ruleId);
    if (!entry) {
        return false;
    }
    entry[key] = value;
    return true;
}

export function stripFiredText(message, ruleId) {
    const entry = newestEntry(message, ruleId);
    if (!entry || entry.text === undefined) {
        return false;
    }
    delete entry.text;
    return true;
}

function clearRecord(holder) {
    const record = getRecord(holder);
    if (!record || record.scores === undefined) {
        return false;
    }
    const kept = { ...record };
    delete kept.scores;
    delete kept.hash;
    delete kept.confidence;
    if (Object.keys(kept).length) {
        holder.extra[KEY] = kept;
    } else {
        delete holder.extra[KEY];
    }
    return true;
}

export function clearScores(chat) {
    let cleared = 0;
    for (const message of chat) {
        if (!isNarrator(message) && !isUser(message)) {
            continue;
        }
        let changed = clearRecord(message);
        for (const copy of Array.isArray(message.swipe_info) ? message.swipe_info : []) {
            changed = clearRecord(copy) || changed;
        }
        cleared += changed ? 1 : 0;
    }
    return cleared;
}
