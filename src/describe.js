import { DEFAULT_ACTION, replacesReply, ruleAction } from './actions.js';
import { TURNS } from './limits.js';
import { conditionHolds, missingSensors, scoreOf } from './rules.js';
import { fired, isNarrator, lastUserIndex } from './store.js';
import { clamp, replyWord, scoreText } from './util.js';

const turnsIn = sensor => clamp(sensor?.turns, TURNS);

const SUFFIXES = ['th', 'st', 'nd', 'rd'];

export function ordinal(count) {
    const number = Math.max(0, Math.trunc(Number(count) || 0));
    const tens = number % 100;
    const suffix = tens >= 11 && tens <= 13 ? 'th' : SUFFIXES[number % 10] ?? 'th';
    return `${number}${suffix}`;
}

export function readsTag(sensor) {
    const base = replyWord(turnsIn(sensor));
    return sensor?.includeContext ? `${base} + context` : base;
}

export function readsSummary(sensor) {
    const turns = turnsIn(sensor);
    const every = clamp(sensor?.measureEvery, TURNS);
    const when = every === 1 ? 'On every reply' : `Every ${ordinal(every)} reply`;
    let base = '';
    if (turns === 1) {
        base = sensor?.includeUser ? 'the last reply and your message before it' : 'the last reply';
    } else {
        base = sensor?.includeUser
            ? `the last ${turns} replies with your messages`
            : `the last ${turns} replies, without your messages`;
    }
    return `${when}, Jev reads ${base}${sensor?.includeContext ? ', plus context' : ''}`;
}

export function questionKeysHint(sensor) {
    const turns = turnsIn(sensor);
    let line = '';
    if (turns === 1) {
        line = sensor?.includeUser
            ? 'Refer to the reply as `latest_turn` and your message as `player_message`.'
            : 'Refer to the reply as `latest_turn`.';
    } else {
        line = 'Refer to the replies as `latest_turns`.';
    }
    return sensor?.includeContext ? `${line} The card and the prompts are in \`context\`.` : line;
}

export function tokenWords(count) {
    return `about ${Number(count).toLocaleString('en-US')} tokens`;
}

export function findSensor(sensors, id) {
    return (sensors ?? []).find(sensor => sensor?.id === id) ?? null;
}

function labelOf(item, id) {
    return String(item?.label ?? '').trim() || String(id ?? '');
}

export function sensorLabel(sensors, id) {
    return labelOf(findSensor(sensors, id), id);
}

export function ruleLabel(rules, id) {
    return labelOf((rules ?? []).find(item => item?.id === id), id);
}

export function levelText(sensor, value) {
    const levels = Array.isArray(sensor?.levels) ? sensor.levels : [];
    if (!levels.length || typeof value !== 'number' || !Number.isFinite(value)) {
        return '';
    }
    const index = Math.min(levels.length - 1, Math.max(0, Math.round(value)));
    return String(levels[index] ?? '').trim();
}

export function scoreLine(sensor, value, { carried = false, words = '' } = {}) {
    const detail = String(words ?? '');
    return `${labelOf(sensor, sensor?.id)}: ${scoreText(value)}${detail ? ` - ${detail}` : ''}${carried ? ' (carried over)' : ''}`;
}

export function bandText(sensor, value) {
    const levels = Array.isArray(sensor?.levels) ? sensor.levels : [];
    const number = typeof value === 'number' ? value : Number.NaN;
    if (!levels.length || !Number.isFinite(number)) {
        return '';
    }
    const low = Math.min(levels.length - 1, Math.max(0, Math.floor(number)));
    const words = String(levels[low] ?? '').trim();
    if (!words) {
        return '';
    }
    return low >= levels.length - 1 ? `${low}: ${words}` : `${low} to ${low + 1}: ${words}`;
}

