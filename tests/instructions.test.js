import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { hostStub } from './helpers/host.js';

const blank = { system: '', jailbreak: '', description: '', personality: '', scenario: '', charDepthPrompt: '', persona: '', mesExamples: '' };
const card = { ...blank };
let tokenizer = async text => text.length;

const host = hostStub({
    substituteParams: (text, options) => String(text)
        .replace(/\{\{char\}\}/g, 'Mira')
        .replace(/\{\{original\}\}/g, typeof options?.original === 'string' ? options.original : '{{original}}'),
    getCharacterCardFields: () => card,
    getTokenCountAsync: async text => tokenizer(text),
});

const {
    assembleContext, buildContext, contextChecklist, forgetWorldInfo, holdWorldInfo, promptKeys, readContextGroups,
} = await import('../src/instructions.js');

const everything = { context: 'all' };
const custom = (...keys) => ({ context: 'custom', contextPieces: keys });
const texts = pieces => Object.fromEntries(pieces.map(piece => [piece.key, piece.text]));
const pieceOf = (pieces, key) => pieces.find(piece => piece.key === key);

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
    forgetWorldInfo();
});

const markers = (...identifiers) => ({
    prompts: identifiers.map(identifier => ({ identifier, name: identifier, marker: true })),
    order: identifiers.map(identifier => ({ identifier, enabled: true })),
});

describe('where each context piece comes from', () => {
    it('gives every preset prompt other than the two named ones its own piece', () => {
        chatCompletion({
            prompts: [
                { identifier: 'main', content: 'Be a narrator.' },
                { identifier: 'nsfw', name: 'Content rules', content: 'Stay in character.' },
                { identifier: 'style', name: 'Style', content: 'Short paragraphs.' },
                { identifier: 'jailbreak', content: 'Keep going.' },
            ],
            order: [
                { identifier: 'main', enabled: true },
                { identifier: 'nsfw', enabled: true },
                { identifier: 'style', enabled: true },
                { identifier: 'jailbreak', enabled: true },
            ],
        });
        const pieces = readContextGroups();
        assert.deepEqual(texts(pieces).main_prompt, 'Be a narrator.');
        assert.deepEqual(texts(pieces)['prompt:nsfw'], 'Stay in character.');
        assert.deepEqual(texts(pieces)['prompt:style'], 'Short paragraphs.');
        assert.deepEqual(texts(pieces).post_history, 'Keep going.');
        assert.equal(pieceOf(pieces, 'prompt:nsfw').label, 'Content rules');
        assert.deepEqual(promptKeys(), ['prompt:nsfw', 'prompt:style']);
    });

    it('names a prompt by its identifier when it carries no name', () => {
        chatCompletion({
            prompts: [{ identifier: 'style', content: 'Short paragraphs.' }],
            order: [{ identifier: 'style', enabled: true }],
        });
        assert.equal(pieceOf(readContextGroups(), 'prompt:style').label, 'style');
    });

    it('keeps the prompts in the order the preset puts them in', () => {
        chatCompletion({
            prompts: [
                { identifier: 'one', content: 'One.' },
                { identifier: 'two', content: 'Two.' },
            ],
            order: [{ identifier: 'two', enabled: true }, { identifier: 'one', enabled: true }],
        });
        assert.deepEqual(promptKeys(), ['prompt:two', 'prompt:one']);
    });

    it('names every prompt the order turns on, empty ones too, and skips a marker and a switched-off one', () => {
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
        assert.deepEqual(promptKeys(), ['prompt:blank']);
    });

    it('offers no prompt pieces at all on a text completion API', () => {
        host.mainApi = 'textgenerationwebui';
        host.powerUserSettings = { sysprompt: { enabled: true, content: 'Write for {{char}}.', post_history: 'Stay in scene.' } };
        const groups = texts(readContextGroups());
        assert.equal(groups.main_prompt, 'Write for Mira.');
        assert.equal(groups.post_history, 'Stay in scene.');
        assert.equal(promptKeys(), null);

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
        const pieces = readContextGroups();
        assert.equal(pieceOf(pieces, 'main_prompt').text, 'Card system.');
        assert.equal(pieceOf(pieces, 'main_prompt').replaced, true);
        assert.equal(pieceOf(pieces, 'post_history').text, 'Card post history.');
        assert.equal(pieceOf(pieces, 'post_history').replaced, true);
        assert.equal(pieceOf(pieces, 'prompt:style').text, 'Preset style.');
        assert.equal(pieceOf(pieces, 'prompt:style').replaced, undefined);
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
        const pieces = readContextGroups();
        assert.equal(pieceOf(pieces, 'main_prompt').text, 'Preset main.');
        assert.equal(pieceOf(pieces, 'main_prompt').replaced, false);
        assert.equal(pieceOf(pieces, 'post_history').text, 'Preset post history.');
        assert.equal(pieceOf(pieces, 'post_history').replaced, false);
    });

    it('ignores the override when the prompt it would replace is turned off', () => {
        chatCompletion({
            prompts: [{ identifier: 'main', content: 'Preset main.' }, { identifier: 'style', content: 'Preset style.' }],
            order: [{ identifier: 'main', enabled: false }, { identifier: 'style', enabled: true }],
        });
        card.system = 'Card system.';
        const groups = texts(readContextGroups());
        assert.equal(groups.main_prompt, '');
        assert.equal(groups['prompt:style'], 'Preset style.');
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
        assert.equal(groups['prompt:style'], 'Keep Mira terse.');
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
        assert.equal(pieceOf(on, 'main_prompt').text, 'Card system.');
        assert.equal(pieceOf(on, 'post_history').text, 'Card post history.');
        assert.equal(pieceOf(on, 'main_prompt').replaced, true);

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
        assert.equal(texts(readContextGroups('normal'))['prompt:carry'], '');
        assert.equal(texts(readContextGroups('continue'))['prompt:carry'], 'Carry on from the last word.');
    });

    it('keeps a Continue-only prompt in the settled selection, whatever type it is asked for', () => {
        withContinueOnly();
        assert.deepEqual(promptKeys(), ['prompt:carry']);
        assert.deepEqual(promptKeys('rescan'), ['prompt:carry']);
        assert.deepEqual(promptKeys('continue'), ['prompt:carry']);
    });

    it('keeps a prompt whose trigger list is empty or missing', () => {
        chatCompletion({
            prompts: [
                { identifier: 'anytime', content: 'Always.', injection_trigger: [] },
                { identifier: 'plain', content: 'Also always.' },
            ],
            order: [{ identifier: 'anytime', enabled: true }, { identifier: 'plain', enabled: true }],
        });
        assert.deepEqual(promptKeys('swipe'), ['prompt:anytime', 'prompt:plain']);
    });

    it('drops a card override when its prompt is left out by the trigger', () => {
        chatCompletion({
            prompts: [{ identifier: 'main', content: 'Preset main.', injection_trigger: ['continue'] }],
            order: [{ identifier: 'main', enabled: true }],
        });
        card.system = 'Card system.';
        assert.equal(pieceOf(readContextGroups('normal'), 'main_prompt').text, '');
        assert.equal(pieceOf(readContextGroups('continue'), 'main_prompt').text, 'Card system.');
    });
});

