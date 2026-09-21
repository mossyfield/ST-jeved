import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { narrator, user } from './helpers/chat.js';
import { hostStub } from './helpers/host.js';

const registered = new Map();

const context = hostStub({
    macros: {
        category: { MISC: 'misc' },
        register: (name, definition) => registered.set(name, definition),
    },
});

const { answerText, askSensor, fillMacros, initMacros } = await import('../src/macros.js');
const { macroText } = await import('../src/sensor-types.js');
const { getSettings, initSettings } = await import('../src/settings.js');
const { writeScores } = await import('../src/store.js');

const score = { id: 'tension', label: 'Tension', watch: true, type: 'score', user: 1, assistant: 1, context: false, question: 'q', levels: ['a', 'b', 'c', 'd', 'e'], options: [] };
const choice = { id: 'scene', label: 'Scene', watch: true, type: 'choice', user: 1, assistant: 0, context: false, question: 'q', levels: [], options: [{ name: 'fight | flee', description: '' }, { name: 'talk', description: '' }] };
const noul = { id: 'danger', label: 'Danger', watch: true, type: 'noul', user: 0, assistant: 1, context: false, question: 'q', levels: [], options: [] };

function setup() {
    context.extensionSettings = {};
    context.chat = [];
    initSettings();
    const settings = getSettings();
    settings.presets.Test = { description: '', sensors: [score, choice, noul], rules: [] };
    settings.activePreset = 'Test';
    return settings;
}

beforeEach(() => {
    registered.clear();
    setup();
});

describe('the text a macro gives for one answer', () => {
    it('writes a score to one decimal, a choice as its option name and a noul as whole percents', () => {
        assert.equal(macroText(score, 2), '2.0');
        assert.equal(macroText(score, 2.44), '2.4');
        assert.equal(macroText(choice, 'talk'), 'talk');
        assert.equal(macroText(noul, 0.856), '86');
        assert.equal(macroText(noul, 0), '0');
    });

    it('gives an empty text for an answer the sensor cannot read', () => {
        assert.equal(macroText(score, null), '');
        assert.equal(macroText(score, 99), '');
        assert.equal(macroText(choice, 'gone'), '');
        assert.equal(macroText(noul, 'calm'), '');
    });
});

describe('answerText', () => {
    it('reads the newest valid answer from a reply or from your message', () => {
        context.chat = [user('u0'), narrator('c0'), user('u1')];
        writeScores(context.chat[1], { tension: 3 });
        writeScores(context.chat[2], { scene: 'talk' });
        assert.equal(answerText('tension'), '3.0');
        assert.equal(answerText('scene'), 'talk');
    });

    it('prefers the newest answer when several messages hold one', () => {
        context.chat = [narrator('c0'), narrator('c1')];
        writeScores(context.chat[0], { tension: 1 });
        writeScores(context.chat[1], { tension: 4 });
        assert.equal(answerText('tension'), '4.0');
    });

    it('gives an empty text for an unknown sensor, no answer and an answer that no longer fits', () => {
        context.chat = [narrator('c0')];
        assert.equal(answerText('nope'), '');
        assert.equal(answerText('tension'), '');
        writeScores(context.chat[0], { scene: 'gone' });
        assert.equal(answerText('scene'), '');
    });

    it('ignores an answer whose message was edited since', () => {
        context.chat = [narrator('c0')];
        writeScores(context.chat[0], { tension: 3 });
        context.chat[0].mes = 'edited';
        assert.equal(answerText('tension'), '');
    });
});

describe('the jeved macro in a rule instruction', () => {
    it('replaces every reference and leaves other text alone', () => {
        context.chat = [user('u0')];
        writeScores(context.chat[0], { scene: 'talk' });
        assert.equal(fillMacros('The scene is {{jeved::scene}}, so {{user}} waits.'), 'The scene is talk, so {{user}} waits.');
    });

    it('leaves an unknown sensor as an empty text and ignores a name it cannot read', () => {
        assert.equal(fillMacros('[{{jeved::nope}}]'), '[]');
        assert.equal(fillMacros('{{jeved::with space}}'), '{{jeved::with space}}');
        assert.equal(fillMacros(null), '');
    });
});

describe('registering the macro with the host', () => {
    it('registers one unnamed argument and answers through the handler', () => {
        assert.equal(initMacros(), true);
        const definition = registered.get('jeved');
        assert.equal(definition.unnamedArgs.length, 1);
        assert.equal(typeof definition.handler, 'function');

        context.chat = [user('u0')];
        writeScores(context.chat[0], { scene: 'fight | flee' });
        assert.equal(definition.handler({ unnamedArgs: ['scene'] }), 'fight | flee');
        assert.equal(definition.handler({ unnamedArgs: [] }), '');
    });

    it('leaves an instruction alone once the host expands the macro itself', () => {
        context.chat = [user('u0')];
        writeScores(context.chat[0], { scene: 'talk' });
        assert.equal(initMacros(), true);
        assert.equal(fillMacros('The scene is {{jeved::scene}}.'), 'The scene is {{jeved::scene}}.');
    });

    it('does nothing when the host has no macro engine', () => {
        const kept = context.macros;
        context.macros = undefined;
        try {
            assert.equal(initMacros(), false);
        } finally {
            context.macros = kept;
        }
        assert.equal(registered.size, 0);
    });
});

describe('the sensor /jeved-ask builds', () => {
    it('defaults to a noul about the newest reply', () => {
        const sensor = askSensor({}, ' Is anyone in danger? ');
        assert.deepEqual(
            [sensor.type, sensor.user, sensor.assistant, sensor.context, sensor.question],
            ['noul', 0, 1, false, 'Is anyone in danger?'],
        );
    });

    it('splits the options on commas and the levels on bars', () => {
        const picker = askSensor({ type: 'choice', options: ' calm , angry ,, ' }, 'q');
        assert.deepEqual(picker.options, [{ name: 'calm', description: '' }, { name: 'angry', description: '' }]);
        assert.deepEqual(askSensor({ type: 'score', levels: 'none|some|a lot' }, 'q').levels, ['none', 'some', 'a lot']);
    });

    it('pulls the message counts into range and reads the context word', () => {
        assert.deepEqual([askSensor({ user: 99 }, 'q').user, askSensor({ assistant: -3 }, 'q').assistant], [50, 0]);
        assert.equal(askSensor({ context: 'true' }, 'q').context, true);
        assert.equal(askSensor({ context: 'false' }, 'q').context, false);
        assert.equal(askSensor({ context: 'on' }, 'q').context, true);
    });

    it('refuses a type it does not know', () => {
        assert.throws(() => askSensor({ type: 'vibe' }, 'q'), /The type must be score, choice, noul\./);
    });
});
