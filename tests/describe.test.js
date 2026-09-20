import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { badgeFor, bandText, conditionShort, conditionText, decisionSentence, excerpt, gaugeFor, levelText, ordinal, previewSentence, questionKeysHint, readsSummary, readsTag, rescanSentence, ruleBrief, ruleProblem, ruleSummary, scoreLine, sensorLabel, sensorProblem, stripChart, tokenWords } from '../src/describe.js';
import { scoreText } from '../src/util.js';

const sensors = [
    { id: 'tone', label: 'Tone', turns: 5, includeContext: true, levels: ['Zero.', 'One.', 'Two.', 'Three.', 'Four.'] },
    { id: 'tension', label: 'Tension', turns: 1, includeUser: true, levels: ['None.', 'Mild.', 'Clear.', 'High.', 'Extreme.'] },
    { id: 'bare', label: '', turns: 1, levels: [] },
];

function rule(overrides = {}) {
    return {
        id: 'flat',
        label: 'Flat',
        enabled: true,
        action: 'nudge',
        conditions: [{ sensor: 'tone', op: 'below', value: 1.5 }],
        need: 3,
        window: 4,
        skipWhen: null,
        cooldown: 0,
        directive: '(OOC: do the thing.)',
        script: '',
        ...overrides,
    };
}

describe('words for one value', () => {
    it('names a sensor by its label and falls back to the id', () => {
        assert.equal(sensorLabel(sensors, 'tone'), 'Tone');
        assert.equal(sensorLabel(sensors, 'bare'), 'bare');
        assert.equal(sensorLabel(sensors, 'gone'), 'gone');
    });

    it('rounds a score to one place and says when there is none', () => {
        assert.equal(scoreText(2.44), '2.4');
        assert.equal(scoreText(2), '2');
        assert.equal(scoreText(null), 'not measured');
        assert.equal(scoreText(undefined), 'not measured');
    });

    it('picks the nearest score description and clamps to the ends', () => {
        assert.equal(levelText(sensors[1], 2.4), 'Clear.');
        assert.equal(levelText(sensors[1], 2.6), 'High.');
        assert.equal(levelText(sensors[1], 9), 'Extreme.');
        assert.equal(levelText(sensors[1], -3), 'None.');
        assert.equal(levelText(sensors[1], null), '');
        assert.equal(levelText(sensors[2], 1), '');
    });

    it('tags a row with what the sensor reads', () => {
        assert.equal(readsTag({ turns: 1 }), '1 reply');
        assert.equal(readsTag({ turns: 5 }), '5 replies');
        assert.equal(readsTag({ turns: 5, includeContext: true }), '5 replies + context');
        assert.equal(readsTag({}), '1 reply');
    });

    it('says what Jev sees in one sentence, with both numbers in it', () => {
        assert.equal(
            readsSummary({ turns: 2, measureEvery: 5, includeUser: true, includeContext: true }),
            'Every 5th reply, Jev reads the last 2 replies with your messages, plus context',
        );
        assert.equal(readsSummary({ turns: 1, measureEvery: 1, includeUser: true }), 'On every reply, Jev reads the last reply and your message before it');
        assert.equal(readsSummary({ turns: 1, measureEvery: 1 }), 'On every reply, Jev reads the last reply');
        assert.equal(readsSummary({ turns: 5, measureEvery: 2, includeContext: true }), 'Every 2nd reply, Jev reads the last 5 replies, without your messages, plus context');
        assert.equal(readsSummary({ turns: 3, measureEvery: 3, includeUser: true }), 'Every 3rd reply, Jev reads the last 3 replies with your messages');
    });

    it('counts with the right ordinal', () => {
        assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    });

    it('names the keys the current settings produce', () => {
        assert.equal(questionKeysHint({ turns: 1, includeUser: true }), 'Refer to the reply as `latest_turn` and your message as `player_message`.');
        assert.equal(questionKeysHint({ turns: 1 }), 'Refer to the reply as `latest_turn`.');
        assert.equal(
            questionKeysHint({ turns: 4, includeContext: true }),
            'Refer to the replies as `latest_turns`. The card and the prompts are in `context`.',
        );
    });

    it('rounds a token count into words', () => {
        assert.equal(tokenWords(3600), 'about 3,600 tokens');
        assert.equal(tokenWords(0), 'about 0 tokens');
    });

    it('cuts an excerpt and flattens its whitespace', () => {
        assert.equal(excerpt('a\n\n  b'), 'a b');
        assert.equal(excerpt('abcdef', 3), 'abc...');
    });

    it('writes one condition in plain words', () => {
        assert.equal(conditionText({ sensor: 'tone', op: 'below', value: 1.5 }, sensors), 'Tone is below 1.5');
        assert.equal(conditionText({ sensor: 'tension', op: 'above', value: 2 }, sensors), 'Tension is above 2');
        assert.equal(conditionText(null, sensors), '');
    });

    it('writes one condition in the short form a row uses', () => {
        assert.equal(conditionShort({ sensor: 'tone', op: 'below', value: 1.5 }, sensors), 'Tone below 1.5');
        assert.equal(conditionShort({ sensor: 'tension', op: 'above', value: 2 }, sensors), 'Tension above 2');
        assert.equal(conditionShort(null, sensors), '');
    });
});

