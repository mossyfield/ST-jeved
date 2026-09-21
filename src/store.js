import { actionOf } from './actions.js';
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

const LISTS_KEY = 'jeved_lists';

export function getRecord(message) {
    const record = message?.extra?.[KEY];
    return record && typeof record === 'object' ? record : null;
}

export function setRecord(message, patch) {
    const extra = ensureExtra(message);
    extra[KEY] = { ...getRecord(message), ...patch };
    return extra[KEY];
}

export function manualChanges() {
    const held = SillyTavern.getContext().chatMetadata?.[LISTS_KEY];
    return Array.isArray(held) ? held : [];
}

export function writeManualChanges(changes) {
    const context = SillyTavern.getContext();
    if (!context.chatMetadata) {
        return;
    }
    context.chatMetadata[LISTS_KEY] = changes;
    context.saveMetadataDebounced();
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

function merged(before, next) {
    return isRecord(before) && isRecord(next) ? { ...before, ...next } : next;
}

export function writeScores(message, scores, hash = hashText(message.mes), confidence = {}) {
    const extra = ensureExtra(message);
    const current = getRecord(message);
    const fresh = !!current && current.hash === hash;
    const kept = fresh && current.scores ? { ...current.scores } : {};
    const levels = fresh && isRecord(current.confidence) ? { ...current.confidence } : {};
    for (const id of Object.keys(scores)) {
        const found = confidence?.[id];
        if (typeof found === 'number' && Number.isFinite(found)) {
            levels[id] = found;
        } else if (isRecord(found)) {
            levels[id] = merged(levels[id], found);
        } else {
            delete levels[id];
        }
        kept[id] = merged(kept[id], scores[id]);
    }
    extra[KEY] = { ...current, hash, scores: kept, confidence: levels };
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

function confidenceOf(level) {
    if (typeof level === 'number' && Number.isFinite(level)) {
        return level;
    }
    if (!isRecord(level)) {
        return null;
    }
    const kept = {};
    for (const [key, one] of Object.entries(level)) {
        if (typeof one === 'number' && Number.isFinite(one)) {
            kept[key] = one;
        }
    }
    return Object.keys(kept).length ? kept : null;
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
        const level = confidenceOf(record.confidence?.[id]);
        if (level !== null) {
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

export function sinceRuleIn(chat) {
    const positions = new Map();
    let replies = 0;
    let waiting = [];

    for (const message of chat) {
        if (isUser(message)) {
            waiting = [];
            for (const entry of fired(message)) {
                if (entry?.rule === undefined) {
                    continue;
                }
                positions.set(entry.rule, replies);
                if (entry.reply !== undefined) {
                    waiting.push(entry);
                }
            }
        } else if (isNarrator(message)) {
            const hash = hashText(message.mes);
            for (const entry of waiting) {
                if (entry.reply === hash) {
                    positions.set(entry.rule, replies);
                }
            }
            replies++;
        }
    }

    return id => (positions.has(id) ? replies - positions.get(id) : Infinity);
}

export function makeReceipt({ rule, reason, entries }, action, { reply, scores } = {}) {
    const entry = { rule: rule.id, action, reason };
    if (reply !== undefined) {
        entry.reply = reply;
    }
    if (entries?.length) {
        entry.entries = [...entries];
    }
    if (actionOf(action)?.usesDirective && String(rule.directive ?? '').trim()) {
        entry.text = rule.directive;
    }
    if (scores && Object.keys(scores).length) {
        entry.scores = scores;
    }
    return entry;
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
