import { blankSensor } from '../defaults.js';
import { excerpt, questionKeysHint, readsSummary, readsTag, rescanSentence, sensorLabel, sensorProblem, tokenWords } from '../describe.js';
import { describeError, measureBlockReason, planMeasurement, rescan, testSensor } from '../engine.js';
import { buildContext, countTokens } from '../instructions.js';
import { LEVEL_COUNT, TURNS } from '../limits.js';
import { legacyReference, slugId, validatePreset } from '../presets.js';
import { buildRequest, groupKeyOf, groupSensors } from '../sensors.js';
import { getPreset, getSettings, normalisePreset, saveSettings } from '../settings.js';
import { currentChat, isNarrator, latestScores, narratorIndices } from '../store.js';
import { toast } from '../toast.js';
import { replyWord, scoreText } from '../util.js';
import { actions, area, busy, button, checkbox, clampNumber, column, detach, field, formRow, help, node, note, resultsBox, row, section, setLabel, text, toggle, toolbar, withReason } from './dom.js';
import { ask } from './dialogs.js';
import { masterDetail } from './master.js';

const TEST_REPLIES = 10;
const CROWDED = 30000;
const READS_DELAY = 250;
const NO_REPLIES = 'This chat has no replies to test yet.';
const ASK_ABOUT = 'Ask about one thing that the text shows.';

function usedBy(preset, id) {
    return preset.rules.filter(rule => [...rule.conditions, rule.skipWhen]
        .some(condition => condition?.sensor === id));
}

function narratorCount() {
    return currentChat().filter(isNarrator).length;
}

function candidateSensor(draft, takenIds) {
    const candidate = structuredClone(draft);
    candidate.id = candidate.id || slugId(candidate.label || 'sensor', takenIds);
    return candidate;
}

function sensorProblems(candidate) {
    return validatePreset({ sensors: [candidate], rules: [] })
        .filter(problem => problem.startsWith('sensor'))
        .map(sensorProblem);
}

function testBlock(draft, takenIds, api) {
    const count = () => Math.min(TEST_REPLIES, narratorCount());
    const caption = () => (count() ? `Test on last ${count()} replies (${count()} API calls)` : 'Test');
    const scored = rows => rows.filter(row => !row.error)
        .map(row => ({ index: row.index, tag: scoreText(row.score), text: excerpt(row.text) }));
    const box = resultsBox();
    const hint = note('');
    let controller = null;

    const run = button(caption(), 'Measure the recent replies with this wording', async () => {
        if (controller) {
            controller.abort();
            return;
        }
        if (!count()) {
            return;
        }
        controller = new AbortController();
        setLabel(run, 'Stop');
        const collected = [];
        try {
            await testSensor(
                { ...draft, id: draft.id || slugId(draft.label || 'draft', takenIds) },
                TEST_REPLIES,
                {
                    signal: controller.signal,
                    onResult: (result, total) => {
                        collected.push(result);
                        hint.textContent = `${collected.length} of ${total}`;
                        box.show('', scored(collected));
                    },
                },
            );
            const rows = scored(collected);
            box.show(`Scores for the last ${replyWord(rows.length)}`, rows, 'Nothing was measured.');
            const failed = collected.find(row => row.error);
            if (failed) {
                box.warn(failed.error);
            }
            box.foot("These scores aren't saved.");
        } catch (error) {
            box.fail(describeError(error));
        } finally {
            controller = null;
            setLabel(run, caption());
            paint();
        }
    });

    function paint() {
        const blocked = measureBlockReason();
        run.title = blocked || 'Measure the recent replies with this wording';
        busy(run, !count() || !!blocked);
        hint.textContent = blocked || (count() ? '' : NO_REPLIES);
    }

    paint();
    api.onRefresh(paint);
    api.onClose(() => controller?.abort());
    return section('Test', toolbar(run, hint), box.element);
}