describe('ruleBrief', () => {
    it('names the action and the condition', () => {
        assert.equal(ruleBrief(rule(), sensors), 'Nudge · Tone below 1.5');
        assert.equal(ruleBrief(rule({ action: 'swipe' }), sensors), 'Reroll · Tone below 1.5');
    });

    it('joins several conditions with a comma', () => {
        const both = rule({ conditions: [
            { sensor: 'tone', op: 'below', value: 2 },
            { sensor: 'tension', op: 'below', value: 2 },
        ] });
        assert.equal(ruleBrief(both, sensors), 'Nudge · Tone below 2, Tension below 2');
    });

    it('leaves the window counts, the cooldown and the exception out', () => {
        const busy = rule({ need: 4, window: 9, cooldown: 5, skipWhen: { sensor: 'tension', op: 'above', value: 3 } });
        assert.equal(ruleBrief(busy, sensors), 'Nudge · Tone below 1.5');
    });

    it('marks a rule that runs a script', () => {
        assert.equal(ruleBrief(rule({ script: '/echo hi' }), sensors), 'Nudge · Tone below 1.5 · Script');
    });

    it('says the action alone when the rule has no condition, and nothing for no rule', () => {
        assert.equal(ruleBrief(rule({ conditions: [] }), sensors), 'Nudge');
        assert.equal(ruleBrief(null, sensors), '');
    });

    it('says the action is unknown rather than leaving the line bare', () => {
        assert.equal(ruleBrief(rule({ action: 'teleport' }), sensors), 'Unknown action · Tone below 1.5');
    });
});

describe('scoreLine', () => {
    it('writes the name, the score and the words of one sensor', () => {
        assert.equal(scoreLine(sensors[1], 2.44, { words: 'Clear.' }), 'Tension: 2.4 - Clear.');
        assert.equal(scoreLine(sensors[1], 3), 'Tension: 3');
    });

    it('marks a score that was carried over and falls back to the id', () => {
        assert.equal(scoreLine(sensors[1], 1, { words: 'Mild.', carried: true }), 'Tension: 1 - Mild. (carried over)');
        assert.equal(scoreLine(sensors[2], null), 'bare: not measured');
    });
});

describe('rescanSentence', () => {
    it('reports the successes on their own when nothing failed', () => {
        assert.equal(rescanSentence({ measured: 1, failed: 0 }), 'Measured 1 reply.');
        assert.equal(rescanSentence({ measured: 12, failed: 0 }), 'Measured 12 replies.');
    });

    it('names the failures beside the successes', () => {
        assert.equal(rescanSentence({ measured: 3, failed: 2 }), 'Measured 3 replies, and 2 failed.');
        assert.equal(rescanSentence({ measured: 1, failed: 1 }), 'Measured 1 reply, and 1 failed.');
    });

    it('says why nothing was measured when every call failed', () => {
        assert.equal(rescanSentence({ measured: 0, failed: 4 }), 'Nothing was measured, because 4 replies failed.');
        assert.equal(rescanSentence({ measured: 0, failed: 1 }), 'Nothing was measured, because 1 reply failed.');
    });

    it('says nothing happened when the scan was stopped or skipped', () => {
        assert.equal(rescanSentence({ measured: 0, failed: 0, skipped: 3 }), 'Nothing was measured.');
        assert.equal(rescanSentence(), 'Nothing was measured.');
    });
});

