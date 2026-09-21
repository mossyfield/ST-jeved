import { cancelled, isCancelled, provider } from '../classifier.js';
import { contextKey, sendsContext } from '../context-groups.js';
import { assembleContext, countPieces, presentPieces, promptKeys, readContextGroups } from '../instructions.js';
import { SAVE_DELAY } from '../limits.js';
import { entryKey, listResolver } from '../lists.js';
import { hasLegacyPrompts, settleLegacyPrompts } from '../presets.js';
import { macroText, repeatOf, typeOf } from '../sensor-types.js';
import {
    askedIdsOf, buildRequest, foldAnswers, groupSensors, groupSpec, hasInput, measuredSensors, missingIds, momentOf,
    NO_INPUT, requestKey, sensorSignature,
} from '../sensors.js';
import { getPreset, getSettings, saveSettings } from '../settings.js';
import {
    MESSAGE_MOMENT, REPLY_MOMENT, clearScores, getRecord, getScores, isNarrator, isUser, narratorIndices, userIndices,
    writeScores,
} from '../store.js';
import { hashText, raceTimeout } from '../util.js';
import {
    addCost, addTokens, clearError, describeError, invalidateMeasured, isPaused, markPreset, measureBlockReason,
    measuredCount, measuredStamp, notify, setError, setMeasuring,
} from './status.js';

export const MEASURED = 'measured';
export const FAILED = 'failed';
const SKIPPED = 'skipped';
export const PARTIAL = 'partial';

const pending = new Map();

let saveChatDebounced = null;
let chatController = new AbortController();
let rescanController = null;
let revision = 0;

export function saver() {
    saveChatDebounced ??= SillyTavern.libs.lodash.debounce(async chatId => {
        const context = SillyTavern.getContext();
        if (context.getCurrentChatId() !== chatId) {
            return;
        }
        try {
            await context.saveChat();
        } catch (error) {
            console.error('Jeved: the chat could not be saved.', error);
        }
    }, SAVE_DELAY);
    return saveChatDebounced;
}

export function saveChatSoon() {
    saver()(SillyTavern.getContext().getCurrentChatId());
}

export function isRescanning() {
    return !!rescanController;
}

export function cancelRescan() {
    rescanController?.abort();
}

export function holdRescan(controller) {
    rescanController = controller;
}

export function cancelWork() {
    revision++;
    chatController.abort();
    chatController = new AbortController();
    cancelRescan();
    pending.clear();
    setMeasuring(0);
}

function workSignal(signal) {
    if (!signal) {
        return chatController.signal;
    }
    const linked = new AbortController();
    const stop = () => linked.abort();
    for (const source of [signal, chatController.signal]) {
        if (source.aborted) {
            stop();
        } else {
            source.addEventListener('abort', stop, { once: true });
        }
    }
    return linked.signal;
}

export async function call(request, signal, { manual = false } = {}) {
    const blocked = measureBlockReason({ manual });
    if (blocked) {
        throw cancelled(blocked);
    }
    const settings = getSettings();
    const result = await provider.classify({
        endpoint: settings.endpoint,
        apiKey: settings.apiKey,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        state: request.state,
        questions: request.questions,
        signal: workSignal(signal),
        headers: () => SillyTavern.getContext().getRequestHeaders?.() ?? null,
    });
    addCost(result.cost);
    addTokens(result.tokens);
    return result;
}

export function targetAt(index) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    if ((!isNarrator(message) && !isUser(message)) || !String(message.mes ?? '').trim()) {
        return null;
    }
    return { chatId: context.getCurrentChatId(), index, message, hash: hashText(message.mes) };
}

export function locate(target) {
    const context = SillyTavern.getContext();
    if (!target?.message || context.getCurrentChatId() !== target.chatId || hashText(target.message.mes) !== target.hash) {
        return -1;
    }
    return context.chat[target.index] === target.message
        ? target.index
        : context.chat.indexOf(target.message);
}

