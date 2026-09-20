import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { hostStub } from './helpers/host.js';

const blank = { system: '', jailbreak: '', description: '', personality: '', scenario: '', charDepthPrompt: '', persona: '' };
const card = { ...blank };
let tokenizer = async text => text.length;

const host = hostStub({
    substituteParams: (text, options) => String(text)
        .replace(/\{\{char\}\}/g, 'Mira')
        .replace(/\{\{original\}\}/g, typeof options?.original === 'string' ? options.original : '{{original}}'),
    getCharacterCardFields: () => card,
    getTokenCountAsync: async text => tokenizer(text),
});

const { CONTEXT_KEYS } = await import('../src/context-groups.js');
const { assembleContext, buildContext, readContextGroups } = await import('../src/instructions.js');

const allOn = Object.fromEntries(CONTEXT_KEYS.map(key => [key, true]));
const texts = groups => Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, group.text]));

function chatCompletion({ prompts, order }) {
    host.mainApi = 'openai';
    host.chatCompletionSettings = {
        prompts,
        prompt_order: [{ character_id: 100001, order }],
    };
}

beforeEach(() => {
    Object.assign(card, blank);
    host.mainApi = 'openai';
    host.chatCompletionSettings = {};
    host.powerUserSettings = {};
    tokenizer = async text => text.length;
});

