import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { builtInPreset } from '../src/defaults.js';
import { buildRequest, carryForwardIds, groupSensors, groupSpec, measuredSensors, neededSensorIds, requestKey } from '../src/sensors.js';

const ids = preset => measuredSensors(preset).map(sensor => sensor.id);
const keys = groups => groups.map(group => group.ids);

const user = mes => ({ mes, is_user: true });
const narrator = mes => ({ mes });

function sensor(overrides = {}) {
    return {
        id: 'a',
        label: 'A',
        watch: true,
        turns: 1,
        includeContext: false,
        includeUser: true,
        measureEvery: 1,
        question: 'q',
        levels: ['a', 'b', 'c', 'd', 'e'],
        ...overrides,
    };
}

const presetOf = (...sensors) => ({ sensors, rules: [] });
const substitute = value => String(value ?? '');

describe('which sensors are measured', () => {
    it('measures only what the enabled rules of the built-in preset name', () => {
        const preset = builtInPreset();
        assert.deepEqual([...neededSensorIds(preset)].sort(), ['change', 'repeats', 'tension', 'tone']);
        assert.deepEqual(ids(preset), ['change', 'tension', 'repeats', 'tone']);
    });

    it('adds a sensor that is watched and drops one whose rule is turned off', () => {
        const preset = builtInPreset();
        preset.sensors.find(sensor => sensor.id === 'world').watch = true;
        preset.rules.find(rule => rule.id === 'drift').enabled = false;
        assert.deepEqual(ids(preset), ['change', 'tension', 'repeats', 'world']);
    });

    it('counts a sensor that only an unless condition names', () => {
        const preset = builtInPreset();
        preset.rules = [{ ...preset.rules[1], conditions: [{ sensor: 'change', op: 'below', value: 2 }], skipWhen: { sensor: 'cost', op: 'above', value: 2 } }];
        assert.deepEqual(ids(preset), ['change', 'cost']);
    });

    it('leaves out a sensor that cannot be asked', () => {
        const preset = builtInPreset();
        preset.sensors.find(sensor => sensor.id === 'change').question = '  ';
        assert.deepEqual(ids(preset), ['tension', 'repeats', 'tone']);
    });

    it('needs two options before it asks a choice sensor, and asks a yes or no sensor with none', () => {
        const one = sensor({ id: 'mood', type: 'choice', levels: [], options: [{ name: 'calm', description: '' }] });
        const two = sensor({ id: 'mood', type: 'choice', levels: [], options: [{ name: 'calm', description: '' }, { name: 'angry', description: '' }] });
        assert.deepEqual(ids(presetOf(one)), []);
        assert.deepEqual(ids(presetOf(two)), ['mood']);
        assert.deepEqual(ids(presetOf(sensor({ id: 'danger', type: 'noul', levels: [] }))), ['danger']);
    });
});

describe('the question a sensor of each type carries', () => {
    const askFor = (...list) => {
        const [group] = groupSensors(presetOf(...list));
        return buildRequest([narrator('hi')], 0, groupSpec(group), null, substitute).questions;
    };

    it('carries the type, the options and every description', () => {
        const questions = askFor(
            sensor({ id: 'mood', type: 'choice', levels: [], options: [{ name: 'calm', description: 'Settled.' }, { name: 'angry', description: 'Furious.' }] }),
            sensor({ id: 'danger', type: 'noul', levels: ['No.', 'Yes.'] }),
        );
        assert.equal(questions.mood.type, 'choice');
        assert.deepEqual(questions.mood.options, [{ name: 'calm', description: 'Settled.' }, { name: 'angry', description: 'Furious.' }]);
        assert.equal(questions.danger.type, 'noul');
        assert.deepEqual(questions.danger.levels, ['No.', 'Yes.']);
    });

    it('sends every description of a scale longer than five', () => {
        const levels = Array.from({ length: 8 }, (_, position) => `level ${position}`);
        assert.deepEqual(askFor(sensor({ levels })).a.levels, levels);
    });
});

