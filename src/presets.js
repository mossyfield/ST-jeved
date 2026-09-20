import { actionIds, isKnownAction } from './actions.js';
import { CONTEXT_KEYS, groupsUpTo } from './context-groups.js';
import { blankRule, blankSensor } from './defaults.js';
import { LEVEL_COUNT, TURNS } from './limits.js';
import { GATE_OFFLINE, checkWalk } from './script-gate.js';
import { clamp, isRecord } from './util.js';

const ACTION_LIST = actionIds().map(id => `'${id}'`).join(' or ');

export const SCHEMA_VERSION = 2;

const UNSTAMPED_VERSION = 2;

const ID_PATTERN = /^[a-z0-9_]+$/;

const RESERVED_KEYS = ['__proto__', 'prototype', 'constructor'];

export function isReservedKey(key) {
    return RESERVED_KEYS.includes(String(key ?? ''));
}

export function slugId(label, taken = []) {
    let base = String(label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item';
    if (isReservedKey(base)) {
        base = `${base}_id`;
    }
    if (!taken.includes(base)) {
        return base;
    }
    let counter = 2;
    while (taken.includes(`${base}_${counter}`)) {
        counter++;
    }
    return `${base}_${counter}`;
}

export function uniqueName(name, taken = []) {
    let base = String(name ?? '').trim() || 'Preset';
    if (isReservedKey(base)) {
        base = `${base} preset`;
    }
    if (!taken.includes(base)) {
        return base;
    }
    let counter = 2;
    while (taken.includes(`${base} (${counter})`)) {
        counter++;
    }
    return `${base} (${counter})`;
}

export function checkScript(script, parse = null) {
    const text = String(script ?? '').trim();
    if (!text) {
        return '';
    }
    if (typeof parse !== 'function') {
        return GATE_OFFLINE;
    }
    try {
        return checkWalk(parse(text));
    } catch (error) {
        return checkWalk({ error: error?.message || 'the script could not be read' });
    }
}

const RENAMES = [
    [/\bnarrator_reply\b/g, 'latest_turn'],
    [/\bplayer_turn\b/g, 'player_message'],
    [/\brecent_story\b/g, 'latest_turns'],
    [/\binstructions\b(?!\.)/g, 'context'],
];

const NESTED_LEGACY = /\b(?:instructions|narrator_reply|player_turn|recent_story)\.[A-Za-z_][A-Za-z0-9_]*/;

function renamed(value) {
    return RENAMES.reduce((text, [pattern, name]) => text.replace(pattern, name), String(value ?? ''));
}

export function legacyReference(sensor) {
    for (const text of [sensor?.question, ...(Array.isArray(sensor?.levels) ? sensor.levels : [])]) {
        const found = NESTED_LEGACY.exec(String(text ?? ''));
        if (found) {
            return found[0];
        }
    }
    return '';
}

function upgradeSensor(sensor, preset) {
    if (sensor.scope === undefined && sensor.turns !== undefined) {
        return;
    }
    const story = sensor.scope === 'story';
    delete sensor.scope;
    sensor.turns = story ? clamp(preset.storyWindow, { ...TURNS, fallback: 5 }) : 1;
    sensor.includeContext = story;
    sensor.includeUser = !story;
    sensor.measureEvery = story ? clamp(preset.storyEvery, TURNS) : 1;
    sensor.question = renamed(sensor.question);
    if (Array.isArray(sensor.levels)) {
        sensor.levels = sensor.levels.map(level => renamed(level));
    }
}

const MIGRATIONS = new Map([
    [1, preset => {
        for (const sensor of Array.isArray(preset.sensors) ? preset.sensors : []) {
            if (isRecord(sensor)) {
                upgradeSensor(sensor, preset);
            }
        }
        delete preset.storyWindow;
        delete preset.storyEvery;
    }],
]);

function looksOlderThanTwo(preset) {
    return preset.storyWindow !== undefined
        || preset.storyEvery !== undefined
        || (Array.isArray(preset.sensors) ? preset.sensors : [])
            .some(sensor => isRecord(sensor) && sensor.scope !== undefined);
}

export function presetVersion(preset) {
    const stated = Number(preset?.jeved);
    if (Number.isFinite(stated) && stated >= 1) {
        return Math.trunc(stated);
    }
    return isRecord(preset) && looksOlderThanTwo(preset) ? 1 : UNSTAMPED_VERSION;
}

export function normaliseContextGroups(preset) {
    const stored = isRecord(preset.contextGroups) ? preset.contextGroups : null;
    preset.contextGroups = Object.fromEntries(CONTEXT_KEYS.map(key => [key, stored ? stored[key] === true : true]));
    return preset;
}

export function stampVersion(preset) {
    if (isRecord(preset)) {
        preset.jeved = SCHEMA_VERSION;
    }
    return preset;
}

function historicalDefaults(preset, version) {
    for (const sensor of Array.isArray(preset.sensors) ? preset.sensors : []) {
        if (isRecord(sensor) && sensor.scope === undefined && sensor.turns === undefined) {
            Object.assign(sensor, { turns: 1, includeContext: false, includeUser: true, measureEvery: 1 });
        }
    }
    const stored = isRecord(preset.contextGroups) ? preset.contextGroups : {};
    const known = groupsUpTo(version);
    preset.contextGroups = Object.fromEntries(CONTEXT_KEYS
        .map(key => [key, stored[key] === undefined ? known.includes(key) : stored[key] === true]));
}

export function upgradePreset(preset) {
    if (!isRecord(preset) || presetVersion(preset) > SCHEMA_VERSION) {
        return preset;
    }
    const from = presetVersion(preset);
    historicalDefaults(preset, from);
    for (let version = from; version < SCHEMA_VERSION; version++) {
        MIGRATIONS.get(version)?.(preset);
    }
    return stampVersion(preset);
}

function checkCondition(condition, where, sensorIds, problems) {
    if (!isRecord(condition)) {
        problems.push(`${where}: it is not a condition`);
        return;
    }
    if (!sensorIds.includes(String(condition.sensor ?? ''))) {
        problems.push(`${where}: no sensor named '${condition.sensor}'`);
    }
    if (condition.op !== 'below' && condition.op !== 'above') {
        problems.push(`${where}: the test must be 'below' or 'above'`);
    }
    if (!Number.isFinite(Number(condition.value))) {
        problems.push(`${where}: the value is not a number`);
    }
}

export function validatePreset(data, { parse = null } = {}) {
    const problems = [];
    if (!isRecord(data)) {
        return ['The file does not hold a preset.'];
    }
    if (data.name !== undefined && isReservedKey(String(data.name).trim())) {
        problems.push(`the name '${data.name}' is reserved and can't be used`);
    }
    if (!Array.isArray(data.sensors) || !Array.isArray(data.rules)) {
        return ['The preset needs a list of sensors and a list of rules.'];
    }

    const sensorIds = [];
    data.sensors.forEach((sensor, index) => {
        const where = `sensor ${index + 1}`;
        if (!isRecord(sensor)) {
            problems.push(`${where}: it is not a sensor`);
            return;
        }
        const id = String(sensor.id ?? '');
        const named = `sensor '${id || index + 1}'`;
        if (isReservedKey(id)) {
            problems.push(`${where}: the id '${id}' is reserved and can't be used`);
        } else if (!ID_PATTERN.test(id)) {
            problems.push(`${where}: the id '${id}' can only hold lowercase letters, numbers and underscores`);
        } else if (sensorIds.includes(id)) {
            problems.push(`${named}: two sensors have that id`);
        } else {
            sensorIds.push(id);
        }
        if (clamp(sensor.turns, TURNS) !== Number(sensor.turns)) {
            problems.push(`${named}: turns must be a whole number from ${TURNS.min} to ${TURNS.max}`);
        }
        if (clamp(sensor.measureEvery, TURNS) !== Number(sensor.measureEvery)) {
            problems.push(`${named}: measure every must be a whole number from ${TURNS.min} to ${TURNS.max}`);
        }
        if (!String(sensor.label ?? '').trim()) {
            problems.push(`${named}: it has no name`);
        }
        if (!String(sensor.question ?? '').trim()) {
            problems.push(`${named}: it has no question`);
        }
        if (!Array.isArray(sensor.levels) || sensor.levels.length !== LEVEL_COUNT) {
            problems.push(`${named}: it needs ${LEVEL_COUNT} score descriptions`);
        } else if (sensor.levels.filter(level => String(level ?? '').trim()).length < 2) {
            problems.push(`${named}: it needs at least two score descriptions filled in`);
        }
    });

    const ruleIds = [];
    data.rules.forEach((rule, index) => {
        const where = `rule ${index + 1}`;
        if (!isRecord(rule)) {
            problems.push(`${where}: it is not a rule`);
            return;
        }
        const id = String(rule.id ?? '');
        const named = `rule '${id || index + 1}'`;
        if (isReservedKey(id)) {
            problems.push(`${where}: the id '${id}' is reserved and can't be used`);
        } else if (!ID_PATTERN.test(id)) {
            problems.push(`${where}: the id '${id}' can only hold lowercase letters, numbers and underscores`);
        } else if (ruleIds.includes(id)) {
            problems.push(`${named}: two rules have that id`);
        } else {
            ruleIds.push(id);
        }
        if (rule.action !== undefined && !isKnownAction(rule.action)) {
            problems.push(`${named}: the action must be ${ACTION_LIST}`);
        }
        if (!Array.isArray(rule.conditions) || !rule.conditions.length) {
            problems.push(`${named}: it has no conditions`);
        } else {
            rule.conditions.forEach((condition, position) => {
                checkCondition(condition, `${named}, condition ${position + 1}`, sensorIds, problems);
            });
        }
        if (rule.skipWhen !== null && rule.skipWhen !== undefined) {
            checkCondition(rule.skipWhen, `${named}, exception`, sensorIds, problems);
        }
        if (!String(rule.directive ?? '').trim() && !String(rule.script ?? '').trim()) {
            problems.push(`${named}: it needs an instruction or a script`);
        }
        const script = checkScript(rule.script, parse);
        if (script) {
            problems.push(`${named}: ${script}`);
        }
    });

    return problems;
}

export function exportPreset(name, preset) {
    return { jeved: SCHEMA_VERSION, name, ...structuredClone(preset) };
}

export function exportFileName(name) {
    return `jeved-${slugId(name)}.json`;
}

const SENSOR_FIELDS = Object.keys(blankSensor(''));
const RULE_FIELDS = Object.keys(blankRule('', ''));
const CONDITION_FIELDS = ['sensor', 'op', 'value'];

function pick(source, fields) {
    const kept = {};
    for (const field of fields) {
        if (source[field] !== undefined) {
            kept[field] = source[field];
        }
    }
    return kept;
}

function knownFields(preset) {
    return normaliseContextGroups({
        description: preset.description,
        sensors: preset.sensors.map(sensor => pick(sensor, SENSOR_FIELDS)),
        rules: preset.rules.map(rule => {
            const kept = pick(rule, RULE_FIELDS);
            kept.conditions = (Array.isArray(rule.conditions) ? rule.conditions : [])
                .map(condition => pick(condition, CONDITION_FIELDS));
            kept.skipWhen = isRecord(rule.skipWhen) ? pick(rule.skipWhen, CONDITION_FIELDS) : null;
            if (String(kept.script ?? '').trim()) {
                kept.enabled = false;
            }
            return kept;
        }),
        contextGroups: preset.contextGroups,
        gap: preset.gap,
        maxNudges: preset.maxNudges,
        jeved: SCHEMA_VERSION,
    });
}

export function importPreset(data, taken = [], { parse = null } = {}) {
    if (!isRecord(data)) {
        return { problems: ['The file does not hold a preset.'] };
    }
    const version = presetVersion(data);
    if (version > SCHEMA_VERSION) {
        return { problems: [`A newer Jeved made this preset (file version ${version}), so Jeved did not import it.`] };
    }
    const preset = upgradePreset(structuredClone(data));
    const problems = validatePreset(preset, { parse });
    if (problems.length) {
        return { problems };
    }
    const kept = knownFields(preset);
    return {
        name: uniqueName(data.name, taken),
        preset: kept,
        disabled: kept.rules.filter(rule => String(rule.script ?? '').trim()).map(rule => rule.label || rule.id),
        problems: [],
    };
}
