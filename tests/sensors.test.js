import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { builtInPreset } from '../src/defaults.js';
import {
    buildRequest, firesInPhase, groupSensors, groupSpec, hasInput, labelsFor, measuredSensors, momentOf, momentOfRule,
    neededSensorIds, phaseOfRule, requestKey,
} from '../src/sensors.js';
import { narrator, user } from './helpers/chat.js';

const ids = preset => measuredSensors(preset).map(sensor => sensor.id);
const keys = groups => groups.map(group => group.ids);

function sensor(overrides = {}) {
    return {
        id: 'a',
        label: 'A',
        watch: true,
        user: 1,
        assistant: 1,
        context: 'none',
        contextPieces: [],
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
        assert.deepEqual([...neededSensorIds(preset)].sort(), ['attention', 'cost', 'house', 'repeats', 'scene', 'speaks', 'tension', 'tone']);
        assert.deepEqual(ids(preset), ['tension', 'cost', 'speaks', 'repeats', 'tone', 'scene', 'attention', 'house']);
    });

    it('makes three calls for each reply and one for each message, and leaves the off rules alone', () => {
        const preset = builtInPreset();
        assert.deepEqual(keys(groupSensors(preset, { moment: 'reply' })), [
            ['tension', 'cost', 'speaks', 'attention'],
            ['repeats'],
            ['tone'],
        ]);
        assert.deepEqual(keys(groupSensors(preset, { moment: 'message' })), [['scene']]);

        const measured = new Set(ids(preset));
        const off = ['change', 'world', 'closeness', 'picture_striking', 'picture_now', 'mood'];
        assert.deepEqual(off.filter(id => measured.has(id)), []);
    });

    it('asks a repeating sensor once per entry and gives it no call while its list is empty', () => {
        const preset = builtInPreset();
        const entriesOf = () => ['no cliffhangers', 'Stay in scene'];
        const [group] = groupSensors(preset, { moment: 'reply', only: new Set(['house']), entriesOf });
        const request = buildRequest([narrator('hi')], 0, groupSpec(group), null, substitute);
        assert.deepEqual(Object.keys(request.questions), ['house#0', 'house#1']);
        assert.equal(request.questions['house#0'].question, '`latest_turn` follows this rule: no cliffhangers');
        assert.deepEqual(request.plan.map(step => step.entry), ['no cliffhangers', 'Stay in scene']);
        assert.deepEqual(groupSensors(preset, { moment: 'reply', only: new Set(['house']) }), []);
    });

    it('adds a sensor that is watched and drops one whose rule is turned off', () => {
        const preset = builtInPreset();
        preset.sensors.find(sensor => sensor.id === 'world').watch = true;
        preset.rules.find(rule => rule.id === 'drift').enabled = false;
        assert.deepEqual(ids(preset), ['cost', 'speaks', 'repeats', 'world', 'scene', 'attention', 'house']);
    });

    it('counts a sensor that only an unless condition names', () => {
        const preset = builtInPreset();
        preset.rules = [{ ...preset.rules[1], conditions: [{ sensor: 'change', op: 'below', value: 2 }], skipWhen: { sensor: 'cost', op: 'above', value: 2 } }];
        assert.deepEqual(ids(preset), ['change', 'cost']);
    });

    it('leaves out a sensor that cannot be asked', () => {
        const preset = builtInPreset();
        preset.sensors.find(sensor => sensor.id === 'cost').question = '  ';
        assert.deepEqual(ids(preset), ['tension', 'speaks', 'repeats', 'tone', 'scene', 'attention', 'house']);
    });

    it('leaves out a sensor that reads no message at all', () => {
        assert.equal(hasInput(sensor({ user: 0, assistant: 0 })), false);
        assert.deepEqual(ids(presetOf(sensor({ user: 0, assistant: 0 }))), []);
        assert.deepEqual(ids(presetOf(sensor({ user: 0, assistant: 1 }))), ['a']);
        assert.deepEqual(ids(presetOf(sensor({ user: 1, assistant: 0 }))), ['a']);
    });

    it('needs two options before it asks a choice sensor, and asks a yes or no sensor with none', () => {
        const one = sensor({ id: 'mood', type: 'choice', levels: [], options: [{ name: 'calm', description: '' }] });
        const two = sensor({ id: 'mood', type: 'choice', levels: [], options: [{ name: 'calm', description: '' }, { name: 'angry', description: '' }] });
        assert.deepEqual(ids(presetOf(one)), []);
        assert.deepEqual(ids(presetOf(two)), ['mood']);
        assert.deepEqual(ids(presetOf(sensor({ id: 'danger', type: 'noul', levels: [] }))), ['danger']);
    });
});

