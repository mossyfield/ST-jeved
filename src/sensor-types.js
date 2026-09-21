import { CONFIDENCE, LEVEL_COUNT, LEVELS, OPTIONS } from './limits.js';
import { isRecord, scoreText } from './util.js';

export const SCORE = 'score';
export const CHOICE = 'choice';
export const NOUL = 'noul';
export const DEFAULT_TYPE = SCORE;

const BELOW = 'below';
const ABOVE = 'above';
const IS = 'is';
const IS_NOT = 'is_not';

const OPS = [
    { id: BELOW, label: 'Below', words: 'below', phrase: value => `below ${value}` },
    { id: ABOVE, label: 'Above', words: 'above', phrase: value => `above ${value}` },
    { id: IS, label: 'Is', words: 'is', phrase: value => String(value) },
    { id: IS_NOT, label: 'Is not', words: 'is not', phrase: value => `not ${value}` },
];

const OP_BY_ID = new Map(OPS.map(op => [op.id, op]));

export function opOf(id) {
    return OP_BY_ID.get(String(id ?? '')) ?? null;
}

export function blankLevels() {
    return Array.from({ length: LEVEL_COUNT }, () => '');
}

function numberOf(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function within(value, max) {
    const number = numberOf(value);
    return number !== null && number >= 0 && number <= max;
}

function levelsOf(item) {
    return Array.isArray(item?.levels) ? item.levels : [];
}

function scaleMax(item) {
    const levels = levelsOf(item);
    return levels.length ? levels.length - 1 : LEVEL_COUNT - 1;
}

function textAt(item, position) {
    return String(levelsOf(item)[position] ?? '').trim();
}

function optionsOf(item) {
    return (Array.isArray(item?.options) ? item.options : []).filter(isRecord);
}

function optionNames(item) {
    return optionsOf(item).map(option => String(option.name ?? '').trim()).filter(name => name);
}

function filledCount(list) {
    return list.filter(item => String(item ?? '').trim()).length;
}

function readConfidence(answer) {
    return within(answer?.confidence, 1) ? answer.confidence : undefined;
}

function readSpread(answer) {
    return isRecord(answer?.probabilities) ? answer.probabilities : undefined;
}

function scoreWords(sensor, value) {
    const levels = levelsOf(sensor);
    const number = numberOf(value);
    if (!levels.length || number === null) {
        return '';
    }
    return String(levels[Math.min(levels.length - 1, Math.max(0, Math.round(number)))] ?? '').trim();
}

function noulWords(sensor, value) {
    const number = numberOf(value);
    if (number === null) {
        return '';
    }
    return number >= 0.5 ? textAt(sensor, 1) || 'Yes' : textAt(sensor, 0) || 'No';
}

export const SENSOR_TYPES = [
    {
        id: SCORE,
        label: 'Score',
        ops: [BELOW, ABOVE],
        hasConfidence: true,
        needs: 'This sensor needs a question and two score descriptions.',
        about: 'Jev rates the reply on a scale that you describe.',
        caption: sensor => `0 to ${scaleMax(sensor)}`,
        askTitle: 'Question',
        askPlaceholder: 'How much tension or pressure is in `latest_turn`?',
        scaleTitle: 'Scale',
        usable: sensor => filledCount(levelsOf(sensor)) >= LEVELS.min,
        problems(sensor) {
            const levels = levelsOf(sensor);
            if (!Array.isArray(sensor?.levels) || levels.length < LEVELS.min || levels.length > LEVELS.max) {
                return [`it needs ${LEVELS.min} to ${LEVELS.max} score descriptions`];
            }
            return filledCount(levels) < LEVELS.min ? ['it needs at least two score descriptions filled in'] : [];
        },
        wire: spec => ({
            type: SCORE,
            instructions: String(spec?.question ?? ''),
            criteria: levelsOf(spec).map(level => String(level ?? '')),
        }),
        read(answer, spec) {
            return within(answer?.score, scaleMax(spec))
                ? { value: answer.score, confidence: readConfidence(answer), probabilities: readSpread(answer) }
                : null;
        },
        valid: (sensor, value) => within(value, scaleMax(sensor)),
        range: sensor => ({ min: 0, max: scaleMax(sensor), step: 0.1, decimals: 1 }),
        seed: sensor => ({ op: BELOW, value: Math.round(scaleMax(sensor) * 5) / 10 }),
        coerce: (sensor, value) => (Number.isFinite(Number(value)) ? Number(value) : 0),
        valueProblem: (sensor, value) => (Number.isFinite(Number(value)) ? '' : 'the value is not a number'),
        format: (sensor, value, missing) => scoreText(value, missing),
        macro: (sensor, value) => Number(value).toFixed(1),
        words: scoreWords,
        band(sensor, value) {
            const levels = levelsOf(sensor);
            const number = numberOf(value);
            if (!levels.length || number === null) {
                return '';
            }
            const low = Math.min(levels.length - 1, Math.max(0, Math.floor(number)));
            const words = String(levels[low] ?? '').trim();
            if (!words) {
                return '';
            }
            return low >= levels.length - 1 ? `${low}: ${words}` : `${low} to ${low + 1}: ${words}`;
        },
    },
    {
        id: CHOICE,
        label: 'Choice',
        ops: [IS, IS_NOT],
        hasConfidence: true,
        needs: 'This sensor needs a question and two options.',
        about: 'Jev picks the one option that fits the reply best.',
        caption: sensor => `${optionNames(sensor).length} options`,
        askTitle: 'Question',
        askPlaceholder: 'What is the mood of `latest_turn`?',
        scaleTitle: 'Options',
        usable: sensor => new Set(optionNames(sensor)).size >= OPTIONS.min,
        problems(sensor) {
            const options = optionsOf(sensor);
            if (!Array.isArray(sensor?.options) || options.length < OPTIONS.min || options.length > OPTIONS.max) {
                return [`it needs ${OPTIONS.min} to ${OPTIONS.max} options`];
            }
            const names = options.map(option => String(option.name ?? '').trim());
            const found = [];
            if (names.some(name => !name)) {
                found.push('an option has no name');
            }
            const repeated = names.find((name, index) => name && names.indexOf(name) !== index);
            if (repeated) {
                found.push(`two options are named '${repeated}'`);
            }
            return found;
        },
        wire: spec => ({
            type: CHOICE,
            instructions: String(spec?.question ?? ''),
            criteria: Object.fromEntries(optionsOf(spec)
                .map(option => [String(option.name ?? '').trim(), String(option.description ?? '')])
                .filter(([name]) => name)),
        }),
        read(answer, spec) {
            const value = typeof answer?.choice === 'string' ? answer.choice : '';
            return value && optionNames(spec).includes(value)
                ? { value, confidence: readConfidence(answer), probabilities: readSpread(answer) }
                : null;
        },
        valid: (sensor, value) => typeof value === 'string' && optionNames(sensor).includes(value),
        range: () => null,
        seed: sensor => ({ op: IS, value: optionNames(sensor)[0] ?? '' }),
        coerce: (sensor, value) => (typeof value === 'string' ? value.trim() : optionNames(sensor)[0] ?? ''),
        valueProblem: (sensor, value) => (optionNames(sensor).includes(String(value ?? '').trim()) ? '' : `no option named '${value}'`),
        format: (sensor, value, missing) => (typeof value === 'string' && value ? value : missing),
        macro: (sensor, value) => String(value),
        words: (sensor, value) => String(optionsOf(sensor)
            .find(option => String(option.name ?? '').trim() === value)?.description ?? '').trim(),
        band: () => '',
    },
    {
        id: NOUL,
        label: 'Noul',
        ops: [BELOW, ABOVE],
        hasConfidence: false,
        needs: 'This sensor needs a statement.',
        about: 'Jev gives the chance, from 0 to 100%, that your statement is true.',
        caption: () => 'Noul',
        askTitle: 'Statement',
        askPlaceholder: '`latest_turn` puts the player in danger.',
        scaleTitle: 'Descriptions (optional)',
        usable: () => true,
        problems(sensor) {
            return !!textAt(sensor, 0) === !!textAt(sensor, 1)
                ? []
                : ['it needs a no description and a yes description, or neither'];
        },
        wire(spec) {
            const question = { type: NOUL, instructions: String(spec?.question ?? '') };
            const no = textAt(spec, 0);
            const yes = textAt(spec, 1);
            if (no && yes) {
                question.criteria = { false: no, true: yes };
            }
            return question;
        },
        read: answer => (within(answer?.noul, 1) ? { value: answer.noul } : null),
        valid: (sensor, value) => within(value, 1),
        range: () => ({ min: 0, max: 1, step: 0.01, decimals: 2, percent: true }),
        seed: () => ({ op: ABOVE, value: 0.5 }),
        coerce: (sensor, value) => (Number.isFinite(Number(value)) ? Math.min(1, Math.max(0, Number(value))) : 0.5),
        valueProblem: (sensor, value) => (within(Number(value), 1) ? '' : 'the value must be a number from 0 to 1'),
        format: (sensor, value, missing) => (numberOf(value) === null ? missing : `${Math.round(value * 100)}%`),
        macro: (sensor, value) => String(Math.round(value * 100)),
        words: noulWords,
        band: noulWords,
    },
];

const BY_ID = new Map(SENSOR_TYPES.map(type => [type.id, type]));
const FALLBACK = BY_ID.get(DEFAULT_TYPE);

export function typeOf(item) {
    return BY_ID.get(String(item?.type ?? DEFAULT_TYPE)) ?? FALLBACK;
}

export function isKnownType(id) {
    return BY_ID.has(String(id ?? ''));
}

export function typeIds() {
    return SENSOR_TYPES.map(type => type.id);
}

export function rangeOf(sensor) {
    return typeOf(sensor).range(sensor);
}

export function hasValue(sensor, value) {
    if (sensor) {
        return typeOf(sensor).valid(sensor, value);
    }
    return numberOf(value) !== null || (typeof value === 'string' && !!value);
}

export function confidenceLevel(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const number = numberOf(Number(value));
    return number !== null && number >= CONFIDENCE.min && number <= CONFIDENCE.max ? number : null;
}

export function seedCondition(sensor) {
    return { sensor: String(sensor?.id ?? ''), ...typeOf(sensor).seed(sensor), minConfidence: null };
}

export function findSensor(sensors, id) {
    return (sensors ?? []).find(sensor => sensor?.id === id) ?? null;
}

export function sensorLabel(sensors, id) {
    return String(findSensor(sensors, id)?.label ?? '').trim() || String(id ?? '');
}

export function valueText(sensor, value, missing = 'not measured') {
    return typeOf(sensor).format(sensor, value, missing);
}

export function macroText(sensor, value) {
    return hasValue(sensor, value) ? typeOf(sensor).macro(sensor, value) : '';
}

function conditionParts(condition, sensors) {
    const sensor = findSensor(sensors, condition.sensor);
    return {
        label: sensorLabel(sensors, condition.sensor),
        op: opOf(condition.op) ?? opOf(typeOf(sensor).ops[0]),
        value: valueText(sensor, condition.value, String(condition.value ?? '')),
    };
}

export function conditionText(condition, sensors) {
    if (!condition?.sensor) {
        return '';
    }
    const { label, op, value } = conditionParts(condition, sensors);
    const least = condition.minConfidence;
    const tail = least === null || least === undefined ? '' : ` with at least ${Math.round(least * 100)}% confidence`;
    return `${label} is ${op.phrase(value)}${tail}`;
}

export function conditionShort(condition, sensors) {
    if (!condition?.sensor) {
        return '';
    }
    const { label, op, value } = conditionParts(condition, sensors);
    return `${label} ${op.words} ${value}`;
}

export function conditionTail(condition, sensors) {
    if (!condition?.sensor) {
        return '';
    }
    const { op, value } = conditionParts(condition, sensors);
    return op.phrase(value);
}

export function normaliseSensor(sensor) {
    sensor.type = isKnownType(sensor.type) ? String(sensor.type) : DEFAULT_TYPE;
    sensor.levels = (Array.isArray(sensor.levels) ? sensor.levels : blankLevels())
        .slice(0, LEVELS.max)
        .map(level => String(level ?? ''));
    sensor.options = optionsOf(sensor)
        .slice(0, OPTIONS.max)
        .map(option => ({ name: String(option.name ?? '').trim(), description: String(option.description ?? '') }));
    return sensor;
}

export function normaliseCondition(condition, sensor) {
    const type = typeOf(sensor);
    condition.sensor = String(condition.sensor ?? '');
    condition.op = type.ops.includes(condition.op) ? condition.op : type.ops[0];
    condition.value = type.coerce(sensor, condition.value);
    condition.minConfidence = type.hasConfidence ? confidenceLevel(condition.minConfidence) : null;
    return condition;
}