export function gaugeFor(rule, history = []) {
    const conditions = (rule?.conditions ?? []).filter(condition => condition?.sensor);
    const first = conditions[0];
    if (!first) {
        return { value: null, threshold: 0, op: 'below', matching: false };
    }
    const latest = history.length ? history[history.length - 1] : null;
    return {
        value: scoreOf(latest, first.sensor),
        threshold: Number.isFinite(Number(first.value)) ? Number(first.value) : 0,
        op: first.op === 'above' ? 'above' : 'below',
        matching: !!latest && conditions.every(condition => conditionHolds(latest, condition)),
    };
}

function tickHolds(value, tick) {
    return tick.op === 'above' ? value > tick.value : value < tick.value;
}

export function stripChart({ columns = [], sensors = [], rules = [], fired: firedBy = {} } = {}) {
    const active = (rules ?? []).filter(rule => rule?.enabled);
    return {
        columns: columns.map(column => {
            const entries = firedBy[column.index] ?? [];
            return {
                index: column.index,
                nudge: entries.some(entry => !replacesReply(entry) && entry?.text),
                reroll: entries.some(entry => replacesReply(entry)),
            };
        }),
        rows: (sensors ?? []).map(sensor => {
            const ticks = [];
            for (const rule of active) {
                for (const condition of rule.conditions ?? []) {
                    if (condition?.sensor === sensor.id) {
                        ticks.push({
                            rule: rule.id,
                            op: condition.op === 'above' ? 'above' : 'below',
                            value: Number(condition.value),
                        });
                    }
                }
            }
            return {
                id: sensor.id,
                label: sensorLabel(sensors, sensor.id),
                ticks,
                cells: columns.map(column => {
                    const value = scoreOf(column, sensor.id);
                    return {
                        index: column.index,
                        value,
                        carried: value !== null && typeof column.own?.[sensor.id] !== 'number',
                        matching: value !== null && ticks.some(tick => tickHolds(value, tick)),
                    };
                }),
            };
        }),
    };
}

export function conditionText(condition, sensors) {
    if (!condition?.sensor) {
        return '';
    }
    const op = condition.op === 'above' ? 'above' : 'below';
    return `${sensorLabel(sensors, condition.sensor)} is ${op} ${Number(condition.value)}`;
}

export function conditionShort(condition, sensors) {
    if (!condition?.sensor) {
        return '';
    }
    const op = condition.op === 'above' ? 'above' : 'below';
    return `${sensorLabel(sensors, condition.sensor)} ${op} ${Number(condition.value)}`;
}

export function ruleBrief(rule, sensors = []) {
    if (!rule) {
        return '';
    }
    const parts = [ruleAction(rule)?.shortLabel || 'Unknown action'];
    const when = (rule.conditions ?? [])
        .filter(condition => condition?.sensor)
        .map(condition => conditionShort(condition, sensors))
        .join(', ');
    if (when) {
        parts.push(when);
    }
    if (String(rule.script ?? '').trim()) {
        parts.push('Script');
    }
    return parts.join(' · ');
}

function countWords(rule) {
    const window = Math.max(1, Number(rule.window) || 1);
    const need = Math.min(window, Math.max(1, Number(rule.need) || 1));
    if (window === 1) {
        return 'on the latest reply';
    }
    if (need >= window) {
        return `in all of the last ${window} replies`;
    }
    return `in at least ${need} of the last ${window} replies`;
}

function thenWords(rule) {
    const parts = [];
    const action = ruleAction(rule);
    if (action?.replacesReply || (action && String(rule.directive ?? '').trim())) {
        parts.push(action.presentTense);
    }
    if (String(rule.script ?? '').trim()) {
        parts.push('run a script');
    }
    return parts.length ? parts.join(' and ') : 'do nothing';
}

export function rescanSentence({ measured = 0, failed = 0 } = {}) {
    if (!measured && !failed) {
        return 'Nothing was measured.';
    }
    if (!measured) {
        return `Nothing was measured, because ${replyWord(failed)} failed.`;
    }
    return failed
        ? `Measured ${replyWord(measured)}, and ${failed} failed.`
        : `Measured ${replyWord(measured)}.`;
}

