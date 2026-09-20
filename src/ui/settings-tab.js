import { BUILT_IN, builtInPreset } from '../defaults.js';
import { readsTag, sensorLabel, tokenWords } from '../describe.js';
import { endpointWarning } from '../classifier.js';
import { describeError, isPaused, lastErrorKind, measureBlockReason, measuredCount, nextReplyGroups, scriptParser, sessionCost, testConnection } from '../engine.js';
import { CONTEXT_GROUPS, TRIM_KEY, groupLabel } from '../context-groups.js';
import { buildContext } from '../instructions.js';
import { CONTEXT_CAP, MAX_NUDGES, NUDGE_GAP, TIMEOUT_MS } from '../limits.js';
import { exportFileName, exportPreset, importPreset, isReservedKey, uniqueName } from '../presets.js';
import { getPreset, getSettings, normaliseSettings, saveSettings } from '../settings.js';
import { toast } from '../toast.js';
import { refreshBadges } from './badge.js';
import { actions, area, busy, button, checkbox, clampNumber, column, detach, editing, field, formRow, help, node, section, text, toggle, withReason } from './dom.js';
import { ask, askForName, confirmImport, contextPopup, download, pickFile, problemsPopup } from './dialogs.js';

let tested = false;

function boundField(target, key, { type = 'text', min, max, step } = {}) {
    return field(type, target()[key], '', value => {
        target()[key] = value;
        if (type === 'number') {
            normaliseSettings(getSettings());
        }
        saveSettings();
    }, {
        min, max, step,
        clamp: type === 'number' ? value => clampNumber(value, min, max) : undefined,
    });
}

function connected() {
    return !!getSettings().apiKey && !lastErrorKind() && (tested || measuredCount() > 0);
}

