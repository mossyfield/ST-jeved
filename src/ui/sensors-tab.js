import { blankSensor } from '../defaults.js';
import { excerpt, listPhrase, momentLine, momentTag, questionKeysHint, rescanSentence, sensorProblem, tokenWords } from '../describe.js';
import { describeError, measureBlockReason, planMeasurement, rescan, testIndices, testSensor } from '../engine.js';
import { buildContext, countTokens } from '../instructions.js';
import { LEVELS, MESSAGES, OPTIONS } from '../limits.js';
import { legacyReference, renameOption, slugId, validatePreset } from '../presets.js';
import { CHOICE, NOUL, SENSOR_TYPES, sensorLabel, typeOf, valueText } from '../sensor-types.js';
import { buildRequest, groupKeyOf, groupSensors, missesReplySensor, momentCount, momentOf, momentWord } from '../sensors.js';
import { getPreset, getSettings, normalisePreset, saveSettings } from '../settings.js';
import { currentChat, latestScores } from '../store.js';
import { toast } from '../toast.js';
import { isRecord } from '../util.js';
import { actions, area, busy, button, column, detach, field, formRow, help, iconButton, node, note, resultsBox, row, section, segmented, setLabel, slider, text, toggle, toolbar, withReason } from './dom.js';
import { ask } from './dialogs.js';
import { masterDetail } from './master.js';

const TEST_REPLIES = 10;
const CROWDED = 30000;
const READS_DELAY = 250;
const SPREAD_ALL = 10;
const SPREAD_TOP = 5;
const COUNT_RANGE = { min: MESSAGES.min, max: MESSAGES.max, step: 1, decimals: 0 };

const TYPE_OPTIONS = SENSOR_TYPES.map(type => ({ value: type.id, label: type.label }));

function usedBy(preset, id, match = () => true) {
    return preset.rules.filter(rule => [...rule.conditions, rule.skipWhen]
        .some(condition => condition?.sensor === id && match(condition)));
}

function ruleNames(rules) {
    return rules.map(rule => rule.label || rule.id).join(', ');
}

export function optionNames(sensor) {
    return new Map((sensor?.options ?? []).map(option => [option, String(option.name ?? '').trim()]));
}

export function optionChanges(before, draft) {
    const renames = new Map();
    const kept = new Set();
    for (const option of draft?.options ?? []) {
        const was = before.get(option);
        if (was === undefined) {
            continue;
        }
        kept.add(was);
        const now = String(option.name ?? '').trim();
        if (was && now && now !== was) {
            renames.set(was, now);
        }
    }
    const removed = [...new Set(before.values())].filter(name => name && !kept.has(name));
    return { renames, removed };
}

function momentBreaks(preset, saved, candidate) {
    const sensors = preset.sensors.map(sensor => (sensor.id === saved.id ? candidate : sensor));
    return usedBy(preset, saved.id).filter(rule => missesReplySensor(rule, sensors));
}

export function changeProblems(preset, saved, candidate, changes) {
    const used = usedBy(preset, saved.id);
    if (!used.length) {
        return [];
    }
    const problems = [];
    if (typeOf(candidate).id !== typeOf(saved).id) {
        problems.push(`This sensor is used by ${ruleNames(used)}, so its type can't change. Change those rules first.`);
    }
    const broken = momentBreaks(preset, saved, candidate);
    if (broken.length) {
        problems.push(`This sensor is used by ${ruleNames(broken)}, which needs a sensor that reads an assistant message. Change those rules first.`);
    }
    for (const name of changes.removed) {
        const holders = usedBy(preset, saved.id, condition => condition.value === name);
        if (holders.length) {
            problems.push(`The option ${name} is used by ${ruleNames(holders)}. Change those rules first.`);
        }
    }
    return problems;
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

export function spreadText(probabilities) {
    if (!isRecord(probabilities)) {
        return '';
    }
    const shares = Object.entries(probabilities)
        .filter(([, share]) => typeof share === 'number' && Number.isFinite(share))
        .sort((one, other) => other[1] - one[1]);
    const shown = shares.length > SPREAD_ALL ? shares.slice(0, SPREAD_TOP) : shares;
    const words = shown.map(([name, share]) => `${name} ${Math.round(share * 100)}%`).join(', ');
    const rest = shares.length - shown.length;
    return rest ? `${words} and ${rest} more` : words;
}

function testNote(row) {
    const parts = [];
    if (typeof row.confidence === 'number') {
        parts.push(`${Math.round(row.confidence * 100)}% confident`);
    }
    const spread = spreadText(row.probabilities);
    if (spread) {
        parts.push(spread);
    }
    return parts.join(' · ');
}

function testBlock(draft, takenIds, api) {
    const moment = () => momentOf(draft);
    const count = () => testIndices(draft, TEST_REPLIES).length;
    const nothing = () => `This chat has no ${momentWord(moment())} to test yet.`;
    const caption = () => (count()
        ? `Test on last ${momentCount(moment(), count())} (${count()} API calls)`
        : 'Test');
    const scored = rows => rows.filter(row => !row.error).map(row => ({
        index: row.index,
        tag: valueText(draft, row.value, ''),
        note: testNote(row),
        text: excerpt(row.text),
        full: String(row.text ?? ''),
    }));
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
            box.show(`Answers for the last ${momentCount(moment(), rows.length)}`, rows, 'Nothing was measured.');
            const failed = collected.find(row => row.error);
            if (failed) {
                box.warn(failed.error);
            }
            box.foot("These answers aren't saved.");
        } catch (error) {
            box.fail(describeError(error));
        } finally {
            controller = null;
            paint();
        }
    });

    function paint() {
        const blocked = measureBlockReason();
        run.title = blocked || 'Measure the recent replies with this wording';
        hint.textContent = blocked || (count() ? '' : nothing());
        if (controller) {
            return;
        }
        busy(run, !count() || !!blocked);
        setLabel(run, caption());
    }

    paint();
    api.onRefresh(paint);
    api.onClose(() => controller?.abort());
    return { element: section('Test', toolbar(run, hint), box.element), paint };
}