function fireWord(count) {
    return count === 1 ? 'once' : `${count} times`;
}

export function previewSentence(savedTurns, draftTurns, scoredCount) {
    if (!scoredCount) {
        return 'This chat has no measured replies yet, so there is nothing to preview.';
    }
    const draft = (draftTurns ?? []).length;
    const saved = savedTurns ? savedTurns.length : draft;
    if (saved !== draft) {
        return draft
            ? `With your changes it would have fired ${fireWord(draft)} (${saved} before).`
            : `With your changes it wouldn't have fired anywhere (${saved} before).`;
    }
    return draft
        ? `This rule would have fired ${fireWord(draft)} in this chat.`
        : "This rule wouldn't have fired anywhere in this chat.";
}

export function ruleSummary(rule, sensors = []) {
    if (!rule) {
        return '';
    }
    const missing = missingSensors(rule, (sensors ?? []).map(sensor => sensor.id));
    if (missing.length) {
        return `This rule is skipped because no sensor is named ${missing.join(', ')}.`;
    }
    const conditions = (rule.conditions ?? []).filter(condition => condition?.sensor);
    if (!conditions.length) {
        return 'This rule has no conditions, so it never fires.';
    }
    const when = conditions.map(condition => conditionText(condition, sensors)).join(' and ');
    const unless = rule.skipWhen?.sensor
        ? `, except when ${conditionText(rule.skipWhen, sensors)} on the latest reply`
        : '';
    const cooldown = Number(rule.cooldown) > 0
        ? ` Then it waits ${replyWord(Number(rule.cooldown))} before it can fire again.`
        : '';
    return `When ${when} ${countWords(rule)}${unless}, ${thenWords(rule)}.${cooldown}`;
}

export function entryWords(entry) {
    const action = ruleAction(entry);
    if (action?.replacesReply) {
        return action.pastTense;
    }
    return entry?.text && action ? action.pastTense : 'ran a script';
}

export function decisionSentence(decision, rules = []) {
    if (!decision) {
        return "Jeved hasn't made a decision yet this session.";
    }
    const entries = Array.isArray(decision.fired) ? decision.fired : [];
    if (!entries.length) {
        return `No rule matched on message #${decision.index}.`;
    }
    const parts = entries.map(entry => `${ruleLabel(rules, entry.rule)} ${entryWords(entry)}`);
    return `On message #${decision.index}, ${parts.join(', and ')}.`;
}

function alternativeEntry(chat, index) {
    const message = chat[index];
    const user = lastUserIndex(chat, index);
    if (user < 0 || chat.slice(user + 1, index).some(isNarrator)) {
        return null;
    }
    const entry = fired(chat[user]).find(item => replacesReply(item) && item?.text);
    if (!entry || typeof entry.swipe !== 'number') {
        return null;
    }
    const shown = typeof message?.swipe_id === 'number' ? message.swipe_id : 0;
    return shown === entry.swipe ? entry : null;
}

export function badgeFor(chat, index) {
    const message = chat[index];
    if (!message) {
        return null;
    }
    if (message.is_user) {
        const entries = fired(message).filter(entry => entry?.text && !replacesReply(entry));
        return entries.length ? { kind: DEFAULT_ACTION, index, entries } : null;
    }
    if (!isNarrator(message)) {
        return null;
    }
    const entry = alternativeEntry(chat, index);
    return entry ? { kind: entry.action, index, entries: [entry] } : null;
}

const RULE_PREFIX = /^rule (?:'[^']*'|\d+)(?:, )?:? */;
const SENSOR_PREFIX = /^sensor (?:'[^']*'|\d+)(?:, )?:? */;

function withoutPrefix(problem, prefix) {
    const rest = String(problem ?? '').replace(prefix, '');
    return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : String(problem ?? '');
}

export function ruleProblem(problem) {
    return withoutPrefix(problem, RULE_PREFIX);
}

export function sensorProblem(problem) {
    return withoutPrefix(problem, SENSOR_PREFIX);
}

export function excerpt(text, limit = 80) {
    const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}
