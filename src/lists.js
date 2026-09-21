import { currentChat, getRecord, isUser, lastUserIndex, manualChanges, setRecord, writeManualChanges } from './store.js';
import { hashText, isRecord } from './util.js';

export const ADD = 'add';
export const REMOVE = 'remove';

export const FROM_PRESET = 'preset';
export const FROM_CHAT = 'chat';
export const FROM_RULE = 'rule';

let counter = 0;

export function normaliseEntry(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

export function entryKey(text) {
    return normaliseEntry(text).toLowerCase();
}

export function normaliseEntries(values) {
    const found = new Map();
    for (const value of Array.isArray(values) ? values : []) {
        const entry = normaliseEntry(value);
        if (entry && !found.has(entryKey(entry))) {
            found.set(entryKey(entry), entry);
        }
    }
    return [...found.values()];
}

export function presetLists(preset) {
    return (Array.isArray(preset?.lists) ? preset.lists : []).filter(isRecord);
}

export function listNames(preset) {
    return presetLists(preset).map(list => String(list.name ?? '')).filter(name => name);
}

export function findList(preset, name) {
    const wanted = String(name ?? '').trim();
    return presetLists(preset).find(list => String(list.name ?? '') === wanted) ?? null;
}

export function startingEntries(preset, name) {
    return normaliseEntries(findList(preset, name)?.entries);
}

export function listDescription(preset, name) {
    return String(findList(preset, name)?.description ?? '').trim();
}

function apply(found, change, scope) {
    const value = normaliseEntry(change?.value);
    const key = entryKey(value);
    if (!key) {
        return;
    }
    if (change.op === ADD) {
        if (!found.has(key)) {
            found.set(key, { value, scope });
        }
    } else if (change.op === REMOVE) {
        found.delete(key);
    }
}

function changesOn(message, name) {
    const record = getRecord(message);
    const held = Array.isArray(record?.lists) ? record.lists : [];
    if (!held.length) {
        return [];
    }
    const hash = hashText(message?.mes);
    return held.filter(change => change?.list === name && change?.hash === hash);
}

export function effectiveList(chat, preset, name, manual = []) {
    const wanted = String(name ?? '').trim();
    const found = new Map();
    for (const entry of startingEntries(preset, wanted)) {
        apply(found, { op: ADD, value: entry }, FROM_PRESET);
    }
    const mine = (Array.isArray(manual) ? manual : []).filter(change => change?.list === wanted);
    const waiting = new Set(mine);
    let pending = [];
    const flush = () => {
        for (const change of pending) {
            apply(found, change, FROM_CHAT);
        }
        pending = [];
    };
    for (const message of chat ?? []) {
        if (isUser(message)) {
            flush();
        }
        for (const change of changesOn(message, wanted)) {
            apply(found, change, FROM_RULE);
        }
        const anchor = getRecord(message)?.listAnchor;
        if (!anchor) {
            continue;
        }
        for (const change of mine) {
            if (change.anchor === anchor && waiting.delete(change)) {
                pending.push(change);
            }
        }
    }
    flush();
    for (const change of mine) {
        if (waiting.has(change)) {
            apply(found, change, FROM_CHAT);
        }
    }
    return [...found.values()];
}

export function effectiveEntries(chat, preset, name, manual = []) {
    return effectiveList(chat, preset, name, manual).map(row => row.value);
}

export function listRows(preset, name) {
    return effectiveList(currentChat(), preset, name, manualChanges());
}

export function listResolver(preset) {
    const held = new Map();
    return name => {
        const wanted = String(name ?? '').trim();
        if (!held.has(wanted)) {
            held.set(wanted, effectiveEntries(currentChat(), preset, wanted, manualChanges()));
        }
        return held.get(wanted);
    };
}

export function hiddenEntries(preset, name, entries) {
    const shown = new Set(entries.map(entryKey));
    return startingEntries(preset, name).filter(entry => !shown.has(entryKey(entry)));
}

export function ruleChange(message, list, op, value) {
    const entry = normaliseEntry(value);
    if (!message || !entry) {
        return false;
    }
    const hash = hashText(message.mes);
    const held = Array.isArray(getRecord(message)?.lists) ? getRecord(message).lists : [];
    setRecord(message, { lists: [...held.filter(change => change?.hash === hash), { list, op, value: entry, hash }] });
    return true;
}

function anchorOf(message) {
    const held = getRecord(message)?.listAnchor;
    if (held) {
        return String(held);
    }
    counter++;
    const made = `${Date.now().toString(36)}${counter.toString(36)}`;
    setRecord(message, { listAnchor: made });
    return made;
}

export function manualChange(list, op, value) {
    const entry = normaliseEntry(value);
    if (!entry) {
        return false;
    }
    const chat = currentChat();
    const index = lastUserIndex(chat);
    const anchor = index < 0 ? '' : anchorOf(chat[index]);
    writeManualChanges([...manualChanges(), { list, op, value: entry, anchor }]);
    return true;
}

export function forgetManual(list, value) {
    const key = entryKey(value);
    const held = manualChanges();
    const kept = held.filter(change => !(change?.list === list && entryKey(change?.value) === key));
    if (kept.length === held.length) {
        return false;
    }
    writeManualChanges(kept);
    return true;
}

export function addStarting(preset, name, value) {
    const target = findList(preset, name);
    const entry = normaliseEntry(value);
    if (!target || !entry) {
        return false;
    }
    target.entries = normaliseEntries([...(target.entries ?? []), entry]);
    forgetManual(name, entry);
    return true;
}

export function removeStarting(preset, name, value) {
    const target = findList(preset, name);
    const key = entryKey(value);
    if (!target || !key) {
        return false;
    }
    target.entries = normaliseEntries(target.entries).filter(entry => entryKey(entry) !== key);
    forgetManual(name, value);
    return true;
}

export function restoreEntry(preset, name, value) {
    forgetManual(name, value);
    const back = effectiveEntries(currentChat(), preset, name, manualChanges())
        .some(entry => entryKey(entry) === entryKey(value));
    return back ? false : manualChange(name, ADD, value);
}

export function fillEntries(text, entries = [], current = '') {
    const list = (entries ?? []).map(entry => normaliseEntry(entry)).filter(entry => entry);
    return String(text ?? '')
        .replaceAll('{{entries_json}}', JSON.stringify(list))
        .replaceAll('{{entries}}', list.join('\n'))
        .replaceAll('{{entry}}', normaliseEntry(current) || list[0] || '');
}