async function requestTokens(draft, preset) {
    const settings = getSettings();
    let total = 0;
    if (draft.context) {
        const built = await buildContext(preset.contextGroups, settings.instructionsCap);
        if (built.total === null) {
            return null;
        }
        total += built.total;
    }
    const chat = currentChat();
    const [latest] = testIndices(draft, 1);
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
        const parts = [];
        if (tokens !== null) {
            parts.push(`${tokenWords(tokens)}.`);
        }
        if (others.length) {
            parts.push(`Shares a call with ${listPhrase(others)}.`);
        }
        line.textContent = parts.join(' ');
        crowded.hidden = tokens === null || tokens <= CROWDED;
        crowded.textContent = crowded.hidden ? '' : "That is close to Jev's 32,000 token limit, so the call may return no answers.";
    }

    const schedule = SillyTavern.libs.lodash.debounce(() => detach(paint()), READS_DELAY);
    api.onClose(() => schedule.cancel());
    detach(paint());
    return { element: formRow('Call size', column('', line, crowded)), schedule };
}

function levelRows(draft, redraw, onChange) {
    return draft.levels.map((level, position) => row(
        text('span', 'jeved-scale-badge', String(position)),
        area(level, '', 2, value => {
            draft.levels[position] = value;
            onChange();
        }),
        draft.levels.length > LEVELS.min
            ? iconButton('fa-xmark', 'Remove this score', () => {
                draft.levels.splice(position, 1);
                redraw();
                onChange();
            })
            : null,
    ));
}

function optionRows(draft, redraw, onChange) {
    return draft.options.map((option, position) => row(
        field('text', option.name, 'calm', value => {
            option.name = value;
            onChange();
        }),
        area(option.description, 'When the reply fits this option.', 2, value => {
            option.description = value;
            onChange();
        }),
        draft.options.length > OPTIONS.min
            ? iconButton('fa-xmark', 'Remove this option', () => {
                draft.options.splice(position, 1);
                redraw();
                onChange();
            })
            : null,
    ));
}

function answerRows(draft, onChange) {
    return ['No', 'Yes'].map((word, position) => row(
        text('span', 'jeved-scale-word', word),
        area(draft.levels[position] ?? '', '', 2, value => {
            draft.levels[position] = value;
            onChange();
        }),
    ));
}

function seedScale(draft) {
    if (typeOf(draft).id === CHOICE) {
        while (draft.options.length < OPTIONS.min) {
            draft.options.push({ name: '', description: '' });
        }
        return;
    }
    while (draft.levels.length < LEVELS.min) {
        draft.levels.push('');
    }
}

function scaleBlock(draft, onChange) {
    const block = node('div', 'jeved-scale-block');
    const draw = () => {
        seedScale(draft);
        const type = typeOf(draft);
        const scale = column('jeved-scale');
        const children = [scale];
        if (type.id === CHOICE) {
            scale.append(...optionRows(draft, draw, onChange));
            if (draft.options.length < OPTIONS.max) {
                children.push(actions(button('Add option', 'Add another option', () => {
                    draft.options.push({ name: '', description: '' });
                    draw();
                    onChange();
                }, { icon: 'fa-plus' })));
            }
        } else if (type.id === NOUL) {
            scale.append(...answerRows(draft, onChange));
        } else {
            scale.append(...levelRows(draft, draw, onChange));
            if (draft.levels.length < LEVELS.max) {
                children.push(actions(button('Add score', 'Add another score description', () => {
                    draft.levels.push('');
                    draw();
                    onChange();
                }, { icon: 'fa-plus' })));
            }
        }
        block.replaceChildren(section(type.scaleTitle, ...children));
    };
    draw();
    return { element: block, draw };
}