describe('where each context group comes from', () => {
    it('splits the chat completion prompts into the main one and the rest', () => {
        chatCompletion({
            prompts: [
                { identifier: 'main', content: 'Be a narrator.' },
                { identifier: 'nsfw', content: 'Stay in character.' },
                { identifier: 'style', content: 'Short paragraphs.' },
                { identifier: 'jailbreak', content: 'Keep going.' },
            ],
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'nsfw', enabled: true },
                { identifier: 'style', enabled: true },
                { identifier: 'jailbreak', enabled: true },
            ],
        });
        const groups = texts(readContextGroups());
        assert.equal(groups.main_prompt, 'Be a narrator.');
        assert.equal(groups.other_prompts, 'Stay in character.\n\nShort paragraphs.');
        assert.equal(groups.post_history, 'Keep going.');
    });

    it('skips a prompt that is turned off, a marker and an empty one', () => {
        chatCompletion({
            prompts: [
                { identifier: 'main', content: 'Be a narrator.' },
                { identifier: 'off', content: 'Never sent.' },
                { identifier: 'chatHistory', marker: true, content: 'Never sent either.' },
                { identifier: 'blank', content: '   ' },
            ],
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'off', enabled: false },
                { identifier: 'chatHistory', enabled: true },
                { identifier: 'blank', enabled: true },
            ],
        });
        assert.equal(texts(readContextGroups()).other_prompts, '');
    });

    it('reads the text completion system prompt only while it is on', () => {
        host.mainApi = 'textgenerationwebui';
        host.powerUserSettings = { sysprompt: { enabled: true, content: 'Write for {{char}}.', post_history: 'Stay in scene.' } };
        const groups = texts(readContextGroups());
        assert.equal(groups.main_prompt, 'Write for Mira.');
        assert.equal(groups.post_history, 'Stay in scene.');
        assert.equal(groups.other_prompts, '');

        host.powerUserSettings = { sysprompt: { enabled: false, content: 'Write for {{char}}.', post_history: 'Stay in scene.' } };
        assert.equal(texts(readContextGroups()).main_prompt, '');
    });

    it('takes every card group from the host', () => {
        Object.assign(card, {
            description: 'A knight.',
            personality: 'Blunt.',
            scenario: 'A siege.',
            charDepthPrompt: 'Stay blunt.',
            persona: 'A squire.',
        });
        const groups = texts(readContextGroups());
        assert.equal(groups.description, 'A knight.');
        assert.equal(groups.personality, 'Blunt.');
        assert.equal(groups.scenario, 'A siege.');
        assert.equal(groups.character_note, 'Stay blunt.');
        assert.equal(groups.persona, 'A squire.');
    });

    it("lets the character's own prompts replace only the two the host replaces", () => {
        chatCompletion({
            prompts: [
                { identifier: 'main', content: 'Preset main.' },
                { identifier: 'style', content: 'Preset style.' },
                { identifier: 'jailbreak', content: 'Preset post history.' },
            ],
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'style', enabled: true },
                { identifier: 'jailbreak', enabled: true },
            ],
        });
        card.system = 'Card system.';
        card.jailbreak = 'Card post history.';
        const groups = readContextGroups();
        assert.equal(groups.main_prompt.text, 'Card system.');
        assert.equal(groups.main_prompt.replaced, true);
        assert.equal(groups.post_history.text, 'Card post history.');
        assert.equal(groups.post_history.replaced, true);
        assert.equal(groups.other_prompts.text, 'Preset style.');
        assert.equal(groups.other_prompts.replaced, undefined);
    });

    it('keeps the preset prompt when the preset forbids the override', () => {
        chatCompletion({
            prompts: [
                { identifier: 'main', content: 'Preset main.', forbid_overrides: true },
                { identifier: 'jailbreak', content: 'Preset post history.', forbid_overrides: true },
            ],
            order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: true }],
        });
        card.system = 'Card system.';
        card.jailbreak = 'Card post history.';
        const groups = readContextGroups();
        assert.equal(groups.main_prompt.text, 'Preset main.');
        assert.equal(groups.main_prompt.replaced, false);
        assert.equal(groups.post_history.text, 'Preset post history.');
        assert.equal(groups.post_history.replaced, false);
    });

    it('ignores the override when the prompt it would replace is turned off', () => {
        chatCompletion({
            prompts: [{ identifier: 'main', content: 'Preset main.' }, { identifier: 'style', content: 'Preset style.' }],
            order: [{ identifier: 'main', enabled: false }, { identifier: 'style', enabled: true }],
        });
        card.system = 'Card system.';
        const groups = readContextGroups();
        assert.equal(groups.main_prompt.text, '');
        assert.equal(groups.other_prompts.text, 'Preset style.');
    });

    it('resolves macros in the preset prompts as the host does', () => {
        chatCompletion({
            prompts: [
                { identifier: 'main', content: 'Narrate for {{char}}.' },
                { identifier: 'style', content: 'Keep {{char}} terse.' },
                { identifier: 'jailbreak', content: 'Stay with {{char}}.' },
            ],
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'style', enabled: true },
                { identifier: 'jailbreak', enabled: true },
            ],
        });
        const groups = texts(readContextGroups());
        assert.equal(groups.main_prompt, 'Narrate for Mira.');
        assert.equal(groups.other_prompts, 'Keep Mira terse.');
        assert.equal(groups.post_history, 'Stay with Mira.');
    });

    it('gives a card override the preset prompt it replaced for {{original}}', () => {
        chatCompletion({
            prompts: [
                { identifier: 'main', content: 'Preset main.' },
                { identifier: 'jailbreak', content: 'Preset post history.' },
            ],
            order: [{ identifier: 'main', enabled: true }, { identifier: 'jailbreak', enabled: true }],
        });
        card.system = '{{original}} Keep dialogue short.';
        card.jailbreak = 'Stay sharp. {{original}}';
        const groups = texts(readContextGroups());
        assert.equal(groups.main_prompt, 'Preset main. Keep dialogue short.');
        assert.equal(groups.post_history, 'Stay sharp. Preset post history.');
    });

    it('gives a card override the text completion system prompt for {{original}}', () => {
        host.mainApi = 'textgenerationwebui';
        host.powerUserSettings = { sysprompt: { enabled: true, content: 'Preset main.', post_history: 'Preset post.' } };
        card.system = '{{original}} And be brief.';
        card.jailbreak = '{{original}} Stay in scene.';
        const groups = texts(readContextGroups());
        assert.equal(groups.main_prompt, 'Preset main. And be brief.');
        assert.equal(groups.post_history, 'Preset post. Stay in scene.');
    });

    it('leaves {{original}} alone in a preset prompt nothing overrides', () => {
        chatCompletion({
            prompts: [{ identifier: 'main', content: 'Preset {{original}} main.' }],
            order: [{ identifier: 'main', enabled: true }],
        });
        assert.equal(texts(readContextGroups()).main_prompt, 'Preset {{original}} main.');
    });

    it('takes the card prompts for text completion only while the system prompt is on', () => {
        host.mainApi = 'textgenerationwebui';
        card.system = 'Card system.';
        card.jailbreak = 'Card post history.';
        host.powerUserSettings = { sysprompt: { enabled: true, content: 'Preset main.', post_history: 'Preset post.' } };
        const on = readContextGroups();
        assert.equal(on.main_prompt.text, 'Card system.');
        assert.equal(on.post_history.text, 'Card post history.');
        assert.equal(on.main_prompt.replaced, true);

        host.powerUserSettings = { sysprompt: { enabled: false, content: 'Preset main.', post_history: 'Preset post.' } };
        const off = texts(readContextGroups());
        assert.equal(off.main_prompt, '');
        assert.equal(off.post_history, '');
    });
});