describe('when a sensor runs', () => {
    it('runs before the reply only when it asks for no assistant message', () => {
        assert.equal(momentOf(sensor({ user: 1, assistant: 0 })), 'message');
        assert.equal(momentOf(sensor({ user: 0, assistant: 1 })), 'reply');
        assert.equal(momentOf(sensor({ user: 4, assistant: 1 })), 'reply');
        assert.equal(momentOf(sensor({ user: 0, assistant: 0 })), 'message');
    });

    it('takes the reply moment unless every sensor a rule reads runs before the reply', () => {
        const sensors = [
            sensor({ id: 'scene', user: 1, assistant: 0 }),
            sensor({ id: 'mood', user: 1, assistant: 0 }),
            sensor({ id: 'tone', user: 0, assistant: 1 }),
        ];
        const rule = (...used) => ({ conditions: used.map(id => ({ sensor: id, op: 'below', value: 1 })) });
        assert.equal(momentOfRule(rule('scene'), sensors), 'message');
        assert.equal(momentOfRule(rule('scene', 'mood'), sensors), 'message');
        assert.equal(momentOfRule(rule('scene', 'tone'), sensors), 'reply');
        assert.equal(momentOfRule(rule('tone'), sensors), 'reply');
    });

    it('counts the exception sensor and an unknown sensor as a reply sensor', () => {
        const sensors = [sensor({ id: 'scene', user: 1, assistant: 0 }), sensor({ id: 'tone', user: 0, assistant: 1 })];
        const gated = {
            conditions: [{ sensor: 'scene', op: 'is', value: 'x' }],
            skipWhen: { sensor: 'tone', op: 'below', value: 1 },
        };
        assert.equal(momentOfRule(gated, sensors), 'reply');
        assert.equal(momentOfRule({ conditions: [{ sensor: 'gone', op: 'below', value: 1 }] }, sensors), 'reply');
        assert.equal(momentOfRule({ conditions: [] }, sensors), 'reply');
    });
});

describe('the phase a rule fires in', () => {
    const sensors = [sensor({ id: 'scene', user: 1, assistant: 0 }), sensor({ id: 'tone', user: 0, assistant: 1 })];
    const on = (id, action) => ({ action, conditions: [{ sensor: id, op: 'below', value: 1 }] });

    it('takes the phase its action is fixed to, whatever the sensors read', () => {
        assert.equal(phaseOfRule(on('scene', 'swipe'), sensors), 'after-reply');
        assert.equal(phaseOfRule(on('tone', 'nudge'), sensors), 'before-generation');
        assert.equal(phaseOfRule(on('scene', 'script'), sensors), 'after-reply');
    });

    it('takes the moment of the rule when the action fixes no phase', () => {
        assert.equal(phaseOfRule(on('scene', 'open'), sensors), 'before-generation');
        assert.equal(phaseOfRule(on('tone', 'open'), sensors), 'after-reply');
    });

    it('answers what fires in one phase and what does not', () => {
        assert.equal(firesInPhase(on('scene', 'open'), 'before-generation', sensors), true);
        assert.equal(firesInPhase(on('scene', 'open'), 'after-reply', sensors), false);
        assert.equal(firesInPhase(on('scene', 'swipe'), 'after-reply', sensors), true);
    });
});

