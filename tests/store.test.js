import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addFired, clearScores, fired, firedRule, getHistory, getScores, latestScores, nudged, repliesSince, stripFiredText, writeDecision, writeScores } from '../src/store.js';
import { hashText } from '../src/util.js';

const narrator = mes => ({ mes, is_user: false });
const user = mes => ({ mes, is_user: true });
const system = mes => ({ mes, is_user: false, is_system: true });
const nudge = (rule, text = 't') => ({ rule, action: 'nudge', reason: 'r', text });

describe('hashText', () => {
    it('separates different texts and repeats for the same text', () => {
        assert.equal(hashText('The door is open.'), hashText('The door is open.'));
        assert.notEqual(hashText('The door is open.'), hashText('The door is shut.'));
        assert.notEqual(hashText(''), hashText(' '));
    });
});

describe('writeScores', () => {
    it('creates extra on a message that has none', () => {
        const message = narrator('one');
        writeScores(message, { change: 2 });
        assert.equal(message.extra.jeved.scores.change, 2);
    });

    it('leaves other extra keys alone', () => {
        const message = { ...narrator('one'), extra: { reasoning: 'kept' } };
        writeScores(message, { change: 2 });
        assert.equal(message.extra.reasoning, 'kept');
    });

    it('merges a second call into the same record', () => {
        const message = narrator('one');
        writeScores(message, { change: 2 });
        writeScores(message, { tone: 1 });
        assert.deepEqual(message.extra.jeved.scores, { change: 2, tone: 1 });
    });

    it('drops old scores when the text has changed since they were written', () => {
        const message = narrator('one');
        writeScores(message, { change: 2 });
        message.mes = 'edited';
        writeScores(message, { tone: 1 });
        assert.deepEqual(message.extra.jeved.scores, { tone: 1 });
    });

    it('stores the hash it is given rather than the current text', () => {
        const message = narrator('one');
        const hash = hashText(message.mes);
        message.mes = 'edited while the call was in flight';
        writeScores(message, { change: 2 }, hash);
        assert.equal(getScores(message), null);
    });
});

describe('getScores', () => {
    it('returns the record while the text is unchanged', () => {
        const message = narrator('one');
        writeScores(message, { change: 2 });
        assert.equal(getScores(message).scores.change, 2);
    });

    it('returns null when the text no longer matches the hash', () => {
        const message = narrator('one');
        writeScores(message, { change: 2 });
        message.mes = 'swiped';
        assert.equal(getScores(message), null);
    });

    it('returns null for a message with no record', () => {
        assert.equal(getScores(narrator('one')), null);
    });
});

describe('getHistory', () => {
    it('returns the last narrator replies oldest first with their chat index, skipping user and system messages', () => {
        const chat = [narrator('a'), user('u1'), narrator('b'), system('s'), user('u2'), narrator('c')];
        chat.filter(message => !message.is_user && !message.is_system).forEach((message, index) => writeScores(message, { change: index }));
        const history = getHistory(chat, 2);
        assert.deepEqual(history.map(entry => entry.index), [2, 5]);
        assert.deepEqual(history.map(entry => entry.scores.change), [1, 2]);
    });

    it('returns null scores in place of a reply whose text changed', () => {
        const chat = [narrator('a'), narrator('b')];
        writeScores(chat[0], { change: 1 });
        writeScores(chat[1], { change: 2 });
        chat[0].mes = 'edited';
        assert.deepEqual(getHistory(chat, 2).map(entry => entry.scores?.change ?? null), [null, 2]);
    });

    it('returns fewer entries than asked when the chat is short', () => {
        assert.equal(getHistory([user('u'), narrator('a')], 5).length, 1);
    });
});

