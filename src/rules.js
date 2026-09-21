import { AFTER_REPLY, DEFAULT_ACTION, actionOf, ruleAction } from './actions.js';
import { conditionText, findSensor, hasValue, opOf, valueText } from './sensor-types.js';
import { latestWords, momentCount, momentOfRule, moreWords, windowWords } from './sensors.js';
import { REPLY_MOMENT } from './store.js';

export function scoreOf(entry, sensorId) {
    const value = entry?.scores?.[sensorId];
    return hasValue(null, value) ? value : null;
}

function confidentEnough(entry, condition) {
    const least = condition?.minConfidence;
    if (least === null || least === undefined) {
        return true;
    }
    const level = entry?.confidence?.[condition.sensor];
    return typeof level === 'number' && Number.isFinite(level) && level >= least;
}

export function conditionHolds(entry, condition) {
    const value = scoreOf(entry, condition?.sensor);
    if (value === null || !confidentEnough(entry, condition)) {
        return false;
    }
    if (condition.op === 'below') {
        return typeof value === 'number' && value < condition.value;
    }
    if (condition.op === 'above') {
        return typeof value === 'number' && value > condition.value;
    }
    if (condition.op === 'is') {
        return value === condition.value;
    }
    if (condition.op === 'is_not') {
        return typeof value === 'string' && value !== condition.value;
    }
    return false;
}

function entryMatches(entry, conditions) {
    return conditions.every(condition => conditionHolds(entry, condition));
}

export function matchingCount(history = [], rule = null) {
    const conditions = (rule?.conditions ?? []).filter(condition => condition?.sensor);
    if (!conditions.length) {
        return 0;
    }
    const window = Math.max(1, Number(rule.window) || 1);
    return history.slice(-window).filter(entry => entryMatches(entry, conditions)).length;
}

export function missingSensors(rule, sensorIds) {
    const known = new Set(sensorIds);
    const used = (rule?.conditions ?? []).map(condition => condition?.sensor);
    if (rule?.skipWhen?.sensor) {
        used.push(rule.skipWhen.sensor);
    }
    return [...new Set(used.filter(id => !known.has(id)))];
}

const opWords = op => opOf(op)?.words ?? String(op ?? '');

function describe(rule, sensors, slice, count) {
    const conditions = rule.conditions
        .map(condition => `${condition.sensor} ${opWords(condition.op)} ${valueText(findSensor(sensors, condition.sensor), condition.value, String(condition.value ?? ''))}`)
        .join(' and ');
    const first = rule.conditions[0].sensor;
    const sensor = findSensor(sensors, first);
    const values = slice.map(entry => valueText(sensor, scoreOf(entry, first), 'missing')).join(', ');
    return `${conditions} in ${count} of ${windowWords(momentOfRule(rule, sensors), slice.length)}: ${values}`;
}

function considered(rule, action, sensorIds) {
    return !!rule?.enabled
        && ruleAction(rule)?.id === action
        && Array.isArray(rule.conditions)
        && rule.conditions.length > 0
        && missingSensors(rule, sensorIds).length === 0;
}

export function evaluate({
    history = [],
    historyOf = null,
    rules = [],
    sensorIds = [],
    sensors = [],
    action = DEFAULT_ACTION,
    sinceRule = () => Infinity,
} = {}) {
    const fired = [];

    for (const rule of rules) {
        if (!considered(rule, action, sensorIds)) {
            continue;
        }
        const scope = historyOf ? historyOf(rule) : history;
        const latest = scope.length ? scope[scope.length - 1] : null;
        if (rule.skipWhen?.sensor && conditionHolds(latest, rule.skipWhen)) {
            continue;
        }
        const slice = scope.slice(-rule.window);
        const count = slice.filter(entry => entryMatches(entry, rule.conditions)).length;
        if (count < rule.need) {
            continue;
        }
        if (sinceRule(rule.id) < (rule.cooldown ?? 0)) {
            continue;
        }
        fired.push({ rule, reason: describe(rule, sensors, slice, count) });
        if (actionOf(action)?.onlyOne) {
            break;
        }
    }
    return fired;
}