describe('prompts that only belong to one generation type', () => {
    function withContinueOnly() {
        chatCompletion({
            prompts: [
                { identifier: 'main', content: 'Preset main.' },
                { identifier: 'carry', content: 'Carry on from the last word.', injection_trigger: ['continue'] },
            ],
            order: [{ identifier: 'main', enabled: true }, { identifier: 'carry', enabled: true }],
        });
    }

    it('leaves a Continue-only prompt out of the context for a normal reply', () => {
        withContinueOnly();
        assert.equal(texts(readContextGroups('normal')).other_prompts, '');
        assert.equal(texts(readContextGroups('continue')).other_prompts, 'Carry on from the last word.');
    });

    it('treats an unknown or missing type as a normal generation', () => {
        withContinueOnly();
        assert.equal(texts(readContextGroups()).other_prompts, '');
        assert.equal(texts(readContextGroups('rescan')).other_prompts, '');
        assert.equal(texts(readContextGroups(' NORMAL ')).other_prompts, '');
    });

    it('keeps a prompt whose trigger list is empty or missing', () => {
        chatCompletion({
            prompts: [
                { identifier: 'anytime', content: 'Always.', injection_trigger: [] },
                { identifier: 'plain', content: 'Also always.' },
            ],
            order: [{ identifier: 'anytime', enabled: true }, { identifier: 'plain', enabled: true }],
        });
        assert.equal(texts(readContextGroups('swipe')).other_prompts, 'Always.\n\nAlso always.');
    });

    it('drops a card override when its prompt is left out by the trigger', () => {
        chatCompletion({
            prompts: [{ identifier: 'main', content: 'Preset main.', injection_trigger: ['continue'] }],
            order: [{ identifier: 'main', enabled: true }],
        });
        card.system = 'Card system.';
        assert.equal(readContextGroups('normal').main_prompt.text, '');
        assert.equal(readContextGroups('continue').main_prompt.text, 'Card system.');
    });
});