describe('getHistory carry forward', () => {
    const measured = (chat, index, scores) => writeScores(chat[index], scores);

    it('inherits a carried score from an older reply that has one', () => {
        const chat = [narrator('a'), narrator('b'), narrator('c')];
        measured(chat, 0, { tone: 1, change: 4 });
        measured(chat, 1, { change: 3 });
        measured(chat, 2, { change: 2 });
        assert.deepEqual(getHistory(chat, 3, ['tone']).map(entry => entry.scores.tone), [1, 1, 1]);
    });

    it('leaves the score missing when no carry forward list is given', () => {
        const chat = [narrator('a'), narrator('b')];
        measured(chat, 0, { tone: 1 });
        measured(chat, 1, { change: 2 });
        assert.equal(getHistory(chat, 2)[1].scores.tone, undefined);
        assert.equal(getHistory(chat, 2, ['tone'])[1].scores.tone, 1);
    });

    it('inherits from a source older than the window', () => {
        const chat = [narrator('a'), narrator('b'), narrator('c')];
        measured(chat, 0, { tone: 1 });
        measured(chat, 1, {});
        measured(chat, 2, {});
        assert.deepEqual(getHistory(chat, 2, ['tone']).map(entry => entry.scores.tone), [1, 1]);
    });

    it('does not inherit an id that is not in the carry forward list', () => {
        const chat = [narrator('a'), narrator('b')];
        measured(chat, 0, { tone: 1, change: 4 });
        measured(chat, 1, {});
        const [, latest] = getHistory(chat, 2, ['tone']);
        assert.equal(latest.scores.tone, 1);
        assert.equal(latest.scores.change, undefined);
    });

    it('does not invent a score when no older reply has one', () => {
        const chat = [narrator('a'), narrator('b')];
        measured(chat, 0, { change: 4 });
        measured(chat, 1, { change: 3 });
        assert.deepEqual(getHistory(chat, 2, ['tone']).map(entry => entry.scores.tone), [undefined, undefined]);
    });

    it('does not carry a score forward from a record whose text has changed', () => {
        const chat = [narrator('a'), narrator('b')];
        measured(chat, 0, { tone: 1 });
        measured(chat, 1, {});
        chat[0].mes = 'edited';
        assert.equal(getHistory(chat, 2, ['tone'])[1].scores.tone, undefined);
    });

    it('keeps the scores a reply was given of its own beside the carried ones', () => {
        const chat = [narrator('a'), narrator('b'), narrator('c')];
        measured(chat, 0, { tone: 1, change: 4 });
        measured(chat, 1, { change: 3 });
        const [oldest, middle, newest] = getHistory(chat, 3, ['tone']);
        assert.deepEqual(oldest.own, { tone: 1, change: 4 });
        assert.equal(middle.scores.tone, 1);
        assert.equal(middle.own.tone, undefined);
        assert.deepEqual(middle.own, { change: 3 });
        assert.equal(newest.own, null);
    });

    it('prefers the newest older score when several replies carry one', () => {
        const chat = [narrator('a'), narrator('b'), narrator('c')];
        measured(chat, 0, { tone: 0 });
        measured(chat, 1, { tone: 3 });
        measured(chat, 2, {});
        assert.equal(getHistory(chat, 1, ['tone'])[0].scores.tone, 3);
    });
});

describe('confidence beside the value', () => {
    const measured = (message, scores, confidence) => writeScores(message, scores, hashText(message.mes), confidence);

    it('keeps the confidence that came with a value', () => {
        const message = narrator('one');
        measured(message, { change: 2 }, { change: 0.8 });
        assert.equal(getScores(message).confidence.change, 0.8);
    });

    it('clears the old confidence when the new answer carries none', () => {
        const message = narrator('one');
        measured(message, { change: 2 }, { change: 0.8 });
        writeScores(message, { change: 3 });
        assert.equal(getScores(message).confidence.change, undefined);
        assert.equal(getScores(message).scores.change, 3);
    });

    it('leaves the confidence of a sensor the call did not answer alone', () => {
        const message = narrator('one');
        measured(message, { change: 2 }, { change: 0.8 });
        measured(message, { tone: 1 }, { tone: 0.2 });
        assert.deepEqual(getScores(message).confidence, { change: 0.8, tone: 0.2 });
    });

    it('refuses a confidence that is not a finite number', () => {
        const message = narrator('one');
        measured(message, { change: 2 }, { change: '0.8' });
        assert.equal(getScores(message).confidence.change, undefined);
    });

    it('reports the confidence on the history entry it belongs to', () => {
        const chat = [narrator('a'), narrator('b')];
        measured(chat[0], { change: 2 }, { change: 0.6 });
        writeScores(chat[1], { change: 3 });
        assert.deepEqual(getHistory(chat, 2).map(entry => entry.confidence.change), [0.6, undefined]);
    });

    it('carries a word value forward with the confidence it was given', () => {
        const chat = [narrator('a'), narrator('b')];
        measured(chat[0], { mood: 'calm' }, { mood: 0.9 });
        writeScores(chat[1], { change: 2 });
        const [, latest] = getHistory(chat, 2, ['mood']);
        assert.equal(latest.scores.mood, 'calm');
        assert.equal(latest.confidence.mood, 0.9);
    });

    it('drops the carried confidence once a later reply was measured without one', () => {
        const chat = [narrator('a'), narrator('b'), narrator('c')];
        measured(chat[0], { mood: 'calm' }, { mood: 0.9 });
        writeScores(chat[1], { mood: 'angry' });
        writeScores(chat[2], {});
        const [, , newest] = getHistory(chat, 3, ['mood']);
        assert.equal(newest.scores.mood, 'angry');
        assert.equal(newest.confidence.mood, undefined);
    });
});

