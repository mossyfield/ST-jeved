import { decisionSentence, entryWords, excerpt, levelText, rescanSentence, ruleLabel, scoreLine, stripChart } from '../describe.js';
import { cancelRescan, chatPreset, clearChatScores, isRescanning, lastDecision, measureBlockReason, measuredCount, planMeasurement, plannedCalls, rescan } from '../engine.js';
import { conditionTail, findSensor, hasValue, valueText } from '../sensor-types.js';
import { measuredSensors } from '../sensors.js';
import { getPreset, getSettings } from '../settings.js';
import { MESSAGE_MOMENT, REPLY_MOMENT, currentChat, fired, getHistory, getScores, isNarrator, isUser, lastUserIndex } from '../store.js';
import { toast } from '../toast.js';
import { hashText } from '../util.js';
import { ask } from './dialogs.js';
import { actions, activate, button, help, node, section, text, withReason } from './dom.js';

const COLUMNS = 20;
const CELL_CHARS = 2;

let progress = null;

function columnName(index) {
    return isUser(currentChat()[index]) ? `Your message ${index}` : `Reply ${index}`;
}

function firedOn(index) {
    const messages = currentChat();
    const message = messages[index];
    if (isUser(message)) {
        return fired(message);
    }
    const user = lastUserIndex(messages, index);
    if (user < 0) {
        return [];
    }
    const hash = hashText(message?.mes);
    const direct = !messages.slice(user + 1, index).some(isNarrator);
    return fired(messages[user])
        .filter(entry => (entry?.reply === undefined ? direct : entry.reply === hash));
}

function buildColumns(preset) {
    const chat = currentChat();
    const columns = getHistory(chat, COLUMNS, REPLY_MOMENT, preset.sensors);
    const last = chat.length - 1;
    if (last >= 0 && isUser(chat[last]) && getScores(chat[last])) {
        columns.push(...getHistory(chat, 1, MESSAGE_MOMENT, preset.sensors));
    }
    return columns.slice(Math.max(0, columns.length - COLUMNS));
}

function cellText(sensor, value) {
    const shown = valueText(sensor, value, '');
    return typeof value === 'string' ? shown.slice(0, CELL_CHARS) : shown;
}

function cellElement(cell, sensor, label, onPick) {
    const classes = ['jeved-cell'];
    if (cell.value === null) {
        classes.push('jeved-cell--empty');
    }
    if (cell.matching) {
        classes.push('jeved-cell--on');
    }
    const element = node('div', classes.join(' '), {
        title: `${columnName(cell.index)}. ${label}: ${valueText(sensor, cell.value)}`,
        tabIndex: 0,
    });
    element.dataset.jevedIndex = String(cell.index);
    if (cell.value !== null) {
        element.textContent = cellText(sensor, cell.value);
    }
    activate(element, () => onPick(cell.index));
    return element;
}

function stripElement(chart, sensors, onPick) {
    const strip = node('div', 'jeved-strip', { id: 'jeved_strip' });
    const track = `repeat(${COLUMNS}, minmax(6px, 1fr))`;

    const marks = node('div', 'jeved-strip-row jeved-strip-row--marks');
    const markCells = node('div', 'jeved-strip-cells');
    markCells.style.gridTemplateColumns = track;
    for (const item of chart.columns) {
        const cell = node('div', 'jeved-mark-cell', { title: columnName(item.index), tabIndex: 0 });
        cell.dataset.jevedIndex = String(item.index);
        if (item.reroll) {
            cell.append(node('i', 'fa-solid fa-rotate jeved-mark jeved-mark--reroll', { title: 'Rerolled' }));
        } else if (item.nudge) {
            cell.append(node('i', 'fa-solid fa-arrow-right jeved-mark jeved-mark--nudge', { title: 'Nudged' }));
        }
        activate(cell, () => onPick(item.index));
        markCells.append(cell);
    }
    marks.append(text('span', 'jeved-strip-label', ''), markCells);
    strip.append(marks);

    for (const row of chart.rows) {
        const sensor = findSensor(sensors, row.id);
        const line = node('div', 'jeved-strip-row');
        const cells = node('div', 'jeved-strip-cells');
        cells.style.gridTemplateColumns = track;
        for (const cell of row.cells) {
            cells.append(cellElement(cell, sensor, row.label, onPick));
        }
        const label = node('span', 'jeved-strip-label');
        label.append(text('span', 'jeved-strip-name', row.label));
        const tails = [...new Set(row.ticks.map(tick => conditionTail(tick.condition, sensors)))];
        if (tails.length) {
            const rule = text('span', 'jeved-strip-rule', tails.length > 1 ? `${tails[0]} +${tails.length - 1}` : tails[0]);
            rule.title = tails.join(', ');
            label.append(rule);
        }
        label.title = row.label;
        line.append(label, cells);
        strip.append(line);
    }
    return strip;
}