function commit(target, result, stamp, signal, fresh) {
    if (stamp !== revision || signal?.aborted || isPaused() || locate(target) < 0) {
        return false;
    }
    writeScores(target.message, result.scores, target.hash, result.confidence);
    invalidateMeasured();
    if (fresh) {
        markPreset();
    }
    saveChatSoon();
    return true;
}

async function sharedContexts(settings, groups, generationType) {
    const wanted = groups.filter(group => sendsContext(group));
    if (!wanted.length) {
        return new Map();
    }
    const pieces = presentPieces(readContextGroups(generationType));
    const counts = await countPieces(pieces);
    const built = new Map();
    for (const group of wanted) {
        const key = contextKey(group);
        if (!built.has(key)) {
            built.set(key, (await assembleContext(pieces, group, settings.instructionsCap, counts)).context);
        }
    }
    return built;
}

export function settleContextPrompts(preset) {
    if (!hasLegacyPrompts(preset)) {
        return;
    }
    const keys = promptKeys();
    if (keys === undefined) {
        return;
    }
    if (settleLegacyPrompts(preset, keys)) {
        saveSettings();
    }
}

function groupsFor(preset, moment, pick = null) {
    settleContextPrompts(preset);
    return groupSensors(preset, { moment, entriesOf: listResolver(preset) })
        .map(group => groupSpec({ ...group, ids: pick ? group.ids.filter(pick) : group.ids }))
        .filter(group => group.ids.length);
}

function momentSensors(preset, moment) {
    return measuredSensors(preset).filter(sensor => momentOf(sensor) === moment);
}

export function missingMessageIds(preset, message) {
    return missingIds(momentSensors(preset, MESSAGE_MOMENT), getScores(message)?.scores, listResolver(preset));
}

async function preparedRequests(settings, groups, generationType) {
    const shared = await sharedContexts(settings, groups, generationType);
    const context = SillyTavern.getContext();
    const substitute = text => context.substituteParams(String(text ?? ''));
    return (index, group) => buildRequest(context.chat, index, group, shared.get(contextKey(group)) ?? null, substitute);
}

export function liveTarget(index, generationType) {
    const target = targetAt(index);
    if (!target || !isNarrator(target.message)) {
        return null;
    }
    return { ...target, generationType, groups: groupsFor(getPreset(), REPLY_MOMENT) };
}

export function messageTarget(index, { missingOnly = false } = {}) {
    const target = targetAt(index);
    if (!target || !isUser(target.message)) {
        return null;
    }
    const preset = getPreset();
    const missing = missingOnly ? new Set(missingMessageIds(preset, target.message)) : null;
    return { ...target, groups: groupsFor(preset, MESSAGE_MOMENT, missing && (id => missing.has(id))) };
}

export function measureMessage(index, signal) {
    return measure(messageTarget(index), signal);
}

async function runMeasurement(target, signal) {
    const stamp = revision;
    const settings = getSettings();
    const groups = target.groups ?? [];
    if (!groups.length || locate(target) < 0) {
        return SKIPPED;
    }

    const build = await preparedRequests(settings, groups, target.generationType);
    const at = locate(target);
    if (at < 0) {
        return SKIPPED;
    }
    const requests = groups.map(group => build(at, group));

    const results = await Promise.allSettled(requests.map(request => call(request, signal)));
    const current = stamp === revision;
    const fresh = measuredCount() === 0;
    let stored = 0;
    let broke = false;
    for (const [position, result] of results.entries()) {
        if (result.status === 'rejected') {
            if (!isCancelled(result.reason)) {
                if (current) {
                    setError(result.reason);
                }
                broke = true;
            }
            continue;
        }
        stored += commit(target, foldAnswers(result.value, requests[position].plan), stamp, signal, fresh) ? 1 : 0;
    }
    if (current && results.every(result => result.status === 'fulfilled')) {
        clearError();
    }
    if (broke) {
        return FAILED;
    }
    if (!stored) {
        return SKIPPED;
    }
    return askedIds(target).length && incomplete(target) ? PARTIAL : MEASURED;
}

function askedIds(target) {
    return (target?.groups ?? []).flatMap(group => group.ids);
}