describe('the checklist the prompt order produces', () => {
    it('gives every row of the order a piece, in that order, and leaves chat history out', () => {
        chatCompletion({
            prompts: [
                { identifier: 'main', name: 'Main Prompt', content: 'Be a narrator.' },
                { identifier: 'worldInfoBefore', name: 'World Info (before)', marker: true },
                { identifier: 'charDescription', name: 'Char Description', marker: true },
                { identifier: 'chatHistory', name: 'Chat History', marker: true },
                { identifier: 'dialogueExamples', name: 'Chat Examples', marker: true },
                { identifier: 'jailbreak', name: 'Post-History Instructions', content: 'Keep going.' },
            ],
            order: ['main', 'worldInfoBefore', 'charDescription', 'chatHistory', 'dialogueExamples', 'jailbreak']
                .map(identifier => ({ identifier, enabled: true })),
        });
        assert.deepEqual(contextChecklist().map(item => item.key), [
            'main_prompt', 'world_info_before', 'description', 'chat_examples', 'post_history', 'character_note',
        ]);
    });

    it('lists a custom prompt of the preset, whatever its role or injection position', () => {
        chatCompletion({
            prompts: [
                { identifier: 'enhanceDefinitions', name: 'Enhance Definitions', content: 'Add lore.' },
                { identifier: 'abc-123', name: 'My prompt', role: 'user', injection_position: 1, injection_depth: 4, content: 'Mine.' },
            ],
            order: [{ identifier: 'enhanceDefinitions', enabled: true }, { identifier: 'abc-123', enabled: true }],
        });
        const listed = contextChecklist();
        assert.deepEqual(listed.map(item => item.key), ['prompt:enhanceDefinitions', 'prompt:abc-123', 'character_note']);
        assert.equal(listed[1].label, 'My prompt');
        assert.deepEqual(promptKeys(), ['prompt:enhanceDefinitions', 'prompt:abc-123']);
    });

    it('treats a prompt named after an inherited property as an ordinary prompt', () => {
        chatCompletion({
            prompts: [{ identifier: 'toString', name: 'Odd', content: 'Mine.' }],
            order: [{ identifier: 'toString', enabled: true }],
        });
        assert.deepEqual(contextChecklist().map(item => item.key), ['prompt:toString', 'character_note']);
        assert.equal(texts(readContextGroups())['prompt:toString'], 'Mine.');
    });

    it('keeps a prompt that is switched off in the list, with its text, and out of the context', () => {
        chatCompletion({
            prompts: [{ identifier: 'style', name: 'Style', content: 'Be terse.' }],
            order: [{ identifier: 'style', enabled: false }],
        });
        const [listed] = contextChecklist();
        assert.equal(listed.off, true);
        assert.equal(listed.text, 'Be terse.');
        assert.equal(texts(readContextGroups())['prompt:style'], '');
        assert.deepEqual(promptKeys(), []);
    });

    it('keeps a prompt the generation type filters out as listed and not switched off', () => {
        chatCompletion({
            prompts: [{ identifier: 'carry', name: 'Carry', content: 'Carry on.', injection_trigger: ['continue'] }],
            order: [{ identifier: 'carry', enabled: true }],
        });
        const [listed] = contextChecklist();
        assert.equal(listed.off, false);
        assert.equal(listed.text, 'Carry on.');
        assert.equal(texts(readContextGroups('normal'))['prompt:carry'], '');
    });

    it('marks a switched-off marker row off, lists its text and leaves it out of the context', () => {
        card.description = 'A knight.';
        chatCompletion({
            prompts: [{ identifier: 'charDescription', name: 'Char Description', marker: true }],
            order: [{ identifier: 'charDescription', enabled: false }],
        });
        const [listed] = contextChecklist();
        assert.equal(listed.off, true);
        assert.equal(listed.text, 'A knight.');
        assert.equal(texts(readContextGroups()).description, '');
    });

    it('keeps the character note on, because the prompt order has no row for it', () => {
        card.charDepthPrompt = 'Stay blunt.';
        chatCompletion({
            prompts: [{ identifier: 'style', name: 'Style', content: 'Be terse.' }],
            order: [{ identifier: 'style', enabled: false }],
        });
        const note = contextChecklist().find(item => item.key === 'character_note');
        assert.equal(note.off, false);
        assert.equal(texts(readContextGroups()).character_note, 'Stay blunt.');
    });

    it('falls back to the fixed list when the preset states no order', () => {
        host.chatCompletionSettings = {};
        assert.deepEqual(contextChecklist().map(item => item.key), [
            'main_prompt', 'world_info_before', 'description', 'personality', 'scenario', 'character_note',
            'persona', 'chat_examples', 'world_info_after', 'post_history',
        ]);
    });

    it('keeps the fixed list on a text completion API', () => {
        host.mainApi = 'textgenerationwebui';
        host.powerUserSettings = { sysprompt: { enabled: true, content: 'Write for {{char}}.', post_history: 'Stay.' } };
        const listed = contextChecklist();
        assert.deepEqual(listed.map(item => item.key), [
            'main_prompt', 'world_info_before', 'description', 'personality', 'scenario', 'character_note',
            'persona', 'chat_examples', 'world_info_after', 'post_history',
        ]);
        assert.equal(texts(listed).main_prompt, 'Write for Mira.');
        assert.equal(promptKeys(), null);
    });
});

