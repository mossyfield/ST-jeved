import { cancelled, isCancelled, provider } from '../classifier.js';
import { buildContext } from '../instructions.js';
import { buildRequest, groupSensors, groupSpec, measuredSensors, requestKey } from '../sensors.js';
import { getPreset, getSettings } from '../settings.js';
import { clearScores, getScores, isNarrator, narratorIndices, writeScores } from '../store.js';
import { hashText } from '../util.js';
import {
    addCost, clearError, describeError, invalidateMeasured, isPaused, markPreset, measureBlockReason,
    measuredCount, measuredStamp, notify, setError, setMeasuring,
} from './status.js';

const SAVE_DELAY = 1000;
const MEASURED = 'measured';
const FAILED = 'failed';
const SKIPPED = 'skipped';

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

export async function call(request, signal) {
    const blocked = measureBlockReason();
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
    });
    addCost(result.cost);
    return result;
}

export function targetAt(index) {
    const context = SillyTavern.getContext();
    const message = context.chat[index];
    if (!isNarrator(message) || !String(message.mes ?? '').trim()) {
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

function commit(target, scores, stamp) {
    if (stamp !== revision || isPaused() || locate(target) < 0) {
        return false;
    }
    const fresh = measuredCount() === 0;
    writeScores(target.message, scores, target.hash);
    invalidateMeasured();
    if (fresh) {
        markPreset();
    }
    saveChatSoon();
    return true;
}

async function sharedContext(preset, settings, groups, generationType) {
    if (!groups.some(group => group.includeContext)) {
        return null;
    }
    return (await buildContext(preset.contextGroups, settings.instructionsCap, generationType)).context;
}

function groupsFor(preset, position = null, pick = null) {
    return groupSensors(preset, { due: position })
        .map(group => groupSpec({ ...group, ids: pick ? group.ids.filter(pick) : group.ids }))
        .filter(group => group.ids.length);
}

async function preparedRequests(preset, settings, groups, generationType) {
    const shared = await sharedContext(preset, settings, groups, generationType);
    const context = SillyTavern.getContext();
    const substitute = text => context.substituteParams(String(text ?? ''));
    return (index, group) => buildRequest(context.chat, index, group, shared, substitute);
}

export function liveTarget(index, generationType) {
    const target = targetAt(index);
    if (!target) {
        return null;
    }
    const position = narratorIndices(SillyTavern.getContext().chat, { from: target.index + 1 }).length;
    return { ...target, generationType, groups: groupsFor(getPreset(), position) };
}

async function runMeasurement(target, signal) {
    const stamp = revision;
    const settings = getSettings();
    const groups = target.groups ?? [];
    if (!groups.length || locate(target) < 0) {
        return SKIPPED;
    }

    const build = await preparedRequests(getPreset(settings), settings, groups, target.generationType);
    const at = locate(target);
    if (at < 0) {
        return SKIPPED;
    }
    const requests = groups.map(group => build(at, group));

    const results = await Promise.allSettled(requests.map(request => call(request, signal)));
    const current = stamp === revision;
    let stored = 0;
    let broke = false;
    for (const result of results) {
        if (result.status === 'rejected') {
            if (!isCancelled(result.reason)) {
                if (current) {
                    setError(result.reason);
                }
                broke = true;
            }
            continue;
        }
        stored += commit(target, result.value.scores, stamp) ? 1 : 0;
    }
    if (current && results.every(result => result.status === 'fulfilled')) {
        clearError();
    }
    if (broke) {
        return FAILED;
    }
    return stored ? MEASURED : SKIPPED;
}

export function measure(target, signal) {
    if (!target) {
        return null;
    }
    const key = `${target.chatId}:${target.index}:${target.hash}:${requestKey(target.groups)}`;
    if (pending.has(key)) {
        return pending.get(key);
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
            if (pending.get(key) === task) {
                pending.delete(key);
                setMeasuring(pending.size);
            }
            if (stamp === revision) {
                notify({ index: target.index });
            }
        });
    pending.set(key, task);
    setMeasuring(pending.size);
    return task;
}

export async function waitForPending(limitMs) {
    if (!pending.size) {
        return;
    }
    let timer = null;
    try {
        await Promise.race([
            Promise.allSettled([...pending.values()]),
            new Promise(resolve => { timer = setTimeout(resolve, limitMs); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export async function testConnection() {
    const request = provider.testRequest();
    const result = await call(request);
    clearError();
    notify();
    return result.scores[request.id];
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
    const [group] = groupsFor(preset);
    const indices = narratorIndices(context.chat, { limit: count }).reverse();
    const build = group ? await preparedRequests(preset, settings, [group]) : null;
    const rows = [];
    for (const index of indices) {
        if (signal?.aborted) {
            break;
        }
        const row = { index, text: String(context.chat[index]?.mes ?? '') };
        try {
            if (!build) {
                throw new Error('This sensor needs a question and two score descriptions.');
            }
            row.score = (await call(build(index, group), signal)).scores[id];
        } catch (error) {
            if (isCancelled(error)) {
                break;
            }
            row.error = describeError(error);
        }
        rows.push(row);
        onResult?.(row, indices.length);
        if (row.error) {
            break;
        }
    }
    return rows;
}

export function nextReplyGroups() {
    const indices = narratorIndices(SillyTavern.getContext().chat);
    return groupSensors(getPreset(), { due: indices.length + 1 });
}

export function planMeasurement({ limit = Infinity, all = false, sensorId = '' } = {}) {
    const context = SillyTavern.getContext();
    const preset = getPreset();
    const indices = narratorIndices(context.chat);
    const tasks = [];
    let calls = 0;

    indices.slice(0, limit).forEach((index, offset) => {
        const stored = getScores(context.chat[index])?.scores ?? {};
        const groups = groupsFor(preset, indices.length - offset, id => (!sensorId || id === sensorId)
            && (all || typeof stored[id] !== 'number'));
        if (!groups.length) {
            return;
        }
        calls += groups.length;
        tasks.push({ ...targetAt(index), groups });
    });

    tasks.reverse();
    return { tasks, calls };
}

let plannedCache = { key: '', counts: {} };

export function plannedCalls(all = false) {
    const context = SillyTavern.getContext();
    const key = [measuredStamp(), context.getCurrentChatId(), context.chat.length, ...measuredSensors(getPreset())
        .map(sensor => `${sensor.id}:${sensor.turns}:${sensor.includeContext ? 1 : 0}:${sensor.includeUser ? 1 : 0}:${sensor.measureEvery}`)]
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
