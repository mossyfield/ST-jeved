import { ACTIONS, ruleAction } from '../actions.js';
import { blankRule } from '../defaults.js';
import { CONFIDENCE, RULE_COOLDOWN, RULE_COUNTS } from '../limits.js';
import { bandText, excerpt, momentTag, previewSentence, ruleLabel, ruleMomentNote, ruleProblem, ruleSummary } from '../describe.js';
import { evaluationContext, historiesFor, historyStamp, lastDecision, measuredCount, scriptParser } from '../engine.js';
import { checkScript, slugId, validatePreset } from '../presets.js';
import { conditionHolds, explain, replayRule, scoreOf } from '../rules.js';
import { findSensor, opOf, rangeOf, seedCondition, sensorLabel, typeOf, valueText } from '../sensor-types.js';
import { latestWords, momentOfRule, momentWord } from '../sensors.js';
import { getPreset, normalisePreset, saveSettings } from '../settings.js';
import { currentChat } from '../store.js';
import { ask } from './dialogs.js';
import { actions, area, button, clampNumber, column, field, fold, formRow, help, iconButton, node, picker, resultsBox, row, section, segmented, slider, tag, text, toggle, withReason } from './dom.js';
import { masterDetail } from './master.js';

const PREVIEW_TURNS = 50;
const PREVIEW_DELAY = 250;

const ACTION_OPTIONS = ACTIONS.map(action => ({ value: action.id, label: action.label }));
function sensorOptions(preset) {
    return preset.sensors.map(sensor => ({
        value: sensor.id,
        label: sensorLabel(preset.sensors, sensor.id),
    }));
}

function opOptions(type) {
    return type.ops.map(id => ({ value: id, label: opOf(id).label }));
}

function valueOptions(sensor) {
    return (sensor?.options ?? [])
        .map(option => String(option?.name ?? '').trim())
        .filter(name => name)
        .map(name => ({ value: name, label: name }));
}

function ruleState(preset) {
    return {
        ...evaluationContext(currentChat(), preset),
        lastFired: (lastDecision()?.fired ?? []).map(entry => entry.rule),
    };
}

function candidateRule(draft, preset, taken) {
    const candidate = structuredClone(draft);
    candidate.id = candidate.id || slugId(candidate.label || 'rule', taken);
    normalisePreset({ description: '', sensors: preset.sensors, rules: [candidate] });
    return candidate;
}

function rowStatus(status) {
    return status.kind === 'fire' && status.text !== 'Fired' ? 'Firing' : status.text;
}

function rowNote(rule, sensors, latest) {
    const ids = [...new Set((rule.conditions ?? []).map(condition => condition?.sensor).filter(id => id))];
    const values = ids.map(id => {
        const value = valueText(findSensor(sensors, id), scoreOf(latest, id), '');
        return value ? `${sensorLabel(sensors, id)} ${value}` : sensorLabel(sensors, id);
    });
    return [ruleAction(rule)?.shortLabel ?? rule.action, ...values].join(' · ');
}

function momentChip(rule, sensors) {
    const moment = momentOfRule(rule, sensors);
    return tag(momentTag(moment), '', ruleMomentNote(moment, ruleAction(rule)?.phase));
}

