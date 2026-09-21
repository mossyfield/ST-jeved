import { BUILT_IN, builtInPreset } from '../defaults.js';
import { sensorLabel } from '../sensor-types.js';
import { endpointWarning } from '../classifier.js';
import { describeError, isPaused, lastErrorKind, measureBlockReason, measuredCount, nextMessageGroups, nextReplyGroups, scriptParser, sessionCost, sessionTokens, testConnection } from '../engine.js';
import { CONTEXT_CAP, TIMEOUT_MS } from '../limits.js';
import { exportFileName, exportPreset, importPreset, isReservedKey, uniqueName } from '../presets.js';
import { getPreset, getSettings, normaliseSettings, saveSettings } from '../settings.js';
import { toast } from '../toast.js';
import { refreshBadges } from './badge.js';
import { hostPicker } from './hosts.js';
import { actions, area, busy, button, clampNumber, column, editing, field, formRow, help, node, section, text, toggle, withReason } from './dom.js';
import { ask, askForName, confirmImport, download, pickFile, problemsPopup } from './dialogs.js';

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
        for (const notice of result.notices ?? []) {
            toast('info', notice);
        }
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
            hosts.refresh();
            saveSettings();
        });
        const modelField = boundField(getSettings, 'model');
        const hosts = hostPicker({
            id: 'jeved_host',
            onPick: () => {
                const current = getSettings();
                endpointField.value = current.endpoint;
                modelField.value = current.model;
                insecure.textContent = endpointWarning(current.endpoint);
            },
        });

        return section(
            'Connection',
            formRow('API key', column('', field('password', settings.apiKey, '', value => {
                const current = getSettings();
                current.apiKey = value;
                saveSettings();
                host.refreshOthers();
            }), actions(withReason(testButton, paused ? measureBlockReason() : ''))), 'Jeved stores the key as plain text in your SillyTavern settings file, so use a key you can revoke.'),
            formRow('Host', hosts.element),
            formRow('Endpoint', column('', endpointField, insecure)),
            formRow('Model', modelField),
            formRow('Timeout (ms)', boundField(getSettings, 'timeoutMs', { type: 'number', ...TIMEOUT_MS })),
        );
    }

    function contextSection() {
        const cap = field('number', getSettings().instructionsCap, '', value => {
            getSettings().instructionsCap = value;
            normaliseSettings(getSettings());
            saveSettings();
        }, { ...CONTEXT_CAP, clamp: value => clampNumber(value, CONTEXT_CAP.min, CONTEXT_CAP.max) });
        cap.id = 'jeved_context_cap';

        return section(
            'Context sent to Jev',
            help('Each sensor picks what it sends, in its own form on the Sensors tab.'),
            formRow('Context cap (tokens)', cap, 'Jev accepts about 32,000 tokens per call, so leave room for the replies and the questions.'),
        );
    }

    function callLines(preset, groups, headline, id) {
        const line = text('div', 'jeved-readout', headline);
        line.id = id;
        return [
            line,
            ...groups.map(group => text('div', 'jeved-hint', group.ids.map(item => sensorLabel(preset.sensors, item)).join(', '))),
        ];
    }

    function costSection() {
        const preset = getPreset();
        const replies = nextReplyGroups();
        const messages = nextMessageGroups();
        const spent = sessionCost();
        const used = `${sessionTokens().toLocaleString('en-US')} tokens`;
        return section(
            'Cost',
            ...callLines(preset, replies, `Each reply: ${replies.length} API ${replies.length === 1 ? 'call' : 'calls'}`, 'jeved_calls'),
            ...(messages.length
                ? callLines(preset, messages, `Each of your messages: ${messages.length} API ${messages.length === 1 ? 'call' : 'calls'}, before the reply`, 'jeved_message_calls')
                : []),
            formRow('Session', text('span', 'jeved-readout', spent > 0 ? `${used} · $${spent.toFixed(6)}` : used)),
        );
    }

    function badges() {
        return section(
            'Badges',
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
        element.replaceChildren(drawConnection(), contextSection(), costSection(), badges(), presetSection());
    }

    draw();
    return {
        element,
        refresh: draw,
        leave: async () => true,
    };
}
