import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { narrator, user } from './helpers/chat.js';
import { hostStub } from './helpers/host.js';

const context = hostStub({});

const {
    ADD, REMOVE, effectiveEntries, fillEntries, forgetManual, hiddenEntries, listResolver, manualChange, restoreEntry,
    ruleChange,
} = await import('../src/lists.js');
const { clearScores, getRecord, manualChanges, writeScores } = await import('../src/store.js');

const preset = entries => ({ lists: [{ name: 'rules', entries }] });
const entries = (chat, held = preset([])) => effectiveEntries(chat, held, 'rules', manualChanges());

beforeEach(() => {
    context.chat = [];
    context.chatMetadata = {};
});

describe('the effective list of a chat', () => {
    it('starts with the preset entries and keeps their order', () => {
        assert.deepEqual(entries([], preset(['one', 'two'])), ['one', 'two']);
    });

    it('applies the changes of each message in chat order, so a later one wins', () => {
        const chat = [user('u0'), narrator('c0'), user('u1')];
        ruleChange(chat[1], 'rules', ADD, 'no cliffhangers');
        ruleChange(chat[2], 'rules', REMOVE, 'no cliffhangers');
        assert.deepEqual(entries(chat), []);

        ruleChange(chat[2], 'rules', ADD, 'no cliffhangers');
        assert.deepEqual(entries(chat), ['no cliffhangers']);
    });

    it('ignores case and outer spaces, and adds nothing twice', () => {
        const chat = [narrator('c0')];
        ruleChange(chat[0], 'rules', ADD, '  No Cliffhangers ');
        ruleChange(chat[0], 'rules', ADD, 'no cliffhangers');
        assert.deepEqual(entries(chat), ['No Cliffhangers']);

        ruleChange(chat[0], 'rules', REMOVE, 'NO CLIFFHANGERS');
        assert.deepEqual(entries(chat), []);
    });

    it('does nothing when a rule takes out an entry that is not there', () => {
        const chat = [narrator('c0')];
        ruleChange(chat[0], 'rules', REMOVE, 'never added');
        assert.deepEqual(entries(chat, preset(['one'])), ['one']);
    });

    it('drops a change once the text of its message has changed', () => {
        const chat = [narrator('c0')];
        ruleChange(chat[0], 'rules', ADD, 'no cliffhangers');
        assert.deepEqual(entries(chat), ['no cliffhangers']);

        chat[0].mes = 'edited';
        assert.deepEqual(entries(chat), []);
    });

    it('clears the changes of an older text when a new swipe inherits the record', () => {
        const chat = [narrator('c0')];
        ruleChange(chat[0], 'rules', ADD, 'old');
        chat[0].mes = 'another';
        ruleChange(chat[0], 'rules', ADD, 'new');

        assert.deepEqual(getRecord(chat[0]).lists.map(change => change.value), ['new']);
        assert.deepEqual(entries(chat), ['new']);
    });

    it('loses a reply change on a swipe and takes it back on the swipe that made it', () => {
        const chat = [user('u0'), narrator('c0')];
        ruleChange(chat[1], 'rules', ADD, 'no cliffhangers');
        const kept = structuredClone(chat[1].extra);

        chat[1].extra = {};
        chat[1].mes = 'another';
        assert.deepEqual(entries(chat), []);

        chat[1].extra = kept;
        chat[1].mes = 'c0';
        assert.deepEqual(entries(chat), ['no cliffhangers']);
    });
});

