import { ACTIONS, DEFAULT_ACTION, REROLL, actionOf } from '../actions.js';
import { blankRule } from '../defaults.js';
import { RULE_COOLDOWN, RULE_COUNTS } from '../limits.js';
import { bandText, excerpt, findSensor, gaugeFor, previewSentence, ruleBrief, ruleLabel, ruleProblem, ruleSummary, sensorLabel } from '../describe.js';
import { evaluationContext, historyStamp, lastDecision, measuredCount, scriptParser } from '../engine.js';
import { checkScript, slugId, validatePreset } from '../presets.js';
import { explain, replayRule } from '../rules.js';
import { carryForwardIds } from '../sensors.js';
import { getPreset, normalisePreset, saveSettings } from '../settings.js';
import { currentChat, getHistory } from '../store.js';
import { ask } from './dialogs.js';
import { actions, area, button, clampNumber, column, field, fold, formRow, gauge, help, iconButton, node, picker, resultsBox, row, section, segmented, slider, text, toggle, withReason } from './dom.js';
import { masterDetail } from './master.js';

const PREVIEW_TURNS = 50;
const PREVIEW_DELAY = 250;

const OP_OPTIONS = [{ value: 'below', label: 'is below' }, { value: 'above', label: 'is above' }];
const ACTION_OPTIONS = ACTIONS.map(action => ({ value: action.id, label: action.label }));
function sensorOptions(preset) {
    return preset.sensors.map(sensor => ({
        value: sensor.id,
        label: sensorLabel(preset.sensors, sensor.id),
    }));
}

function ruleState(preset) {
    return {
        ...evaluationContext(currentChat(), preset),
        labels: Object.fromEntries(preset.sensors.map(sensor => [sensor.id, sensorLabel(preset.sensors, sensor.id)])),
        lastFired: (lastDecision()?.fired ?? []).map(entry => entry.rule),
    };
}

function candidateRule(draft, preset, taken) {
    const candidate = structuredClone(draft);
    candidate.id = candidate.id || slugId(candidate.label || 'rule', taken);
    normalisePreset({ description: '', sensors: preset.sensors, rules: [candidate], gap: 0, maxNudges: 1 });
    return candidate;
}

function conditionRow(preset, condition, onChange, onRemove) {
    const block = column('jeved-condition');
    const band = help('');
    const paintBand = () => {
        band.textContent = bandText(findSensor(preset.sensors, condition.sensor), condition.value);
    };
    const line = row(
        picker(sensorOptions(preset), condition.sensor, value => {
            condition.sensor = value;
            paintBand();
            onChange();
        }),
        picker(OP_OPTIONS, condition.op, value => {
            condition.op = value;
            onChange();
        }),
        slider(condition.value, value => {
            condition.value = value;
            paintBand();
            onChange();
        }, { label: 'Threshold' }),
        onRemove ? iconButton('fa-xmark', 'Remove this condition', onRemove) : null,
    );
    paintBand();
    block.append(line, band);
    return block;
}

function previewBlock(preset, saved, api, currentDraft) {
    const sentence = text('div', 'jeved-preview-line', '');
    const meter = node('div', 'jeved-preview-gauge');
    const box = resultsBox({ clearable: false });
    const turns = fold('Show replies', box.element);
    let stamp = '';
    let histories = {};
    let savedTurns = null;

    const historyFor = action => {
        const known = actionOf(action) ?? actionOf(DEFAULT_ACTION);
        histories[known.id] ??= getHistory(currentChat(), currentChat().length, known.usesCarriedScores ? carryForwardIds(preset) : []);
        return histories[known.id];
    };

    const replay = rule => replayRule({
        history: historyFor(rule.action),
        rule,
        sensorIds: preset.sensors.map(sensor => sensor.id),
        gap: preset.gap,
    });

    const reread = () => {
        const now = historyStamp();
        if (now === stamp) {
            return;
        }
        stamp = now;
        histories = {};
        savedTurns = saved ? replay(saved) : null;
    };

    const paint = () => {
        reread();
        const candidate = currentDraft();
        const draftTurns = replay(candidate);
        sentence.textContent = previewSentence(savedTurns, draftTurns, measuredCount());
        meter.replaceChildren(formRow(
            'Latest score against the threshold',
            gauge(gaugeFor(candidate, historyFor(candidate.action))),
        ));
        const shown = draftTurns.slice(-PREVIEW_TURNS);
        box.show('', shown.map(turn => ({ index: turn.index, text: excerpt(currentChat()[turn.index]?.mes) })));
        if (draftTurns.length > shown.length) {
            box.foot(`and ${draftTurns.length - shown.length} earlier`);
        }
        turns.hidden = !draftTurns.length;
    };

    const schedule = SillyTavern.libs.lodash.debounce(paint, PREVIEW_DELAY);

    api.onClose(() => schedule.cancel());
    api.onRefresh(() => {
        if (historyStamp() !== stamp) {
            schedule();
        }
    });
    paint();
    return { element: section('Preview', sentence, meter, turns), schedule };
}

