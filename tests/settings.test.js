import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUILT_IN, builtInPreset } from '../src/defaults.js';
import { hostStub } from './helpers/host.js';
import { SCHEMA_VERSION } from '../src/limits.js';
import { conditionHolds } from '../src/rules.js';
import { getPreset, getSettings, initSettings, normalisePreset, normaliseSettings, saveSettings, schemaProblem } from '../src/settings.js';

const preset = (overrides = {}) => ({ description: '', sensors: [], rules: [], ...overrides });

const host = extensionSettings => hostStub({ extensionSettings });

describe('normaliseSettings', () => {
    it('replaces a value that is not a number with the built-in default', () => {
        const settings = normaliseSettings({ timeoutMs: 'soon', instructionsCap: undefined });
        assert.equal(settings.timeoutMs, 20000);
        assert.equal(settings.instructionsCap, 24000);
    });

    it('pulls a number back inside its range and rounds it', () => {
        const settings = normaliseSettings({
            timeoutMs: 1e12,
            instructionsCap: -1,
            presets: { a: preset({ sensors: [{ id: 'a', user: 2.6, assistant: -4 }, { id: 'b', user: 99, assistant: 'lots' }] }) },
        });
        assert.equal(settings.timeoutMs, 600000);
        assert.equal(settings.instructionsCap, 0);
        assert.deepEqual(
            settings.presets.a.sensors.map(sensor => [sensor.user, sensor.assistant]),
            [[3, 0], [50, 1]],
        );
    });

    it('drops the settings that 0.3 removed', () => {
        const settings = normaliseSettings({
            presets: { a: preset({ gap: 8, maxNudges: 2, sensors: [{ id: 'a', turns: 5, includeUser: true, includeContext: true, measureEvery: 2 }] }) },
        });
        const [sensor] = settings.presets.a.sensors;
        assert.deepEqual([sensor.user, sensor.assistant, sensor.context], [1, 1, false]);
    });

    it('keeps a rule countable: whole numbers, at least one, and need no larger than window', () => {
        const settings = normaliseSettings({
            presets: { a: preset({ rules: [{ id: 'r', need: 0, window: 0 }, { id: 's', need: 9, window: 4, cooldown: -3 }] }) },
        });
        assert.deepEqual(settings.presets.a.rules.map(rule => [rule.need, rule.window]), [[1, 1], [4, 4]]);
        assert.equal(settings.presets.a.rules[1].cooldown, 0);
    });

    it('gives every rule and sensor the new fields', () => {
        const settings = normaliseSettings({
            presets: { a: preset({ sensors: [{ id: 'a' }], rules: [{ id: 'r', action: 'jump' }] }) },
        });
        const [sensor] = settings.presets.a.sensors;
        assert.equal(sensor.levels.length, 5);
        assert.equal(sensor.watch, false);
        assert.deepEqual([sensor.user, sensor.assistant, sensor.context], [1, 1, false]);
        assert.equal(settings.presets.a.rules[0].script, '');
    });

    it('turns off a rule whose action this Jeved does not know, and keeps its data', () => {
        const settings = normaliseSettings({
            presets: { a: preset({
                sensors: [{ id: 'a' }],
                rules: [{ id: 'r', enabled: true, action: 'teleport', directive: 'd', conditions: [{ sensor: 'a', op: 'below', value: 1 }] }],
            }) },
        });
        const [rule] = settings.presets.a.rules;
        assert.equal(rule.action, 'teleport');
        assert.equal(rule.enabled, false);
        assert.equal(rule.directive, 'd');
        assert.deepEqual(rule.conditions, [{ sensor: 'a', op: 'below', value: 1, minConfidence: null }]);
    });

    it('leaves a rule with no action at all on the default action', () => {
        const settings = normaliseSettings({
            presets: { a: preset({ sensors: [{ id: 'a' }], rules: [{ id: 'r', enabled: true }] }) },
        });
        assert.equal(settings.presets.a.rules[0].action, 'nudge');
        assert.equal(settings.presets.a.rules[0].enabled, true);
    });

    it('makes every condition value a finite number', () => {
        const settings = normaliseSettings({
            presets: { a: preset({
                sensors: [{ id: 'a' }],
                rules: [{ id: 'r', need: 1, window: 1, conditions: [{ sensor: 'a', op: 'below', value: 'x' }], skipWhen: { sensor: 'a', op: 'above', value: '3' } }],
            }) },
        });
        assert.equal(settings.presets.a.rules[0].conditions[0].value, 0);
        assert.equal(settings.presets.a.rules[0].skipWhen.value, 3);
    });

    it('keeps a choice condition instead of forcing it into a number', () => {
        const normalised = normalisePreset({
            description: '',
            gap: 8,
            maxNudges: 1,
            sensors: [{ id: 'mood', type: 'choice', options: [{ name: 'calm', description: '' }, { name: 'angry', description: '' }] }],
            rules: [{
                id: 'r',
                need: 1,
                window: 1,
                conditions: [{ sensor: 'mood', op: 'is_not', value: 'calm' }],
                skipWhen: { sensor: 'mood', op: 'is', value: 'angry' },
            }],
        });
        assert.deepEqual(normalised.rules[0].conditions[0], { sensor: 'mood', op: 'is_not', value: 'calm', minConfidence: null });
        assert.deepEqual(normalised.rules[0].skipWhen, { sensor: 'mood', op: 'is', value: 'angry', minConfidence: null });
    });

    it('pulls a condition back to what its sensor type allows', () => {
        const normalised = normalisePreset({
            description: '',
            gap: 8,
            maxNudges: 1,
            sensors: [
                { id: 'mood', type: 'choice', options: [{ name: 'calm', description: '' }, { name: 'angry', description: '' }] },
                { id: 'danger', type: 'noul', levels: ['no', 'yes'] },
            ],
            rules: [{
                id: 'r',
                need: 1,
                window: 1,
                conditions: [
                    { sensor: 'mood', op: 'below', value: 2, minConfidence: 0.5 },
                    { sensor: 'danger', op: 'above', value: 4, minConfidence: 0.5 },
                ],
            }],
        });
        const [mood, danger] = normalised.rules[0].conditions;
        assert.deepEqual(mood, { sensor: 'mood', op: 'is', value: 'calm', minConfidence: 0.5 });
        assert.deepEqual(danger, { sensor: 'danger', op: 'above', value: 1, minConfidence: null });
    });

    it('trims an option name and the condition that names it, so the two still match', () => {
        const normalised = normalisePreset({
            description: '',
            gap: 8,
            maxNudges: 1,
            sensors: [{ id: 'mood', type: 'choice', options: [{ name: ' calm ', description: 'x' }, { name: 'angry', description: '' }] }],
            rules: [{ id: 'r', need: 1, window: 1, conditions: [{ sensor: 'mood', op: 'is', value: ' calm ' }] }],
        });
        assert.deepEqual(normalised.sensors[0].options.map(option => option.name), ['calm', 'angry']);
        assert.equal(normalised.rules[0].conditions[0].value, 'calm');
        assert.equal(conditionHolds({ scores: { mood: 'calm' } }, normalised.rules[0].conditions[0]), true);
    });

    it('gives every sensor a type and an option list', () => {
        const settings = normaliseSettings({ presets: { a: preset({ sensors: [{ id: 'a' }, { id: 'b', type: 'vibe' }] }) } });
        assert.deepEqual(settings.presets.a.sensors.map(item => item.type), ['score', 'score']);
        assert.deepEqual(settings.presets.a.sensors[0].options, []);
    });

    it('drops junk instead of throwing', () => {
        const settings = normaliseSettings({
            activePreset: 'gone',
            presets: {
                good: preset({ sensors: [null, 'x', { id: 'a' }], rules: [null, 7] }),
                bad: 5,
                worse: null,
                broken: preset({ sensors: 'nope', rules: { id: 'r' } }),
            },
        });
        assert.deepEqual(Object.keys(settings.presets), ['good', 'broken']);
        assert.equal(settings.activePreset, 'good');
        assert.equal(settings.presets.good.sensors.length, 1);
        assert.deepEqual(settings.presets.good.rules, []);
        assert.deepEqual(settings.presets.broken.sensors, []);
    });

    it('falls back to the built-in preset when none is left', () => {
        const settings = normaliseSettings({ presets: { bad: 5 } });
        assert.deepEqual(Object.keys(settings.presets), [BUILT_IN]);
        assert.equal(settings.activePreset, BUILT_IN);
        assert.deepEqual(settings.presets[BUILT_IN].rules.filter(rule => rule.enabled).map(rule => rule.id), [
            'puppet', 'attention', 'echo', 'drift', 'gentle',
            'scene_combat', 'scene_conversation', 'scene_travel', 'scene_intimate',
        ]);
    });
});

