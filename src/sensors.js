import { AFTER_REPLY, BEFORE_GENERATION, ruleAction } from './actions.js';
import { contextKey, contextKeys, contextMode, sendsContext } from './context-groups.js';
import { MESSAGES } from './limits.js';
import { entryKey, fillEntries } from './lists.js';
import { entryValue, findSensor, hasValue, repeatOf, typeOf } from './sensor-types.js';
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

export function phaseOfRule(rule, sensors = []) {
    const fixed = ruleAction(rule)?.phase;
    if (fixed) {
        return fixed;
    }
    return momentOfRule(rule, sensors) === MESSAGE_MOMENT ? BEFORE_GENERATION : AFTER_REPLY;
}

export function firesInPhase(rule, phase, sensors = []) {
    return phaseOfRule(rule, sensors) === phase;
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
    if (sendsContext(sensor)) {
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
    return `${userCount(sensor)}:${assistantCount(sensor)}:${contextKey(sensor)}`;
}

export function measuredSensors(preset, only = null) {
    const needed = neededSensorIds(preset);
    return (preset?.sensors ?? []).filter(sensor => usable(sensor)
        && needed.has(sensor.id)
        && (!only || only.has(sensor.id)));
}

export function missingIds(sensors, scores, entriesOf = null) {
    return (sensors ?? []).filter(sensor => {
        const list = repeatOf(sensor);
        if (!list) {
            return !hasValue(sensor, scores?.[sensor.id]);
        }
        const entries = entriesOf ? entriesOf(list) : [];
        return entries.some(entry => entryValue(sensor, scores?.[sensor.id], entryKey(entry)) === null);
    }).map(sensor => sensor.id);
}

export function sensorSignature(preset) {
    return measuredSensors(preset).map(sensor => `${sensor.id}:${groupKeyOf(sensor)}`).join('|');
}

export function entriesOfSensor(sensor) {
    return Array.isArray(sensor?.entries) ? sensor.entries : null;
}

export function groupSensors(preset, { moment = null, only = null, entriesOf = null } = {}) {
    const groups = new Map();
    for (const sensor of measuredSensors(preset, only)) {
        if (moment && momentOf(sensor) !== moment) {
            continue;
        }
        const list = repeatOf(sensor);
        const entries = list ? (entriesOf?.(list) ?? []) : null;
        if (entries && !entries.length) {
            continue;
        }
        const key = groupKeyOf(sensor);
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                user: userCount(sensor),
                assistant: assistantCount(sensor),
                context: contextMode(sensor),
                contextPieces: contextKeys(sensor),
                ids: [],
                sensors: [],
            });
        }
        const group = groups.get(key);
        group.ids.push(sensor.id);
        group.sensors.push(entries ? { ...sensor, entries } : sensor);
    }
    return [...groups.values()];
}

function sensorSpec(sensor) {
    const spec = {
        id: sensor.id,
        type: typeOf(sensor).id,
        question: String(sensor.question ?? ''),
        levels: (sensor.levels ?? []).map(level => String(level ?? '')),
        options: (sensor.options ?? []).map(option => ({ ...option })),
    };
    const entries = entriesOfSensor(sensor);
    if (entries) {
        spec.entries = [...entries];
    }
    return spec;
}

export function groupSpec(group) {
    const ids = [...group.ids];
    const wanted = new Set(ids);
    return {
        key: group.key,
        user: group.user,
        assistant: group.assistant,
        context: contextMode(group),
        contextPieces: contextKeys(group),
        ids,
        sensors: (group.sensors ?? []).filter(sensor => wanted.has(sensor.id)).map(sensorSpec),
    };
}

export function askedIdsOf(group) {
    const held = new Map((group?.sensors ?? []).map(sensor => [sensor.id, entriesOfSensor(sensor)]));
    return [...(group?.ids ?? [])].map(id => {
        const entries = held.get(id);
        return entries ? `${id}[${entries.map(entry => entryKey(entry)).join('|')}]` : id;
    });
}

export function requestKey(groups) {
    return (groups ?? [])
        .map(group => `${group.key}=${askedIdsOf(group).sort().join(',')}`)
        .sort()
        .join('|');
}

function questionOf(sensor, substitute, entry) {
    const fill = text => substitute(fillEntries(text, entry ? [entry] : []));
    return {
        type: typeOf(sensor).id,
        question: fill(sensor.question),
        levels: (sensor.levels ?? []).map(level => fill(level)),
        options: (sensor.options ?? []).map(option => ({
            name: String(option?.name ?? ''),
            description: fill(option?.description),
        })),
    };
}

function buildQuestions(sensors, substitute) {
    const questions = Object.create(null);
    const plan = [];
    for (const sensor of sensors) {
        const entries = entriesOfSensor(sensor);
        if (!entries) {
            questions[sensor.id] = questionOf(sensor, substitute, '');
            plan.push({ wire: sensor.id, id: sensor.id, entry: '' });
            continue;
        }
        entries.forEach((entry, position) => {
            const wire = `${sensor.id}#${position}`;
            questions[wire] = questionOf(sensor, substitute, entry);
            plan.push({ wire, id: sensor.id, entry });
        });
    }
    return { questions, plan };
}

export function foldAnswers(result, plan) {
    const folded = { scores: Object.create(null), confidence: Object.create(null), probabilities: Object.create(null) };
    for (const step of plan ?? []) {
        for (const field of ['scores', 'confidence', 'probabilities']) {
            const found = result?.[field]?.[step.wire];
            if (found === undefined) {
                continue;
            }
            if (!step.entry) {
                folded[field][step.id] = found;
            } else {
                folded[field][step.id] ??= {};
                folded[field][step.id][entryKey(step.entry)] = found;
            }
        }
    }
    return folded;
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
    if (context && sendsContext(group)) {
        state.context = context;
    }
    return { state, ...buildQuestions(group.sensors ?? [], substitute) };
}