describe('the world info a sensor can send', () => {
    it('splits the entries of the newest scan into before and after, and ignores other positions', () => {
        chatCompletion(markers('worldInfoBefore', 'worldInfoAfter'));
        holdWorldInfo([
            { position: 0, content: 'A fortress.' },
            { position: 1, content: 'It is raining.' },
            { position: 0, content: 'A siege.' },
            { position: 4, content: 'At depth.' },
            { position: 2, content: 'An author note.' },
        ]);
        const groups = texts(readContextGroups());
        assert.equal(groups.world_info_before, 'A fortress.\nA siege.');
        assert.equal(groups.world_info_after, 'It is raining.');
    });

    it('holds only the newest scan and forgets it on a chat change', () => {
        chatCompletion(markers('worldInfoBefore'));
        holdWorldInfo([{ position: 0, content: 'One.' }]);
        holdWorldInfo([{ position: 0, content: 'Two.' }]);
        assert.equal(texts(readContextGroups()).world_info_before, 'Two.');

        forgetWorldInfo();
        assert.equal(texts(readContextGroups()).world_info_before, '');
    });

    it('does not throw on junk', () => {
        chatCompletion(markers('worldInfoBefore'));
        holdWorldInfo(null);
        assert.equal(texts(readContextGroups()).world_info_before, '');
        holdWorldInfo([null, { position: 0 }, { position: 0, content: '  ' }]);
        assert.equal(texts(readContextGroups()).world_info_before, '');
    });
});