export function sinceFire(action, position, firedAt) {
    if (firedAt === null || firedAt === undefined) {
        return Infinity;
    }
    return position - firedAt + (actionOf(action)?.fireOffset ?? 0);
}

export function replayRule({ history = [], rule = null, sensorIds = [], sensors = [] } = {}) {
    if (!rule || !Array.isArray(rule.conditions) || !rule.conditions.length) {
        return [];
    }
    const candidate = { ...rule, enabled: true };
    const action = ruleAction(candidate)?.id ?? DEFAULT_ACTION;
    const late = actionOf(action)?.phase === AFTER_REPLY;
    const turns = [];
    let last = null;
    for (let i = 0; i < history.length; i++) {
        if (!late && history[i].decides === false) {
            continue;
        }
        const at = history[i].replies ?? i;
        const since = sinceFire(action, at, last);
        const hits = evaluate({
            history: history.slice(0, i + 1),
            rules: [candidate],
            sensorIds,
            sensors,
            action,
            sinceRule: () => since,
        });
        if (hits.length) {
            turns.push({ index: history[i].index, reason: hits[0].reason });
            last = at;
        }
    }
    return turns;
}

export function explain(rule, {
    history = [],
    sensorIds = [],
    sensors = [],
    sinceRule = () => Infinity,
    lastFired = [],
} = {}) {
    if (rule && !ruleAction(rule)) {
        return {
            kind: 'warn',
            text: 'Unknown action',
            detail: `This rule uses the action '${rule.action}', which this version of Jeved does not have. Pick another action, or update Jeved.`,
        };
    }
    if (!rule?.enabled) {
        return { kind: 'idle', text: 'Off', detail: 'This rule is turned off.' };
    }
    const missing = missingSensors(rule, sensorIds);
    if (missing.length) {
        return { kind: 'warn', text: 'Sensor missing', detail: `No sensor is named ${missing.join(', ')}.` };
    }
    if (lastFired.includes(rule.id)) {
        return { kind: 'fire', text: 'Fired', detail: 'This rule fired on the last turn.' };
    }
    const waiting = Math.max(0, (rule.cooldown ?? 0) - sinceRule(rule.id));
    if (waiting > 0 && Number.isFinite(waiting)) {
        return {
            kind: 'busy',
            text: `Cooling down (${waiting})`,
            detail: `This rule can fire again in ${momentCount(REPLY_MOMENT, waiting)}.`,
        };
    }

    const moment = momentOfRule(rule, sensors);
    const slice = history.slice(-rule.window);
    const latest = slice.length ? slice[slice.length - 1] : null;
    const measured = slice.filter(entry => rule.conditions.every(condition => scoreOf(entry, condition?.sensor) !== null)).length;
    if (measured < rule.need) {
        const short = moreWords(moment, rule.need - measured);
        return { kind: 'idle', text: `Needs ${short}`, detail: `Jeved needs an answer on ${short} before this rule can match.` };
    }
    if (rule.skipWhen?.sensor && conditionHolds(latest, rule.skipWhen)) {
        return {
            kind: 'warn',
            text: 'Blocked',
            detail: `Blocked because ${conditionText(rule.skipWhen, sensors)} on ${latestWords(moment)}.`,
        };
    }
    const count = matchingCount(history, rule);
    if (count < rule.need) {
        return {
            kind: 'idle',
            text: `${count} of ${rule.need}`,
            detail: `${count} of ${windowWords(moment, slice.length)} ${count === 1 ? 'matches' : 'match'}. The rule fires at ${rule.need}.`,
        };
    }
    if (lastFired.length && ruleAction(rule)?.onlyOne) {
        return { kind: 'idle', text: 'Outranked this turn', detail: 'Another rule fired first on this turn.' };
    }
    if (ruleAction(rule)?.phase === AFTER_REPLY) {
        return { kind: 'fire', text: 'Fires after this reply', detail: 'This rule will fire right after the next reply.' };
    }
    return { kind: 'fire', text: 'Fires next turn', detail: 'This rule will fire on your next message.' };
}
