import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AFTER_REPLY, BEFORE_GENERATION } from '../src/actions.js';
import { evaluate, replayRule, sinceFire } from '../src/rules.js';
import { phaseOfRule } from '../src/sensors.js';
import { addFired, getHistory, sinceRuleIn, writeDecision, writeScores } from '../src/store.js';
import { hashText } from '../src/util.js';

const ids = ['change', 'tension', 'scene'];
const sensors = [
    { id: 'change', label: 'Change', user: 1, assistant: 1 },
    { id: 'tension', label: 'Tension', user: 1, assistant: 1 },
    { id: 'scene', label: 'Scene', user: 1, assistant: 0 },
];

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

function live(subject, turns, { moment = 'reply', members = 1 } = {}) {
    const chat = [];
    const fired = [];
    const action = subject.action ?? 'nudge';
    const late = phaseOfRule(subject, sensors) === AFTER_REPLY;
    const sinceRule = id => sinceRuleIn(chat)(id);
    let lastReply = -1;

    const hitsNow = () => evaluate({
        history: getHistory(chat, subject.window, moment, sensors),
        rules: [subject],
        sensorIds: ids,
        sensors,
        action,
        sinceRule,
    });

    for (const turn of turns) {
        const message = { mes: `user ${chat.length}`, is_user: true };
        writeScores(message, turn.message ?? {});
        chat.push(message);
        const userIndex = chat.length - 1;

        if (!late && hitsNow().length) {
            writeDecision(chat[userIndex], [{ rule: subject.id, action, reason: '', text: 'x' }]);
            fired.push(moment === 'message' ? userIndex : lastReply);
        }

        for (let member = 0; member < members; member++) {
            const reply = { mes: `reply ${chat.length}` };
            writeScores(reply, turn.replies?.[member] ?? turn.reply ?? {});
            chat.push(reply);
            lastReply = chat.length - 1;
            if (late && hitsNow().length) {
                addFired(chat[userIndex], { rule: subject.id, action, reason: '', reply: hashText(reply.mes) });
                fired.push(lastReply);
            }
        }
    }

    if (!late && moment === 'reply') {
        chat.push({ mes: 'user next', is_user: true });
        if (hitsNow().length) {
            fired.push(lastReply);
        }
        chat.pop();
    }
    return { chat, fired };
}

function replayed(subject, chat, moment = 'reply') {
    return replayRule({
        history: getHistory(chat, chat.length, moment, sensors),
        rule: subject,
        sensorIds: ids,
        sensors,
    }).map(turn => turn.index);
}

const calm = count => Array.from({ length: count }, () => ({ reply: { change: 1, tension: 1 } }));

describe('sinceFire', () => {
    it('counts a before-reply rule from the reply it was decided on', () => {
        assert.equal(sinceFire(BEFORE_GENERATION, 5, 3), 2);
        assert.equal(sinceFire(BEFORE_GENERATION, 3, 3), 0);
    });

    it('counts an after-reply rule one higher, because the reply it fired on is already past', () => {
        assert.equal(sinceFire(AFTER_REPLY, 5, 3), 3);
        assert.equal(sinceFire(AFTER_REPLY, 3, 3), 1);
    });

    it('is infinite when the rule has never fired', () => {
        assert.equal(sinceFire(BEFORE_GENERATION, 4, null), Infinity);
        assert.equal(sinceFire(AFTER_REPLY, 4, undefined), Infinity);
    });
});

describe('replay agrees with a live run at the reply moment', () => {
    it('agrees for a nudge rule with no cooldown', () => {
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
        const scores = [1, 4, 1, 1, 4, 1].map(change => ({ reply: { change } }));
        for (const action of ['nudge', 'swipe']) {
            const subject = rule({ action, cooldown: 1 });
            const { chat, fired } = live(subject, scores);
            assert.deepEqual(replayed(subject, chat), fired, action);
        }
    });

    it('replays a nudge rule only where a decision is really made', () => {
        const subject = rule();
        const turns = Array.from({ length: 3 }, () => ({ replies: [{ change: 1 }, { change: 4 }] }));
        const { chat, fired } = live(subject, turns, { members: 2 });
        assert.deepEqual(fired, []);
        assert.deepEqual(replayed(subject, chat), []);
    });

    it('agrees for a script rule, which fires on the reply like a swipe rule', () => {
        const subject = rule({ action: 'script', directive: '', script: '/echo hi', cooldown: 2 });
        const { chat, fired } = live(subject, calm(8));
        assert.ok(fired.length > 1);
        assert.deepEqual(replayed(subject, chat), fired);
    });

    it('agrees for a script rule in a group chat, where its cooldown starts at one of two replies', () => {
        const subject = rule({ action: 'script', directive: '', script: '/echo hi', cooldown: 3 });
        const turns = Array.from({ length: 4 }, () => ({ replies: [{ change: 1 }, { change: 1 }] }));
        const { chat, fired } = live(subject, turns, { members: 2 });
        assert.ok(fired.length > 1 && fired.length < 8);
        assert.deepEqual(replayed(subject, chat), fired);
    });

    it('agrees in a group chat, where one message brings two replies', () => {
        const subject = rule({ cooldown: 2 });
        const turns = Array.from({ length: 4 }, () => ({ replies: [{ change: 4 }, { change: 1 }] }));
        const { chat, fired } = live(subject, turns, { members: 2 });
        assert.ok(fired.length > 1);
        assert.deepEqual(replayed(subject, chat), fired);
    });
});

describe('replay agrees with a live run at the message moment', () => {
    const early = overrides => rule({ conditions: [{ sensor: 'scene', op: 'below', value: 2 }], ...overrides });
    const asked = count => Array.from({ length: count }, () => ({ message: { scene: 1 }, reply: { change: 1 } }));

    it('agrees with no cooldown', () => {
        const subject = early();
        const { chat, fired } = live(subject, asked(5), { moment: 'message' });
        assert.deepEqual(fired.length, 5);
        assert.deepEqual(replayed(subject, chat, 'message'), fired);
    });

    it('agrees with a cooldown counted in replies', () => {
        const subject = early({ cooldown: 2 });
        const { chat, fired } = live(subject, asked(6), { moment: 'message' });
        assert.deepEqual(replayed(subject, chat, 'message'), fired);
        assert.ok(fired.length > 1 && fired.length < 6);
    });

    it('agrees in a group chat, where two replies pass between messages', () => {
        const subject = early({ cooldown: 2 });
        const turns = Array.from({ length: 4 }, () => ({ message: { scene: 1 }, reply: { change: 1 } }));
        const { chat, fired } = live(subject, turns, { moment: 'message', members: 2 });
        assert.deepEqual(fired.length, 4);
        assert.deepEqual(replayed(subject, chat, 'message'), fired);
    });

    it('skips a message with no answer', () => {
        const subject = early();
        const turns = [{ message: { scene: 1 } }, { message: {} }, { message: { scene: 1 } }];
        const { chat, fired } = live(subject, turns, { moment: 'message' });
        assert.deepEqual(fired.length, 2);
        assert.deepEqual(replayed(subject, chat, 'message'), fired);
    });
});
