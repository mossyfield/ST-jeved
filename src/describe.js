import { AFTER_REPLY, DEFAULT_ACTION, replacesReply, ruleAction } from './actions.js';
import { conditionHolds, missingSensors, scoreOf } from './rules.js';
import { conditionText, sensorLabel, typeOf, valueText } from './sensor-types.js';
import { NO_INPUT, hasInput, labelsFor, latestWords, momentCount, momentOf, momentOfRule, windowWords } from './sensors.js';
import { MESSAGE_MOMENT, REPLY_MOMENT, firedFor, isNarrator, lastUserIndex } from './store.js';

const LABEL_WORDS = {
    latest_turn: 'the reply as `latest_turn`',
    player_message: 'your message as `player_message`',
    history: 'the earlier messages as `history`',
    context: 'the card and prompts as `context`',
};

export function momentTag(moment) {
    return moment === MESSAGE_MOMENT ? 'Before the reply' : 'After the reply';
}

export function ruleMomentNote(moment, phase) {
    if (phase === AFTER_REPLY) {
        return 'This rule acts right after the reply.';
    }
    return moment === MESSAGE_MOMENT
        ? 'This rule acts on the reply that comes next.'
        : 'This rule acts on your next turn.';
}

export function momentLine(sensor) {
    if (!hasInput(sensor)) {
        return NO_INPUT;
    }
    return momentOf(sensor) === MESSAGE_MOMENT ? 'Runs before the reply, on your message.' : 'Runs after each reply.';
}

export function listPhrase(items) {
    if (items.length < 3) {
        return items.join(' and ');
    }
    return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function questionKeysHint(sensor) {
    const labels = labelsFor(sensor);
    return labels.length ? `Refer to ${listPhrase(labels.map(label => LABEL_WORDS[label]))}.` : '';
}

export function tokenWords(count) {
    return `About ${Number(count).toLocaleString('en-US')} tokens`;
}

function labelOf(item, id) {
    return String(item?.label ?? '').trim() || String(id ?? '');
}

export function ruleLabel(rules, id) {
    return labelOf((rules ?? []).find(item => item?.id === id), id);
}

export function levelText(sensor, value) {
    return typeOf(sensor).words(sensor, value);
}

export function scoreLine(sensor, value, { words = '' } = {}) {
    const detail = String(words ?? '');
    return `${labelOf(sensor, sensor?.id)}: ${valueText(sensor, value)}${detail ? ` - ${detail}` : ''}`;
}

export function bandText(sensor, value) {
    return typeOf(sensor).band(sensor, value);
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
                        ticks.push({ rule: rule.id, condition });
                    }
                }
            }
            return {
                id: sensor.id,
                label: sensorLabel(sensors, sensor.id),
                ticks,
                cells: columns.map(column => ({
                    index: column.index,
                    value: scoreOf(column, sensor.id),
                    matching: ticks.some(tick => conditionHolds(column, tick.condition)),
                })),
            };
        }),
    };
}

function countWords(rule, moment) {
    const window = Math.max(1, Number(rule.window) || 1);
    const need = Math.min(window, Math.max(1, Number(rule.need) || 1));
    if (window === 1) {
        return `on ${latestWords(moment)}`;
    }
    if (need >= window) {
        return `in all of ${windowWords(moment, window)}`;
    }
    return `in at least ${need} of ${windowWords(moment, window)}`;
}

function thenWords(rule) {
    const action = ruleAction(rule);
    const script = !!String(rule.script ?? '').trim();
    if (!action) {
        return script ? 'run a script' : 'do nothing';
    }
    if (!action.usesDirective) {
        return script ? action.presentTense : 'do nothing';
    }
    const parts = [];
    if (action.replacesReply || String(rule.directive ?? '').trim()) {
        parts.push(action.presentTense);
    }
    if (script) {
        parts.push('run a script');
    }
    return parts.length ? parts.join(' and ') : 'do nothing';
}

export function rescanSentence({ measured = 0, failed = 0 } = {}) {
    if (!measured && !failed) {
        return 'Nothing was measured.';
    }
    if (!measured) {
        return `Nothing was measured, because ${momentCount(MESSAGE_MOMENT, failed)} failed.`;
    }
    return failed
        ? `Measured ${momentCount(MESSAGE_MOMENT, measured)}, and ${failed} failed.`
        : `Measured ${momentCount(MESSAGE_MOMENT, measured)}.`;
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
    const moment = momentOfRule(rule, sensors);
    const when = conditions.map(condition => conditionText(condition, sensors)).join(' and ');
    const unless = rule.skipWhen?.sensor
        ? `, except when ${conditionText(rule.skipWhen, sensors)} on ${latestWords(moment)}`
        : '';
    const cooldown = Number(rule.cooldown) > 0
        ? ` Then it waits ${momentCount(REPLY_MOMENT, Number(rule.cooldown))} before it can fire again.`
        : '';
    return `When ${when} ${countWords(rule, moment)}${unless}, ${thenWords(rule)}.${cooldown}`;
}

export function entryWords(entry) {
    const action = ruleAction(entry);
    if (!action) {
        return 'ran a script';
    }
    return action.replacesReply || !action.usesDirective || entry?.text ? action.pastTense : 'ran a script';
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
    const entry = firedFor(chat[user]).find(item => replacesReply(item) && item?.text);
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
        const entries = firedFor(message).filter(entry => entry?.text && !replacesReply(entry));
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