describe('previewSentence', () => {
    const turns = count => Array.from({ length: count }, (_, index) => ({ index }));

    it('counts the turns the rule would have fired on', () => {
        assert.equal(previewSentence(null, turns(61), 61), 'This rule would have fired 61 times in this chat.');
        assert.equal(previewSentence(turns(1), turns(1), 20), 'This rule would have fired once in this chat.');
    });

    it('says nothing fired when the rule matches no turn', () => {
        assert.equal(previewSentence(null, [], 20), "This rule wouldn't have fired anywhere in this chat.");
        assert.equal(previewSentence(turns(0), [], 20), "This rule wouldn't have fired anywhere in this chat.");
    });

    it('compares the draft with the saved rule only when the counts differ', () => {
        assert.equal(previewSentence(turns(61), turns(48), 61), 'With your changes it would have fired 48 times (61 before).');
        assert.equal(previewSentence(turns(61), turns(61), 61), 'This rule would have fired 61 times in this chat.');
        assert.equal(previewSentence(turns(2), [], 61), "With your changes it wouldn't have fired anywhere (2 before).");
    });

    it('asks for scores before it previews anything', () => {
        assert.equal(previewSentence(null, [], 0), 'This chat has no measured replies yet, so there is nothing to preview.');
        assert.equal(previewSentence(turns(3), turns(3), 0), 'This chat has no measured replies yet, so there is nothing to preview.');
    });
});

describe('ruleProblem', () => {
    it('drops the rule prefix and starts the sentence with a capital', () => {
        assert.equal(ruleProblem("rule 'flat': it needs an instruction or a script"), 'It needs an instruction or a script');
        assert.equal(ruleProblem("rule 'flat', condition 2: no sensor named 'tensoin'"), "Condition 2: no sensor named 'tensoin'");
        assert.equal(ruleProblem("rule 'flat', exception: no sensor named 'gone'"), "Exception: no sensor named 'gone'");
        assert.equal(ruleProblem('rule 1: it is not a rule'), 'It is not a rule');
    });

    it('leaves a problem that names no rule alone', () => {
        assert.equal(ruleProblem('The rule needs a name.'), 'The rule needs a name.');
        assert.equal(ruleProblem(''), '');
    });

    it('drops the sensor prefix the same way', () => {
        assert.equal(sensorProblem("sensor 'tone': it has no question"), 'It has no question');
        assert.equal(sensorProblem('sensor 1: it is not a sensor'), 'It is not a sensor');
        assert.equal(sensorProblem('Something else.'), 'Something else.');
    });
});

describe('bandText', () => {
    it('names the band a threshold falls in', () => {
        assert.equal(bandText(sensors[1], 1), '1 to 2: Mild.');
        assert.equal(bandText(sensors[1], 1.9), '1 to 2: Mild.');
        assert.equal(bandText(sensors[1], 2), '2 to 3: Clear.');
    });

    it('drops the range at the top of the scale', () => {
        assert.equal(bandText(sensors[1], 4), '4: Extreme.');
        assert.equal(bandText(sensors[1], 9), '4: Extreme.');
    });

    it('clamps below zero and says nothing without a description', () => {
        assert.equal(bandText(sensors[1], -2), '0 to 1: None.');
        assert.equal(bandText(sensors[2], 1), '');
        assert.equal(bandText(sensors[1], null), '');
    });
});

describe('gaugeFor', () => {
    const history = [{ index: 0, scores: { tone: 3 } }, { index: 1, scores: { tone: 1, tension: 4 } }];

    it('reads the threshold and the latest score of the first condition', () => {
        const gauge = gaugeFor(rule(), history);
        assert.deepEqual(gauge, { value: 1, threshold: 1.5, op: 'below', matching: true });
    });

    it('is not matching when the latest reply is on the other side', () => {
        const gauge = gaugeFor(rule({ conditions: [{ sensor: 'tone', op: 'above', value: 1.5 }] }), history);
        assert.deepEqual(gauge, { value: 1, threshold: 1.5, op: 'above', matching: false });
    });

    it('needs every condition to hold before it accents the dot', () => {
        const both = rule({ conditions: [
            { sensor: 'tone', op: 'below', value: 1.5 },
            { sensor: 'tension', op: 'below', value: 2 },
        ] });
        assert.equal(gaugeFor(both, history).matching, false);
        assert.equal(gaugeFor(both, history).value, 1);
    });

    it('has no value when the latest reply is not measured', () => {
        assert.equal(gaugeFor(rule(), [{ index: 0, scores: null }]).value, null);
        assert.equal(gaugeFor(rule(), []).value, null);
    });

    it('falls back to a flat gauge when the rule has no condition', () => {
        assert.deepEqual(gaugeFor(rule({ conditions: [] }), history), { value: null, threshold: 0, op: 'below', matching: false });
        assert.deepEqual(gaugeFor(null, history), { value: null, threshold: 0, op: 'below', matching: false });
    });
});

