import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conditionHolds, evaluate, explain, matchingCount, missingSensors, replayRule } from '../src/rules.js';

let next = 0;
const reply = scores => ({ index: next++, scores });

function rule(overrides = {}) {
    return {
        id: 'flat',
        label: 'Flat',
        enabled: true,
        action: 'nudge',
        conditions: [{ sensor: 'change', op: 'below', value: 2.5 }],
        need: 3,
        window: 4,
        skipWhen: null,
        cooldown: 0,
        directive: '(OOC: do the thing.)',
        script: '',
        ...overrides,
    };
}

const scale = ['a', 'b', 'c', 'd', 'e'];
const sensors = [
    { id: 'change', label: 'Change', levels: scale },
    { id: 'tension', label: 'Tension', levels: scale },
    { id: 'tone', label: 'Tone', levels: scale },
    { id: 'cost', label: 'Cost', levels: scale },
];
const ids = sensors.map(sensor => sensor.id);

function run(history, rules, extra = {}) {
    return evaluate({ history, rules, sensorIds: ids, ...extra });
}

const firedIds = hits => hits.map(hit => hit.rule.id);
const calm = () => [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 })];

describe('evaluate', () => {
    it('fires when K of the last W replies match', () => {
        const history = [reply({ change: 3 }), reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 })];
        assert.deepEqual(firedIds(run(history, [rule()])), ['flat']);
    });

    it('does not fire when fewer than K replies match', () => {
        const history = [reply({ change: 1 }), reply({ change: 3 }), reply({ change: 3 }), reply({ change: 1 })];
        assert.deepEqual(run(history, [rule()]), []);
    });

    it('ignores replies outside the window', () => {
        const history = [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 3 }), reply({ change: 3 }), reply({ change: 3 })];
        assert.deepEqual(run(history, [rule()]), []);
    });

    it('treats a missing score as no match', () => {
        const history = [reply({ change: 1 }), reply({}), reply({ change: 1 }), reply({ change: 1 })];
        assert.deepEqual(run(history, [rule({ need: 4 })]), []);
    });

    it('breaks a consecutive run when one reply has no record', () => {
        const consecutive = rule({ need: 5, window: 5 });
        const broken = [reply({ change: 1 }), reply({ change: 1 }), reply(null), reply({ change: 1 }), reply({ change: 1 })];
        const whole = [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 })];
        assert.deepEqual(run(broken, [consecutive]), []);
        assert.deepEqual(firedIds(run(whole, [consecutive])), ['flat']);
    });

    it('requires every condition of a rule to hold on the same reply', () => {
        const both = rule({ need: 2, window: 2, conditions: [
            { sensor: 'change', op: 'below', value: 2.5 },
            { sensor: 'tension', op: 'below', value: 1.5 },
        ] });
        const mixed = [reply({ change: 1, tension: 3 }), reply({ change: 1, tension: 1 })];
        const matching = [reply({ change: 1, tension: 1 }), reply({ change: 1, tension: 1 })];
        assert.deepEqual(run(mixed, [both]), []);
        assert.deepEqual(firedIds(run(matching, [both])), ['flat']);
    });

    it('compares with above as well as below', () => {
        const high = rule({ need: 1, window: 1, conditions: [{ sensor: 'tension', op: 'above', value: 2.5 }] });
        assert.deepEqual(firedIds(run([reply({ tension: 3 })], [high])), ['flat']);
        assert.deepEqual(run([reply({ tension: 2 })], [high]), []);
    });

    it('skips a rule when the latest reply matches skipWhen', () => {
        const gated = rule({ skipWhen: { sensor: 'tension', op: 'above', value: 2.5 } });
        const history = [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1, tension: 3 })];
        assert.deepEqual(run(history, [gated]), []);
    });

    it('does not skip when the latest reply has no score for skipWhen', () => {
        const gated = rule({ skipWhen: { sensor: 'tension', op: 'above', value: 2.5 } });
        assert.deepEqual(firedIds(run(calm(), [gated])), ['flat']);
    });

    it('ignores a disabled rule and a rule with no conditions', () => {
        assert.deepEqual(run(calm(), [rule({ enabled: false })]), []);
        assert.deepEqual(run(calm(), [rule({ conditions: [] })]), []);
    });

    it('skips a rule that names a sensor that no longer exists', () => {
        const orphan = rule({ conditions: [{ sensor: 'gone', op: 'below', value: 1 }] });
        assert.deepEqual(run(calm(), [orphan]), []);
    });

    it('names the missing sensors of a rule', () => {
        const orphan = rule({
            conditions: [{ sensor: 'gone', op: 'below', value: 1 }],
            skipWhen: { sensor: 'also_gone', op: 'above', value: 1 },
        });
        assert.deepEqual(missingSensors(orphan, ids), ['gone', 'also_gone']);
        assert.deepEqual(missingSensors(rule(), ids), []);
    });

    it('reports the sensor, the counts and the window scores, naming a missing one', () => {
        const history = [reply({ change: 3 }), reply({ change: 1.25 }), reply(null), reply({ change: 1 })];
        const [hit] = run(history, [rule({ need: 2 })]);
        assert.equal(hit.reason, 'change below 2.5 in 2 of the last 4 replies: 3, 1.3, missing, 1');
    });

    it('writes the threshold and the values of the fire reason the way the sensor type reads', () => {
        const typed = [
            { id: 'danger', label: 'Danger', type: 'noul' },
            { id: 'mood', label: 'Mood', type: 'choice', options: [{ name: 'calm' }, { name: 'angry' }] },
        ];
        const risky = rule({ need: 1, window: 1, conditions: [{ sensor: 'danger', op: 'above', value: 0.6 }] });
        const [hit] = run([reply({ danger: 0.72 })], [risky], { sensors: typed, sensorIds: ['danger', 'mood'] });
        assert.equal(hit.reason, 'danger above 60% in 1 of the last 1 replies: 72%');

        const picked = rule({ need: 1, window: 1, conditions: [{ sensor: 'mood', op: 'is_not', value: 'calm' }] });
        const [other] = run([reply({ mood: 'angry' })], [picked], { sensors: typed, sensorIds: ['danger', 'mood'] });
        assert.equal(other.reason, 'mood is not calm in 1 of the last 1 replies: angry');
    });

    it('holds a directive rule until the gap has passed', () => {
        assert.deepEqual(run(calm(), [rule()], { gap: 8, sinceAnyNudge: 7 }), []);
        assert.deepEqual(firedIds(run(calm(), [rule()], { gap: 8, sinceAnyNudge: 8 })), ['flat']);
    });

    it('lets a script-only rule through the gap and fires it beside a directive rule', () => {
        const script = rule({ id: 'log', directive: '', script: '/echo hello' });
        assert.deepEqual(firedIds(run(calm(), [script], { gap: 8, sinceAnyNudge: 0 })), ['log']);
        assert.deepEqual(
            firedIds(run(calm(), [script, rule()], { gap: 8, sinceAnyNudge: Infinity })),
            ['log', 'flat'],
        );
    });

    it('holds a rule until its own cooldown has passed', () => {
        const waiting = rule({ cooldown: 3 });
        assert.deepEqual(run(calm(), [waiting], { sinceRule: () => 2 }), []);
        assert.deepEqual(firedIds(run(calm(), [waiting], { sinceRule: () => 3 })), ['flat']);
    });

    it('counts the cooldown per rule', () => {
        const first = rule({ id: 'one', cooldown: 5 });
        const second = rule({ id: 'two', cooldown: 0 });
        const sinceRule = id => (id === 'one' ? 1 : Infinity);
        assert.deepEqual(firedIds(run(calm(), [first, second], { maxNudges: 2, sinceRule })), ['two']);
    });

    it('lets only maxNudges directive rules fire on one turn', () => {
        const first = rule({ id: 'one' });
        const second = rule({ id: 'two' });
        assert.deepEqual(firedIds(run(calm(), [first, second])), ['one']);
        assert.deepEqual(firedIds(run(calm(), [first, second], { maxNudges: 2 })), ['one', 'two']);
    });

    it('considers only the rules of the action it is asked for', () => {
        const swipeRule = rule({ id: 'reroll', action: 'swipe' });
        assert.deepEqual(firedIds(run(calm(), [swipeRule, rule()])), ['flat']);
        assert.deepEqual(firedIds(run(calm(), [swipeRule, rule()], { action: 'swipe' })), ['reroll']);
    });

    it('fires at most one swipe rule and ignores the gap', () => {
        const first = rule({ id: 'one', action: 'swipe' });
        const second = rule({ id: 'two', action: 'swipe' });
        const hits = run(calm(), [first, second], { action: 'swipe', gap: 8, sinceAnyNudge: 0 });
        assert.deepEqual(firedIds(hits), ['one']);
    });

    it('does not fire a swipe rule on a score the reply did not get', () => {
        const swipeRule = rule({ id: 'reroll', action: 'swipe', need: 1, window: 1, conditions: [{ sensor: 'tone', op: 'below', value: 1.5 }] });
        const carried = [reply({ change: 1, tone: 1 })];
        const own = [reply({ change: 1 })];
        assert.deepEqual(firedIds(run(carried, [swipeRule], { action: 'swipe' })), ['reroll']);
        assert.deepEqual(run(own, [swipeRule], { action: 'swipe' }), []);
    });
});

