import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUILT_IN, builtInPreset } from '../src/defaults.js';
import { CONTEXT_KEYS } from '../src/context-groups.js';
import { SCHEMA_VERSION, exportFileName, exportPreset, importPreset, isReservedKey, legacyReference, normaliseContextGroups, presetVersion, renameOption, slugId, uniqueName, upgradePreset, validatePreset } from '../src/presets.js';
import { UNPARSABLE, stubParser } from './helpers/parser.js';

const parse = stubParser();

const choiceSensor = (overrides = {}) => ({
    id: 'mood',
    label: 'Mood',
    watch: false,
    type: 'choice',
    turns: 1,
    includeContext: false,
    includeUser: true,
    measureEvery: 1,
    question: 'Which mood fits `latest_turn`?',
    levels: [],
    options: [{ name: 'calm', description: 'Settled.' }, { name: 'angry', description: 'Furious.' }],
    ...overrides,
});

const noulSensor = (overrides = {}) => ({
    id: 'danger',
    label: 'Danger',
    watch: false,
    type: 'noul',
    turns: 1,
    includeContext: false,
    includeUser: true,
    measureEvery: 1,
    question: 'Is anyone in danger in `latest_turn`?',
    levels: ['Nobody is.', 'Someone is.'],
    options: [],
    ...overrides,
});

const sensor = (overrides = {}) => ({
    id: 'tone',
    label: 'Tone',
    watch: false,
    turns: 5,
    includeContext: true,
    includeUser: false,
    measureEvery: 1,
    question: 'How well does `latest_turns` match `context`?',
    levels: ['a', 'b', 'c', 'd', 'e'],
    ...overrides,
});

const rule = (overrides = {}) => ({
    id: 'flat',
    label: 'Flat',
    enabled: true,
    action: 'nudge',
    conditions: [{ sensor: 'tone', op: 'below', value: 1.5 }],
    need: 3,
    window: 4,
    skipWhen: null,
    cooldown: 0,
    directive: '(OOC: do the thing.)',
    script: '',
    ...overrides,
});

const preset = (overrides = {}) => ({
    description: 'A preset.',
    sensors: [sensor()],
    rules: [rule()],
    contextGroups: Object.fromEntries(CONTEXT_KEYS.map(key => [key, true])),
    gap: 8,
    maxNudges: 1,
    ...overrides,
});

const legacySensor = (overrides = {}) => ({
    id: 'tone',
    label: 'Tone',
    watch: false,
    scope: 'story',
    question: 'How well does `recent_story` match the intent of `instructions`?',
    levels: ['The `player_turn` is ignored.', 'b', 'c', 'd', 'The `narrator_reply` fits.'],
    ...overrides,
});

const legacyPreset = (overrides = {}) => ({
    description: 'A preset.',
    sensors: [legacySensor()],
    rules: [rule()],
    storyWindow: 7,
    storyEvery: 2,
    gap: 8,
    maxNudges: 1,
    ...overrides,
});