describe('stripChart', () => {
    const columns = [
        { index: 2, scores: { tone: 1, tension: 3 }, own: { tone: 1, tension: 3 } },
        { index: 4, scores: { tone: 1, tension: 1 }, own: { tension: 1 } },
        { index: 6, scores: {}, own: {} },
    ];
    const rules = [rule(), rule({ id: 'off', enabled: false, conditions: [{ sensor: 'tension', op: 'above', value: 3.5 }] })];

    it('builds one row per sensor with a cell per column', () => {
        const chart = stripChart({ columns, sensors, rules });
        assert.deepEqual(chart.rows.map(row => row.id), ['tone', 'tension', 'bare']);
        assert.equal(chart.rows[0].cells.length, 3);
        assert.deepEqual(chart.rows[0].cells.map(cell => cell.value), [1, 1, null]);
    });

    it('marks a carried score and a missing one', () => {
        const [tone] = stripChart({ columns, sensors, rules }).rows;
        assert.deepEqual(tone.cells.map(cell => cell.carried), [false, true, false]);
        assert.deepEqual(tone.cells.map(cell => cell.value === null), [false, false, true]);
    });

    it('takes a tick from every enabled rule that names the sensor', () => {
        const chart = stripChart({ columns, sensors, rules });
        assert.deepEqual(chart.rows[0].ticks, [{ rule: 'flat', op: 'below', value: 1.5 }]);
        assert.deepEqual(chart.rows[1].ticks, []);
    });

    it('accents the cells that satisfy a tick', () => {
        const chart = stripChart({ columns, sensors, rules });
        assert.deepEqual(chart.rows[0].cells.map(cell => cell.matching), [true, true, false]);
        assert.deepEqual(chart.rows[1].cells.map(cell => cell.matching), [false, false, false]);
    });

    it('marks the turns a rule fired on, and tells a nudge from a reroll', () => {
        const chart = stripChart({
            columns,
            sensors,
            rules,
            fired: {
                2: [{ rule: 'flat', action: 'nudge', text: '(OOC)' }],
                4: [{ rule: 'flat', action: 'swipe', text: '(OOC)' }],
                6: [{ rule: 'log', action: 'nudge' }],
            },
        });
        assert.deepEqual(chart.columns, [
            { index: 2, nudge: true, reroll: false },
            { index: 4, nudge: false, reroll: true },
            { index: 6, nudge: false, reroll: false },
        ]);
    });

    it('returns empty rows and columns for nothing', () => {
        assert.deepEqual(stripChart(), { columns: [], rows: [] });
    });
});

describe('ruleSummary', () => {
    it('states the conditions, the counts and what happens', () => {
        assert.equal(
            ruleSummary(rule(), sensors),
            'When Tone is below 1.5 in at least 3 of the last 4 replies, nudge the next turn.',
        );
    });

    it('says all when every reply in the window must match', () => {
        assert.equal(
            ruleSummary(rule({ need: 4 }), sensors),
            'When Tone is below 1.5 in all of the last 4 replies, nudge the next turn.',
        );
    });

    it('says the latest reply when the window is one', () => {
        assert.equal(
            ruleSummary(rule({ need: 1, window: 1 }), sensors),
            'When Tone is below 1.5 on the latest reply, nudge the next turn.',
        );
    });

    it('joins several conditions with and', () => {
        const both = rule({
            conditions: [
                { sensor: 'tone', op: 'below', value: 1.5 },
                { sensor: 'tension', op: 'below', value: 1 },
            ],
        });
        assert.match(ruleSummary(both, sensors), /^When Tone is below 1\.5 and Tension is below 1 in at least 3/);
    });

    it('adds the unless clause and the cooldown sentence', () => {
        const held = rule({ skipWhen: { sensor: 'tension', op: 'above', value: 2.5 }, cooldown: 3 });
        assert.equal(
            ruleSummary(held, sensors),
            'When Tone is below 1.5 in at least 3 of the last 4 replies, except when Tension is above 2.5 on the latest reply, nudge the next turn. Then it waits 3 replies before it can fire again.',
        );
    });

    it('names the swipe action and the script', () => {
        assert.match(ruleSummary(rule({ action: 'swipe' }), sensors), /reroll the reply\.$/);
        assert.match(ruleSummary(rule({ script: '/echo hi' }), sensors), /nudge the next turn and run a script\.$/);
        assert.match(ruleSummary(rule({ directive: '', script: '/echo hi' }), sensors), /replies, run a script\.$/);
        assert.match(ruleSummary(rule({ directive: '', script: '' }), sensors), /replies, do nothing\.$/);
    });

    it('says when a rule names a sensor that is gone, or has no conditions', () => {
        const orphan = rule({ conditions: [{ sensor: 'tensoin', op: 'below', value: 1 }] });
        assert.equal(ruleSummary(orphan, sensors), 'This rule is skipped because no sensor is named tensoin.');
        assert.equal(ruleSummary(rule({ conditions: [] }), sensors), 'This rule has no conditions, so it never fires.');
    });

    it('waits one reply in the singular', () => {
        assert.match(ruleSummary(rule({ cooldown: 1 }), sensors), /waits 1 reply before/);
    });
});