function rulePane(preset, draft, api, host, { saved, otherIds }, move) {
    const conditions = node('div', 'jeved-conditions');
    const trigger = node('div', 'jeved-trigger');
    const scriptNote = help('');
    const summary = help('');
    summary.classList.add('jeved-rule-recap');
    let preview = null;
    const paintSummary = () => {
        summary.textContent = ruleSummary(draft, preset.sensors);
    };
    const touch = () => {
        paintSummary();
        api.markDirty();
        preview?.schedule();
    };

    const drawConditions = () => {
        conditions.replaceChildren(...draft.conditions.map((condition, position) => conditionRow(
            preset,
            condition,
            touch,
            draft.conditions.length > 1
                ? () => {
                    draft.conditions.splice(position, 1);
                    drawConditions();
                    touch();
                }
                : null,
        )));
    };

    const drawTrigger = () => {
        const windowField = field('number', draft.window, '', value => { draft.window = value; touch(); }, {
            min: 1, step: '1', clamp: value => clampNumber(value, RULE_COUNTS.min, RULE_COUNTS.max),
        });
        const needField = field('number', draft.need, '', value => { draft.need = value; touch(); }, {
            min: RULE_COUNTS.min, step: '1', clamp: value => clampNumber(value, RULE_COUNTS.min, draft.window),
        });
        trigger.replaceChildren(row(
            text('span', 'jeved-inline-label', 'Trigger when'),
            needField,
            text('span', 'jeved-inline-label', 'of last'),
            windowField,
            text('span', 'jeved-inline-label', 'replies match'),
        ));
    };

    const unlessBlock = node('div', 'jeved-unless');
    const drawUnless = () => {
        const children = [row(
            toggle(!!draft.skipWhen?.sensor, 'Skip this rule when the latest reply matches', value => {
                draft.skipWhen = value ? { sensor: preset.sensors[0]?.id ?? '', op: 'above', value: 2 } : null;
                drawUnless();
                touch();
            }),
            text('span', 'jeved-inline-label', 'Skip this rule when'),
        )];
        if (draft.skipWhen?.sensor) {
            children.push(conditionRow(preset, draft.skipWhen, touch, null));
        }
        unlessBlock.replaceChildren(...children);
    };

    drawConditions();
    drawTrigger();
    drawUnless();
    paintSummary();
    scriptNote.textContent = checkScript(draft.script, scriptParser());
    preview = previewBlock(preset, saved, api, () => candidateRule(draft, preset, otherIds));

    const instruction = area(draft.directive, '(OOC: ...)', 4, value => { draft.directive = value; touch(); });
    const actionPicker = segmented(ACTION_OPTIONS, draft.action, value => {
        draft.action = value;
        if (value === REROLL) {
            draft.need = 1;
            draft.window = 1;
            drawTrigger();
        }
        touch();
    });

    const remove = button('Delete rule', 'Delete this rule', async () => {
        if (!saved || !await ask(`Delete the rule ${saved.label || saved.id}? This can't be undone.`, { ok: 'Delete' })) {
            return;
        }
        const at = preset.rules.indexOf(saved);
        if (at < 0) {
            return;
        }
        preset.rules.splice(at, 1);
        saveSettings();
        host.refreshAll();
    }, { variant: 'danger', icon: 'fa-trash-can' });

    const bar = actions();
    const drawBar = () => {
        const at = saved ? preset.rules.indexOf(saved) : -1;
        const unsaved = at < 0 ? 'Save this rule first.' : '';
        bar.replaceChildren(
            withReason(
                button('Move up', 'Move this rule up the list', () => move(at, -1), { icon: 'fa-chevron-up' }),
                unsaved || (at === 0 ? 'This rule is already first.' : ''),
            ),
            withReason(
                button('Move down', 'Move this rule down the list', () => move(at, 1), { icon: 'fa-chevron-down' }),
                unsaved || (at >= preset.rules.length - 1 ? 'This rule is already last.' : ''),
            ),
            remove,
        );
    };
    drawBar();
    api.onRefresh(drawBar);

    const body = column(
        'jeved-form',
        summary,
        formRow('Name', field('text', draft.label, 'Flat', value => { draft.label = value; api.markDirty(); })),
        section(
            'When',
            conditions,
            actions(button('Add condition', 'Add another condition', () => {
                draft.conditions.push({ sensor: preset.sensors[0]?.id ?? '', op: 'below', value: 2 });
                drawConditions();
                touch();
            }, { icon: 'fa-plus' })),
            trigger,
        ),
        section(
            'Then',
            formRow('Action', actionPicker),
            formRow('Instruction (OOC)', instruction, "Describe the result you want in the story. Don't mention scores or Jeved."),
        ),
        fold(
            'More options',
            formRow('Exception', unlessBlock, "If the latest reply matches this, the rule won't fire that turn."),
            formRow('Cooldown (replies)', field('number', draft.cooldown, '0', value => { draft.cooldown = value; touch(); }, {
                min: RULE_COOLDOWN.min, step: RULE_COOLDOWN.step, clamp: value => clampNumber(value, RULE_COOLDOWN.min, RULE_COOLDOWN.max),
            }), "After this rule fires, it waits this many replies before it can fire again. Other rules aren't affected."),
            formRow('Script (STscript)', column(
                '',
                area(draft.script, '/echo the rule fired', 3, value => {
                    draft.script = value;
                    scriptNote.textContent = checkScript(value, scriptParser());
                    paintSummary();
                    api.markDirty();
                }),
                scriptNote,
            ), 'The script runs when the rule fires, and Jeved allows only a short list of commands, so /gen, /trigger and /swipe are refused.'),
        ),
        preview.element,
        bar,
    );
    return body;
}