function askedPairs(target) {
    return (target?.groups ?? []).flatMap(group => askedIdsOf(group).map(part => `${group.key}=${part}`));
}

function incomplete(target) {
    const preset = getPreset();
    const missing = new Set(missingIds(measuredSensors(preset), getScores(target.message)?.scores, listResolver(preset)));
    return askedIds(target).some(id => missing.has(id));
}

function keyOf(target) {
    return `${target.chatId}:${target.index}:${target.hash}:${requestKey(target.groups)}`;
}

export function pendingMeasurement(target) {
    if (!target) {
        return null;
    }
    const wanted = askedPairs(target);
    for (const held of pending.values()) {
        const same = held.chatId === target.chatId && held.index === target.index && held.hash === target.hash;
        if (same && wanted.every(pair => held.asked.has(pair))) {
            return held.task;
        }
    }
    return null;
}

export function measure(target, signal) {
    if (!target) {
        return null;
    }
    const key = keyOf(target);
    if (pending.has(key)) {
        return pending.get(key).task;
    }
    const stamp = revision;
    const task = runMeasurement(target, signal)
        .catch(error => {
            if (stamp === revision) {
                setError(error);
            }
            return FAILED;
        })
        .finally(() => {
            if (pending.get(key)?.task === task) {
                pending.delete(key);
                setMeasuring(pending.size);
            }
            if (stamp === revision) {
                notify({ index: target.index });
            }
        });
    pending.set(key, {
        task,
        chatId: target.chatId,
        index: target.index,
        hash: target.hash,
        asked: new Set(askedPairs(target)),
    });
    setMeasuring(pending.size);
    return task;
}

export async function waitForPending(limitMs) {
    if (!pending.size) {
        return;
    }
    await raceTimeout(Promise.allSettled([...pending.values()].map(held => held.task)), limitMs);
}

export async function testConnection() {
    const request = provider.testRequest();
    const result = await call(request);
    clearError();
    notify();
    return result.scores[request.id];
}

export function testIndices(sensor, count) {
    const chat = SillyTavern.getContext().chat;
    const pick = momentOf(sensor) === MESSAGE_MOMENT ? userIndices : narratorIndices;
    return pick(chat, { limit: count }).reverse();
}

export async function askOnce(sensor) {
    if (!hasInput(sensor)) {
        throw new Error(NO_INPUT);
    }
    if (typeOf(sensor).problems(sensor).length) {
        throw new Error(typeOf(sensor).needs);
    }
    const settings = getSettings();
    const preset = { ...getPreset(settings), sensors: [{ ...sensor, watch: true }], rules: [] };
    const [group] = groupsFor(preset, momentOf(sensor));
    if (!group) {
        throw new Error(typeOf(sensor).needs);
    }
    const [index] = testIndices(sensor, 1);
    if (index === undefined) {
        throw new Error(momentOf(sensor) === MESSAGE_MOMENT
            ? 'This chat has no message to ask about.'
            : 'This chat has no reply to ask about.');
    }
    const controller = new AbortController();
    const build = await preparedRequests(settings, [group]);
    const request = build(index, group);
    const result = await call(request, controller.signal, { manual: true });
    return macroText(sensor, foldAnswers(result, request.plan).scores[sensor.id]);
}

export function testEntries(sensor) {
    const list = repeatOf(sensor);
    return list ? listResolver(getPreset())(list) : [];
}

function emptyListProblem(sensor) {
    const list = repeatOf(sensor);
    return list && !testEntries(sensor).length
        ? `The list ${list} has no entries in this chat, so there is nothing to ask.`
        : '';
}