describe('validatePreset', () => {
    it('passes the built-in preset', () => {
        assert.deepEqual(validatePreset(builtInPreset(), { parse: stubParser() }), []);
    });

    it('names a condition that points at a sensor that is not there', () => {
        const problems = validatePreset(preset({
            rules: [rule({ conditions: [{ sensor: 'tone', op: 'below', value: 1 }, { sensor: 'tensoin', op: 'below', value: 1 }] })],
        }));
        assert.deepEqual(problems, ["rule 'flat', condition 2: no sensor named 'tensoin'"]);
    });

    it('names an unless condition that points at a sensor that is not there', () => {
        const problems = validatePreset(preset({ rules: [rule({ skipWhen: { sensor: 'gone', op: 'above', value: 2 } })] }));
        assert.deepEqual(problems, ["rule 'flat', exception: no sensor named 'gone'"]);
    });

    it('asks a rule for an instruction or a script', () => {
        assert.deepEqual(validatePreset(preset({ rules: [rule({ directive: '', script: '' })] })), ["rule 'flat': it needs an instruction or a script"]);
        assert.deepEqual(validatePreset(preset({ rules: [rule({ directive: '', script: '/echo hello' })] }), { parse }), []);
    });

    it('asks a score sensor for 2 to 10 descriptions', () => {
        assert.deepEqual(validatePreset(preset({ sensors: [sensor({ levels: ['a'] })] })), ["sensor 'tone': it needs 2 to 10 score descriptions"]);
        assert.deepEqual(
            validatePreset(preset({ sensors: [sensor({ levels: Array.from({ length: 11 }, () => 'a') })] })),
            ["sensor 'tone': it needs 2 to 10 score descriptions"],
        );
        assert.deepEqual(validatePreset(preset({ sensors: [sensor({ levels: ['a', 'b', 'c'] })] })), []);
    });

    it('asks a choice sensor for at least two options with different names', () => {
        const only = preset({ sensors: [choiceSensor({ options: [{ name: 'calm', description: '' }] })], rules: [] });
        assert.deepEqual(validatePreset(only), ["sensor 'mood': it needs 2 to 255 options"]);

        const twins = preset({
            sensors: [choiceSensor({ options: [{ name: 'calm', description: '' }, { name: 'calm', description: '' }] })],
            rules: [],
        });
        assert.deepEqual(validatePreset(twins), ["sensor 'mood': two options are named 'calm'"]);

        const nameless = preset({
            sensors: [choiceSensor({ options: [{ name: ' ', description: 'x' }, { name: 'calm', description: '' }] })],
            rules: [],
        });
        assert.deepEqual(validatePreset(nameless), ["sensor 'mood': an option has no name"]);
    });

    it('asks a noul sensor for both texts or neither', () => {
        assert.deepEqual(validatePreset(preset({ sensors: [noulSensor({ levels: ['Nobody is.', ''] })], rules: [] })), [
            "sensor 'danger': it needs a no description and a yes description, or neither",
        ]);
        assert.deepEqual(validatePreset(preset({ sensors: [noulSensor({ levels: [] })], rules: [] })), []);
        assert.deepEqual(validatePreset(preset({ sensors: [noulSensor()], rules: [] })), []);
    });

    it('refuses a sensor type this Jeved does not know', () => {
        assert.deepEqual(validatePreset(preset({ sensors: [sensor({ type: 'vibe' })], rules: [] })), [
            "sensor 'tone': the type must be 'score' or 'choice' or 'noul'",
        ]);
    });

    it('refuses a test the sensor type does not offer', () => {
        const mixed = preset({
            sensors: [choiceSensor()],
            rules: [rule({ conditions: [{ sensor: 'mood', op: 'below', value: 2 }] })],
        });
        assert.deepEqual(validatePreset(mixed), ["rule 'flat', condition 1: the test must be 'is' or 'is_not'"]);

        const numeric = preset({ rules: [rule({ conditions: [{ sensor: 'tone', op: 'is', value: 'calm' }] })] });
        assert.deepEqual(validatePreset(numeric), ["rule 'flat', condition 1: the test must be 'below' or 'above'"]);
    });

    it('refuses a choice condition that names an option the sensor lost', () => {
        const gone = preset({
            sensors: [choiceSensor()],
            rules: [rule({ conditions: [{ sensor: 'mood', op: 'is', value: 'bored' }] })],
        });
        assert.deepEqual(validatePreset(gone), ["rule 'flat', condition 1: no option named 'bored'"]);
    });

    it('checks the least confidence a condition asks for', () => {
        const high = preset({ rules: [rule({ conditions: [{ sensor: 'tone', op: 'below', value: 1, minConfidence: 2 }] })] });
        assert.deepEqual(validatePreset(high), ["rule 'flat', condition 1: the confidence must be a number from 0 to 1"]);

        const onNoul = preset({
            sensors: [noulSensor()],
            rules: [rule({ skipWhen: { sensor: 'danger', op: 'above', value: 0.5, minConfidence: 0.7 }, conditions: [{ sensor: 'danger', op: 'above', value: 0.5 }] })],
        });
        assert.deepEqual(validatePreset(onNoul), ["rule 'flat', exception: a noul sensor has no confidence"]);

        const fine = preset({ rules: [rule({ conditions: [{ sensor: 'tone', op: 'below', value: 1, minConfidence: 0.7 }] })] });
        assert.deepEqual(validatePreset(fine), []);
    });

    it('asks a sensor for a name and for two descriptions that are filled in', () => {
        assert.deepEqual(validatePreset(preset({ sensors: [sensor({ label: '  ' })], rules: [] })), ["sensor 'tone': it has no name"]);
        assert.deepEqual(
            validatePreset(preset({ sensors: [sensor({ levels: ['a', '', '', '', ' '] })], rules: [] })),
            ["sensor 'tone': it needs at least two score descriptions filled in"],
        );
        assert.deepEqual(validatePreset(preset({ sensors: [sensor({ levels: ['a', 'b', '', '', ''] })], rules: [] })), []);
    });

    it('lets a rule run any command the parser accepts', () => {
        assert.deepEqual(validatePreset(preset({ rules: [rule({ script: '/echo one | /swipe' })] }), { parse }), []);
        assert.deepEqual(validatePreset(preset({ rules: [rule({ script: '/setvar key=a 1 | /imagine scene' })] }), { parse }), []);
        assert.deepEqual(validatePreset(preset({ rules: [rule({ script: '/while {{getvar::go}} /echo hi' })] }), { parse }), []);
    });

    it('refuses a script the parser cannot read', () => {
        const problems = validatePreset(preset({ rules: [rule({ script: UNPARSABLE })] }), { parse });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /can't read this script: unexpected end of closure/);
    });

    it('lets a script through when no parser is available', () => {
        assert.deepEqual(validatePreset(preset({ rules: [rule({ script: UNPARSABLE })] })), []);
    });

    it('refuses a bad id, a repeated id, a bad turn count and a bad action', () => {
        assert.deepEqual(validatePreset(preset({ sensors: [sensor({ id: 'To ne' })], rules: [] })), [
            "sensor 1: the id 'To ne' can only hold lowercase letters, numbers and underscores",
        ]);
        assert.ok(validatePreset(preset({ sensors: [sensor(), sensor()], rules: [] })).includes("sensor 'tone': two sensors have that id"));
        assert.ok(validatePreset(preset({ sensors: [sensor({ turns: 0 })], rules: [] })).includes("sensor 'tone': turns must be a whole number from 1 to 50"));
        assert.ok(validatePreset(preset({ sensors: [sensor({ measureEvery: 99 })], rules: [] })).includes("sensor 'tone': measure every must be a whole number from 1 to 50"));
        assert.ok(validatePreset(preset({ rules: [rule({ action: 'shout' })] })).includes("rule 'flat': the action must be 'nudge' or 'swipe'"));
    });

    it('refuses a reserved id and a reserved preset name', () => {
        assert.ok(validatePreset(preset({ sensors: [sensor({ id: '__proto__' })], rules: [] }))
            .includes("sensor 1: the id '__proto__' is reserved and can't be used"));
        assert.ok(validatePreset(preset({ rules: [rule({ id: 'constructor' })] }))
            .includes("rule 1: the id 'constructor' is reserved and can't be used"));
        assert.ok(validatePreset({ ...preset(), name: '__proto__' })
            .includes("the name '__proto__' is reserved and can't be used"));
    });

    it('refuses a file that is not a preset', () => {
        assert.deepEqual(validatePreset(null), ['The file does not hold a preset.']);
        assert.deepEqual(validatePreset({ sensors: [] }), ['The preset needs a list of sensors and a list of rules.']);
    });
});