export function settingsTab(host) {
    const element = node('div', 'jeved-settings');
    let open = false;

    function commitSettings(settings) {
        normaliseSettings(settings);
        saveSettings();
        host.refreshAll();
    }

    async function importFile(file) {
        let data = null;
        try {
            data = JSON.parse(await file.text());
        } catch {
            await problemsPopup('The preset could not be read', ['The file does not hold JSON.']);
            return;
        }
        const settings = getSettings();
        const result = importPreset(data, Object.keys(settings.presets), { parse: scriptParser() });
        if (result.problems.length) {
            await problemsPopup('The preset could not be imported', result.problems);
            return;
        }
        if (!await confirmImport(result.name, result.preset, result.disabled)) {
            return;
        }
        settings.presets[result.name] = result.preset;
        settings.activePreset = result.name;
        commitSettings(settings);
        toast('success', `The preset ${result.name} was imported.`);
    }

    function drawConnection() {
        const settings = getSettings();
        if (connected() && !open) {
            const line = node('div', 'jeved-row');
            line.append(
                node('i', 'fa-solid fa-circle-check jeved-ok-mark'),
                text('span', '', 'Connected'),
                button('Change', 'Show the connection fields', () => {
                    open = true;
                    draw();
                }),
            );
            return section('Connection', line);
        }
        const paused = isPaused();
        const testButton = button('Test', paused ? measureBlockReason() : 'Make one small call to check the key', async () => {
            if (isPaused()) {
                return;
            }
            busy(testButton, true);
            try {
                const score = await testConnection();
                tested = true;
                toast('success', `The endpoint answered with ${Math.round(score * 100) / 100}.`);
            } catch (error) {
                tested = false;
                toast('error', describeError(error));
            } finally {
                busy(testButton, false);
                open = false;
                draw();
                host.refreshOthers();
            }
        }, { variant: 'primary' });

        const insecure = text('div', 'jeved-hint jeved-cut', endpointWarning(settings.endpoint));
        insecure.id = 'jeved_endpoint_warning';
        const endpointField = field('text', settings.endpoint, '', value => {
            getSettings().endpoint = value;
            insecure.textContent = endpointWarning(value);
            saveSettings();
        });

        return section(
            'Connection',
            formRow('API key', column('', field('password', settings.apiKey, '', value => {
                const current = getSettings();
                current.apiKey = value;
                saveSettings();
                host.refreshOthers();
            }), actions(withReason(testButton, paused ? measureBlockReason() : ''))), 'Jeved stores the key as plain text in your SillyTavern settings file, so use a key you can revoke.'),
            formRow('Endpoint', column('', endpointField, insecure)),
            formRow('Model', boundField(getSettings, 'model')),
            formRow('Timeout (ms)', boundField(getSettings, 'timeoutMs', { type: 'number', ...TIMEOUT_MS })),
        );
    }

    function contextSection() {
        const preset = getPreset();
        const grid = node('div', 'jeved-context', { id: 'jeved_context' });
        const tallies = {};
        const total = text('div', 'jeved-hint', 'Counting the context.');
        total.id = 'jeved_context_total';
        const cut = text('div', 'jeved-hint jeved-cut', '');
        cut.id = 'jeved_context_cut';
        cut.hidden = true;
        let built = null;

        for (const group of CONTEXT_GROUPS) {
            const item = checkbox(group.label, preset.contextGroups[group.key] !== false, value => {
                getPreset().contextGroups[group.key] = value;
                saveSettings();
                detach(paint());
            });
            item.classList.add('jeved-context-item');
            item.querySelector('input').id = `jeved_context_${group.key}`;
            tallies[group.key] = text('span', 'jeved-context-count', '');
            item.append(tallies[group.key]);
            grid.append(item);
        }

        async function paint() {
            const settings = getSettings();
            built = await buildContext(getPreset(settings).contextGroups, settings.instructionsCap);
            for (const group of CONTEXT_GROUPS) {
                const count = built.counts[group.key];
                tallies[group.key].textContent = count === undefined ? 'empty' : (count === null ? '' : count.toLocaleString('en-US'));
            }
            if (built.total === null) {
                total.textContent = 'The token count is unavailable, so Jeved sends every group you ticked.';
            } else if (settings.instructionsCap > 0) {
                total.textContent = `${tokenWords(built.total)} of ${settings.instructionsCap.toLocaleString('en-US')}.`;
            } else {
                total.textContent = `${tokenWords(built.total)}, with no cap.`;
            }
            const lines = [];
            if (built.cut.length) {
                lines.push(`Over the cap, so Jeved left out: ${built.cut.map(groupLabel).join(', ')}.`);
            }
            if (built.trimmed) {
                lines.push(`The ${groupLabel(TRIM_KEY).toLowerCase()} was cut short.`);
            }
            if (built.over) {
                lines.push('The main prompt and the post-history prompt alone are over the cap.');
            }
            cut.textContent = lines.join(' ');
            cut.hidden = !lines.length;
        }

        const preview = button('Preview', 'Read the exact text Jeved sends', async () => {
            if (!built) {
                await paint();
            }
            await contextPopup(built);
        });
        preview.id = 'jeved_context_preview';

        const cap = field('number', getSettings().instructionsCap, '', value => {
            getSettings().instructionsCap = value;
            normaliseSettings(getSettings());
            saveSettings();
            detach(paint());
        }, { ...CONTEXT_CAP, clamp: value => clampNumber(value, CONTEXT_CAP.min, CONTEXT_CAP.max) });
        cap.id = 'jeved_context_cap';
        detach(paint());

        return section(
            'Context sent to Jev',
            help('Sensors with Include context on get the groups you tick here.'),
            grid,
            total,
            cut,
            actions(preview),
            formRow('Context cap (tokens)', cap, 'Jev accepts about 32,000 tokens per call, so leave room for the replies and the questions.'),
        );
    }

    function costSection() {
        const preset = getPreset();
        const groups = nextReplyGroups();
        const calls = text('div', 'jeved-readout', `Next reply: ${groups.length} API ${groups.length === 1 ? 'call' : 'calls'}`);
        calls.id = 'jeved_calls';
        const members = groups.map(group => text(
            'div',
            'jeved-hint',
            `${group.ids.map(id => sensorLabel(preset.sensors, id)).join(', ')} (${readsTag(group)})`,
        ));
        return section(
            'Cost',
            calls,
            ...members,
            formRow('Session cost', text('span', 'jeved-readout', `$${sessionCost().toFixed(6)}`)),
        );
    }

    function nudges() {
        return section(
            'Nudges',
            formRow('Nudge spacing (replies)', boundField(getPreset, 'gap', { type: 'number', ...NUDGE_GAP })),
            formRow('Max nudges per turn', boundField(getPreset, 'maxNudges', { type: 'number', ...MAX_NUDGES })),
            formRow('Show badges', toggle(getSettings().showBadge, 'Show a badge on each message where a rule fired', value => {
                getSettings().showBadge = value;
                saveSettings();
                refreshBadges();
            })),
        );
    }

    async function renamePreset() {
        const settings = getSettings();
        const current = settings.activePreset;
        const typed = await askForName('Rename the preset', current);
        if (!typed) {
            return;
        }
        if (isReservedKey(typed)) {
            toast('error', `The name ${typed} can't be used.`);
            return;
        }
        const name = uniqueName(typed, Object.keys(settings.presets).filter(other => other !== current));
        settings.presets[name] = settings.presets[current];
        if (name !== current) {
            delete settings.presets[current];
        }
        settings.activePreset = name;
        commitSettings(settings);
    }

    async function deletePreset() {
        const settings = getSettings();
        const current = settings.activePreset;
        if (Object.keys(settings.presets).length < 2) {
            toast('info', 'This is the only preset. Import or duplicate one first.');
            return;
        }
        if (!await ask(`Delete the preset ${current}? This can't be undone.`, { ok: 'Delete' })) {
            return;
        }
        delete settings.presets[current];
        settings.activePreset = Object.keys(settings.presets)[0];
        commitSettings(settings);
    }

    async function restorePreset() {
        if (!await ask(`Restore the built-in ${BUILT_IN} preset? Your changes to it will be lost.`, { ok: 'Restore' })) {
            return;
        }
        const settings = getSettings();
        settings.presets[BUILT_IN] = builtInPreset();
        settings.activePreset = BUILT_IN;
        commitSettings(settings);
    }

    function presetSection() {
        const settings = getSettings();
        const preset = getPreset(settings);
        return section(
            'Preset',
            formRow('Name', text('span', 'jeved-readout', settings.activePreset)),
            formRow('Description', area(preset.description, '', 2, value => {
                getPreset().description = value;
                saveSettings();
            })),
            actions(
                button('Duplicate', 'Make a copy you can change', () => {
                    const name = uniqueName(settings.activePreset, Object.keys(settings.presets));
                    settings.presets[name] = structuredClone(settings.presets[settings.activePreset]);
                    settings.activePreset = name;
                    commitSettings(settings);
                }),
                button('Rename', 'Give this preset another name', renamePreset),
                button('Import', 'Import a preset from a file', () => pickFile(importFile)),
                button('Export', 'Save this preset to a file', () => {
                    download(exportFileName(settings.activePreset), exportPreset(settings.activePreset, getPreset(settings)));
                }),
                button('Restore built-in', `Restore the built-in ${BUILT_IN} preset`, restorePreset),
                button('Delete', 'Delete this preset', deletePreset, { variant: 'danger' }),
            ),
            help('Exports never include your key, endpoint or model.'),
        );
    }

    function draw() {
        if (element.childNodes.length && editing(element)) {
            return;
        }
        element.replaceChildren(drawConnection(), contextSection(), costSection(), nudges(), presetSection());
    }

    draw();
    return {
        element,
        refresh: draw,
        leave: async () => true,
    };
}