function sensorPane(preset, draft, api, host, { saved, otherIds }) {
    const questionHint = help(questionKeysHint(draft));
    questionHint.id = 'jeved_sensor_hint';
    const wording = help('');
    wording.id = 'jeved_sensor_wording';
    const reads = readsBlock(preset, draft, saved, api);
    const askRow = node('div', 'jeved-ask-row');
    const typeAbout = help(typeOf(draft).about);
    const runsLine = help(momentLine(draft));
    runsLine.id = 'jeved_sensor_runs';
    const test = testBlock(draft, otherIds, api);

    const paintWording = () => {
        const found = legacyReference(draft);
        wording.textContent = found ? `This wording still uses the old name ${found}.` : '';
        wording.hidden = !found;
    };
    const touch = () => {
        questionHint.textContent = questionKeysHint(draft);
        runsLine.textContent = momentLine(draft);
        test.paint();
        reads.schedule();
        api.markDirty();
    };

    const scale = scaleBlock(draft, () => {
        paintWording();
        api.markDirty();
    });
    const typeControl = segmented(TYPE_OPTIONS, typeOf(draft).id, value => {
        draft.type = value;
        typeAbout.textContent = typeOf(draft).about;
        drawAsk();
        scale.draw();
        api.markDirty();
    });
    typeControl.id = 'jeved_sensor_type';

    const userSlider = slider(draft.user, value => { draft.user = value; touch(); }, {
        range: COUNT_RANGE, label: 'User messages',
    });
    userSlider.id = 'jeved_sensor_user';
    const assistantSlider = slider(draft.assistant, value => { draft.assistant = value; touch(); }, {
        range: COUNT_RANGE, label: 'Assistant messages',
    });
    assistantSlider.id = 'jeved_sensor_assistant';
    const contextToggle = toggle(draft.context, 'Send the card and the prompts with this sensor', value => {
        draft.context = value;
        touch();
    });
    contextToggle.id = 'jeved_sensor_context';

    function drawAsk() {
        const type = typeOf(draft);
        const questionField = area(draft.question, type.askPlaceholder, 3, value => {
            draft.question = value;
            paintWording();
            api.markDirty();
        });
        questionField.id = 'jeved_sensor_question';
        askRow.replaceChildren(formRow(type.askTitle, column('', questionField, questionHint, wording)));
    }
    drawAsk();
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
        formRow('Type', column('', typeControl, typeAbout)),
        column(
            'jeved-field-grid',
            formRow('User messages', userSlider),
            formRow('Assistant messages', assistantSlider),
            formRow('Context', contextToggle, 'The card and your prompts.'),
        ),
        runsLine,
        reads.element,
        askRow,
        scale.element,
        formRow(
            'Measure anyway',
            watchToggle,
            'Measure this sensor even when no rule uses it, so its answers show in Activity.',
        ),
        test.element,
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
    let openNames = new Map();

    const controller = masterDetail({
        newLabel: 'New sensor',
        caption: '',
        emptyText: 'No sensors yet.',
        pickText: 'Pick a sensor, or add one.',
        items: () => preset.sensors,
        identity: () => preset,
        blankDraft: () => ({ ...blankSensor(''), watch: true }),
        draftOf: item => structuredClone(item),
        beforeRows: () => {
            const chat = currentChat();
            return latestScores(chat, preset.sensors.map(sensor => sensor.id), chat.length, preset.sensors);
        },
        rowOf: (sensor, index, api, latest) => {
            const line = node('div', 'jeved-sensor-row');
            const used = usedBy(preset, sensor.id).filter(rule => rule.enabled);
            const names = ruleNames(used);
            line.classList.toggle('jeved-list-row--off', !used.length && !sensor.watch);
            line.title = names ? `Used by: ${names}` : (sensor.watch ? 'Measured, no rule uses it' : 'Not measured');
            line.append(
                text('span', 'jeved-sensor-name', sensorLabel(preset.sensors, sensor.id)),
                text('span', 'jeved-sensor-score', valueText(sensor, latest[sensor.id], '')),
                text('span', 'jeved-sensor-note', [typeOf(sensor).caption(sensor), momentTag(momentOf(sensor))].join(' · ')),
            );
            return line;
        },
        paneOf: (draft, api, selected) => {
            openNames = optionNames(draft);
            return sensorPane(preset, draft, api, host, selected);
        },
        save: (draft, { index, otherIds }) => {
            const candidate = candidateSensor(draft, otherIds);
            const saved = index >= 0 ? preset.sensors[index] : null;
            const changes = optionChanges(openNames, draft);
            const problems = [
                ...sensorProblems(candidate),
                ...(saved ? changeProblems(preset, saved, candidate, changes) : []),
            ];
            if (problems.length) {
                return { problems, id: '' };
            }
            if (saved) {
                renameOption(preset.rules, saved.id, changes.renames);
                Object.assign(saved, candidate);
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
            bar.append(note('Earlier replies have no answers until you measure them.'));
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