describe('the labels a sensor produces', () => {
    it('names only the labels its settings fill', () => {
        assert.deepEqual(labelsFor(sensor({ user: 1, assistant: 1 })), ['latest_turn', 'player_message']);
        assert.deepEqual(labelsFor(sensor({ user: 0, assistant: 1 })), ['latest_turn']);
        assert.deepEqual(labelsFor(sensor({ user: 1, assistant: 0 })), ['player_message']);
        assert.deepEqual(labelsFor(sensor({ user: 0, assistant: 5 })), ['latest_turn', 'history']);
        assert.deepEqual(labelsFor(sensor({ user: 3, assistant: 0 })), ['player_message', 'history']);
        assert.deepEqual(labelsFor(sensor({ user: 0, assistant: 1, context: 'all' })), ['latest_turn', 'context']);
        assert.deepEqual(labelsFor(sensor({ user: 0, assistant: 1, context: 'custom' })), ['latest_turn', 'context']);
        assert.deepEqual(labelsFor(sensor({ user: 0, assistant: 1, context: 'none' })), ['latest_turn']);
        assert.deepEqual(labelsFor(sensor({ user: 0, assistant: 0 })), []);
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
            sensor({ id: 'b', user: 0, assistant: 5 }),
            sensor({ id: 'c', user: 0, assistant: 5, context: 'all' }),
            sensor({ id: 'd' }),
        ));
        assert.deepEqual(keys(groups), [['a', 'd'], ['b'], ['c']]);
    });

    it('shares one call between sensors with the same three settings', () => {
        const groups = groupSensors(presetOf(
            sensor({ id: 'a', user: 2, assistant: 3, context: 'all' }),
            sensor({ id: 'b', user: 2, assistant: 3, context: 'all' }),
        ));
        assert.deepEqual(keys(groups), [['a', 'b']]);
    });

    it('shares one call between two custom sensors that ticked the same pieces, whatever the order', () => {
        const custom = pieces => ({ context: 'custom', contextPieces: pieces });
        const groups = groupSensors(presetOf(
            sensor({ id: 'a', ...custom(['persona', 'description']) }),
            sensor({ id: 'b', ...custom(['description', 'persona', 'persona']) }),
            sensor({ id: 'c', ...custom(['description']) }),
            sensor({ id: 'd', context: 'all' }),
        ));
        assert.deepEqual(keys(groups), [['a', 'b'], ['c'], ['d']]);
    });

    it('keeps a sensor that sends everything apart from one that ticked every piece by hand', () => {
        const groups = groupSensors(presetOf(
            sensor({ id: 'a', context: 'all' }),
            sensor({ id: 'b', context: 'custom', contextPieces: ['description'] }),
        ));
        assert.deepEqual(keys(groups), [['a'], ['b']]);
    });

    it('keeps the two moments in separate calls and asks for one moment at a time', () => {
        const preset = presetOf(
            sensor({ id: 'scene', user: 1, assistant: 0 }),
            sensor({ id: 'mood', user: 1, assistant: 0 }),
            sensor({ id: 'tone', user: 0, assistant: 1 }),
        );
        assert.deepEqual(keys(groupSensors(preset, { moment: 'message' })), [['scene', 'mood']]);
        assert.deepEqual(keys(groupSensors(preset, { moment: 'reply' })), [['tone']]);
        assert.deepEqual(keys(groupSensors(preset)), [['scene', 'mood'], ['tone']]);
    });

    it('narrows the call to the sensors it is asked for', () => {
        const preset = presetOf(sensor({ id: 'a' }), sensor({ id: 'b' }), sensor({ id: 'c', assistant: 4 }));
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
        const preset = presetOf(sensor({ id: 'a' }), sensor({ id: 'b' }), sensor({ id: 'c', assistant: 4 }));
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

describe('the text a call carries at the reply moment', () => {
    const chat = [user('u0'), narrator('c0'), user('u1'), narrator('c1'), narrator('c2'), user('u2'), narrator('c3')];
    const build = (index, overrides, context = null) => {
        const [group] = groupSensors(presetOf(sensor(overrides)));
        return buildRequest(chat, index, group, context, substitute).state;
    };

    it('sends one reply with the message before it', () => {
        assert.deepEqual(build(3, { user: 1, assistant: 1 }), { latest_turn: 'c1', player_message: 'u1' });
    });

    it('sends one reply alone when no user message is asked for', () => {
        assert.deepEqual(build(3, { user: 0, assistant: 1 }), { latest_turn: 'c1' });
    });

    it('puts the older replies in history, oldest first, with a speaker line', () => {
        assert.deepEqual(build(6, { user: 0, assistant: 3 }), {
            latest_turn: 'c3',
            history: 'Narrator:\nc1\n\nNarrator:\nc2',
        });
    });

    it('mixes older replies and older messages into one history in chat order', () => {
        assert.deepEqual(build(3, { user: 2, assistant: 2 }), {
            latest_turn: 'c1',
            player_message: 'u1',
            history: 'Player:\nu0\n\nNarrator:\nc0',
        });
    });

    it('repeats the one message before two replies in a row', () => {
        assert.deepEqual(build(4, { user: 1, assistant: 1 }), { latest_turn: 'c2', player_message: 'u1' });
    });

    it('never reaches past the reply it is measuring', () => {
        assert.deepEqual(build(3, { user: 0, assistant: 10 }), {
            latest_turn: 'c1',
            history: 'Narrator:\nc0',
        });
    });

    it('takes a greeting with no message before it', () => {
        const greeting = [narrator('hello there'), user('u0'), narrator('c0')];
        const [group] = groupSensors(presetOf(sensor({ user: 2, assistant: 2 })));
        assert.deepEqual(buildRequest(greeting, 2, group, null, substitute).state, {
            latest_turn: 'c0',
            player_message: 'u0',
            history: 'Narrator:\nhello there',
        });
    });

    it('asks for more messages than the chat holds', () => {
        const short = [user('u0'), narrator('c0')];
        const [group] = groupSensors(presetOf(sensor({ user: 0, assistant: 5 })));
        assert.deepEqual(buildRequest(short, 1, group, null, substitute).state, { latest_turn: 'c0' });
    });

    it('adds the context only to a sensor that asked for it', () => {
        const context = { description: 'a knight' };
        assert.deepEqual(build(3, { context: 'all' }, context).context, context);
        assert.deepEqual(build(3, { context: 'custom', contextPieces: ['description'] }, context).context, context);
        assert.equal(build(3, { context: 'none' }, context).context, undefined);
        assert.deepEqual(build(3, { context: 'all' }, {}).context, {});
    });
});

describe('the text a call carries at the message moment', () => {
    const chat = [user('u0'), narrator('c0'), user('u1'), narrator('c1'), user('u2')];
    const build = (index, overrides) => {
        const [group] = groupSensors(presetOf(sensor(overrides)));
        return buildRequest(chat, index, group, null, substitute).state;
    };

    it('sends the judged message on its own', () => {
        assert.deepEqual(build(4, { user: 1, assistant: 0 }), { player_message: 'u2' });
    });

    it('puts the earlier messages in history and never reaches a reply', () => {
        assert.deepEqual(build(4, { user: 3, assistant: 0 }), {
            player_message: 'u2',
            history: 'Player:\nu0\n\nPlayer:\nu1',
        });
    });

    it('sends nothing at all when both counts are zero', () => {
        const [group] = groupSensors(presetOf(sensor({ user: 0, assistant: 0 })));
        assert.equal(group, undefined);
    });
});