describe('conditionHolds', () => {
    const entry = (scores, confidence = {}) => ({ index: 0, scores, confidence });

    it('compares a number with below and above', () => {
        assert.equal(conditionHolds(entry({ change: 1 }), { sensor: 'change', op: 'below', value: 2 }), true);
        assert.equal(conditionHolds(entry({ change: 2 }), { sensor: 'change', op: 'below', value: 2 }), false);
        assert.equal(conditionHolds(entry({ change: 3 }), { sensor: 'change', op: 'above', value: 2 }), true);
        assert.equal(conditionHolds(entry({ change: 2 }), { sensor: 'change', op: 'above', value: 2 }), false);
    });

    it('matches an option name with is and is not', () => {
        assert.equal(conditionHolds(entry({ mood: 'calm' }), { sensor: 'mood', op: 'is', value: 'calm' }), true);
        assert.equal(conditionHolds(entry({ mood: 'angry' }), { sensor: 'mood', op: 'is', value: 'calm' }), false);
        assert.equal(conditionHolds(entry({ mood: 'angry' }), { sensor: 'mood', op: 'is_not', value: 'calm' }), true);
        assert.equal(conditionHolds(entry({ mood: 'calm' }), { sensor: 'mood', op: 'is_not', value: 'calm' }), false);
    });

    it('never compares a word against a number, whichever way the sensor changed', () => {
        assert.equal(conditionHolds(entry({ mood: 'calm' }), { sensor: 'mood', op: 'above', value: 1 }), false);
        assert.equal(conditionHolds(entry({ mood: 'calm' }), { sensor: 'mood', op: 'below', value: 1 }), false);
        assert.equal(conditionHolds(entry({ change: 1 }), { sensor: 'change', op: 'is', value: 'calm' }), false);
        assert.equal(conditionHolds(entry({ change: 1 }), { sensor: 'change', op: 'is_not', value: 'calm' }), false);
    });

    it('waits for the confidence the condition asks for', () => {
        const condition = { sensor: 'change', op: 'below', value: 2, minConfidence: 0.7 };
        assert.equal(conditionHolds(entry({ change: 1 }, { change: 0.8 }), condition), true);
        assert.equal(conditionHolds(entry({ change: 1 }, { change: 0.7 }), condition), true);
        assert.equal(conditionHolds(entry({ change: 1 }, { change: 0.5 }), condition), false);
        assert.equal(conditionHolds(entry({ change: 1 }), condition), false);
        assert.equal(conditionHolds(entry({ change: 1 }), { ...condition, minConfidence: null }), true);
    });

    it('says no for a reply with no value and for a test it does not know', () => {
        assert.equal(conditionHolds(entry({}), { sensor: 'change', op: 'below', value: 2 }), false);
        assert.equal(conditionHolds(null, { sensor: 'change', op: 'below', value: 2 }), false);
        assert.equal(conditionHolds(entry({ change: 1 }), { sensor: 'change', op: 'near', value: 2 }), false);
    });

    it('carries a choice rule through evaluate the same way', () => {
        const picked = rule({ need: 2, window: 2, conditions: [{ sensor: 'tone', op: 'is_not', value: 'calm' }] });
        const history = [entry({ tone: 'angry' }), entry({ tone: 'bored' })];
        assert.deepEqual(firedIds(run(history, [picked])), ['flat']);
        assert.deepEqual(run([entry({ tone: 'calm' }), entry({ tone: 'angry' })], [picked]), []);
    });
});

