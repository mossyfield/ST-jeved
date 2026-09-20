import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluate, replayRule, sinceFire } from '../src/rules.js';
import { addFired, firedRule, getHistory, nudged, repliesSince, writeDecision, writeScores } from '../src/store.js';

const ids = ['change', 'tension'];

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
        directive: '(OOC: do the thing.)',
        script: '',
        ...overrides,
    };
}

function live(subject, replies, gap = 0) {
    const chat = [];
    const narrators = [];
    const fired = [];
    const action = subject.action ?? 'nudge';
    const cooldown = subject.cooldown || Infinity;
    const sinceRule = () => repliesSince(chat, firedRule(subject.id), cooldown);

    const decide = userIndex => {
        const hits = evaluate({
            history: getHistory(chat, subject.window),
            rules: [subject],
            sensorIds: ids,
            action: 'nudge',
            gap,
            maxNudges: 1,
            sinceAnyNudge: repliesSince(chat, nudged, gap),
            sinceRule,
        });
        if (hits.length) {
            writeDecision(chat[userIndex], { fired: [{ rule: subject.id, action: 'nudge', reason: '', text: 'x' }] });
            fired.push(narrators[narrators.length - 1]);
        }
    };

    for (let turn = 0; turn < replies.length; turn++) {
        chat.push({ mes: `user ${turn}`, is_user: true });
        const userIndex = chat.length - 1;

        if (action === 'nudge') {
            decide(userIndex);
        }

        const message = { mes: `reply ${turn}` };
        writeScores(message, replies[turn]);
        chat.push(message);
        narrators.push(chat.length - 1);

        if (action === 'swipe') {
            const hits = evaluate({
                history: getHistory(chat, subject.window),
                rules: [subject],
                sensorIds: ids,
                action: 'swipe',
                sinceRule,
            });
            if (hits.length) {
                addFired(chat[userIndex], { rule: subject.id, action: 'swipe', reason: '', text: 'x' });
                fired.push(chat.length - 1);
            }
        }
    }

    if (action === 'nudge') {
        chat.push({ mes: 'user next', is_user: true });
        decide(chat.length - 1);
        chat.pop();
    }
    return { chat, fired };
}

function replayed(subject, chat, gap = 0) {
    return replayRule({
        history: getHistory(chat, chat.length),
        rule: subject,
        sensorIds: ids,
        gap,
    }).map(turn => turn.index);
}

const calm = count => Array.from({ length: count }, () => ({ change: 1, tension: 1 }));

describe('sinceFire', () => {
    it('counts a nudge from the reply it was decided on', () => {
        assert.equal(sinceFire('nudge', 5, 3), 2);
        assert.equal(sinceFire('nudge', 3, 3), 0);
    });

    it('counts a swipe one higher, because the reply it fired on is already past', () => {
        assert.equal(sinceFire('swipe', 5, 3), 3);
        assert.equal(sinceFire('swipe', 3, 3), 1);
    });

    it('is infinite when the rule has never fired', () => {
        assert.equal(sinceFire('nudge', 4, null), Infinity);
        assert.equal(sinceFire('swipe', 4, undefined), Infinity);
    });
});

describe('replay agrees with a live run', () => {
    it('agrees for a nudge rule with no wait', () => {
        const subject = rule();
        const { chat, fired } = live(subject, calm(6));
        assert.deepEqual(replayed(subject, chat), fired);
    });

    it('agrees for a nudge rule with a cooldown', () => {
        const subject = rule({ cooldown: 2 });
        const { chat, fired } = live(subject, calm(8));
        assert.deepEqual(replayed(subject, chat), fired);
        assert.ok(fired.length > 1 && fired.length < 8);
    });

    it('agrees for a nudge rule with a wait between nudges', () => {
        const subject = rule();
        const { chat, fired } = live(subject, calm(9), 3);
        assert.deepEqual(replayed(subject, chat, 3), fired);
    });

    it('agrees for a swipe rule with a cooldown', () => {
        const subject = rule({ action: 'swipe', cooldown: 2 });
        const { chat, fired } = live(subject, calm(8));
        assert.deepEqual(replayed(subject, chat), fired);
    });

    it('agrees for a swipe rule with no cooldown', () => {
        const subject = rule({ action: 'swipe' });
        const { chat, fired } = live(subject, calm(5));
        assert.deepEqual(replayed(subject, chat), fired);
    });

    it('agrees when only some replies match', () => {
        const scores = [{ change: 1 }, { change: 4 }, { change: 1 }, { change: 1 }, { change: 4 }, { change: 1 }];
        for (const action of ['nudge', 'swipe']) {
            const subject = rule({ action, cooldown: 1 });
            const { chat, fired } = live(subject, scores);
            assert.deepEqual(replayed(subject, chat), fired, action);
        }
    });
});
