import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { hostStub } from './helpers/host.js';

const scripts = [];
const context = hostStub({
    substituteParams: text => String(text).replace(/\{\{user\}\}/g, 'Aria'),
    executeSlashCommandsWithOptions: async (script, options) => {
        scripts.push({ script, options });
        if (script.includes('boom')) {
            throw new Error('the script broke');
        }
    },
});

const { forceRule, forcedRule, interceptGeneration, lastError, setErrorText } = await import('../src/engine.js');
const { getSettings, initSettings } = await import('../src/settings.js');
const { fired, writeDecision, writeScores } = await import('../src/store.js');

const user = mes => ({ mes, is_user: true });
const narrator = mes => ({ mes, is_user: false });

function rule(overrides = {}) {
    return {
        id: 'flat',
        label: 'Flat',
        enabled: true,
        action: 'nudge',
        conditions: [{ sensor: 'change', op: 'below', value: 2.5 }],
        need: 1,
        window: 1,
        skipWhen: null,
        cooldown: 0,
        directive: '(OOC: raise the pressure on {{user}}.)',
        script: '',
        ...overrides,
    };
}

function setup(rules) {
    context.extensionSettings = {};
    initSettings();
    const settings = getSettings();
    settings.enabled = true;
    settings.apiKey = 'test-key';
    settings.presets.Test = {
        description: '',
        sensors: [{ id: 'change', label: 'Change', watch: false, turns: 1, includeContext: false, includeUser: true, measureEvery: 1, question: 'q', levels: ['a', 'b', 'c', 'd', 'e'] }],
        rules,
        gap: 8,
        maxNudges: 1,
    };
    settings.activePreset = 'Test';
    context.chat = [user('hello'), narrator('a quiet reply'), user('and then?')];
    writeScores(context.chat[1], { change: 1 });
    return settings;
}

const copyOf = () => context.chat.map(message => ({ ...message }));

beforeEach(() => {
    scripts.length = 0;
    setErrorText('', '');
    forceRule('');
});

describe('interceptGeneration', () => {
    it('decides once, appends the instruction to the prompt copy and leaves the stored message alone', async () => {
        setup([rule()]);
        const copy = copyOf();
        await interceptGeneration(copy, 100, () => {}, 'normal');
        assert.deepEqual(fired(context.chat[2]).map(entry => entry.rule), ['flat']);
        assert.ok(copy[2].mes.endsWith('(OOC: raise the pressure on Aria.)'));
        assert.equal(context.chat[2].mes, 'and then?');
    });

    it('appends every fired text in order', async () => {
        setup([]);
        writeDecision(context.chat[2], { fired: [
            { rule: 'one', action: 'nudge', reason: 'r', text: 'first' },
            { rule: 'two', action: 'nudge', reason: 'r' },
            { rule: 'three', action: 'swipe', reason: 'r', text: 'second' },
        ] });
        const copy = copyOf();
        await interceptGeneration(copy, 100, () => {}, 'normal');
        assert.equal(copy[2].mes, 'and then?\n\nfirst\n\nsecond');
    });

    it('reuses the saved record on a swipe and does not run the script again', async () => {
        setup([rule({ script: '/echo hello' })]);
        await interceptGeneration(copyOf(), 100, () => {}, 'normal');
        assert.equal(scripts.length, 1);
        assert.deepEqual(scripts[0].options, { handleParserErrors: false, handleExecutionErrors: false });
        const copy = copyOf();
        await interceptGeneration(copy, 100, () => {}, 'swipe');
        assert.equal(scripts.length, 1);
        assert.ok(copy[2].mes.includes('(OOC: raise the pressure on Aria.)'));
    });

    it('runs a script whatever commands it holds', async () => {
        setup([rule({ script: '/setvar key=mood calm | /imagine scene' })]);
        setErrorText('', '');
        await interceptGeneration(copyOf(), 100, () => {}, 'normal');
        assert.equal(scripts.length, 1);
        assert.equal(scripts[0].script, '/setvar key=mood calm | /imagine scene');
        assert.equal(lastError(), '');
        assert.deepEqual(fired(context.chat[2]).map(entry => entry.rule), ['flat']);
    });

    it('keeps going when a script throws', async () => {
        setup([rule({ script: '/echo boom' })]);
        const copy = copyOf();
        await interceptGeneration(copy, 100, () => {}, 'normal');
        assert.match(lastError(), /failed/);
        assert.ok(copy[2].mes.endsWith('(OOC: raise the pressure on Aria.)'));
    });

    it('does nothing for a background generation or while it is turned off', async () => {
        setup([rule()]);
        const quiet = copyOf();
        await interceptGeneration(quiet, 100, () => {}, 'quiet');
        assert.equal(quiet[2].mes, 'and then?');
        assert.equal(fired(context.chat[2]).length, 0);

        getSettings().enabled = false;
        const off = copyOf();
        await interceptGeneration(off, 100, () => {}, 'normal');
        assert.equal(off[2].mes, 'and then?');
    });

    it('writes a decision with nothing fired when no rule matches', async () => {
        setup([rule({ conditions: [{ sensor: 'change', op: 'above', value: 3 }] })]);
        const copy = copyOf();
        await interceptGeneration(copy, 100, () => {}, 'normal');
        assert.equal(context.chat[2].extra.jeved.decided, true);
        assert.deepEqual(fired(context.chat[2]), []);
        assert.equal(copy[2].mes, 'and then?');
    });

    it('nudges once when a rule is forced and clears the flag', async () => {
        setup([rule({ enabled: false })]);
        forceRule('flat');
        const copy = copyOf();
        await interceptGeneration(copy, 100, () => {}, 'normal');
        assert.deepEqual(fired(context.chat[2]).map(entry => entry.reason), ['Forced with /jeved-nudge.']);
        assert.equal(forcedRule(), '');
    });
});