describe('replayRule', () => {
    const flat = rule({ need: 1, window: 1 });
    const line = length => Array.from({ length }, () => reply({ change: 1 }));
    const turns = result => result.map(turn => turn.index);

    it('lists every turn where the rule would have fired', () => {
        const history = line(3);
        assert.deepEqual(turns(replayRule({ history, rule: flat, sensorIds: ids })), history.map(entry => entry.index));
    });

    it('holds the rule back for the wait between nudges', () => {
        const history = line(5);
        const fired = turns(replayRule({ history, rule: flat, sensorIds: ids, gap: 3 }));
        assert.deepEqual(fired, [history[0].index, history[3].index]);
    });

    it('holds the rule back for its own cooldown', () => {
        const history = line(5);
        const fired = turns(replayRule({ history, rule: rule({ need: 1, window: 1, cooldown: 2 }), sensorIds: ids }));
        assert.deepEqual(fired, [history[0].index, history[2].index, history[4].index]);
    });

    it('replays a rule that is turned off, so a draft can be tried', () => {
        const history = line(2);
        assert.equal(replayRule({ history, rule: rule({ need: 1, window: 1, enabled: false }), sensorIds: ids }).length, 2);
    });

    it('ignores the wait between nudges for a swipe rule', () => {
        const history = line(3);
        const swipe = rule({ need: 1, window: 1, action: 'swipe' });
        assert.equal(replayRule({ history, rule: swipe, sensorIds: ids, gap: 10 }).length, 3);
    });

    it('returns nothing for a rule with no conditions and nothing to replay', () => {
        assert.deepEqual(replayRule({ history: line(3), rule: rule({ conditions: [] }), sensorIds: ids }), []);
        assert.deepEqual(replayRule({ history: [], rule: flat, sensorIds: ids }), []);
        assert.deepEqual(replayRule({}), []);
    });

    it('carries the reason of each turn', () => {
        const [first] = replayRule({ history: line(1), rule: flat, sensorIds: ids });
        assert.equal(first.reason, 'change below 2.5 in 1 of the last 1 replies: 1');
    });
});