describe('reserved keys', () => {
    it('drops a preset, a sensor and a rule that use a reserved key', () => {
        const presets = JSON.parse('{"Good": null, "__proto__": null}');
        presets.Good = preset({
            sensors: [{ id: 'tone' }, { id: '__proto__' }],
            rules: [{ id: 'flat' }, { id: 'constructor' }],
        });
        assert.deepEqual(Object.keys(presets), ['Good', '__proto__'], 'the import really made an own key');

        const settings = normaliseSettings({ presets, activePreset: 'Good' });
        assert.deepEqual(Object.keys(settings.presets), ['Good']);
        assert.deepEqual(settings.presets.Good.sensors.map(item => item.id), ['tone']);
        assert.deepEqual(settings.presets.Good.rules.map(item => item.id), ['flat']);
    });

    it('does not let a reserved preset name change the prototype', () => {
        const settings = normaliseSettings({ presets: JSON.parse('{"__proto__": {}}') });
        assert.equal(Object.getPrototypeOf(settings.presets), Object.prototype);
        assert.ok(settings.presets[BUILT_IN]);
    });

    it('falls back to a real preset when the chosen name is only an inherited property', () => {
        for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
            const settings = normaliseSettings({ presets: { Good: preset() }, activePreset: name });
            assert.equal(settings.activePreset, 'Good', name);
            assert.equal(getPreset(settings), settings.presets.Good, name);
        }
    });

    it('keeps the chosen preset when it really is one of its own', () => {
        const settings = normaliseSettings({ presets: { Good: preset(), Other: preset() }, activePreset: 'Other' });
        assert.equal(settings.activePreset, 'Other');
        assert.equal(getPreset(settings), settings.presets.Other);
    });
});