describe('names and ids', () => {
    it('makes a name unique with a number', () => {
        assert.equal(uniqueName('Director', []), 'Director');
        assert.equal(uniqueName('Director', ['Director']), 'Director (2)');
        assert.equal(uniqueName('Director', ['Director', 'Director (2)']), 'Director (3)');
        assert.equal(uniqueName('  ', []), 'Preset');
    });

    it('makes an id from a label', () => {
        assert.equal(slugId('Speaks for the user'), 'speaks_for_the_user');
        assert.equal(slugId('Tone!', ['tone']), 'tone_2');
        assert.equal(slugId('***'), 'item');
    });

    it('never makes a reserved id or a reserved name', () => {
        for (const reserved of ['__proto__', 'prototype', 'constructor']) {
            assert.ok(isReservedKey(reserved));
            assert.notEqual(slugId(reserved), reserved);
            assert.notEqual(uniqueName(reserved, []), reserved);
        }
        assert.equal(isReservedKey('tone'), false);
        assert.equal(slugId('__proto__'), 'proto');
        assert.equal(slugId('constructor'), 'constructor_id');
        assert.equal(uniqueName('__proto__', []), '__proto__ preset');
    });
});

describe('upgradePreset', () => {
    it('turns a reply sensor into one turn with your message, measured every reply', () => {
        const upgraded = upgradePreset(legacyPreset({ sensors: [legacySensor({ scope: 'reply' })] }));
        assert.deepEqual(
            [upgraded.sensors[0].turns, upgraded.sensors[0].includeContext, upgraded.sensors[0].includeUser, upgraded.sensors[0].measureEvery],
            [1, false, true, 1],
        );
    });

    it('turns a story sensor into the old window and interval, with context and without your messages', () => {
        const upgraded = upgradePreset(legacyPreset());
        assert.deepEqual(
            [upgraded.sensors[0].turns, upgraded.sensors[0].includeContext, upgraded.sensors[0].includeUser, upgraded.sensors[0].measureEvery],
            [7, true, false, 2],
        );
        assert.equal(upgraded.storyWindow, undefined);
        assert.equal(upgraded.storyEvery, undefined);
        assert.equal(upgraded.sensors[0].scope, undefined);
    });

    it('renames the four old references in the question and in every description', () => {
        const upgraded = upgradePreset(legacyPreset());
        assert.equal(upgraded.sensors[0].question, 'How well does `latest_turns` match the intent of `context`?');
        assert.equal(upgraded.sensors[0].levels[0], 'The `player_message` is ignored.');
        assert.equal(upgraded.sensors[0].levels[4], 'The `latest_turn` fits.');
    });

    it('leaves a nested reference alone so the editor can flag it', () => {
        const upgraded = upgradePreset(legacyPreset({
            sensors: [legacySensor({ question: 'Does `recent_story` match `instructions.character`?' })],
        }));
        assert.equal(upgraded.sensors[0].question, 'Does `latest_turns` match `instructions.character`?');
        assert.equal(legacyReference(upgraded.sensors[0]), 'instructions.character');
        assert.equal(legacyReference(sensor()), '');
    });

    it('stamps the preset with the version it now holds', () => {
        assert.equal(upgradePreset(legacyPreset()).jeved, SCHEMA_VERSION);
        assert.equal(upgradePreset(preset()).jeved, SCHEMA_VERSION);
    });

    it('gives a schema 2 sensor the score type and an empty option list', () => {
        const upgraded = upgradePreset({ jeved: 2, sensors: [{ id: 'tone', label: 'Tone' }], rules: [] });
        assert.equal(upgraded.sensors[0].type, 'score');
        assert.deepEqual(upgraded.sensors[0].options, []);
    });

    it('leaves a type a newer file already states alone', () => {
        const upgraded = upgradePreset({ jeved: 3, sensors: [{ id: 'mood', type: 'choice', options: [{ name: 'calm' }] }], rules: [] });
        assert.equal(upgraded.sensors[0].type, 'choice');
        assert.deepEqual(upgraded.sensors[0].options, [{ name: 'calm' }]);
    });

    it('changes nothing the second time it runs', () => {
        const once = upgradePreset(legacyPreset());
        const twice = upgradePreset(structuredClone(once));
        assert.deepEqual(twice, once);
    });

    it('does not throw on junk', () => {
        assert.equal(upgradePreset(null), null);
        assert.deepEqual(upgradePreset({ sensors: 'nope' }).sensors, 'nope');
        assert.deepEqual(upgradePreset({ sensors: [null, 5] }).sensors, [null, 5]);
    });

    it('gives a schema 2 sensor with no turns the defaults the old build supplied', () => {
        const upgraded = upgradePreset({ jeved: 2, sensors: [{ id: 'tone', label: 'Tone' }], rules: [] });
        assert.deepEqual(
            [upgraded.sensors[0].turns, upgraded.sensors[0].includeContext, upgraded.sensors[0].includeUser, upgraded.sensors[0].measureEvery],
            [1, false, true, 1],
        );
    });

    it('turns on a group that a preset of its schema left out of the map', () => {
        for (const older of [{ jeved: 2, sensors: [], rules: [] }, legacyPreset()]) {
            const upgraded = upgradePreset({ ...older, contextGroups: { persona: false } });
            assert.equal(upgraded.contextGroups.persona, false);
            assert.equal(upgraded.contextGroups.main_prompt, true);
            assert.equal(upgraded.contextGroups.scenario, true);
        }
    });

    it('leaves plain normalisation defaulting a group that is not in the map off', () => {
        assert.equal(normaliseContextGroups({ contextGroups: { persona: false } }).contextGroups.main_prompt, false);
    });

    it('leaves a preset from a newer Jeved untouched', () => {
        const future = { jeved: 9, sensors: [{ id: 'tone', scope: 'story' }], storyWindow: 4, mystery: true };
        assert.deepEqual(upgradePreset(future), { jeved: 9, sensors: [{ id: 'tone', scope: 'story' }], storyWindow: 4, mystery: true });
    });
});