describe('a rule whose action this Jeved does not know', () => {
    const odd = () => rule({ action: 'teleport' });

    it('never fires, whichever action is being evaluated', () => {
        assert.deepEqual(firedIds(run(calm(), [odd()])), []);
        assert.deepEqual(firedIds(run(calm(), [odd()], { action: 'swipe' })), []);
        assert.deepEqual(firedIds(run(calm(), [odd()], { action: 'teleport' })), []);
    });

    it('says so, rather than reporting itself as off', () => {
        const status = explain(odd(), { history: calm(), sensorIds: ids });
        assert.equal(status.text, 'Unknown action');
        assert.equal(status.kind, 'warn');
        assert.match(status.detail, /teleport/);
    });

    it('replays nothing, so Preview cannot promise a fire', () => {
        assert.deepEqual(replayRule({ history: calm(), rule: odd(), sensorIds: ids }), []);
    });
});

describe('explain', () => {
    const state = (history, extra = {}) => ({ history, sensorIds: ids, sensors, ...extra });

    it('says how many more replies must be measured', () => {
        const history = [reply({ change: 1 }), reply(null)];
        assert.equal(explain(rule(), state(history)).text, 'Needs 2 more replies');
    });

    it('counts the matching replies while the rule is short of its need', () => {
        const history = [reply({ tone: 2.4 }), reply({ tone: 2.4 }), reply({ tone: 1 })];
        const drift = rule({ id: 'drift', need: 3, window: 3, conditions: [{ sensor: 'tone', op: 'below', value: 1.5 }] });
        const status = explain(drift, state(history));
        assert.equal(status.text, '1 of 3');
        assert.equal(status.detail, '1 of the last 3 replies matches. The rule fires at 3.');
    });

    it('makes the count sentence plural when more than one reply matches', () => {
        const history = [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 3 }), reply({ change: 3 })];
        const status = explain(rule(), state(history));
        assert.equal(status.text, '2 of 3');
        assert.equal(status.detail, '2 of the last 4 replies match. The rule fires at 3.');
    });

    it('counts zero matches without saying no match', () => {
        const history = [reply({ change: 3 }), reply({ change: 3 }), reply({ change: 3 }), reply({ change: 3 })];
        const status = explain(rule(), state(history));
        assert.equal(status.text, '0 of 3');
        assert.equal(status.detail, '0 of the last 4 replies match. The rule fires at 3.');
    });

    it('counts down the wait between nudges and the rule cooldown', () => {
        assert.equal(explain(rule(), state(calm(), { gap: 8, sinceAnyNudge: 5 })).text, 'Cooling down (3)');
        assert.equal(explain(rule({ cooldown: 4 }), state(calm(), { sinceRule: () => 3 })).text, 'Cooling down (1)');
    });

    it('does not make a script-only rule wait for the gap', () => {
        const script = rule({ directive: '', script: '/echo hello' });
        assert.equal(explain(script, state(calm(), { gap: 8, sinceAnyNudge: 0 })).text, 'Fires next turn');
    });

    it('says when another rule went first and when this rule matched', () => {
        assert.equal(explain(rule(), state(calm(), { lastFired: ['drift'] })).text, 'Outranked this turn');
        assert.equal(explain(rule(), state(calm(), { lastFired: ['flat'] })).text, 'Fired');
    });

    it('says when a sensor is gone', () => {
        const orphan = rule({ conditions: [{ sensor: 'tensoin', op: 'below', value: 1 }] });
        assert.equal(explain(orphan, state(calm())).text, 'Sensor missing');
        assert.equal(explain(orphan, state(calm())).detail, 'No sensor is named tensoin.');
    });

    it('says when the rule is off', () => {
        assert.equal(explain(rule({ enabled: false }), state(calm())).text, 'Off');
    });

    it('says when the exception holds on the latest reply', () => {
        const gated = rule({ skipWhen: { sensor: 'tension', op: 'above', value: 2.5 } });
        const history = [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1, tension: 3 })];
        const result = explain(gated, state(history));
        assert.equal(result.text, 'Blocked');
        assert.equal(result.kind, 'warn');
        assert.equal(result.detail, 'Blocked because Tension is above 2.5 on the latest reply.');
    });

    it('writes the blocking threshold the way its sensor type reads', () => {
        const typed = [
            ...sensors,
            { id: 'danger', label: 'Danger', type: 'noul' },
            { id: 'mood', label: 'Mood', type: 'choice', options: [{ name: 'calm' }] },
        ];
        const known = { sensors: typed, sensorIds: typed.map(sensor => sensor.id) };
        const filler = [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 })];

        const gated = rule({ skipWhen: { sensor: 'danger', op: 'above', value: 0.6 } });
        const risky = explain(gated, state([...filler, reply({ change: 1, danger: 0.8 })], known));
        assert.equal(risky.detail, 'Blocked because Danger is above 60% on the latest reply.');

        const picked = rule({ skipWhen: { sensor: 'mood', op: 'is', value: 'calm' } });
        const settled = explain(picked, state([...filler, reply({ change: 1, mood: 'calm' })], known));
        assert.equal(settled.detail, 'Blocked because Mood is calm on the latest reply.');
    });

    it('keeps the least confidence of the exception in the blocked detail', () => {
        const gated = rule({ skipWhen: { sensor: 'tension', op: 'above', value: 2.5, minConfidence: 0.7 } });
        const history = [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 1 }), { index: 9, scores: { change: 1, tension: 3 }, confidence: { tension: 0.9 } }];
        assert.equal(
            explain(gated, state(history)).detail,
            'Blocked because Tension is above 2.5 with at least 70% confidence on the latest reply.',
        );
    });

    it('names the chip kind beside the words', () => {
        assert.equal(explain(rule(), state(calm())).kind, 'fire');
        assert.equal(explain(rule(), state(calm(), { lastFired: ['flat'] })).kind, 'fire');
        assert.equal(explain(rule(), state(calm(), { lastFired: ['drift'] })).kind, 'idle');
        assert.equal(explain(rule({ enabled: false }), state(calm())).kind, 'idle');
        assert.equal(explain(rule({ conditions: [{ sensor: 'gone', op: 'below', value: 1 }] }), state(calm())).kind, 'warn');
        assert.equal(explain(rule({ cooldown: 4 }), state(calm(), { sinceRule: () => 3 })).kind, 'busy');
        assert.equal(explain(rule(), state([reply(null)])).kind, 'idle');
        assert.equal(explain(rule({ action: 'teleport' }), state(calm())).kind, 'warn');
    });

    it('needs one more reply in the singular', () => {
        assert.equal(explain(rule({ need: 1, window: 1 }), state([reply(null)])).text, 'Needs 1 more reply');
    });
});

describe('matchingCount', () => {
    it('counts only the replies inside the window', () => {
        const history = [reply({ change: 1 }), reply({ change: 1 }), reply({ change: 3 }), reply({ change: 1 }), reply({ change: 1 })];
        assert.equal(matchingCount(history, rule()), 3);
        assert.equal(matchingCount(history, rule({ window: 2 })), 2);
    });

    it('needs every condition to hold on the same reply', () => {
        const both = rule({ window: 2, conditions: [
            { sensor: 'change', op: 'below', value: 2.5 },
            { sensor: 'tension', op: 'below', value: 1.5 },
        ] });
        assert.equal(matchingCount([reply({ change: 1, tension: 3 }), reply({ change: 1, tension: 1 })], both), 1);
    });

    it('counts a reply with no score as no match', () => {
        assert.equal(matchingCount([reply(null), reply({ change: 1 })], rule()), 1);
    });

    it('counts nothing for a rule with no conditions and for no rule', () => {
        assert.equal(matchingCount(calm(), rule({ conditions: [] })), 0);
        assert.equal(matchingCount(calm(), null), 0);
        assert.equal(matchingCount([], rule()), 0);
    });
});
