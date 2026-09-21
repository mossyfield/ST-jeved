import { ruleAction } from '../actions.js';
import { listProblem, ruleLabel } from '../describe.js';
import { invalidateMeasured } from '../engine.js';
import { findList, listResolver, presetLists } from '../lists.js';
import { validatePreset } from '../presets.js';
import { repeatOf, sensorLabel } from '../sensor-types.js';
import { getPreset, normalisePreset, saveSettings, schemaProblem } from '../settings.js';
import { actions, area, busy, button, column, detach, field, formRow, help, node, row, text, withReason } from './dom.js';
import { ask } from './dialogs.js';
import { entriesBlock, hasChat } from './entries.js';
import { masterDetail } from './master.js';

const SENSOR_HINT = 'A sensor asks a question for each entry. Pick this list under Repeat over list.';
const RULE_HINT = 'A rule writes to it. Use Add to list.';

function usersOf(preset, name) {
    const wanted = String(name ?? '').trim();
    return [
        ...preset.sensors.filter(sensor => repeatOf(sensor) === wanted)
            .map(sensor => sensorLabel(preset.sensors, sensor.id)),
        ...preset.rules.filter(rule => ruleAction(rule)?.usesList && String(rule.list ?? '').trim() === wanted)
            .map(rule => ruleLabel(preset.rules, rule.id)),
    ];
}

function nameProblems(name, otherIds) {
    const problems = validatePreset({ lists: [{ name, entries: [] }], sensors: [], rules: [] })
        .filter(problem => problem.startsWith('list'))
        .map(listProblem);
    if (!problems.length && otherIds.includes(name)) {
        problems.push('Another list has that name.');
    }
    return problems;
}

function nameRow(draft, saved, api) {
    if (saved) {
        return formRow('Name', text('div', 'jeved-readout', draft.name));
    }
    const control = field('text', draft.name, 'house_rules', value => {
        draft.name = value;
        api.markDirty();
    });
    control.id = 'jeved_list_name';
    control.disabled = !!schemaProblem();
    return formRow('Name', control, 'Lowercase letters, numbers and underscores.');
}

function usedRow(preset, name, host) {
    const used = usersOf(preset, name);
    if (used.length) {
        return formRow('Used by', text('div', 'jeved-readout', used.join(', ')));
    }
    const line = (words, caption, tab) => row(
        help(words),
        button(caption, `Open the ${tab} tab`, () => host.openTab(tab)),
    );
    return formRow('Used by', column(
        'jeved-list-guide',
        text('div', 'jeved-readout', 'Nothing yet.'),
        line(SENSOR_HINT, 'Open Sensors', 'sensors'),
        line(RULE_HINT, 'Open Rules', 'rules'),
    ), '', { wide: true });
}

function listPane(preset, draft, api, host, saved) {
    const name = saved?.list?.name ?? '';
    const here = entriesBlock(preset, () => name, () => {
        here.draw();
        api.refresh();
    });
    here.draw();
    api.onRefresh(() => here.draw());

    const about = area(draft.description, 'What one entry holds.', 2, value => {
        draft.description = value;
        api.markDirty();
    });
    about.id = 'jeved_list_description';
    about.disabled = !!schemaProblem();

    const remove = button('Delete list', 'Delete this list', async () => {
        if (!saved || schemaProblem()) {
            return;
        }
        const used = usersOf(preset, name);
        if (used.length) {
            api.problems([`This list is used by ${used.join(', ')}, so it can't be deleted. Change those first.`]);
            return;
        }
        if (!await ask(`Delete the list ${name}? This can't be undone.`, { ok: 'Delete' })) {
            return;
        }
        preset.lists = presetLists(preset).filter(item => String(item.name ?? '') !== name);
        normalisePreset(preset);
        saveSettings();
        invalidateMeasured();
        host.refreshAll();
    }, { variant: 'danger', icon: 'fa-trash-can' });

    const body = column('jeved-form', nameRow(draft, saved, api));
    if (saved) {
        body.append(
            usedRow(preset, name, host),
            formRow('Entries', here.element, '', { wide: true }),
        );
    }
    body.append(
        formRow('Description', about, 'Tell yourself what one entry holds. End it with an example.'),
        actions(withReason(remove, schemaProblem())),
    );
    return body;
}

export function listsTab(host) {
    let preset = getPreset();
    const views = () => presetLists(preset).map(list => ({ id: String(list.name ?? ''), list }));

    const controller = masterDetail({
        newLabel: 'New list',
        caption: '',
        emptyText: 'No lists yet. A list holds lines that a sensor or a rule can use.',
        pickText: 'Pick a list, or add one.',
        items: views,
        identity: () => preset,
        blankDraft: () => ({ name: '', description: '' }),
        draftOf: item => ({
            name: String(item.list.name ?? ''),
            description: String(item.list.description ?? ''),
        }),
        beforeRows: () => listResolver(preset),
        rowOf: (item, index, api, resolve) => {
            const name = item.list.name;
            const used = usersOf(preset, name);
            const line = node('div', 'jeved-listing-row');
            line.classList.toggle('jeved-list-row--off', !used.length);
            line.title = used.length ? `Used by: ${used.join(', ')}` : 'No sensor or rule uses this list';
            line.append(
                text('span', 'jeved-sensor-name', name),
                text('span', 'jeved-sensor-score', hasChat() ? `${resolve(name).length} entries` : ''),
                text('span', 'jeved-sensor-note', String(item.list.description ?? '') || 'No description'),
            );
            return line;
        },
        paneOf: (draft, api, selected) => listPane(preset, draft, api, host, selected.saved),
        save: (draft, { saved, otherIds }) => {
            const blocked = schemaProblem();
            if (blocked) {
                return { problems: [blocked], id: '' };
            }
            const name = saved ? saved.list.name : String(draft.name ?? '').trim();
            const problems = saved ? [] : nameProblems(name, otherIds);
            if (problems.length) {
                return { problems, id: '' };
            }
            const description = String(draft.description ?? '');
            const target = findList(preset, name);
            if (target) {
                target.description = description;
            } else {
                preset.lists = [...presetLists(preset), { name, description, entries: [] }];
            }
            normalisePreset(preset);
            saveSettings();
            invalidateMeasured();
            return { problems: [], id: name };
        },
        afterSave: () => host.refreshOthers(),
    });

    const adder = controller.element.querySelector('.jeved-list-head')?.querySelector('.jeved-btn');
    if (schemaProblem() && adder) {
        busy(adder, true);
    }
    const [first] = views();
    if (first) {
        detach(controller.openId(first.id));
    }

    return {
        element: controller.element,
        refresh() {
            preset = getPreset();
            controller.refresh();
        },
        select: controller.openId,
        leave: controller.leave,
        dispose: controller.dispose,
    };
}