describe('grouping sensors into calls', () => {
    it('gives every distinct set of reading settings its own call', () => {
        const groups = groupSensors(presetOf(
            sensor({ id: 'a' }),
            sensor({ id: 'b', turns: 5, includeUser: false }),
            sensor({ id: 'c', turns: 5, includeUser: false, includeContext: true }),
            sensor({ id: 'd' }),
        ));
        assert.deepEqual(keys(groups), [['a', 'd'], ['b'], ['c']]);
    });

    it('shares one call between sensors that differ only in how often they run', () => {
        const groups = groupSensors(presetOf(
            sensor({ id: 'a', measureEvery: 1 }),
            sensor({ id: 'b', measureEvery: 3 }),
        ), { due: 3 });
        assert.deepEqual(keys(groups), [['a', 'b']]);
    });

    it('leaves out a sensor that is not due on this reply', () => {
        const preset = presetOf(sensor({ id: 'a', measureEvery: 1 }), sensor({ id: 'b', measureEvery: 3 }));
        assert.deepEqual(keys(groupSensors(preset, { due: 2 })), [['a']]);
        assert.deepEqual(keys(groupSensors(preset, { due: 3 })), [['a', 'b']]);
        assert.deepEqual(groupSensors(presetOf(sensor({ id: 'b', measureEvery: 3 })), { due: 2 }), []);
    });

    it('narrows the call to the sensors it is asked for', () => {
        const preset = presetOf(sensor({ id: 'a' }), sensor({ id: 'b' }), sensor({ id: 'c', turns: 4 }));
        assert.deepEqual(keys(groupSensors(preset, { only: new Set(['b', 'c']) })), [['b'], ['c']]);
        assert.deepEqual(groupSensors(preset, { only: new Set() }), []);
    });

    it('captures the wording of a group, so a later edit cannot change it', () => {
        const watched = sensor({ id: 'a', question: 'original?' });
        const [group] = groupSensors(presetOf(watched));
        const spec = groupSpec(group);
        watched.question = 'edited?';
        watched.levels[0] = 'edited';
        assert.deepEqual(spec.sensors.map(item => item.question), ['original?']);
        assert.equal(spec.sensors[0].levels[0], 'a');
        assert.deepEqual(buildRequest([narrator('hi')], 0, spec, null, substitute).questions.a.question, 'original?');
    });

    it('keeps only the sensors a narrowed group still asks for', () => {
        const [group] = groupSensors(presetOf(sensor({ id: 'a' }), sensor({ id: 'b' })));
        assert.deepEqual(groupSpec({ ...group, ids: ['b'] }).sensors.map(item => item.id), ['b']);
    });

    it('gives the same key to two requests that ask for the same thing', () => {
        const preset = presetOf(sensor({ id: 'a' }), sensor({ id: 'b' }), sensor({ id: 'c', turns: 4 }));
        const all = groupSensors(preset).map(groupSpec);
        assert.equal(requestKey(all), requestKey([...all].reverse()));
        assert.notEqual(requestKey(all), requestKey(groupSensors(preset, { only: new Set(['c']) }).map(groupSpec)));
    });

    it('builds a question map that a reserved key cannot reach through', () => {
        const [group] = groupSensors(presetOf(sensor()));
        const request = buildRequest([narrator('hi')], 0, group, null, substitute);
        assert.equal(Object.getPrototypeOf(request.questions), null);
        assert.deepEqual(Object.keys(request.questions), ['a']);
    });
});

describe('the turn text a call carries', () => {
    const chat = [user('u0'), narrator('c0'), user('u1'), narrator('c1'), narrator('c2'), user('u2'), narrator('c3')];
    const build = (index, overrides, context = null) => {
        const [group] = groupSensors(presetOf(sensor(overrides)));
        return buildRequest(chat, index, group, context, substitute).state;
    };

    it('sends one reply with the message before it', () => {
        assert.deepEqual(build(3, { turns: 1, includeUser: true }), { player_message: 'u1', latest_turn: 'c1' });
    });

    it('sends one reply alone when your messages are left out', () => {
        assert.deepEqual(build(3, { turns: 1, includeUser: false }), { latest_turn: 'c1' });
    });

    it('joins several replies with a blank line, oldest first', () => {
        assert.deepEqual(build(6, { turns: 3, includeUser: false }), { latest_turns: 'c1\n\nc2\n\nc3' });
    });

    it('labels each turn when your messages come along', () => {
        assert.deepEqual(build(3, { turns: 2, includeUser: true }), {
            latest_turns: 'Player:\nu0\n\nNarrator:\nc0\n\n---\n\nPlayer:\nu1\n\nNarrator:\nc1',
        });
    });

    it('repeats the one message before two replies in a row', () => {
        assert.deepEqual(build(4, { turns: 2, includeUser: true }), {
            latest_turns: 'Player:\nu1\n\nNarrator:\nc1\n\n---\n\nPlayer:\nu1\n\nNarrator:\nc2',
        });
    });

    it('never reaches past the reply it is measuring', () => {
        assert.deepEqual(build(3, { turns: 10, includeUser: false }), { latest_turns: 'c0\n\nc1' });
    });

    it('takes a greeting with no message before it', () => {
        const greeting = [narrator('hello there'), user('u0'), narrator('c0')];
        const [group] = groupSensors(presetOf(sensor({ turns: 2, includeUser: true })));
        assert.deepEqual(buildRequest(greeting, 2, group, null, substitute).state, {
            latest_turns: 'Player:\n\n\nNarrator:\nhello there\n\n---\n\nPlayer:\nu0\n\nNarrator:\nc0',
        });
        assert.deepEqual(build(1, { turns: 1, includeUser: true }), { player_message: 'u0', latest_turn: 'c0' });
    });

    it('asks for fewer turns than the chat holds', () => {
        const short = [user('u0'), narrator('c0')];
        const [group] = groupSensors(presetOf(sensor({ turns: 5, includeUser: false })));
        assert.deepEqual(buildRequest(short, 1, group, null, substitute).state, { latest_turns: 'c0' });
    });

    it('adds the context only to a sensor that asked for it', () => {
        const context = { description: 'a knight' };
        assert.deepEqual(build(3, { turns: 1, includeContext: true }, context).context, context);
        assert.equal(build(3, { turns: 1, includeContext: false }, context).context, undefined);
        assert.deepEqual(build(3, { turns: 1, includeContext: true }, {}).context, {});
    });
});

describe('which scores carry forward', () => {
    it('carries a sensor that reads several turns', () => {
        assert.deepEqual(carryForwardIds(presetOf(sensor({ id: 'slow', turns: 5 }))), ['slow']);
    });

    it('carries a sensor that is measured now and then', () => {
        assert.deepEqual(carryForwardIds(presetOf(sensor({ id: 'rare', measureEvery: 4 }))), ['rare']);
    });

    it('never carries a one-turn sensor that runs on every reply', () => {
        assert.deepEqual(carryForwardIds(presetOf(sensor({ id: 'fast' }))), []);
    });

    it('carries the story and repeats sensors of the built-in preset and not the reply ones', () => {
        const preset = builtInPreset();
        assert.deepEqual(carryForwardIds(preset), ['repeats', 'tone']);
    });
});