describe('a stored value that no longer fits its sensor', () => {
    const picker = [{ id: 'mood', type: 'choice', options: [{ name: 'calm', description: '' }, { name: 'angry', description: '' }] }];

    it('reads as not measured once the option is gone', () => {
        const chat = [narrator('a')];
        writeScores(chat[0], { mood: 'bored' });
        assert.equal(getHistory(chat, 1, [], picker)[0].scores.mood, undefined);
        assert.equal(getHistory(chat, 1)[0].scores.mood, 'bored');
    });

    it('reads as not measured once the sensor changed type', () => {
        const chat = [narrator('a')];
        writeScores(chat[0], { mood: 3 });
        assert.equal(getHistory(chat, 1, [], picker)[0].scores.mood, undefined);
    });

    it('reads as not measured once the scale got shorter', () => {
        const chat = [narrator('a')];
        writeScores(chat[0], { tone: 3 });
        assert.equal(getHistory(chat, 1, [], [{ id: 'tone', levels: ['a', 'b'] }])[0].scores.tone, undefined);
        assert.equal(getHistory(chat, 1, [], [{ id: 'tone', levels: ['a', 'b', 'c', 'd'] }])[0].scores.tone, 3);
    });

    it('is not carried forward and is not the latest score either', () => {
        const chat = [narrator('a'), narrator('b')];
        writeScores(chat[0], { mood: 'bored' });
        writeScores(chat[1], {});
        assert.equal(getHistory(chat, 2, ['mood'], picker)[1].scores.mood, undefined);
        assert.equal(latestScores(chat, ['mood'], 2, picker).mood, undefined);
        assert.equal(latestScores(chat, ['mood'], 2).mood, 'bored');
    });
});

describe('repliesSince', () => {
    it('is infinite when no user message matches', () => {
        const chat = [user('u'), narrator('a')];
        writeDecision(chat[0], { fired: [] });
        assert.equal(repliesSince(chat, nudged), Infinity);
    });

    it('counts the narrator replies after the newest nudged user message', () => {
        const chat = [user('u1'), narrator('a'), user('u2'), narrator('b'), narrator('c')];
        writeDecision(chat[0], { fired: [nudge('flat')] });
        assert.equal(repliesSince(chat, nudged), 3);
    });

    it('is zero on the turn the nudge was decided', () => {
        const chat = [narrator('a'), user('u')];
        writeDecision(chat[1], { fired: [nudge('flat')] });
        assert.equal(repliesSince(chat, nudged), 0);
    });

    it('ignores a fired entry whose text was taken away', () => {
        const chat = [user('u'), narrator('a')];
        writeDecision(chat[0], { fired: [{ rule: 'long', action: 'swipe', reason: 'r' }] });
        assert.equal(repliesSince(chat, nudged), Infinity);
        assert.equal(repliesSince(chat, firedRule('long')), 1);
    });

    it('counts one rule at a time for its own cooldown', () => {
        const chat = [user('u1'), narrator('a'), user('u2'), narrator('b')];
        writeDecision(chat[0], { fired: [nudge('drift')] });
        writeDecision(chat[2], { fired: [nudge('flat')] });
        assert.equal(repliesSince(chat, firedRule('drift')), 2);
        assert.equal(repliesSince(chat, firedRule('flat')), 1);
        assert.equal(repliesSince(chat, firedRule('gentle')), Infinity);
    });

    it('stops counting at the limit it is given', () => {
        const chat = [user('u'), narrator('a'), narrator('b'), narrator('c')];
        writeDecision(chat[0], { fired: [nudge('flat')] });
        assert.equal(repliesSince(chat, nudged, 2), 2);
        assert.equal(repliesSince(chat, nudged, 8), 3);
    });
});

describe('fired entries', () => {
    it('adds an entry to a message that has no record yet', () => {
        const message = user('u');
        addFired(message, { rule: 'long', action: 'swipe', reason: 'r', text: 't' });
        assert.deepEqual(fired(message).map(entry => entry.rule), ['long']);
        assert.equal(message.extra.jeved.decided, true);
    });

    it('keeps the entries that are already there', () => {
        const message = user('u');
        writeDecision(message, { fired: [nudge('flat')] });
        addFired(message, { rule: 'long', action: 'swipe', reason: 'r' });
        assert.deepEqual(fired(message).map(entry => entry.rule), ['flat', 'long']);
    });

    it('takes the text off one entry and leaves the entry in place', () => {
        const message = user('u');
        writeDecision(message, { fired: [nudge('flat'), { rule: 'long', action: 'swipe', reason: 'r', text: 't' }] });
        assert.equal(stripFiredText(message, 'long'), true);
        assert.equal(stripFiredText(message, 'long'), false);
        assert.equal(stripFiredText(message, 'gone'), false);
        assert.deepEqual(fired(message).map(entry => entry.text), ['t', undefined]);
        assert.equal(fired(message).length, 2);
    });
});

describe('clearScores', () => {
    it('removes narrator records and keeps user decisions', () => {
        const chat = [user('u'), narrator('a'), narrator('b')];
        writeDecision(chat[0], { fired: [nudge('flat')] });
        writeScores(chat[1], { change: 1 });
        writeScores(chat[2], { change: 2 });
        assert.equal(clearScores(chat), 2);
        assert.equal(getScores(chat[1]), null);
        assert.equal(fired(chat[0])[0].rule, 'flat');
    });
});