export function conditionRow(preset, condition, onChange, onRemove) {
    const block = column('jeved-condition');
    const line = row();
    const band = help('');
    const confidence = node('div', 'jeved-condition-sure');
    const sensorOf = () => findSensor(preset.sensors, condition.sensor);

    const paintBand = () => {
        band.textContent = bandText(sensorOf(), condition.value);
    };

    const valueControl = sensor => {
        const range = rangeOf(sensor);
        if (!range) {
            return picker(valueOptions(sensor), condition.value, value => {
                condition.value = value;
                paintBand();
                onChange();
            });
        }
        return slider(condition.value, value => {
            condition.value = value;
            paintBand();
            onChange();
        }, { range, label: range.percent ? 'Threshold (%)' : 'Threshold' });
    };

    const drawConfidence = () => {
        const type = typeOf(sensorOf());
        if (!type.hasConfidence) {
            condition.minConfidence = null;
            confidence.replaceChildren();
            return;
        }
        const on = condition.minConfidence !== null && condition.minConfidence !== undefined;
        const line = row(
            toggle(on, 'Match only when Jev is this sure', value => {
                condition.minConfidence = value ? CONFIDENCE.fallback : null;
                drawConfidence();
                onChange();
            }),
            text('span', 'jeved-inline-label', 'Minimum confidence (%)'),
            on
                ? slider(condition.minConfidence, value => {
                    condition.minConfidence = value;
                    onChange();
                }, { range: CONFIDENCE, label: 'Minimum confidence (%)' })
                : null,
        );
        confidence.replaceChildren(line, ...(on
            ? [help('Jev reports how strongly it favoured its answer over the others, and this condition ignores answers below that level.')]
            : []));
    };

    const draw = () => {
        const sensor = sensorOf();
        line.replaceChildren(...[
            picker(sensorOptions(preset), condition.sensor, value => {
                Object.assign(condition, seedCondition(findSensor(preset.sensors, value)));
                draw();
                onChange();
            }),
            picker(opOptions(typeOf(sensor)), condition.op, value => {
                condition.op = value;
                onChange();
            }),
            valueControl(sensor),
            onRemove ? iconButton('fa-xmark', 'Remove this condition', onRemove) : null,
        ].filter(child => child));
        paintBand();
        drawConfidence();
    };

    draw();
    block.append(line, band, confidence);
    return block;
}

export function latestLines(rule, latest, sensors) {
    return (rule?.conditions ?? [])
        .filter(condition => condition?.sensor)
        .map(condition => {
            const value = scoreOf(latest, condition.sensor);
            const words = `${sensorLabel(sensors, condition.sensor)}: ${valueText(findSensor(sensors, condition.sensor), value)}`;
            return { words, match: value === null ? '' : conditionHolds(latest, condition) ? 'Matches' : 'Does not match' };
        });
}