describe('the chat examples piece', () => {
    it('takes the example messages of the card', () => {
        card.mesExamples = 'Mira: Hello.';
        chatCompletion(markers('dialogueExamples'));
        assert.equal(texts(readContextGroups()).chat_examples, 'Mira: Hello.');
    });
});

describe('assembling the context', () => {
    const pieces = (...entries) => entries.map(([key, text]) => ({ key, label: key, text }));
    const cards = values => pieces(
        ['main_prompt', values.main_prompt ?? ''],
        ['description', values.description ?? ''],
        ['personality', values.personality ?? ''],
        ['scenario', values.scenario ?? ''],
        ['character_note', values.character_note ?? ''],
        ['persona', values.persona ?? ''],
        ['post_history', values.post_history ?? ''],
    );

    it('sends every piece that has text when the sensor asks for everything', async () => {
        const built = await assembleContext(cards({ main_prompt: 'main', description: 'desc', persona: 'me' }), everything, 0);
        assert.deepEqual(built.context, { main_prompt: 'main', description: 'desc', persona: 'me' });
        assert.equal(built.total, 'main'.length + 'desc'.length + 'me'.length);
    });

    it('sends nothing at all when the sensor asks for none', async () => {
        const built = await assembleContext(cards({ main_prompt: 'main' }), { context: 'none' }, 0);
        assert.deepEqual(built.context, {});
        assert.equal(built.total, 0);
    });

    it('sends only the pieces a custom sensor ticked, and counts the rest anyway', async () => {
        const source = cards({ main_prompt: 'main', description: 'desc' });
        const built = await assembleContext(source, custom('main_prompt'), 0);
        assert.deepEqual(Object.keys(built.context), ['main_prompt']);
        assert.equal(built.counts.description, 4);
        assert.equal(built.total, 4);
    });

    it('skips a ticked piece that is not there right now', async () => {
        const built = await assembleContext(cards({ main_prompt: 'main' }), custom('main_prompt', 'prompt:gone'), 0);
        assert.deepEqual(built.context, { main_prompt: 'main' });
    });

    it('sends the prompt pieces a custom sensor names, in preset order', async () => {
        const source = [
            ...pieces(['main_prompt', 'main']),
            ...pieces(['prompt:style', 'style'], ['prompt:nsfw', 'nsfw']),
            ...cards({ description: 'desc' }),
        ];
        const built = await assembleContext(source, custom('prompt:nsfw', 'prompt:style'), 0);
        assert.deepEqual(Object.keys(built.context), ['prompt:style', 'prompt:nsfw']);
    });

    it('takes world info and the examples out before the prompts and the card groups', async () => {
        const source = [
            ...pieces(['main_prompt', 'm'.repeat(10)]),
            ...pieces(['world_info_before', 'b'.repeat(10)], ['prompt:one', 'o'.repeat(10)]),
            ...cards({ persona: 'u'.repeat(10) }),
            ...pieces(['chat_examples', 'x'.repeat(10)], ['world_info_after', 'a'.repeat(10)]),
        ];
        const built = await assembleContext(source, everything, 15);
        assert.deepEqual(built.cut, ['world_info_after', 'world_info_before', 'chat_examples', 'prompt:one', 'persona']);
        assert.deepEqual(Object.keys(built.context), ['main_prompt']);
    });

    it('takes the prompt pieces out first, newest prompt first, then whole card groups', async () => {
        const source = [
            ...pieces(['main_prompt', 'm'.repeat(10)]),
            ...pieces(['prompt:one', 'o'.repeat(10)], ['prompt:two', 't'.repeat(10)]),
            ...cards({
                personality: 'p'.repeat(10),
                scenario: 's'.repeat(10),
                character_note: 'n'.repeat(10),
                persona: 'u'.repeat(10),
                post_history: 'h'.repeat(10),
            }),
        ];
        const built = await assembleContext(source, everything, 45);
        assert.deepEqual(built.cut, ['prompt:two', 'prompt:one', 'persona', 'character_note']);
        assert.deepEqual(Object.keys(built.context), ['main_prompt', 'personality', 'scenario', 'post_history']);
        assert.equal(built.over, false);
    });

    it('cuts the description short once the whole groups are gone', async () => {
        const source = cards({ main_prompt: 'm'.repeat(10), description: 'd'.repeat(1000), persona: 'u'.repeat(10) });
        const built = await assembleContext(source, everything, 400);
        assert.deepEqual(built.cut, ['persona']);
        assert.equal(built.trimmed, true);
        assert.ok(built.context.description.startsWith('ddd'));
        assert.ok(built.context.description.length < 400, built.context.description.length);
        assert.equal(built.context.main_prompt, 'm'.repeat(10));
    });

    it('never cuts the main prompt or the post-history prompt, and says it is still over', async () => {
        const source = cards({ main_prompt: 'm'.repeat(300), post_history: 'h'.repeat(300), persona: 'u'.repeat(10) });
        const built = await assembleContext(source, everything, 100);
        assert.deepEqual(built.cut, ['persona']);
        assert.equal(built.over, true);
        assert.equal(built.context.main_prompt.length, 300);
        assert.equal(built.context.post_history.length, 300);
    });

    it('counts the description it keeps, so a dense prefix cannot slip past the cap', async () => {
        tokenizer = async text => [...text].reduce((sum, letter) => sum + (letter === 'Ж' ? 10 : 1), 0);
        const source = cards({ main_prompt: 'M'.repeat(50), description: 'Ж'.repeat(100) + 'q'.repeat(900) });
        const built = await assembleContext(source, everything, 250);
        assert.equal(built.trimmed, true);
        assert.equal(built.over, false);
        const sent = await tokenizer(built.context.main_prompt) + await tokenizer(built.context.description);
        assert.ok(sent <= 250, `${sent} tokens were sent`);
        assert.equal(built.total, sent);
    });

    it('drops the description when no prefix of it fits', async () => {
        tokenizer = async text => (text.length ? 5000 : 0);
        const source = cards({ main_prompt: 'A'.repeat(10), description: 'B'.repeat(500) });
        const built = await assembleContext(source, everything, 6000);
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
        const source = cards({ main_prompt: 'D'.repeat(500), description: whole });
        const built = await assembleContext(source, everything, 800);
        assert.equal(built.total, null);
        assert.equal(built.over, false);
        assert.equal(built.context.description, whole);
    });

    it('sends everything uncut when the tokenizer fails', async () => {
        tokenizer = async () => { throw new Error('no tokenizer'); };
        const source = cards({ main_prompt: 'm'.repeat(500), persona: 'u'.repeat(500) });
        const built = await assembleContext(source, everything, 10);
        assert.equal(built.total, null);
        assert.deepEqual(built.cut, []);
        assert.equal(built.context.persona.length, 500);
    });

    it('counts a piece nobody ticked even when the tokenizer fails on it', async () => {
        tokenizer = async text => (text.startsWith('d') ? null : text.length);
        const source = cards({ main_prompt: 'main', description: 'desc' });
        const built = await assembleContext(source, custom('main_prompt'), 0);
        assert.equal(built.total, 4);
    });

    it('reuses counts the caller already made', async () => {
        const source = cards({ main_prompt: 'main' });
        tokenizer = async () => { throw new Error('nobody should count again'); };
        const built = await assembleContext(source, everything, 0, { main_prompt: 99 });
        assert.equal(built.total, 99);
    });
});

describe('buildContext', () => {
    it('reads the host and assembles in one step', async () => {
        card.description = 'A knight.';
        card.persona = 'A squire.';
        const built = await buildContext(custom('description'), 0);
        assert.deepEqual(built.context, { description: 'A knight.' });
    });
});