describe('initSettings', () => {
    it('leaves the settings of another extension where they are', () => {
        const extensionSettings = { director: { enabled: true, apiKey: 'test-key' } };
        const counts = host(extensionSettings);
        const settings = initSettings();
        assert.deepEqual(extensionSettings.director, { enabled: true, apiKey: 'test-key' });
        assert.equal(settings.apiKey, '');
        assert.ok(counts.saveCount > 0);
        assert.equal(getSettings(), extensionSettings.jeved);
    });

    it('gives the plain defaults when nothing was stored', () => {
        const extensionSettings = {};
        host(extensionSettings);
        const settings = initSettings();
        assert.equal(settings.enabled, false);
        assert.equal(settings.apiKey, '');
        assert.equal(settings.instructionsCap, 24000);
        assert.equal(settings.activePreset, BUILT_IN);
        assert.equal(settings.presets[BUILT_IN].sensors.length, 14);
    });

    it('starts over when the stored value is not a record', () => {
        for (const junk of ['junk', 42, true, [], null]) {
            const extensionSettings = { jeved: junk };
            host(extensionSettings);
            const settings = initSettings();
            assert.equal(settings.activePreset, BUILT_IN);
            assert.equal(settings.presets[BUILT_IN].sensors.length, 14);
        }
    });

    it('fills a field that a later version added', () => {
        const extensionSettings = { jeved: { enabled: true, presets: { Mine: preset() }, activePreset: 'Mine' } };
        host(extensionSettings);
        const settings = initSettings();
        assert.equal(settings.model, 'typesafe/jev-1.13');
        assert.equal(settings.showBadge, true);
        assert.equal(settings.activePreset, 'Mine');
    });

    it('upgrades a stored schema 1 file, keeps the cap the user chose and saves once', () => {
        const extensionSettings = {
            jeved: {
                schema: 1,
                instructionsCap: 48000,
                activePreset: 'Mine',
                presets: { Mine: {
                    description: '',
                    rules: [],
                    storyWindow: 4,
                    storyEvery: 1,
                    sensors: [
                        { id: 'tone', scope: 'story', question: 'Does `recent_story` fit `instructions`?', levels: ['a', 'b', 'c', 'd', 'e'] },
                        { id: 'pace', scope: 'reply', question: 'How fast is `narrator_reply`?', levels: ['a', 'b', 'c', 'd', 'e'] },
                    ],
                } },
            },
        };
        const counts = host(extensionSettings);
        const settings = initSettings();
        const [tone, pace] = settings.presets.Mine.sensors;
        assert.equal(settings.schema, SCHEMA_VERSION);
        assert.equal(settings.instructionsCap, 48000);
        assert.deepEqual([tone.user, tone.assistant, tone.context], [0, 4, true]);
        assert.deepEqual([pace.user, pace.assistant, pace.context], [1, 1, false]);
        assert.equal(tone.question, 'Does `history` and `latest_turn` fit `context`?');
        assert.equal(settings.presets.Mine.contextGroups.persona, true);
        assert.equal(settings.presets.Mine.storyWindow, undefined);
        assert.equal(settings.presets.Mine.jeved, SCHEMA_VERSION);
        assert.equal(counts.saveCount, 1);

        initSettings();
        assert.equal(counts.saveCount, 1);
    });

    it('keeps the built-in preset out of the older migrations, however often it is loaded', () => {
        host({});
        const first = structuredClone(initSettings().presets[BUILT_IN]);
        assert.equal(first.jeved, SCHEMA_VERSION);
        const repeats = first.sensors.find(sensor => sensor.id === 'repeats');
        assert.deepEqual([repeats.type, repeats.user, repeats.assistant, repeats.context], ['score', 0, 5, false]);

        const again = initSettings().presets[BUILT_IN];
        assert.deepEqual(again.sensors, first.sensors);
        assert.deepEqual(again.rules, first.rules);
    });

    it('keeps Scene and Mood choices with their options through Restore built-in and a reload', () => {
        const extensionSettings = {};
        host(extensionSettings);
        initSettings();

        extensionSettings.jeved.presets[BUILT_IN] = builtInPreset();
        normaliseSettings(extensionSettings.jeved);

        const stored = initSettings().presets[BUILT_IN];
        const scene = stored.sensors.find(sensor => sensor.id === 'scene');
        assert.deepEqual([scene.type, scene.user, scene.assistant, scene.context], ['choice', 1, 0, false]);
        assert.deepEqual(scene.options.map(option => option.name), ['combat', 'conversation', 'travel', 'intimate', 'downtime']);
        assert.ok(scene.options.every(option => option.description));

        const mood = stored.sensors.find(sensor => sensor.id === 'mood');
        assert.deepEqual([mood.type, mood.user, mood.assistant, mood.context], ['choice', 0, 1, false]);
        assert.equal(mood.options.length, 28);
        assert.equal(mood.options.at(-1).name, 'neutral');
        assert.ok(mood.options.every(option => option.name && option.description === ''));
        assert.equal(stored.rules.find(rule => rule.id === 'mood').conditions[0].value, 'neutral');

        const rules = stored.rules.filter(rule => rule.id.startsWith('scene_'));
        assert.deepEqual(rules.map(rule => [rule.label, rule.enabled, rule.conditions[0].value]), [
            ['Scene: combat', true, 'combat'],
            ['Scene: conversation', true, 'conversation'],
            ['Scene: travel', true, 'travel'],
            ['Scene: intimate', true, 'intimate'],
        ]);
        assert.ok(rules.every(rule => rule.need === 1 && rule.window === 1 && rule.cooldown === 0 && rule.directive));
    });

    it('says which sensors changed wording when it upgrades a stored schema 3 file', () => {
        const notices = [];
        globalThis.toastr = { info: message => notices.push(message), error() {}, success() {}, warning() {} };
        host({
            jeved: {
                schema: 3,
                activePreset: 'Mine',
                presets: { Mine: {
                    description: '',
                    rules: [{ id: 'r', enabled: true, action: 'nudge', need: 1, window: 1, directive: '(OOC)', conditions: [{ sensor: 'tone', op: 'below', value: 1 }] }],
                    gap: 7,
                    sensors: [{ id: 'tone', label: 'Tone', turns: 5, includeUser: false, includeContext: true, measureEvery: 1, question: 'Does `latest_turns` fit?', levels: ['a', 'b'] }],
                } },
            },
        });
        const stored = initSettings().presets.Mine;
        assert.deepEqual(notices, ['Jeved 0.3 changed the wording of these sensors. Check: Tone.']);
        assert.deepEqual([stored.sensors[0].user, stored.sensors[0].assistant, stored.sensors[0].context], [0, 5, true]);
        assert.equal(stored.rules[0].cooldown, 7);
    });

    it('shows one notice when two stored presets get the same wording change', () => {
        const notices = [];
        globalThis.toastr = { info: message => notices.push(message), error() {}, success() {}, warning() {} };
        const old = () => ({
            description: '',
            rules: [],
            gap: 1,
            sensors: [{ id: 'tone', label: 'Tone', turns: 5, includeUser: false, includeContext: true, measureEvery: 1, question: 'Does `latest_turns` fit?', levels: ['a', 'b'] }],
        });
        host({ jeved: { schema: 3, activePreset: 'Mine', presets: { Mine: old(), 'Mine (2)': old() } } });
        initSettings();
        assert.deepEqual(notices, ['Jeved 0.3 changed the wording of these sensors. Check: Tone.']);
    });

    it('keeps the groups a stored schema 2 preset left out of its map switched on', () => {
        const extensionSettings = {
            jeved: {
                schema: 2,
                activePreset: 'Mine',
                presets: { Mine: {
                    description: '',
                    rules: [],
                    sensors: [{ id: 'tone', label: 'Tone', turns: 1, question: 'q', levels: ['a', 'b', 'c', 'd', 'e'] }],
                    contextGroups: { persona: false },
                } },
            },
        };
        host(extensionSettings);
        const stored = initSettings().presets.Mine;
        assert.equal(stored.contextGroups.persona, false);
        assert.equal(stored.contextGroups.main_prompt, true);
        assert.equal(stored.jeved, SCHEMA_VERSION);
    });

    it('stamps every preset it hands back with the schema this build knows', () => {
        host({ jeved: { schema: 2, activePreset: 'Mine', presets: { Mine: { description: '', rules: [], sensors: [] } } } });
        const settings = initSettings();
        assert.deepEqual(Object.values(settings.presets).map(item => item.jeved), [SCHEMA_VERSION]);
    });

    it('reads the version off the presets when the file states none', () => {
        const extensionSettings = {
            jeved: {
                activePreset: 'Mine',
                presets: { Mine: {
                    description: '',
                    rules: [],
                    storyWindow: 3,
                    sensors: [{ id: 'tone', scope: 'story', question: 'q', levels: ['a', 'b', 'c', 'd', 'e'] }],
                } },
            },
        };
        const counts = host(extensionSettings);
        const settings = initSettings();
        assert.equal(settings.presets.Mine.sensors[0].assistant, 3);
        assert.equal(settings.schema, SCHEMA_VERSION);
        assert.equal(counts.saveCount, 1);
    });
});