export async function testSensor(sensor, count, { signal, onResult } = {}) {
    const blocked = measureBlockReason();
    if (blocked) {
        throw new Error(blocked);
    }
    const context = SillyTavern.getContext();
    const settings = getSettings();
    const id = String(sensor.id ?? '').trim() || 'draft';
    const preset = { ...getPreset(settings), sensors: [{ ...sensor, id, watch: true }], rules: [] };
    const [group] = groupsFor(preset, momentOf(sensor));
    const indices = testIndices(sensor, count);
    const build = group ? await preparedRequests(settings, [group]) : null;
    const entries = testEntries(sensor);
    const rows = [];
    for (const index of indices) {
        if (signal?.aborted) {
            break;
        }
        const text = String(context.chat[index]?.mes ?? '');
        const made = [];
        try {
            if (!build) {
                throw new Error(emptyListProblem(sensor) || (hasInput(sensor) ? typeOf(sensor).needs : NO_INPUT));
            }
            const request = build(index, group);
            const answers = foldAnswers(await call(request, signal), request.plan);
            if (!entries.length) {
                made.push({ index, text, value: answers.scores[id], confidence: answers.confidence[id], probabilities: answers.probabilities[id] });
            } else {
                for (const entry of entries) {
                    const at = entryKey(entry);
                    made.push({
                        index,
                        text,
                        entry,
                        value: answers.scores[id]?.[at],
                        confidence: answers.confidence[id]?.[at],
                        probabilities: answers.probabilities[id]?.[at],
                    });
                }
            }
        } catch (error) {
            if (isCancelled(error)) {
                break;
            }
            made.push({ index, text, error: describeError(error) });
        }
        for (const row of made) {
            rows.push(row);
            onResult?.(row, indices.length * Math.max(1, entries.length));
        }
        if (made.some(row => row.error)) {
            break;
        }
    }
    return rows;
}

export function nextReplyGroups() {
    const preset = getPreset();
    return groupSensors(preset, { moment: REPLY_MOMENT, entriesOf: listResolver(preset) });
}

export function nextMessageGroups() {
    const preset = getPreset();
    return groupSensors(preset, { moment: MESSAGE_MOMENT, entriesOf: listResolver(preset) });
}

function storedAt(target) {
    const record = getRecord(target.message);
    return record?.hash === target.hash ? record.scores : null;
}

export function planMeasurement({ limit = Infinity, all = false, sensorId = '' } = {}) {
    const context = SillyTavern.getContext();
    const preset = getPreset();
    settleContextPrompts(preset);
    const entriesOf = listResolver(preset);
    const tasks = [];
    let calls = 0;

    const plan = (indices, moment) => {
        const built = groupSensors(preset, { moment, entriesOf })
            .map(group => ({ ...group, ids: group.ids.filter(id => !sensorId || id === sensorId) }))
            .filter(group => group.ids.length);
        if (!built.length) {
            return;
        }
        const wanted = all ? [] : momentSensors(preset, moment);
        for (const index of indices) {
            const target = targetAt(index);
            if (!target) {
                continue;
            }
            const missing = all ? null : new Set(missingIds(wanted, storedAt(target), entriesOf));
            const groups = built
                .map(group => groupSpec(missing ? { ...group, ids: group.ids.filter(id => missing.has(id)) } : group))
                .filter(group => group.ids.length);
            if (!groups.length) {
                continue;
            }
            calls += groups.length;
            tasks.push({ ...target, groups });
        }
    };

    plan(narratorIndices(context.chat).slice(0, limit), REPLY_MOMENT);
    plan(userIndices(context.chat).slice(0, limit), MESSAGE_MOMENT);

    tasks.sort((one, other) => one.index - other.index);
    return { tasks, calls };
}

let plannedCache = { key: '', counts: {} };

export function plannedCalls(all = false) {
    const context = SillyTavern.getContext();
    const key = [measuredStamp(), context.getCurrentChatId(), context.chat.length, sensorSignature(getPreset())]
        .join('|');
    if (plannedCache.key !== key) {
        plannedCache = { key, counts: {} };
    }
    const field = all ? 'all' : 'missing';
    if (plannedCache.counts[field] === undefined) {
        plannedCache.counts[field] = planMeasurement(all ? { all: true } : {}).calls;
    }
    return plannedCache.counts[field];
}

export function clearChatScores() {
    const context = SillyTavern.getContext();
    cancelWork();
    const cleared = clearScores(context.chat);
    invalidateMeasured();
    if (cleared) {
        markPreset();
        saveChatSoon();
    }
    notify();
    return cleared;
}