describe('presetVersion', () => {
    it('believes the number the file states', () => {
        assert.equal(presetVersion({ jeved: 1, ...preset() }), 1);
        assert.equal(presetVersion({ jeved: 2, ...legacyPreset() }), 2);
        assert.equal(presetVersion({ jeved: 7 }), 7);
    });

    it('reads the shape only when the file states no number', () => {
        assert.equal(presetVersion(legacyPreset()), 1);
        assert.equal(presetVersion(preset()), 2);
        assert.equal(presetVersion({ sensors: [], rules: [] }), 2);
        assert.equal(presetVersion({ sensors: 'nope' }), 2);
    });

    it('ignores a version that is not a usable number', () => {
        assert.equal(presetVersion({ jeved: 'two', ...legacyPreset() }), 1);
        assert.equal(presetVersion({ jeved: 0, ...preset() }), 2);
    });
});

describe('normaliseContextGroups', () => {
    it('ticks every context group and keeps the ones you turned off', () => {
        assert.deepEqual(normaliseContextGroups(legacyPreset()).contextGroups, Object.fromEntries(CONTEXT_KEYS.map(key => [key, true])));
        const kept = normaliseContextGroups(preset({ contextGroups: { persona: false, description: true, junk: true } }));
        assert.equal(kept.contextGroups.persona, false);
        assert.equal(kept.contextGroups.description, true);
        assert.equal(kept.contextGroups.junk, undefined);
    });

    it('leaves a group this preset never saw turned off', () => {
        const older = normaliseContextGroups({ contextGroups: { main_prompt: true } });
        assert.equal(older.contextGroups.main_prompt, true);
        assert.equal(older.contextGroups.persona, false);
        assert.equal(older.contextGroups.description, false);
    });

    it('does not throw on junk', () => {
        assert.equal(normaliseContextGroups({ contextGroups: 'nope' }).contextGroups.persona, true);
    });
});

