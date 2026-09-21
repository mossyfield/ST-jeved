import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { buttonNamed, installDom, settle } from './helpers/dom.js';
import { hostStub } from './helpers/host.js';

const body = installDom();
globalThis.document.getElementById = id => (id === 'extensions_settings2' ? body : null);
globalThis.IntersectionObserver = class { observe() {} };

const { SCHEMA_VERSION } = await import('../src/limits.js');

const future = () => ({
    schema: SCHEMA_VERSION + 1,
    enabled: true,
    apiKey: 'k',
    model: 'future-model',
    activePreset: 'Mine',
    somethingNew: true,
    presets: {
        Mine: { description: '', sensors: [], rules: [], contextGroups: { main_prompt: true }, somethingElse: 1 },
        Other: { description: '', sensors: [], rules: [], contextGroups: { main_prompt: true }, somethingElse: 2 },
    },
});

const extensionSettings = { jeved: future() };
const host = hostStub({ extensionSettings });

const { initSettings } = await import('../src/settings.js');
const { addDrawer } = await import('../src/ui/drawer.js');
const { settingsTab } = await import('../src/ui/settings-tab.js');

const inputWithValue = value => body.querySelectorAll('.jeved-input').find(item => item.value === value) ?? null;

describe('settings written by a newer Jeved are read-only', () => {
    let tab = null;

    before(async () => {
        initSettings();
        addDrawer();
        tab = settingsTab({ refreshAll: () => {}, refreshOthers: () => {} });
        body.append(tab.element);
        await settle();
    });

    it('says once why, in the drawer chip', () => {
        assert.equal(body.querySelector('.jeved-chip').textContent, 'Newer settings');
    });

    it('leaves the stored object alone when the preset picker is used', async () => {
        const picker = body.querySelector('.jeved-picker');
        picker.value = 'Other';
        picker.fire('change');
        await settle();
        assert.deepEqual(extensionSettings.jeved, future());
        assert.equal(host.saveCount, 0);
    });

    it('leaves the stored object alone when a field is edited', () => {
        const model = inputWithValue('future-model');
        assert.ok(model, 'the model field was on screen');
        model.value = 'mine';
        model.fire('input');
        assert.deepEqual(extensionSettings.jeved, future());
        assert.equal(host.saveCount, 0);
    });

    it('leaves the stored object alone when a preset is duplicated', async () => {
        buttonNamed(tab.element, 'Duplicate').fire('click');
        await settle();
        assert.deepEqual(extensionSettings.jeved, future());
        assert.equal(host.saveCount, 0);
    });
});