describe('decisionSentence', () => {
    const rules = [{ id: 'flat', label: 'Flat' }, { id: 'drift', label: 'Drift' }];

    it('says when nothing has happened yet', () => {
        assert.equal(decisionSentence(null, rules), "Jeved hasn't made a decision yet this session.");
    });

    it('says when no rule matched', () => {
        assert.equal(decisionSentence({ index: 12, fired: [] }, rules), 'No rule matched on message #12.');
    });

    it('names each rule and what it did', () => {
        const decision = {
            index: 12,
            fired: [
                { rule: 'flat', action: 'nudge', text: '(OOC)' },
                { rule: 'drift', action: 'nudge' },
            ],
        };
        assert.equal(decisionSentence(decision, rules), 'On message #12, Flat nudged the next turn, and Drift ran a script.');
    });

    it('names a swipe', () => {
        const decision = { index: 4, fired: [{ rule: 'flat', action: 'swipe', text: '(OOC)' }] };
        assert.equal(decisionSentence(decision, rules), 'On message #4, Flat rerolled the reply.');
    });
});

describe('badgeFor', () => {
    const user = (mes, fired) => ({ mes, is_user: true, extra: fired ? { jeved: { decided: true, fired } } : undefined });
    const reply = (mes, swipeId) => (swipeId === undefined ? { mes } : { mes, swipe_id: swipeId });

    it('badges the user message that carried an instruction', () => {
        const chat = [user('hi', [{ rule: 'flat', action: 'nudge', text: '(OOC)' }]), reply('r')];
        const item = badgeFor(chat, 0);
        assert.equal(item.kind, 'nudge');
        assert.equal(item.entries.length, 1);
        assert.equal(badgeFor(chat, 1), null);
    });

    it('does not badge a user message whose rule only ran a script', () => {
        const chat = [user('hi', [{ rule: 'log', action: 'nudge' }])];
        assert.equal(badgeFor(chat, 0), null);
    });

    it('badges only the swipe the reroll made', () => {
        const entry = { rule: 'long', action: 'swipe', text: '(OOC)', swipe: 1 };
        const chat = [user('hi', [entry]), reply('alternative', 1)];
        assert.equal(badgeFor(chat, 1).kind, 'swipe');

        chat[1].swipe_id = 0;
        assert.equal(badgeFor(chat, 1), null, 'the original must not wear the badge');

        chat[1].swipe_id = 2;
        assert.equal(badgeFor(chat, 1), null, 'a later swipe must not wear it either');
    });

    it('does not badge a reroll that never landed', () => {
        const chat = [user('hi', [{ rule: 'long', action: 'swipe', text: '(OOC)' }]), reply('r', 0)];
        assert.equal(badgeFor(chat, 1), null);
    });

    it('does not badge a reply further down the chat', () => {
        const entry = { rule: 'long', action: 'swipe', text: '(OOC)', swipe: 0 };
        const chat = [user('hi', [entry]), reply('first', 0), reply('second', 0)];
        assert.equal(badgeFor(chat, 1).kind, 'swipe');
        assert.equal(badgeFor(chat, 2), null);
    });

    it('carries the scores that caused the reroll', () => {
        const entry = { rule: 'long', action: 'swipe', text: '(OOC)', swipe: 1, scores: { tension: 0.5 } };
        const chat = [user('hi', [entry]), reply('alternative', 1)];
        assert.deepEqual(badgeFor(chat, 1).entries[0].scores, { tension: 0.5 });
    });
});
