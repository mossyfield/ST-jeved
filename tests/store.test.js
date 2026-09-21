import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    addFired, clearScores, fired, firedFor, getHistory, getRecord, getScores, latestScores, makeReceipt,
    sinceRuleIn, stripFiredText, writeDecision, writeScores,
} from '../src/store.js';
import { hashText } from '../src/util.js';
import { user } from './helpers/chat.js';

const narrator = mes => ({ mes, is_user: false });
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

    it('keeps the decision and the receipts a user message already carries', () => {
        const message = user('u');
        writeDecision(message, [nudge('flat')]);
        writeScores(message, { scene: 'combat' });
        assert.equal(getScores(message).scores.scene, 'combat');
        assert.equal(getRecord(message).decided, true);
        assert.deepEqual(fired(message).map(entry => entry.rule), ['flat']);
    });
});

describe('the answers of a repeating sensor', () => {
    const house = { id: 'house', label: 'House', type: 'noul', repeat: 'rules' };

    it('merges a partial answer entry by entry instead of replacing the map', () => {
        const message = narrator('one');
        writeScores(message, { house: { one: 0.9 } });
        writeScores(message, { house: { two: 0.2 } });
        assert.deepEqual(getScores(message).scores.house, { one: 0.9, two: 0.2 });
    });

    it('merges the confidence of each entry the same way', () => {
        const message = narrator('one');
        writeScores(message, { tone: 1 }, hashText('one'), { tone: 0.5 });
        writeScores(message, { tone: { one: 1 } }, hashText('one'), { tone: { one: 0.8 } });
        writeScores(message, { tone: { two: 1 } }, hashText('one'), { tone: { two: 0.4 } });
        assert.deepEqual(getScores(message).confidence.tone, { one: 0.8, two: 0.4 });
    });

    it('carries the confidence of each entry into the history, and drops a level that is not a number', () => {
        const chat = [narrator('one')];
        writeScores(chat[0], { house: { one: 0.9, two: 0.2 } }, hashText('one'), { house: { one: 0.8, two: 'high' } });
        assert.deepEqual(getHistory(chat, 1, 'reply', [house])[0].confidence.house, { one: 0.8 });
    });

    it('is read as an answer only while one entry holds a usable value', () => {
        const chat = [narrator('one')];
        writeScores(chat[0], { house: { one: 0.9 } });
        assert.deepEqual(getHistory(chat, 1, 'reply', [house])[0].scores.house, { one: 0.9 });

        writeScores(chat[1] = narrator('two'), { house: {} });
        assert.equal(getHistory([chat[1]], 1, 'reply', [house])[0].scores.house, undefined);
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

describe('getHistory at the reply moment', () => {
    it('returns the last replies oldest first with their chat index, skipping user and system messages', () => {
        const chat = [narrator('a'), user('u1'), narrator('b'), system('s'), user('u2'), narrator('c')];
        chat.filter(message => !message.is_user && !message.is_system).forEach((message, index) => writeScores(message, { change: index }));
        const history = getHistory(chat, 2);
        assert.deepEqual(history.map(entry => entry.index), [2, 5]);
        assert.deepEqual(history.map(entry => entry.scores.change), [1, 2]);
    });

    it('merges the answers of the nearest user message before the reply', () => {
        const chat = [user('u1'), narrator('a'), user('u2'), narrator('b')];
        writeScores(chat[0], { scene: 'combat' });
        writeScores(chat[1], { change: 1 });
        writeScores(chat[2], { scene: 'travel' });
        writeScores(chat[3], { change: 2 });
        const history = getHistory(chat, 2);
        assert.deepEqual(history.map(entry => entry.scores), [{ scene: 'combat', change: 1 }, { scene: 'travel', change: 2 }]);
    });

    it('shares one user message between the replies of a group', () => {
        const chat = [user('u1'), narrator('a'), narrator('b')];
        writeScores(chat[0], { scene: 'combat' });
        writeScores(chat[1], { change: 1 });
        writeScores(chat[2], { change: 2 });
        assert.deepEqual(getHistory(chat, 2).map(entry => entry.scores.scene), ['combat', 'combat']);
    });

    it('gives a reply with no user message before it its own answers only', () => {
        const chat = [narrator('greeting'), user('u1'), narrator('a')];
        writeScores(chat[0], { change: 0 });
        writeScores(chat[1], { scene: 'travel' });
        writeScores(chat[2], { change: 1 });
        const [greeting, reply] = getHistory(chat, 2);
        assert.deepEqual(greeting.scores, { change: 0 });
        assert.deepEqual(reply.scores, { scene: 'travel', change: 1 });
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

    it('counts the replies before each entry', () => {
        const chat = [user('u1'), narrator('a'), narrator('b'), user('u2'), narrator('c')];
        assert.deepEqual(getHistory(chat, 5).map(entry => entry.replies), [0, 1, 2]);
    });
});

describe('getHistory at the message moment', () => {
    it('gives every user message its own entry with its own answers', () => {
        const chat = [user('u1'), narrator('a'), user('u2'), narrator('b')];
        writeScores(chat[0], { scene: 'combat' });
        writeScores(chat[1], { change: 1 });
        writeScores(chat[2], { scene: 'travel' });
        const history = getHistory(chat, 5, 'message');
        assert.deepEqual(history.map(entry => entry.index), [0, 2]);
        assert.deepEqual(history.map(entry => entry.scores), [{ scene: 'combat' }, { scene: 'travel' }]);
    });

    it('keeps two messages in a row apart and counts the replies before each', () => {
        const chat = [user('u1'), user('u2'), narrator('a'), user('u3')];
        for (const message of chat) {
            writeScores(message, { scene: 'travel' });
        }
        const history = getHistory(chat, 5, 'message');
        assert.deepEqual(history.map(entry => entry.index), [0, 1, 3]);
        assert.deepEqual(history.map(entry => entry.replies), [0, 0, 1]);
    });

    it('leaves a message with no answer in the window as no match', () => {
        const chat = [user('u1'), user('u2')];
        writeScores(chat[0], { scene: 'combat' });
        const history = getHistory(chat, 5, 'message');
        assert.equal(history.length, 2);
        assert.equal(history[1].scores, null);
    });
});

describe('a stored value that no longer fits its sensor', () => {
    const picker = [{ id: 'mood', type: 'choice', options: [{ name: 'calm', description: '' }, { name: 'angry', description: '' }] }];

    it('reads as not measured once the option is gone', () => {
        const chat = [narrator('a')];
        writeScores(chat[0], { mood: 'bored' });
        assert.equal(getHistory(chat, 1, 'reply', picker)[0].scores.mood, undefined);
        assert.equal(getHistory(chat, 1)[0].scores.mood, 'bored');
    });

    it('reads as not measured once the sensor changed type', () => {
        const chat = [narrator('a')];
        writeScores(chat[0], { mood: 3 });
        assert.equal(getHistory(chat, 1, 'reply', picker)[0].scores.mood, undefined);
    });

    it('reads as not measured once the scale got shorter', () => {
        const chat = [narrator('a')];
        writeScores(chat[0], { tone: 3 });
        assert.equal(getHistory(chat, 1, 'reply', [{ id: 'tone', levels: ['a', 'b'] }])[0].scores.tone, undefined);
        assert.equal(getHistory(chat, 1, 'reply', [{ id: 'tone', levels: ['a', 'b', 'c', 'd'] }])[0].scores.tone, 3);
    });

    it('is not the latest answer either', () => {
        const chat = [narrator('a'), narrator('b')];
        writeScores(chat[0], { mood: 'bored' });
        writeScores(chat[1], {});
        assert.equal(latestScores(chat, ['mood'], 2, picker).mood, undefined);
        assert.equal(latestScores(chat, ['mood'], 2).mood, 'bored');
    });
});

describe('latestScores', () => {
    it('reads the newest answer from a user message as well as a reply', () => {
        const chat = [user('u1'), narrator('a'), user('u2')];
        writeScores(chat[0], { scene: 'combat' });
        writeScores(chat[1], { change: 1 });
        writeScores(chat[2], { scene: 'travel' });
        assert.deepEqual(latestScores(chat, ['scene', 'change']), { scene: 'travel', change: 1 });
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

    it('merges the confidence of a user message into the reply entry', () => {
        const chat = [user('u'), narrator('a')];
        measured(chat[0], { scene: 'combat' }, { scene: 0.9 });
        measured(chat[1], { change: 2 }, { change: 0.6 });
        assert.deepEqual(getHistory(chat, 1)[0].confidence, { scene: 0.9, change: 0.6 });
    });
});

describe('sinceRuleIn', () => {
    const script = (rule, reply) => ({ rule, action: 'script', reason: 'r', reply });

    it('is infinite for a rule with no receipt', () => {
        const chat = [user('u'), narrator('a')];
        writeDecision(chat[0], []);
        assert.equal(sinceRuleIn(chat)('flat'), Infinity);
    });

    it('counts the replies after the user message of a receipt that names no reply', () => {
        const chat = [user('u1'), narrator('a'), user('u2'), narrator('b'), narrator('c')];
        writeDecision(chat[0], [nudge('flat')]);
        assert.equal(sinceRuleIn(chat)('flat'), 3);
    });

    it('is zero on the turn the rule was decided', () => {
        const chat = [narrator('a'), user('u')];
        writeDecision(chat[1], [nudge('flat')]);
        assert.equal(sinceRuleIn(chat)('flat'), 0);
    });

    it('counts one rule at a time and takes the newest receipt of each', () => {
        const chat = [user('u1'), narrator('a'), user('u2'), narrator('b')];
        writeDecision(chat[0], [nudge('drift')]);
        writeDecision(chat[2], [nudge('flat')]);
        const since = sinceRuleIn(chat);
        assert.equal(since('drift'), 2);
        assert.equal(since('flat'), 1);
        assert.equal(since('gentle'), Infinity);
    });

    it('counts from the reply a receipt names, not from the message it sits on', () => {
        const chat = [user('u'), narrator('a'), narrator('b'), narrator('c')];
        addFired(chat[0], script('shot', hashText('b')));
        assert.equal(sinceRuleIn(chat)('shot'), 2);
    });

    it('falls back to the user message when the reply it names is gone', () => {
        const chat = [user('u'), narrator('a'), narrator('b'), narrator('c')];
        addFired(chat[0], script('shot', hashText('b')));
        chat[2].mes = 'swiped';
        assert.equal(sinceRuleIn(chat)('shot'), 3);
    });

    it('matches a reply of its own turn only', () => {
        const chat = [user('u1'), narrator('a'), narrator('b'), user('u2'), narrator('b')];
        addFired(chat[0], script('shot', hashText('b')));
        assert.equal(sinceRuleIn(chat)('shot'), 2);
    });

    it('ignores a position stored by an older version', () => {
        const chat = [user('u'), narrator('a'), narrator('b')];
        addFired(chat[0], { ...script('shot'), at: 99 });
        assert.equal(sinceRuleIn(chat)('shot'), 2);
    });
});

describe('makeReceipt', () => {
    const hit = (directive = '') => ({ rule: { id: 'flat', directive }, reason: 'because' });

    it('carries the text of a rule whose action uses one', () => {
        assert.deepEqual(makeReceipt(hit('(OOC)'), 'nudge'), { rule: 'flat', action: 'nudge', reason: 'because', text: '(OOC)' });
        assert.equal(makeReceipt(hit('   '), 'nudge').text, undefined);
    });

    it('leaves the text off an action that adds no instruction', () => {
        assert.equal(makeReceipt(hit('(OOC)'), 'script').text, undefined);
    });

    it('keeps the reply it was made on and the answers behind it', () => {
        const entry = makeReceipt(hit(), 'script', { reply: 'h1', scores: { tone: 2 } });
        assert.equal(entry.reply, 'h1');
        assert.deepEqual(entry.scores, { tone: 2 });
    });

    it('stores no empty answers and no missing reply', () => {
        const entry = makeReceipt(hit(), 'swipe', { scores: {} });
        assert.equal('scores' in entry, false);
        assert.equal('reply' in entry, false);
    });
});

describe('a decision on a message that was edited', () => {
    it('stamps each entry and the record with the text it was made on', () => {
        const message = user('u');
        writeDecision(message, [nudge('flat')]);
        assert.equal(getRecord(message).decidedHash, hashText('u'));
        assert.deepEqual(fired(message).map(entry => entry.hash), [hashText('u')]);
        assert.deepEqual(firedFor(message).map(entry => entry.rule), ['flat']);
    });

    it('keeps the old entries as receipts and gives no text for them', () => {
        const message = user('u');
        writeDecision(message, [nudge('flat')]);
        message.mes = 'edited';
        writeDecision(message, [nudge('drift')]);
        assert.deepEqual(fired(message).map(entry => entry.rule), ['flat', 'drift']);
        assert.deepEqual(firedFor(message).map(entry => entry.rule), ['drift']);
        assert.equal(getRecord(message).decidedHash, hashText('edited'));
    });

    it('keeps the receipts when the new decision fires nothing', () => {
        const message = user('u');
        writeDecision(message, [nudge('flat')]);
        message.mes = 'edited';
        writeDecision(message, []);
        assert.deepEqual(fired(message).map(entry => entry.rule), ['flat']);
        assert.deepEqual(firedFor(message), []);
        assert.equal(sinceRuleIn([message])('flat'), 0);
    });

    it('keeps the answers the message already had', () => {
        const message = user('u');
        writeScores(message, { scene: 'combat' });
        writeDecision(message, [nudge('flat')]);
        assert.equal(getScores(message).scores.scene, 'combat');
    });

    it('takes the text off the entries it replaces, so the old text cannot come back', () => {
        const message = user('u');
        writeDecision(message, [nudge('flat', 'first')]);
        message.mes = 'edited';
        writeDecision(message, [nudge('drift', 'second')]);
        message.mes = 'u';

        assert.deepEqual(firedFor(message).map(entry => entry.text), [undefined]);
        assert.deepEqual(fired(message).map(entry => entry.rule), ['flat', 'drift']);
        assert.equal(sinceRuleIn([message])('flat'), 0);
    });
});

describe('fired entries', () => {
    it('adds an entry to a message that has no record yet, and makes no decision of it', () => {
        const message = user('u');
        addFired(message, { rule: 'long', action: 'swipe', reason: 'r', text: 't' });
        assert.deepEqual(fired(message).map(entry => entry.rule), ['long']);
        assert.deepEqual(firedFor(message).map(entry => entry.rule), ['long']);
        assert.equal(getRecord(message).decided, undefined);
        assert.equal(getRecord(message).decidedHash, undefined);
    });

    it('leaves the hash of a decision that is already there alone', () => {
        const message = user('u');
        writeDecision(message, [nudge('flat')]);
        const stamped = getRecord(message).decidedHash;
        message.mes = 'edited';
        addFired(message, { rule: 'long', action: 'swipe', reason: 'r', text: 't' });
        assert.equal(getRecord(message).decidedHash, stamped);
    });

    it('keeps the entries that are already there', () => {
        const message = user('u');
        writeDecision(message, [nudge('flat')]);
        addFired(message, { rule: 'long', action: 'swipe', reason: 'r' });
        assert.deepEqual(fired(message).map(entry => entry.rule), ['flat', 'long']);
    });

    it('takes the text off the newest entry of a rule and leaves the entry in place', () => {
        const message = user('u');
        writeDecision(message, [nudge('flat'), { rule: 'long', action: 'swipe', reason: 'r', text: 't' }]);
        assert.equal(stripFiredText(message, 'long'), true);
        assert.equal(stripFiredText(message, 'long'), false);
        assert.equal(stripFiredText(message, 'gone'), false);
        assert.deepEqual(fired(message).map(entry => entry.text), ['t', undefined]);
        assert.equal(fired(message).length, 2);
    });
});

describe('clearScores', () => {
    it('clears the answers on replies and on user messages and keeps the decisions', () => {
        const chat = [user('u'), narrator('a'), narrator('b')];
        writeDecision(chat[0], [nudge('flat')]);
        writeScores(chat[0], { scene: 'combat' });
        writeScores(chat[1], { change: 1 });
        writeScores(chat[2], { change: 2 });
        assert.equal(clearScores(chat), 3);
        assert.equal(getScores(chat[0]), null);
        assert.equal(getScores(chat[1]), null);
        assert.deepEqual(fired(chat[0]).map(entry => entry.rule), ['flat']);
        assert.equal(getRecord(chat[0]).decided, true);
    });

    it('clears the copy the host keeps in swipe_info and drops an empty record', () => {
        const reply = narrator('a');
        writeScores(reply, { change: 1 });
        reply.swipe_info = [{ extra: { jeved: { hash: 'x', scores: { change: 4 } } } }];
        assert.equal(clearScores([reply]), 1);
        assert.equal(reply.extra.jeved, undefined);
        assert.equal(reply.swipe_info[0].extra.jeved, undefined);
    });

    it('counts a message whose only answers sat in an inactive swipe copy', () => {
        const reply = narrator('a');
        reply.swipe_info = [{ extra: { jeved: { hash: 'x', scores: { change: 4 } } } }];
        assert.equal(clearScores([reply]), 1);
        assert.equal(reply.swipe_info[0].extra.jeved, undefined);
    });

    it('counts nothing when no message holds an answer', () => {
        const chat = [user('u'), narrator('a')];
        writeDecision(chat[0], [nudge('flat')]);
        assert.equal(clearScores(chat), 0);
    });
});
