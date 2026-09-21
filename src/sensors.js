import { ruleAction } from './actions.js';
import { MESSAGES } from './limits.js';
import { findSensor, hasValue, typeOf } from './sensor-types.js';
import { MESSAGE_MOMENT, REPLY_MOMENT, isNarrator, narratorIndices, userIndices } from './store.js';
import { clamp } from './util.js';

export const NO_INPUT = 'Pick at least one message.';

export function needsReplyProblem(noun) {
    return `A ${noun} rule needs a sensor that reads an assistant message.`;
}

const MOMENT_WORDS = {
    [MESSAGE_MOMENT]: { one: 'message', many: 'messages', owner: 'your' },
    [REPLY_MOMENT]: { one: 'reply', many: 'replies', owner: 'the' },
};

function wordsOf(moment) {
    return MOMENT_WORDS[moment] ?? MOMENT_WORDS[REPLY_MOMENT];
}

export function momentCount(moment, count) {
    const words = wordsOf(moment);
    return `${count} ${count === 1 ? words.one : words.many}`;
}

export function windowWords(moment, count) {
    return `${wordsOf(moment).owner} last ${momentCount(moment, count)}`;
}

export function moreWords(moment, count) {
    const words = wordsOf(moment);
    return `${count} more ${count === 1 ? words.one : words.many}`;
}

export function latestWords(moment) {
    const words = wordsOf(moment);
    return `${words.owner} latest ${words.one}`;
}

export function momentWord(moment) {
    return wordsOf(moment).many;
}

function userCount(sensor) {
    return clamp(sensor?.user, MESSAGES);
}

function assistantCount(sensor) {
    return clamp(sensor?.assistant, MESSAGES);
}

export function hasInput(sensor) {
    return userCount(sensor) + assistantCount(sensor) > 0;
}

export function momentOf(sensor) {
    return assistantCount(sensor) === 0 ? MESSAGE_MOMENT : REPLY_MOMENT;
}

function ruleSensorIds(rule) {
    return [...(rule?.conditions ?? []), rule?.skipWhen]
        .map(condition => condition?.sensor)
        .filter(id => id);
}

export function momentOfRule(rule, sensors = []) {
    const used = ruleSensorIds(rule);
    return used.length && used.every(id => momentOf(findSensor(sensors, id)) === MESSAGE_MOMENT)
        ? MESSAGE_MOMENT
        : REPLY_MOMENT;
}

export function missesReplySensor(rule, sensors = []) {
    return !!ruleAction(rule)?.needsReplySensor && momentOfRule(rule, sensors) === MESSAGE_MOMENT;
}

export function labelsFor(sensor) {
    const user = userCount(sensor);
    const assistant = assistantCount(sensor);
    const labels = [];
    if (assistant > 0) {
        labels.push('latest_turn');
    }
    if (user > 0) {
        labels.push('player_message');
    }
    if (user > 1 || assistant > 1) {
        labels.push('history');
    }
    if (sensor?.context) {
        labels.push('context');
    }
    return labels;
}

export function neededSensorIds(preset) {
    const ids = new Set();
    for (const rule of preset?.rules ?? []) {
        if (!rule?.enabled) {
            continue;
        }
        for (const id of ruleSensorIds(rule)) {
            ids.add(id);
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
        && hasInput(sensor)
        && typeOf(sensor).usable(sensor);
}

export function groupKeyOf(sensor) {
    return `${userCount(sensor)}:${assistantCount(sensor)}:${sensor?.context ? 1 : 0}`;
}

export function measuredSensors(preset, only = null) {
    const needed = neededSensorIds(preset);
    return (preset?.sensors ?? []).filter(sensor => usable(sensor)
        && needed.has(sensor.id)
        && (!only || only.has(sensor.id)));
}

export function missingIds(sensors, scores) {
    return (sensors ?? []).filter(sensor => !hasValue(sensor, scores?.[sensor.id])).map(sensor => sensor.id);
}

export function sensorSignature(preset) {
    return measuredSensors(preset).map(sensor => `${sensor.id}:${groupKeyOf(sensor)}`).join('|');
}

export function groupSensors(preset, { moment = null, only = null } = {}) {
    const groups = new Map();
    for (const sensor of measuredSensors(preset, only)) {
        if (moment && momentOf(sensor) !== moment) {
            continue;
        }
        const key = groupKeyOf(sensor);
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                user: userCount(sensor),
                assistant: assistantCount(sensor),
                context: !!sensor.context,
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
        user: group.user,
        assistant: group.assistant,
        context: group.context,
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

function textAt(chat, index) {
    return String(chat[index]?.mes ?? '');
}

function buildState(chat, index, group) {
    const reply = momentOf(group) === REPLY_MOMENT;
    const replies = reply ? narratorIndices(chat, { from: index + 1, limit: assistantCount(group) }) : [];
    const users = userIndices(chat, { from: reply ? index : index + 1, limit: userCount(group) });
    const state = {};
    if (replies.length) {
        state.latest_turn = textAt(chat, replies[0]);
    }
    if (users.length) {
        state.player_message = textAt(chat, users[0]);
    }
    const rest = [...replies.slice(1), ...users.slice(1)].sort((one, other) => one - other);
    if (rest.length) {
        state.history = rest
            .map(at => `${isNarrator(chat[at]) ? 'Narrator' : 'Player'}:\n${textAt(chat, at)}`)
            .join('\n\n');
    }
    return state;
}

export function buildRequest(chat, index, group, context, substitute) {
    const state = buildState(chat, index, group);
    if (group.context && context) {
        state.context = context;
    }
    return { state, questions: buildQuestions(group.sensors ?? [], substitute) };
}