function previewBlock(preset, saved, api, currentDraft) {
    const sentence = text('div', 'jeved-preview-line', '');
    const meter = node('div', 'jeved-preview-latest');
    const box = resultsBox({ clearable: false });
    const turns = fold('Show replies', box.element);
    let stamp = '';
    let historyOf = null;
    let savedTurns = null;

    const replay = rule => replayRule({
        history: historyOf(rule),
        rule,
        sensorIds: preset.sensors.map(sensor => sensor.id),
        sensors: preset.sensors,
    });

    const reread = () => {
        const now = historyStamp();
        if (now === stamp) {
            return;
        }
        stamp = now;
        historyOf = historiesFor(currentChat(), currentChat().length, preset.sensors);
        savedTurns = saved ? replay(saved) : null;
    };

    const paint = () => {
        reread();
        const candidate = currentDraft();
        const draftTurns = replay(candidate);
        sentence.textContent = previewSentence(savedTurns, draftTurns, measuredCount());
        const lines = latestLines(candidate, historyOf(candidate).at(-1) ?? null, preset.sensors);
        meter.replaceChildren(...(lines.length
            ? [formRow('Latest answers', column('', ...lines.map(line => row(
                text('span', 'jeved-readout', line.words),
                line.match ? tag(line.match, line.match === 'Matches' ? 'on' : '') : null,
            ))))]
            : []));
        const shown = draftTurns.slice(-PREVIEW_TURNS);
        box.show('', shown.map(turn => ({
            index: turn.index,
            text: excerpt(currentChat()[turn.index]?.mes),
            full: String(currentChat()[turn.index]?.mes ?? ''),
        })));
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
    const moment = node('div', 'jeved-rule-moment');
    const matchWord = text('span', 'jeved-inline-label', '');
    const unlessHint = help('');
    let preview = null;
    const momentNow = () => momentOfRule(draft, preset.sensors);
    const paintSummary = () => {
        summary.textContent = ruleSummary(draft, preset.sensors);
    };
    const paintMoment = () => {
        moment.replaceChildren(momentChip(draft, preset.sensors));
    };
    const paintWords = () => {
        matchWord.textContent = `${momentWord(momentNow())} match`;
        unlessHint.textContent = `If ${latestWords(momentNow())} matches this, the rule won't fire that turn.`;
    };
    const touch = () => {
        paintSummary();
        paintMoment();
        paintWords();
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
            matchWord,
        ));
    };

    const unlessBlock = node('div', 'jeved-unless');
    const drawUnless = () => {
        const children = [row(
            toggle(!!draft.skipWhen?.sensor, 'Skip this rule when the latest reply matches', value => {
                draft.skipWhen = value ? seedCondition(preset.sensors[0]) : null;
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
    paintWords();
    drawTrigger();
    drawUnless();
    paintSummary();
    paintMoment();
    scriptNote.textContent = checkScript(draft.script, scriptParser());
    preview = previewBlock(preset, saved, api, () => candidateRule(draft, preset, otherIds));

    const instructionRow = formRow(
        'Instruction (OOC)',
        area(draft.directive, '(OOC: ...)', 4, value => { draft.directive = value; touch(); }),
        "Describe the result you want in the story. Don't mention answers or Jeved.",
    );
    const scriptRow = formRow('Script (STscript)', column(
        '',
        area(draft.script, '/echo the rule fired', 3, value => {
            draft.script = value;
            scriptNote.textContent = checkScript(value, scriptParser());
            paintSummary();
            api.markDirty();
        }),
        scriptNote,
    ), 'The script runs on its own when the rule fires, so read it before you turn the rule on.');

    const thenBlock = node('div', 'jeved-then');
    const moreBlock = node('div', 'jeved-more');
    const actionPicker = segmented(ACTION_OPTIONS, draft.action, value => {
        draft.action = value;
        if (ruleAction(draft)?.replacesReply) {
            draft.need = 1;
            draft.window = 1;
            drawTrigger();
        }
        drawThen();
        touch();
    });

    function drawThen() {
        const action = ruleAction(draft);
        const scripted = action?.usesDirective === false;
        thenBlock.replaceChildren(section(
            'Then',
            formRow('Action', actionPicker, action?.about ?? ''),
            scripted ? scriptRow : instructionRow,
        ));
        moreBlock.replaceChildren(fold(
            'More options',
            formRow('Exception', column('', unlessBlock, unlessHint)),
            formRow('Cooldown (replies)', field('number', draft.cooldown, '0', value => { draft.cooldown = value; touch(); }, {
                min: RULE_COOLDOWN.min, step: RULE_COOLDOWN.step, clamp: value => clampNumber(value, RULE_COOLDOWN.min, RULE_COOLDOWN.max),
            }), "After this rule fires, it waits this many replies before it can fire again. Other rules aren't affected."),
            scripted ? null : scriptRow,
        ));
    }
    drawThen();

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
        moment,
        formRow('Name', field('text', draft.label, 'Flat', value => { draft.label = value; api.markDirty(); })),
        section(
            'When',
            conditions,
            actions(button('Add condition', 'Add another condition', () => {
                draft.conditions.push(seedCondition(preset.sensors[0]));
                drawConditions();
                touch();
            }, { icon: 'fa-plus' })),
            trigger,
        ),
        thenBlock,
        moreBlock,
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
        blankDraft: seed => ({ ...blankRule('', findSensor(preset.sensors, seed) ?? preset.sensors[0] ?? null), enabled: true }),
        draftOf: item => structuredClone(item),
        beforeRows: () => ruleState(preset),
        rowOf: (rule, index, api, evaluation) => {
            const status = explain(rule, { ...evaluation, history: evaluation.historyOf(rule) });
            const line = node('div', 'jeved-rule-row');
            const switcher = toggle(rule.enabled, 'Turn this rule on or off', value => {
                rule.enabled = value;
                saveSettings();
                api.listChanged(rule.id, { enabled: value });
            });
            switcher.classList.add('jeved-list-keep');
            const loud = status.kind !== 'idle' && status.kind !== 'busy';
            const state = text('span', `jeved-rule-status jeved-rule-status--${status.kind}`, loud ? rowStatus(status) : '');
            line.title = `${status.text}. ${status.detail}`;
            line.classList.toggle('jeved-list-row--off', !rule.enabled);
            line.classList.toggle('jeved-list-row--fire', rule.enabled && status.kind === 'fire');
            line.append(
                switcher,
                text('span', 'jeved-rule-name', ruleLabel(preset.rules, rule.id)),
                state,
                text('span', 'jeved-rule-note', rowNote(rule, preset.sensors, evaluation.historyOf(rule).at(-1))),
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