export function rulesTab(host) {
    let preset = getPreset();

    const move = (index, step) => {
        const rules = preset.rules;
        if (index + step < 0 || index + step >= rules.length) {
            return;
        }
        rules.splice(index + step, 0, rules.splice(index, 1)[0]);
        saveSettings();
        controller.refresh();
    };

    const controller = masterDetail({
        newLabel: 'New rule',
        caption: 'Priority: top first',
        emptyText: 'No rules yet.',
        pickText: 'Pick a rule, or add one.',
        items: () => preset.rules,
        identity: () => preset,
        blankDraft: seed => ({ ...blankRule('', seed || preset.sensors[0]?.id || ''), enabled: true }),
        draftOf: item => structuredClone(item),
        beforeRows: () => ruleState(preset),
        rowOf: (rule, index, api, evaluation) => {
            const status = explain(rule, { ...evaluation, history: evaluation.historyFor(rule.action) });
            const line = node('div', 'jeved-rule-row');
            const switcher = toggle(rule.enabled, 'Turn this rule on or off', value => {
                rule.enabled = value;
                saveSettings();
                api.listChanged(rule.id, { enabled: value });
            });
            switcher.classList.add('jeved-list-keep');
            const state = text('span', `jeved-rule-status jeved-rule-status--${status.kind}`, status.text);
            state.title = status.detail;
            line.append(
                switcher,
                text('span', 'jeved-rule-name', ruleLabel(preset.rules, rule.id)),
                state,
                text('span', 'jeved-rule-note', ruleBrief(rule, preset.sensors)),
            );
            return line;
        },
        paneOf: (draft, api, selected) => rulePane(preset, draft, api, host, selected, move),
        save: (draft, { index, otherIds }) => {
            const problems = validatePreset(
                { sensors: preset.sensors, rules: [candidateRule(draft, preset, otherIds)] },
                { parse: scriptParser() },
            ).filter(problem => problem.startsWith('rule')).map(ruleProblem);
            if (!String(draft.label ?? '').trim()) {
                problems.unshift('The rule needs a name.');
            }
            if (problems.length) {
                return { problems, id: '' };
            }
            const candidate = candidateRule(draft, preset, otherIds);
            if (index >= 0) {
                candidate.id = preset.rules[index].id;
                Object.assign(preset.rules[index], candidate);
            } else {
                preset.rules.push(candidate);
            }
            normalisePreset(preset);
            saveSettings();
            return { problems: [], id: candidate.id };
        },
        afterSave: () => host.refreshOthers(),
    });

    return {
        element: controller.element,
        refresh() {
            preset = getPreset();
            controller.refresh();
        },
        leave: controller.leave,
        startNew: controller.startNew,
        dispose: controller.dispose,
    };
}
