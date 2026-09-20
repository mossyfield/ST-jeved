import { TURNS } from './limits.js';
import { typeOf } from './sensor-types.js';
import { lastUserIndex, narratorIndices } from './store.js';
import { clamp } from './util.js';

export function neededSensorIds(preset) {
    const ids = new Set();
    for (const rule of preset?.rules ?? []) {
        if (!rule?.enabled) {
            continue;
        }
        for (const condition of [...(rule.conditions ?? []), rule.skipWhen]) {
            if (condition?.sensor) {
                ids.add(condition.sensor);
            }
        }
    }
    for (const sensor of preset?.sensors ?? []) {
        if (sensor?.watch && sensor.id) {
            ids.add(sensor.id);
        }
    }
    return ids;
}

function usable(sensor) {
    return !!sensor
        && !!String(sensor.id ?? '').trim()
        && !!String(sensor.question ?? '').trim()
        && typeOf(sensor).usable(sensor);
}

function turnsOf(sensor) {
    return clamp(sensor?.turns, TURNS);
}

function everyOf(sensor) {
    return clamp(sensor?.measureEvery, TURNS);
}

export function groupKeyOf(sensor) {
    return `${turnsOf(sensor)}:${sensor?.includeContext ? 1 : 0}:${sensor?.includeUser ? 1 : 0}`;
}

export function measuredSensors(preset, only = null) {
    const needed = neededSensorIds(preset);
    return (preset?.sensors ?? []).filter(sensor => usable(sensor)
        && needed.has(sensor.id)
        && (!only || only.has(sensor.id)));
}

function isDue(sensor, position) {
    return position % everyOf(sensor) === 0;
}

export function groupSensors(preset, { due = null, only = null } = {}) {
    const groups = new Map();
    for (const sensor of measuredSensors(preset, only)) {
        if (due !== null && !isDue(sensor, due)) {
            continue;
        }
        const key = groupKeyOf(sensor);
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                turns: turnsOf(sensor),
                includeContext: !!sensor.includeContext,
                includeUser: !!sensor.includeUser,
                ids: [],
                sensors: [],
            });
        }
        const group = groups.get(key);
        group.ids.push(sensor.id);
        group.sensors.push(sensor);
    }
    return [...groups.values()];
}

function sensorSpec(sensor) {
    return {
        id: sensor.id,
        type: typeOf(sensor).id,
        question: String(sensor.question ?? ''),
        levels: (sensor.levels ?? []).map(level => String(level ?? '')),
        options: (sensor.options ?? []).map(option => ({ ...option })),
    };
}

export function groupSpec(group) {
    const ids = [...group.ids];
    const wanted = new Set(ids);
    return {
        key: group.key,
        turns: group.turns,
        includeContext: group.includeContext,
        includeUser: group.includeUser,
        ids,
        sensors: (group.sensors ?? []).filter(sensor => wanted.has(sensor.id)).map(sensorSpec),
    };
}

export function requestKey(groups) {
    return (groups ?? [])
        .map(group => `${group.key}=${[...group.ids].sort().join(',')}`)
        .sort()
        .join('|');
}

export function carryForwardIds(preset) {
    return measuredSensors(preset)
        .filter(sensor => turnsOf(sensor) > 1 || everyOf(sensor) > 1)
        .map(sensor => sensor.id);
}

function buildQuestions(sensors, substitute) {
    const questions = Object.create(null);
    for (const sensor of sensors) {
        questions[sensor.id] = {
            type: typeOf(sensor).id,
            question: substitute(sensor.question),
            levels: (sensor.levels ?? []).map(level => substitute(level)),
            options: (sensor.options ?? []).map(option => ({
                name: String(option?.name ?? ''),
                description: substitute(option?.description),
            })),
        };
    }
    return questions;
}

function precedingUserText(chat, index) {
    const user = lastUserIndex(chat, index);
    return user < 0 ? '' : String(chat[user].mes ?? '');
}

function turnState(chat, index, { turns, includeUser }) {
    const count = clamp(turns, TURNS);
    if (count === 1) {
        const state = {};
        if (includeUser) {
            state.player_message = precedingUserText(chat, index);
        }
        state.latest_turn = String(chat[index]?.mes ?? '');
        return state;
    }
    const indices = narratorIndices(chat, { from: index + 1, limit: count }).reverse();
    if (!includeUser) {
        return { latest_turns: indices.map(at => String(chat[at].mes ?? '')).join('\n\n') };
    }
    return {
        latest_turns: indices
            .map(at => `Player:\n${precedingUserText(chat, at)}\n\nNarrator:\n${String(chat[at].mes ?? '')}`)
            .join('\n\n---\n\n'),
    };
}

export function buildRequest(chat, index, group, context, substitute) {
    const state = turnState(chat, index, group);
    if (group.includeContext && context) {
        state.context = context;
    }
    return { state, questions: buildQuestions(group.sensors ?? [], substitute) };
}