function listWords(items) {
    return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

async function requestTokens(draft, preset) {
    const settings = getSettings();
    let total = 0;
    if (draft.includeContext) {
        const built = await buildContext(preset.contextGroups, settings.instructionsCap);
        if (built.total === null) {
            return null;
        }
        total += built.total;
    }
    const chat = currentChat();
    const [latest] = narratorIndices(chat);
    if (latest === undefined) {
        return total;
    }
    const { state } = buildRequest(chat, latest, { ...draft, sensors: [] }, null, value => value);
    const count = await countTokens(Object.values(state).join('\n\n'));
    return count === null ? null : total + count;
}

function readsBlock(preset, draft, saved, api) {
    const line = text('div', 'jeved-readout', '');
    line.id = 'jeved_sensor_reads';
    const crowded = help('');
    crowded.id = 'jeved_sensor_crowded';
    crowded.hidden = true;

    async function paint() {
        const group = groupSensors(preset).find(item => item.key === groupKeyOf(draft));
        const others = (group?.sensors ?? [])
            .filter(sensor => sensor.id !== saved?.id)
            .map(sensor => sensorLabel(preset.sensors, sensor.id));
        const tokens = await requestTokens(draft, preset);
        const parts = [`${readsSummary(draft)}${tokens === null ? '' : ` (${tokenWords(tokens)})`}.`];
        if (others.length) {
            parts.push(`Shares a call with ${listWords(others)}.`);
        }
        line.textContent = parts.join(' ');
        crowded.hidden = tokens === null || tokens <= CROWDED;
        crowded.textContent = crowded.hidden ? '' : "That is close to Jev's 32,000 token limit, so the call may return no scores.";
    }

    const schedule = SillyTavern.libs.lodash.debounce(() => detach(paint()), READS_DELAY);
    api.onClose(() => schedule.cancel());
    detach(paint());
    return { element: formRow('What Jev sees', column('', line, crowded)), schedule };
}

function sensorPane(preset, draft, api, host, { saved, otherIds }) {
    const questionHint = help(`${questionKeysHint(draft)} ${ASK_ABOUT}`);
    questionHint.id = 'jeved_sensor_hint';
    const wording = help('');
    wording.id = 'jeved_sensor_wording';
    const reads = readsBlock(preset, draft, saved, api);

    const paintWording = () => {
        const found = legacyReference(draft);
        wording.textContent = found ? `This wording still uses the old name ${found}.` : '';
        wording.hidden = !found;
    };
    const touch = () => {
        questionHint.textContent = `${questionKeysHint(draft)} ${ASK_ABOUT}`;
        reads.schedule();
        api.markDirty();
    };

    const scale = column('jeved-scale');
    for (let position = 0; position < LEVEL_COUNT; position++) {
        scale.append(row(
            text('span', 'jeved-scale-badge', String(position)),
            area(draft.levels[position], '', 2, value => {
                draft.levels[position] = value;
                paintWording();
                api.markDirty();
            }),
        ));
    }

    const turnsField = field('number', draft.turns, '', value => { draft.turns = value; touch(); }, {
        min: TURNS.min, max: TURNS.max, step: '1', clamp: value => clampNumber(value, TURNS.min, TURNS.max),
    });
    turnsField.id = 'jeved_sensor_turns';
    const everyField = field('number', draft.measureEvery, '', value => { draft.measureEvery = value; touch(); }, {
        min: TURNS.min, max: TURNS.max, step: '1', clamp: value => clampNumber(value, TURNS.min, TURNS.max),
    });
    everyField.id = 'jeved_sensor_every';
    const contextToggle = toggle(draft.includeContext, 'Send the card and the prompts with this sensor', value => {
        draft.includeContext = value;
        touch();
    });
    contextToggle.id = 'jeved_sensor_context';
    const userToggle = toggle(draft.includeUser, 'Send your own messages with this sensor', value => {
        draft.includeUser = value;
        touch();
    });
    userToggle.id = 'jeved_sensor_user';

    const questionField = area(draft.question, 'How much tension or pressure is in `latest_turn`?', 3, value => {
        draft.question = value;
        paintWording();
        api.markDirty();
    });
    questionField.id = 'jeved_sensor_question';
    paintWording();

    const watchToggle = toggle(draft.watch, 'Measure this sensor when no rule uses it', value => {
        draft.watch = value;
        api.markDirty();
    });
    api.onRefresh(patch => {
        if (patch && 'watch' in patch) {
            watchToggle.checked = !!draft.watch;
        }
    });

    return column(
        'jeved-form',
        formRow('Name', field('text', draft.label, 'Tension', value => { draft.label = value; api.markDirty(); })),
        column(
            'jeved-field-grid',
            formRow('History (replies)', turnsField),
            formRow('Interval (replies)', everyField),
            formRow('Include context', contextToggle),
            formRow('Include my messages', userToggle),
        ),
        reads.element,
        formRow('Question', column('', questionField, questionHint, wording)),
        section('Scale', help('0 means none, and 4 means the most possible.'), scale),
        formRow(
            'Measure anyway',
            watchToggle,
            'Measure this sensor even when no rule uses it, so its scores show in Activity.',
        ),
        testBlock(draft, otherIds, api),
        actions(button('Delete sensor', 'Delete this sensor', async () => {
            if (!saved) {
                return;
            }
            const used = usedBy(preset, saved.id);
            if (used.length) {
                api.problems([`This sensor is used by ${used.map(rule => rule.label || rule.id).join(', ')}. Remove it there first.`]);
                return;
            }
            if (!await ask(`Delete the sensor ${saved.label || saved.id}? This can't be undone.`, { ok: 'Delete' })) {
                return;
            }
            const at = preset.sensors.indexOf(saved);
            if (at < 0) {
                return;
            }
            preset.sensors.splice(at, 1);
            saveSettings();
            host.refreshAll();
        }, { variant: 'danger', icon: 'fa-trash-can' })),
    );
}

export function sensorsTab(host) {
    let preset = getPreset();

    const controller = masterDetail({
        newLabel: 'New sensor',
        caption: 'Measured 0 to 4',
        emptyText: 'No sensors yet.',
        pickText: 'Pick a sensor, or add one.',
        items: () => preset.sensors,
        identity: () => preset,
        blankDraft: () => ({ ...blankSensor(''), watch: true }),
        draftOf: item => structuredClone(item),
        beforeRows: () => latestScores(currentChat(), preset.sensors.map(sensor => sensor.id)),
        rowOf: (sensor, index, api, latest) => {
            const line = node('div', 'jeved-sensor-row');
            const used = usedBy(preset, sensor.id).filter(rule => rule.enabled);
            const names = used.map(rule => rule.label || rule.id).join(', ');
            line.append(
                text('span', 'jeved-sensor-name', sensorLabel(preset.sensors, sensor.id)),
                text('span', 'jeved-sensor-score', scoreText(latest[sensor.id], '')),
                text('span', 'jeved-sensor-note', `${readsTag(sensor)} · ${names ? `Used by: ${names}` : 'Unused'}`),
            );
            if (!used.length) {
                const watch = checkbox('Measure anyway', sensor.watch, value => {
                    sensor.watch = value;
                    saveSettings();
                    api.listChanged(sensor.id, { watch: value });
                });
                watch.classList.add('jeved-list-keep', 'jeved-sensor-watch');
                line.append(watch);
            }
            return line;
        },
        paneOf: (draft, api, selected) => sensorPane(preset, draft, api, host, selected),
        save: (draft, { index, otherIds }) => {
            const candidate = candidateSensor(draft, otherIds);
            const problems = sensorProblems(candidate);
            if (problems.length) {
                return { problems, id: '' };
            }
            if (index >= 0) {
                Object.assign(preset.sensors[index], draft);
            } else {
                preset.sensors.push(candidate);
            }
            normalisePreset(preset);
            saveSettings();
            return { problems: [], id: candidate.id };
        },
        afterSave: async (id, wasNew, api) => {
            host.refreshOthers();
            if (!wasNew) {
                return;
            }
            const plan = planMeasurement({ sensorId: id });
            const stopped = measureBlockReason();
            const bar = toolbar();
            if (plan.calls) {
                const measure = button(`Measure this chat (${plan.calls} API calls)`, stopped || 'Measure the replies in this chat', async () => {
                    if (measureBlockReason()) {
                        return;
                    }
                    busy(measure, true);
                    const counts = await rescan(plan.tasks);
                    busy(measure, false);
                    api.setNotice(null);
                    toast(counts.failed ? 'warning' : 'success', rescanSentence(counts));
                    host.refreshOthers();
                });
                bar.append(withReason(measure, stopped));
            }
            bar.append(button('New rule from this sensor', 'Add a rule that reads this sensor', () => {
                api.setNotice(null);
                return host.newRuleFrom(id);
            }));
            bar.append(note('Earlier replies have no scores until you measure them.'));
            api.setNotice(bar);
        },
    });

    return {
        element: controller.element,
        refresh() {
            preset = getPreset();
            controller.refresh();
        },
        leave: controller.leave,
        dispose: controller.dispose,
    };
}