describe('export and import', () => {
    it('writes the preset with its name and nothing else', () => {
        const data = exportPreset(BUILT_IN, builtInPreset());
        assert.equal(data.jeved, SCHEMA_VERSION);
        assert.equal(data.name, BUILT_IN);
        assert.equal(data.apiKey, undefined);
        assert.equal(data.endpoint, undefined);
        assert.equal(data.sensors.length, 7);
        assert.equal(exportFileName('My preset'), 'jeved-my_preset.json');
    });

    it('imports under a new name when the name is taken', () => {
        const data = exportPreset(BUILT_IN, builtInPreset());
        const result = importPreset(data, [BUILT_IN], { parse });
        assert.deepEqual(result.problems, []);
        assert.equal(result.name, 'Director (2)');
        assert.equal(result.preset.name, undefined);
        assert.equal(result.preset.jeved, SCHEMA_VERSION);
    });

    it('keeps the least confidence of a condition and of an exception', () => {
        const data = exportPreset('Shared', preset({
            rules: [rule({
                conditions: [{ sensor: 'tone', op: 'below', value: 1, minConfidence: 0.7 }],
                skipWhen: { sensor: 'tone', op: 'above', value: 3, minConfidence: 0.4 },
            })],
        }));
        assert.equal(data.rules[0].conditions[0].minConfidence, 0.7);
        const { preset: imported } = importPreset(data, []);
        assert.equal(imported.rules[0].conditions[0].minConfidence, 0.7);
        assert.equal(imported.rules[0].skipWhen.minConfidence, 0.4);
    });

    it('keeps the type and the options of a choice sensor through a round trip', () => {
        const data = exportPreset('Shared', preset({
            sensors: [choiceSensor()],
            rules: [rule({ conditions: [{ sensor: 'mood', op: 'is_not', value: 'calm' }] })],
        }));
        const { preset: imported, problems } = importPreset(data, []);
        assert.deepEqual(problems, []);
        assert.equal(imported.sensors[0].type, 'choice');
        assert.deepEqual(imported.sensors[0].options.map(option => option.name), ['calm', 'angry']);
        assert.equal(imported.rules[0].conditions[0].value, 'calm');
    });

    it('carries only the fields Jeved knows, so nothing unknown is re-exported', () => {
        const data = exportPreset('Shared', preset({
            sensors: [sensor({ mystery: 'keep me', levels: ['a', 'b', 'c', 'd', 'e'] })],
            rules: [rule({ hack: 1, conditions: [{ sensor: 'tone', op: 'below', value: 1, extra: 'x' }], skipWhen: { sensor: 'tone', op: 'above', value: 3, extra: 'y' } })],
        }));
        data.leftover = { anything: true };
        const { preset: imported } = importPreset(data, []);

        assert.equal(imported.leftover, undefined);
        assert.equal(imported.sensors[0].mystery, undefined);
        assert.equal(imported.sensors[0].question, sensor().question);
        assert.equal(imported.rules[0].hack, undefined);
        assert.equal(imported.rules[0].conditions[0].extra, undefined);
        assert.equal(imported.rules[0].conditions[0].value, 1);
        assert.equal(imported.rules[0].skipWhen.extra, undefined);
        assert.equal(imported.rules[0].skipWhen.value, 3);
        assert.deepEqual(Object.keys(exportPreset('Shared', imported)).filter(key => key === 'leftover'), []);
    });

    it('imports a rule that carries a script turned off, and lists it in the summary', () => {
        const data = exportPreset('Shared', preset({
            rules: [
                rule({ id: 'quiet', label: 'Quiet', script: '/echo hello', enabled: true }),
                rule({ id: 'plain', label: 'Plain', enabled: true }),
                rule({ id: 'off', label: 'Off', enabled: false }),
            ],
        }));
        const result = importPreset(data, [], { parse });
        assert.deepEqual(result.preset.rules.map(item => [item.id, item.enabled]), [['quiet', false], ['plain', true], ['off', false]]);
        assert.deepEqual(result.disabled, ['Quiet']);
        assert.equal(result.preset.rules[0].script, '/echo hello', 'the dialog can show the script it is warning about');
    });

    it('refuses a file whose script the parser cannot read', () => {
        const data = exportPreset('Shared', preset({ rules: [rule({ script: UNPARSABLE })] }));
        const result = importPreset(data, [], { parse });
        assert.equal(result.preset, undefined);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], /can't read this script/);
    });

    it('imports a schema 2 sensor that never stated its turns', () => {
        const data = exportPreset('Shared', preset());
        delete data.sensors[0].turns;
        delete data.sensors[0].measureEvery;
        const result = importPreset(data, []);
        assert.deepEqual(result.problems, []);
        assert.deepEqual([result.preset.sensors[0].turns, result.preset.sensors[0].includeUser], [1, true]);
    });

    it('imports nothing when the file has a problem', () => {
        const result = importPreset(preset({ rules: [rule({ conditions: [{ sensor: 'gone', op: 'below', value: 1 }] })] }), []);
        assert.equal(result.preset, undefined);
        assert.equal(result.problems.length, 1);
    });

    it('brings an older file up to date on the way in', () => {
        const result = importPreset({ jeved: 1, name: 'Old', ...legacyPreset() }, []);
        assert.deepEqual(result.problems, []);
        assert.equal(result.preset.sensors[0].turns, 7);
        assert.equal(result.preset.sensors[0].measureEvery, 2);
        assert.equal(result.preset.sensors[0].question, 'How well does `latest_turns` match the intent of `context`?');
        assert.equal(result.preset.storyWindow, undefined);
        assert.equal(result.preset.contextGroups.persona, true);
    });

    it('brings a file with no version at all up to date', () => {
        const result = importPreset({ name: 'Ancient', ...legacyPreset() }, []);
        assert.deepEqual(result.problems, []);
        assert.equal(result.name, 'Ancient');
        assert.equal(result.preset.sensors[0].includeContext, true);
    });

    it('leaves the file it was handed alone', () => {
        const data = { jeved: 1, name: 'Old', ...legacyPreset() };
        importPreset(data, []);
        assert.equal(data.sensors[0].scope, 'story');
        assert.equal(data.storyWindow, 7);
    });

    it('refuses a file from a newer Jeved with one message, and leaves it alone', () => {
        const ahead = SCHEMA_VERSION + 1;
        const data = { jeved: ahead, name: 'Future', ...preset() };
        const before = structuredClone(data);
        const result = importPreset(data, []);
        assert.equal(result.preset, undefined);
        assert.equal(result.problems.length, 1);
        assert.match(result.problems[0], new RegExp(`A newer Jeved made this preset \\(file version ${ahead}\\)`));
        assert.deepEqual(data, before);
    });

    it('renames an option in every condition and exception that names it', () => {
        const rules = [
            rule({ conditions: [{ sensor: 'mood', op: 'is', value: 'calm' }], skipWhen: { sensor: 'mood', op: 'is_not', value: 'calm' } }),
            rule({ id: 'other', conditions: [{ sensor: 'mood', op: 'is', value: 'angry' }, { sensor: 'tone', op: 'below', value: 1 }] }),
        ];
        const rename = new Map([['calm', 'settled']]);
        assert.equal(renameOption(rules, 'mood', rename), 2);
        assert.equal(rules[0].conditions[0].value, 'settled');
        assert.equal(rules[0].skipWhen.value, 'settled');
        assert.equal(rules[1].conditions[0].value, 'angry');
        assert.equal(rules[1].conditions[1].value, 1);
        assert.equal(renameOption(rules, 'mood', rename), 0);
        assert.equal(renameOption(null, 'mood', rename), 0);
    });

    it('swaps two option names in one pass instead of chaining them', () => {
        const rules = [rule({ conditions: [{ sensor: 'mood', op: 'is', value: 'calm' }, { sensor: 'mood', op: 'is', value: 'angry' }] })];
        assert.equal(renameOption(rules, 'mood', new Map([['calm', 'angry'], ['angry', 'calm']])), 2);
        assert.deepEqual(rules[0].conditions.map(condition => condition.value), ['angry', 'calm']);
    });

    it('refuses an action this Jeved does not know instead of quietly nudging', () => {
        const result = importPreset(exportPreset('Odd', preset({ rules: [rule({ action: 'teleport' })] })), []);
        assert.equal(result.preset, undefined);
        assert.deepEqual(result.problems, ["rule 'flat': the action must be 'nudge' or 'swipe'"]);
    });

    it('refuses a file that is not a preset at all', () => {
        assert.deepEqual(importPreset(null, []).problems, ['The file does not hold a preset.']);
        assert.deepEqual(importPreset('nope', []).problems, ['The file does not hold a preset.']);
    });
});
