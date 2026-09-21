import { actionIds, isKnownAction, ruleAction } from './actions.js';
import { ALL_CONTEXT, CUSTOM_CONTEXT, NO_CONTEXT, isPromptKey } from './context-groups.js';
import { blankRule, blankSensor } from './defaults.js';
import { MESSAGES, SCHEMA_VERSION } from './limits.js';
import { normaliseEntries } from './lists.js';
import { DEFAULT_TYPE, confidenceLevel, isKnownType, repeatOf, typeIds, typeOf } from './sensor-types.js';
import { NO_INPUT, hasInput, missesReplySensor, needsReplyProblem } from './sensors.js';
import { clamp, isRecord } from './util.js';

const quoted = ids => ids.map(id => `'${id}'`).join(' or ');

const ACTION_LIST = quoted(actionIds());
const TYPE_LIST = quoted(typeIds());

const UNSTAMPED_VERSION = 2;

const TURNS_V1 = { min: 1, max: 50, fallback: 1 };
const GAP_V3 = 5;

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

function unreadable(problem) {
    return `Jeved can't read this script: ${String(problem).replace(/\.$/, '')}.`;
}

export function checkScript(script, parse = null) {
    const text = String(script ?? '').trim();
    if (!text || typeof parse !== 'function') {
        return '';
    }
    try {
        const problem = parse(text);
        return problem ? unreadable(problem) : '';
    } catch (error) {
        return unreadable(error?.message || 'the script could not be read');
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
    sensor.turns = story ? clamp(preset.storyWindow, { ...TURNS_V1, fallback: 5 }) : 1;
    sensor.includeContext = story;
    sensor.includeUser = !story;
    sensor.measureEvery = story ? clamp(preset.storyEvery, TURNS_V1) : 1;
    sensor.question = renamed(sensor.question);
    if (Array.isArray(sensor.levels)) {
        sensor.levels = sensor.levels.map(level => renamed(level));
    }
}

const LATEST_TURNS = /`latest_turns`|\blatest_turns\b/g;
const SPLIT_LABELS = '`history` and `latest_turn`';

function upgradeInput(sensor) {
    if (sensor.turns === undefined) {
        Object.assign(sensor, { turns: 1, includeUser: true, includeContext: false });
    }
    const turns = clamp(sensor.turns, TURNS_V1);
    sensor.assistant = turns;
    sensor.user = sensor.includeUser ? turns : 0;
    sensor.context = !!sensor.includeContext;
    delete sensor.turns;
    delete sensor.includeUser;
    delete sensor.includeContext;
    delete sensor.measureEvery;
}

function upgradeWording(sensor) {
    let changed = false;
    const split = value => {
        const before = String(value ?? '');
        const after = before.replace(LATEST_TURNS, SPLIT_LABELS);
        changed ||= after !== before;
        return after;
    };
    sensor.question = split(sensor.question);
    if (Array.isArray(sensor.levels)) {
        sensor.levels = sensor.levels.map(level => split(level));
    }
    if (Array.isArray(sensor.options)) {
        sensor.options = sensor.options.map(option => (isRecord(option)
            ? { ...option, description: split(option.description) }
            : option));
    }
    return changed;
}

export const LEGACY_PROMPTS = 'other_prompts';

const LEGACY_CONTEXT_KEYS = [
    'main_prompt', LEGACY_PROMPTS, 'description', 'personality', 'scenario', 'character_note', 'persona',
    'post_history',
];

function sensorsOf(preset) {
    return (Array.isArray(preset?.sensors) ? preset.sensors : []).filter(isRecord);
}

export function hasLegacyPrompts(preset) {
    return sensorsOf(preset).some(sensor => (Array.isArray(sensor.contextPieces) ? sensor.contextPieces : [])
        .includes(LEGACY_PROMPTS));
}

export function settleLegacyPrompts(preset, promptKeys) {
    let changed = 0;
    for (const sensor of sensorsOf(preset)) {
        const stored = Array.isArray(sensor.contextPieces) ? sensor.contextPieces : [];
        if (!stored.includes(LEGACY_PROMPTS)) {
            continue;
        }
        const kept = stored.filter(key => key !== LEGACY_PROMPTS && !isPromptKey(key));
        sensor.contextPieces = [...new Set([...kept, ...(promptKeys ?? [])])];
        changed++;
    }
    return changed;
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
    [2, preset => {
        for (const sensor of Array.isArray(preset.sensors) ? preset.sensors : []) {
            if (isRecord(sensor)) {
                sensor.type = DEFAULT_TYPE;
                sensor.options = [];
            }
        }
    }],
    [3, (preset, notices) => {
        const reworded = [];
        for (const sensor of Array.isArray(preset.sensors) ? preset.sensors : []) {
            if (!isRecord(sensor)) {
                continue;
            }
            upgradeInput(sensor);
            if (upgradeWording(sensor)) {
                reworded.push(String(sensor.label ?? '').trim() || String(sensor.id ?? ''));
            }
        }
        const gap = Number.isFinite(Number(preset.gap)) ? Math.max(0, Math.round(Number(preset.gap))) : GAP_V3;
        for (const rule of Array.isArray(preset.rules) ? preset.rules : []) {
            if (isRecord(rule) && String(rule.directive ?? '').trim()) {
                rule.cooldown = Math.max(Number(rule.cooldown) || 0, gap);
            }
        }
        delete preset.gap;
        delete preset.maxNudges;
        if (reworded.length) {
            notices.push(`Jeved 0.3 changed the wording of these sensors. Check: ${reworded.join(', ')}.`);
        }
    }],
    [4, preset => {
        const stored = isRecord(preset.contextGroups) ? preset.contextGroups : {};
        const ticked = LEGACY_CONTEXT_KEYS.filter(key => stored[key] === undefined || stored[key] === true);
        const everything = ticked.length === LEGACY_CONTEXT_KEYS.length;
        for (const sensor of sensorsOf(preset)) {
            const sends = !!sensor.context;
            sensor.context = sends ? (everything ? ALL_CONTEXT : CUSTOM_CONTEXT) : NO_CONTEXT;
            sensor.contextPieces = sends && !everything ? [...ticked] : [];
            sensor.repeat = '';
        }
        preset.lists = [];
        delete preset.contextGroups;
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

export function stampVersion(preset) {
    if (isRecord(preset)) {
        preset.jeved = SCHEMA_VERSION;
    }
    return preset;
}

export function upgradePreset(preset, notices = []) {
    if (!isRecord(preset) || presetVersion(preset) > SCHEMA_VERSION) {
        return preset;
    }
    const from = presetVersion(preset);
    if (from >= SCHEMA_VERSION) {
        return stampVersion(preset);
    }
    for (let version = from; version < SCHEMA_VERSION; version++) {
        MIGRATIONS.get(version)?.(preset, notices);
    }
    return stampVersion(preset);
}

function checkCondition(condition, where, sensors, problems) {
    if (!isRecord(condition)) {
        problems.push(`${where}: it is not a condition`);
        return;
    }
    const sensor = sensors.find(item => item.id === String(condition.sensor ?? ''));
    if (!sensor) {
        problems.push(`${where}: no sensor named '${condition.sensor}'`);
        return;
    }
    const type = typeOf(sensor);
    if (!type.ops.includes(condition.op)) {
        problems.push(`${where}: the test must be ${quoted(type.ops)}`);
    } else {
        const problem = type.valueProblem(sensor, condition.value);
        if (problem) {
            problems.push(`${where}: ${problem}`);
        }
    }
    if (condition.minConfidence === null || condition.minConfidence === undefined) {
        return;
    }
    if (!type.hasConfidence) {
        problems.push(`${where}: a noul sensor has no confidence`);
    } else if (confidenceLevel(condition.minConfidence) === null) {
        problems.push(`${where}: the confidence must be a number from 0 to 1`);
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

    const lists = [];
    if (data.lists !== undefined && !Array.isArray(data.lists)) {
        problems.push('the lists must be an array');
    }
    (Array.isArray(data.lists) ? data.lists : []).forEach((list, index) => {
        const where = `list ${index + 1}`;
        if (!isRecord(list)) {
            problems.push(`${where}: it is not a list`);
            return;
        }
        const name = String(list.name ?? '');
        if (isReservedKey(name)) {
            problems.push(`${where}: the name '${name}' is reserved and can't be used`);
        } else if (!ID_PATTERN.test(name)) {
            problems.push(`${where}: the name '${name}' can only hold lowercase letters, numbers and underscores`);
        } else if (lists.includes(name)) {
            problems.push(`list '${name}': two lists have that name`);
        } else {
            lists.push(name);
        }
        if (list.entries !== undefined && !Array.isArray(list.entries)) {
            problems.push(`${where}: its entries must be an array`);
        } else if ((list.entries ?? []).some(entry => typeof entry !== 'string')) {
            problems.push(`${where}: every entry must be a text`);
        }
        if (list.description !== undefined && typeof list.description !== 'string') {
            problems.push(`${where}: the description must be a text`);
        }
    });

    const known = [];
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
            known.push(sensor);
        }
        for (const [key, words] of [['user', 'user messages'], ['assistant', 'assistant messages']]) {
            if (clamp(sensor[key], MESSAGES) !== Number(sensor[key])) {
                problems.push(`${named}: ${words} must be a whole number from ${MESSAGES.min} to ${MESSAGES.max}`);
            }
        }
        if (!hasInput(sensor)) {
            problems.push(`${named}: ${NO_INPUT}`);
        }
        if (!String(sensor.label ?? '').trim()) {
            problems.push(`${named}: it has no name`);
        }
        if (!String(sensor.question ?? '').trim()) {
            problems.push(`${named}: it has no question`);
        }
        if (sensor.type !== undefined && !isKnownType(sensor.type)) {
            problems.push(`${named}: the type must be ${TYPE_LIST}`);
        } else {
            problems.push(...typeOf(sensor).problems(sensor).map(problem => `${named}: ${problem}`));
        }
        const repeat = repeatOf(sensor);
        if (repeat && !lists.includes(repeat)) {
            problems.push(`${named}: no list named '${repeat}'`);
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
        const action = ruleAction(rule);
        if (!Array.isArray(rule.conditions) || !rule.conditions.length) {
            problems.push(`${named}: it has no conditions`);
        } else {
            rule.conditions.forEach((condition, position) => {
                checkCondition(condition, `${named}, condition ${position + 1}`, known, problems);
            });
            if (missesReplySensor(rule, known)) {
                problems.push(`${named}: ${needsReplyProblem(action.ruleNoun)}`);
            }
            const over = [...new Set(rule.conditions
                .map(condition => repeatOf(known.find(item => item.id === String(condition?.sensor ?? ''))))
                .filter(name => name))].sort();
            if (over.length > 1) {
                problems.push(`${named}: its sensors repeat over two lists, ${over.join(' and ')}`);
            }
        }
        if (rule.skipWhen !== null && rule.skipWhen !== undefined) {
            checkCondition(rule.skipWhen, `${named}, exception`, known, problems);
            if (repeatOf(known.find(item => item.id === String(rule.skipWhen?.sensor ?? '')))) {
                problems.push(`${named}, exception: a sensor that repeats over a list can't be an exception`);
            }
        }
        if (action?.usesList) {
            const list = String(rule.list ?? '').trim();
            if (!list) {
                problems.push(`${named}: it needs a list`);
            } else if (!lists.includes(list)) {
                problems.push(`${named}: no list named '${list}'`);
            }
            if (!String(rule.value ?? '').trim()) {
                problems.push(`${named}: it needs a value`);
            }
        } else if (action?.needsScript) {
            if (!String(rule.script ?? '').trim()) {
                problems.push(`${named}: it needs a script`);
            }
        } else if (!String(rule.directive ?? '').trim() && !String(rule.script ?? '').trim()) {
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
const RULE_FIELDS = Object.keys(blankRule('', null));
const CONDITION_FIELDS = ['sensor', 'op', 'value', 'minConfidence'];

function conditionsOf(rule) {
    return [...(Array.isArray(rule?.conditions) ? rule.conditions : []), rule?.skipWhen].filter(isRecord);
}

export function renameOption(rules, sensorId, renames) {
    const wanted = new Map([...(renames ?? [])]
        .map(([from, to]) => [String(from ?? '').trim(), String(to ?? '').trim()]));
    let changed = 0;
    for (const rule of Array.isArray(rules) ? rules : []) {
        for (const condition of conditionsOf(rule)) {
            const held = typeof condition.value === 'string' ? condition.value.trim() : condition.value;
            if (condition.sensor === sensorId && wanted.has(held)) {
                condition.value = wanted.get(held);
                changed++;
            }
        }
    }
    return changed;
}

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
    return {
        description: preset.description,
        lists: (Array.isArray(preset.lists) ? preset.lists : []).filter(isRecord).map(list => ({
            name: String(list.name ?? ''),
            description: String(list.description ?? ''),
            entries: normaliseEntries(list.entries),
        })),
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
        jeved: SCHEMA_VERSION,
    };
}

export function importPreset(data, taken = [], { parse = null } = {}) {
    if (!isRecord(data)) {
        return { problems: ['The file does not hold a preset.'] };
    }
    const version = presetVersion(data);
    if (version > SCHEMA_VERSION) {
        return { problems: [`A newer Jeved made this preset (file version ${version}), so Jeved did not import it.`] };
    }
    const notices = [];
    const preset = upgradePreset(structuredClone(data), notices);
    const problems = validatePreset(preset, { parse });
    if (problems.length) {
        return { problems };
    }
    const kept = knownFields(preset);
    return {
        name: uniqueName(data.name, taken),
        preset: kept,
        disabled: kept.rules.filter(rule => String(rule.script ?? '').trim()).map(rule => rule.label || rule.id),
        notices,
        problems: [],
    };
}