describe('assembling the context', () => {
    function groups(values) {
        return Object.fromEntries(CONTEXT_KEYS.map(key => [key, { text: values[key] ?? '' }]));
    }

    it('sends every group that is ticked and has text', async () => {
        const source = groups({ main_prompt: 'main', description: 'desc', persona: 'me' });
        const built = await assembleContext(source, allOn, 0);
        assert.deepEqual(built.context, { main_prompt: 'main', description: 'desc', persona: 'me' });
        assert.equal(built.total, 'main'.length + 'desc'.length + 'me'.length);
    });

    it('drops the key of a group that is unticked, and counts it anyway', async () => {
        const source = groups({ main_prompt: 'main', description: 'desc' });
        const built = await assembleContext(source, { ...allOn, description: false }, 0);
        assert.deepEqual(Object.keys(built.context), ['main_prompt']);
        assert.equal(built.counts.description, 4);
        assert.equal(built.total, 4);
    });

    it('takes whole groups out in order until the context fits', async () => {
        const source = groups({
            main_prompt: 'm'.repeat(10),
            other_prompts: 'o'.repeat(10),
            personality: 'p'.repeat(10),
            scenario: 's'.repeat(10),
            character_note: 'n'.repeat(10),
            persona: 'u'.repeat(10),
            post_history: 'h'.repeat(10),
        });
        const built = await assembleContext(source, allOn, 45);
        assert.deepEqual(built.cut, ['other_prompts', 'persona', 'character_note']);
        assert.deepEqual(Object.keys(built.context), ['main_prompt', 'personality', 'scenario', 'post_history']);
        assert.equal(built.over, false);
    });

    it('cuts the description short once the whole groups are gone', async () => {
        const source = groups({ main_prompt: 'm'.repeat(10), description: 'd'.repeat(1000), persona: 'u'.repeat(10) });
        const built = await assembleContext(source, allOn, 400);
        assert.deepEqual(built.cut, ['persona']);
        assert.equal(built.trimmed, true);
        assert.ok(built.context.description.startsWith('ddd'));
        assert.ok(built.context.description.length < 400, built.context.description.length);
        assert.equal(built.context.main_prompt, 'm'.repeat(10));
    });

    it('never cuts the main prompt or the post-history prompt, and says it is still over', async () => {
        const source = groups({ main_prompt: 'm'.repeat(300), post_history: 'h'.repeat(300), persona: 'u'.repeat(10) });
        const built = await assembleContext(source, allOn, 100);
        assert.deepEqual(built.cut, ['persona']);
        assert.equal(built.over, true);
        assert.equal(built.context.main_prompt.length, 300);
        assert.equal(built.context.post_history.length, 300);
    });

    it('counts the description it keeps, so a dense prefix cannot slip past the cap', async () => {
        tokenizer = async text => [...text].reduce((sum, letter) => sum + (letter === 'Ж' ? 10 : 1), 0);
        const source = groups({ main_prompt: 'M'.repeat(50), description: 'Ж'.repeat(100) + 'q'.repeat(900) });
        const built = await assembleContext(source, allOn, 250);
        assert.equal(built.trimmed, true);
        assert.equal(built.over, false);
        const sent = await tokenizer(built.context.main_prompt) + await tokenizer(built.context.description);
        assert.ok(sent <= 250, `${sent} tokens were sent`);
        assert.equal(built.total, sent);
    });

    it('drops the description when no prefix of it fits', async () => {
        tokenizer = async text => (text.length ? 5000 : 0);
        const source = groups({ main_prompt: 'A'.repeat(10), description: 'B'.repeat(500) });
        const built = await assembleContext(source, allOn, 6000);
        assert.deepEqual(built.cut, ['description']);
        assert.equal(built.context.description, undefined);
        assert.equal(built.trimmed, false);
        assert.equal(built.over, false);
        assert.equal(built.total, 5000);
    });

    it('sends the whole description when the tokenizer fails during the trim', async () => {
        const whole = 'C'.repeat(500);
        tokenizer = async text => {
            if (text.length < 500) {
                throw new Error('the tokenizer went away');
            }
            return text.length;
        };
        const source = groups({ main_prompt: 'D'.repeat(500), description: whole });
        const built = await assembleContext(source, allOn, 800);
        assert.equal(built.total, null);
        assert.equal(built.over, false);
        assert.equal(built.context.description, whole);
    });

    it('sends everything uncut when the tokenizer fails', async () => {
        tokenizer = async () => { throw new Error('no tokenizer'); };
        const source = groups({ main_prompt: 'm'.repeat(500), persona: 'u'.repeat(500) });
        const built = await assembleContext(source, allOn, 10);
        assert.equal(built.total, null);
        assert.deepEqual(built.cut, []);
        assert.equal(built.context.persona.length, 500);
    });

});

describe('buildContext', () => {
    it('reads the host and assembles in one step', async () => {
        card.description = 'A knight.';
        card.persona = 'A squire.';
        const built = await buildContext({ ...allOn, persona: false }, 0);
        assert.deepEqual(built.context, { description: 'A knight.' });
    });
});