describe('a change made by hand', () => {
    it('wins over every rule change of the turn it was made in, and loses to the next turn', () => {
        context.chat = [user('u0'), narrator('c0')];
        ruleChange(context.chat[1], 'rules', ADD, 'no cliffhangers');
        manualChange('rules', REMOVE, 'no cliffhangers');
        assert.deepEqual(entries(context.chat), []);

        context.chat.push(narrator('c1'));
        ruleChange(context.chat[2], 'rules', ADD, 'no cliffhangers');
        assert.deepEqual(entries(context.chat), []);

        context.chat.push(user('u1'), narrator('c2'));
        ruleChange(context.chat[4], 'rules', ADD, 'no cliffhangers');
        assert.deepEqual(entries(context.chat), ['no cliffhangers']);
    });

    it('applies last when the message it was anchored to is gone', () => {
        context.chat = [user('u0'), narrator('c0')];
        manualChange('rules', REMOVE, 'one');
        context.chat.splice(0, 1);
        context.chat.push(narrator('c1'));
        ruleChange(context.chat.at(-1), 'rules', ADD, 'one');
        assert.deepEqual(entries(context.chat, preset(['one'])), []);
    });

    it('survives a swipe of the reply, because it sits in the chat metadata', () => {
        context.chat = [user('u0'), narrator('c0')];
        manualChange('rules', ADD, 'stay in scene');
        context.chat[1].extra = {};
        context.chat[1].mes = 'another';
        assert.deepEqual(entries(context.chat), ['stay in scene']);
    });

    it('hides a starting entry and gives it back when the change is forgotten', () => {
        context.chat = [user('u0')];
        const held = preset(['one', 'two']);
        manualChange('rules', REMOVE, 'one');
        assert.deepEqual(entries(context.chat, held), ['two']);
        assert.deepEqual(hiddenEntries(held, 'rules', entries(context.chat, held)), ['one']);

        assert.equal(forgetManual('rules', 'one'), true);
        assert.equal(forgetManual('rules', 'one'), false);
        assert.deepEqual(entries(context.chat, held), ['one', 'two']);
    });

    it('restores a starting entry that a rule took out, not only one taken out by hand', () => {
        context.chat = [user('u0'), narrator('c0')];
        const held = preset(['one']);
        ruleChange(context.chat[1], 'rules', REMOVE, 'one');
        manualChange('rules', REMOVE, 'one');
        assert.deepEqual(entries(context.chat, held), []);

        restoreEntry(held, 'rules', 'one');
        assert.deepEqual(entries(context.chat, held), ['one']);
    });

    it('takes no second change when forgetting the hand-made one is enough', () => {
        context.chat = [user('u0')];
        const held = preset(['one']);
        manualChange('rules', REMOVE, 'one');
        assert.equal(restoreEntry(held, 'rules', 'one'), false);
        assert.deepEqual(manualChanges(), []);
    });

    it('needs no user message at all', () => {
        context.chat = [narrator('greeting')];
        manualChange('rules', ADD, 'stay in scene');
        assert.deepEqual(entries(context.chat), ['stay in scene']);
        assert.deepEqual(manualChanges().map(change => change.anchor), ['']);
    });
});

describe('clearing the answers of a chat', () => {
    it('leaves the list changes where they are', () => {
        const chat = [user('u0'), narrator('c0')];
        writeScores(chat[1], { tension: 2 });
        ruleChange(chat[1], 'rules', ADD, 'no cliffhangers');
        assert.equal(clearScores(chat), 1);
        assert.deepEqual(entries(chat), ['no cliffhangers']);
    });
});

describe('the resolver a preset hands out', () => {
    it('reads the current chat once per list name', () => {
        context.chat = [narrator('c0')];
        ruleChange(context.chat[0], 'rules', ADD, 'one');
        const resolve = listResolver(preset([]));
        assert.deepEqual(resolve('rules'), ['one']);
        assert.deepEqual(resolve('gone'), []);
    });
});

describe('fillEntries', () => {
    it('writes the first match, every match and the JSON of the matches', () => {
        const text = 'one: {{entry}}\nall:\n{{entries}}\njson: {{entries_json}}';
        assert.equal(
            fillEntries(text, ['a', 'b']),
            'one: a\nall:\na\nb\njson: ["a","b"]',
        );
    });

    it('takes the entry it is pointed at over the first match', () => {
        assert.equal(fillEntries('{{entry}}', ['a', 'b'], 'b'), 'b');
    });

    it('leaves an empty text where there is no match', () => {
        assert.equal(fillEntries('[{{entry}}][{{entries}}][{{entries_json}}]', []), '[][][[]]');
    });
});