function detailElement(preset, index, entry) {
    const block = node('div', 'jeved-detail', { id: 'jeved_detail' });
    if (index === null) {
        block.append(help('Pick a column to see what happened there.'));
        return block;
    }
    const context = SillyTavern.getContext();
    const message = currentChat()[index];
    block.append(text('h4', 'jeved-section-title', columnName(index)));
    block.append(text('div', 'jeved-excerpt', excerpt(message?.mes, 240)));

    const scores = entry?.scores ?? {};
    const lines = measuredSensors(preset)
        .filter(sensor => hasValue(sensor, scores[sensor.id]))
        .map(sensor => scoreLine(sensor, scores[sensor.id], {
            words: context.substituteParams(levelText(sensor, scores[sensor.id])),
        }));
    block.append(...(lines.length ? lines.map(line => text('div', 'jeved-detail-line', line)) : [help('This message has no answers.')]));

    const entries = firedOn(index);
    if (!entries.length) {
        block.append(help('No rule fired on this turn.'));
        return block;
    }
    for (const one of entries) {
        block.append(text('div', 'jeved-detail-fired', `${ruleLabel(preset.rules, one.rule)}: ${entryWords(one)}`));
        if (one.reason) {
            block.append(text('div', 'jeved-detail-line', one.reason));
        }
        if (one.text) {
            block.append(text('pre', 'jeved-script-text', one.text));
        }
    }
    return block;
}

export function activityTab(host) {
    const element = node('div', 'jeved-activity');
    let picked = null;

    function measureButton(caption, title, onClick, options) {
        const blocked = measureBlockReason();
        return withReason(button(caption, blocked || title, onClick, options), blocked);
    }

    async function run(tasks) {
        const blocked = measureBlockReason();
        if (blocked) {
            toast('info', blocked);
            return;
        }
        if (!tasks.length) {
            toast('info', 'Every message already has the answers it needs.');
            return;
        }
        progress = { done: 0, total: tasks.length };
        draw();
        const counts = await rescan(tasks, (done, total) => {
            progress = { done, total };
            draw();
        });
        progress = null;
        host.refreshAll();
        toast(counts.failed ? 'warning' : 'success', rescanSentence(counts));
    }

    async function remeasure() {
        const blocked = measureBlockReason();
        if (blocked) {
            toast('info', blocked);
            return;
        }
        const plan = planMeasurement({ all: true });
        if (!plan.tasks.length) {
            toast('info', 'This chat has nothing to measure.');
            return;
        }
        if (!await ask(`Clear the answers in this chat and measure it again? That costs ${plan.calls} API calls.`, { ok: 'Re-measure' })) {
            return;
        }
        clearChatScores();
        await run(planMeasurement({ all: true }).tasks);
    }

    function draw() {
        const preset = getPreset();
        const sensors = measuredSensors(preset);
        const columns = buildColumns(preset);
        const firedBy = Object.fromEntries(columns.map(item => [item.index, firedOn(item.index)]));
        const children = [];

        if (!sensors.length) {
            children.push(help('No sensor is being measured. Turn on a rule, or tick Measure anyway on a sensor.'));
        } else if (!columns.length) {
            children.push(help('This chat has no replies yet.'));
        } else {
            children.push(stripElement(stripChart({ columns, sensors, rules: preset.rules, fired: firedBy }), sensors, index => {
                picked = index;
                draw();
            }));
            children.push(help("The newest message is on the right. An amber answer met a rule's condition."));
            children.push(detailElement(preset, picked, columns.find(column => column.index === picked)));
        }

        children.push(text('div', 'jeved-decision', decisionSentence(lastDecision(), preset.rules)));

        const marked = chatPreset();
        if (marked && marked !== getSettings().activePreset && measuredCount() > 0) {
            const stale = node('div', 'info-block warning jeved-stale');
            stale.append(
                text('div', '', `The answers in this chat came from the ${marked} preset.`),
                actions(measureButton(`Re-measure this chat (${plannedCalls(true)} API calls)`, 'Clear and measure again', remeasure)),
            );
            children.push(stale);
        }

        children.push(actions(
            measureButton(`Measure missing (${plannedCalls()} API calls)`, 'Measure the messages that have no answer', () => run(planMeasurement({}).tasks)),
            button('Clear answers', 'Remove every answer in this chat', async () => {
                if (!await ask("Clear every answer in this chat? This can't be undone.", { ok: 'Clear' })) {
                    return;
                }
                toast('info', `Cleared the answers on ${clearChatScores()} messages.`);
                host.refreshAll();
            }, { variant: 'danger' }),
        ));

        if (isRescanning() || progress) {
            const line = node('div', 'jeved-progress', { id: 'jeved_progress' });
            line.append(
                text('span', '', progress ? `Measured ${progress.done} of ${progress.total} messages.` : 'Measuring'),
                button('Stop', 'Stop measuring', cancelRescan),
            );
            children.push(line);
        }

        element.replaceChildren(section('Activity', ...children));
    }

    draw();
    return {
        element,
        refresh: draw,
        leave: async () => true,
    };
}