describe('settings from a newer Jeved', () => {
    const future = () => ({
        schema: 99,
        enabled: true,
        apiKey: 'k',
        activePreset: 'Mine',
        presets: { Mine: { description: '', sensors: [], rules: [], gap: 8, maxNudges: 1, futureField: 'keep' } },
        somethingNew: true,
    });

    it('leaves them exactly as they are and saves nothing', () => {
        const extensionSettings = { jeved: future() };
        const counts = host(extensionSettings);
        const settings = initSettings();

        assert.deepEqual(settings, future());
        assert.equal(settings.model, undefined);
        assert.equal(counts.saveCount, 0);

        saveSettings();
        assert.equal(counts.saveCount, 0);
    });

    it('says once why, and still hands the active preset back', () => {
        host({ jeved: future() });
        initSettings();
        assert.match(schemaProblem(), /schema 99/);
        assert.equal(getPreset().futureField, 'keep');
    });

    it('goes back to work once a known file is loaded', () => {
        host({ jeved: future() });
        initSettings();
        assert.notEqual(schemaProblem(), '');

        const extensionSettings = {};
        const counts = host(extensionSettings);
        initSettings();
        assert.equal(schemaProblem(), '');
        saveSettings();
        assert.ok(counts.saveCount > 1);
    });
});
