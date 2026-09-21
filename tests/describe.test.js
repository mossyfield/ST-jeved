import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { badgeFor, bandText, decisionSentence, excerpt, levelText, listPhrase, momentLine, momentTag, previewSentence, questionKeysHint, rescanSentence, ruleMomentNote, ruleProblem, ruleSummary, scoreLine, sensorProblem, stripChart, tokenWords } from '../src/describe.js';
import { conditionShort, conditionText, sensorLabel, valueText } from '../src/sensor-types.js';
import { hashText, scoreText } from '../src/util.js';

const sensors = [
    { id: 'tone', label: 'Tone', user: 0, assistant: 5, context: 'all', levels: ['Zero.', 'One.', 'Two.', 'Three.', 'Four.'] },
    { id: 'tension', label: 'Tension', user: 1, assistant: 1, levels: ['None.', 'Mild.', 'Clear.', 'High.', 'Extreme.'] },
    { id: 'bare', label: '', user: 1, assistant: 1, levels: [] },
    { id: 'scene', label: 'Scene', user: 1, assistant: 0, levels: ['Zero.', 'One.', 'Two.', 'Three.', 'Four.'] },
];

const typed = [
    { id: 'mood', label: 'Mood', type: 'choice', options: [{ name: 'calm', description: 'Settled.' }, { name: 'angry', description: 'Furious.' }] },
    { id: 'danger', label: 'Danger', type: 'noul', levels: ['Nobody is.', 'Someone is.'] },
    { id: 'plain', label: 'Plain', type: 'noul', levels: [] },
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

    it('tags a row with the moment the sensor runs at', () => {
        assert.equal(momentTag('reply'), 'After the reply');
        assert.equal(momentTag('message'), 'Before the reply');
        assert.equal(ruleMomentNote('message'), 'This rule acts on the reply that comes next.');
        assert.equal(ruleMomentNote('reply'), 'This rule acts on your next turn.');
        assert.equal(ruleMomentNote('reply', 'after-reply'), 'This rule acts right after the reply.');
    });

    it('says when a sensor runs, and asks for a message when it reads none', () => {
        assert.equal(momentLine({ user: 1, assistant: 1 }), 'Runs after each reply.');
        assert.equal(momentLine({ user: 1, assistant: 0 }), 'Runs before the reply, on your message.');
        assert.equal(momentLine({ user: 0, assistant: 0 }), 'Pick at least one message.');
    });

    it('names only the keys the current settings produce', () => {
        assert.equal(questionKeysHint({ user: 0, assistant: 1 }), 'Refer to the reply as `latest_turn`.');
        assert.equal(
            questionKeysHint({ user: 1, assistant: 1 }),
            'Refer to the reply as `latest_turn` and your message as `player_message`.',
        );
        assert.equal(
            questionKeysHint({ user: 1, assistant: 1, context: 'all' }),
            'Refer to the reply as `latest_turn`, your message as `player_message`, and the pieces you picked as `context`.',
        );
    });

    it('names history once the sensor asks for more than one message of a kind', () => {
        assert.equal(
            questionKeysHint({ user: 0, assistant: 4 }),
            'Refer to the reply as `latest_turn` and the earlier messages as `history`.',
        );
        assert.equal(
            questionKeysHint({ user: 3, assistant: 0, context: 'all' }),
            'Refer to your message as `player_message`, the earlier messages as `history`, and the pieces you picked as `context`.',
        );
        assert.equal(questionKeysHint({ user: 0, assistant: 0 }), '');
    });

    it('rounds a token count into words', () => {
        assert.equal(tokenWords(3600), 'About 3,600 tokens');
        assert.equal(tokenWords(0), 'About 0 tokens');
    });

    it('cuts an excerpt and flattens its whitespace', () => {
        assert.equal(excerpt('a\n\n  b'), 'a b');
        assert.equal(excerpt('abcdef', 3), 'abc...');
    });

    it('joins a list with and, and keeps the comma before it from three items on', () => {
        assert.equal(listPhrase(['one']), 'one');
        assert.equal(listPhrase(['one', 'two']), 'one and two');
        assert.equal(listPhrase(['one', 'two', 'three']), 'one, two, and three');
        assert.equal(listPhrase([]), '');
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

describe('words for a sensor of each type', () => {
    it('writes the value the way its type reads', () => {
        assert.equal(valueText(sensors[1], 2.44), '2.4');
        assert.equal(valueText(typed[0], 'calm'), 'calm');
        assert.equal(valueText(typed[1], 0.716), '72%');
        assert.equal(valueText(typed[1], 0), '0%');
    });

    it('says not measured for a value its type cannot read', () => {
        assert.equal(valueText(typed[0], null), 'not measured');
        assert.equal(valueText(typed[1], null), 'not measured');
        assert.equal(valueText(typed[1], 'calm'), 'not measured');
        assert.equal(valueText(typed[0], 2, ''), '');
    });

    it('gives the words that go with the value', () => {
        assert.equal(levelText(typed[0], 'angry'), 'Furious.');
        assert.equal(levelText(typed[0], 'gone'), '');
        assert.equal(levelText(typed[1], 0.8), 'Someone is.');
        assert.equal(levelText(typed[1], 0.2), 'Nobody is.');
        assert.equal(levelText(typed[2], 0.8), 'Yes');
        assert.equal(levelText(typed[2], 0.2), 'No');
    });

    it('writes a score line for each type', () => {
        assert.equal(scoreLine(typed[0], 'calm', { words: 'Settled.' }), 'Mood: calm - Settled.');
        assert.equal(scoreLine(typed[1], 0.9, { words: 'Someone is.' }), 'Danger: 90% - Someone is.');
    });

    it('bands a threshold only where a band means something', () => {
        assert.equal(bandText(typed[1], 0.6), 'Someone is.');
        assert.equal(bandText(typed[1], 0.4), 'Nobody is.');
        assert.equal(bandText(typed[0], 'calm'), '');
    });

    it('writes a condition sentence that fits the sensor type', () => {
        assert.equal(conditionText({ sensor: 'mood', op: 'is', value: 'calm' }, typed), 'Mood is calm');
        assert.equal(conditionText({ sensor: 'mood', op: 'is_not', value: 'calm' }, typed), 'Mood is not calm');
        assert.equal(conditionText({ sensor: 'danger', op: 'above', value: 0.6 }, typed), 'Danger is above 60%');
    });

    it('names the least confidence when a condition asks for one', () => {
        assert.equal(
            conditionText({ sensor: 'mood', op: 'is', value: 'calm', minConfidence: 0.7 }, typed),
            'Mood is calm with at least 70% confidence',
        );
        assert.equal(conditionText({ sensor: 'mood', op: 'is', value: 'calm', minConfidence: null }, typed), 'Mood is calm');
    });

    it('shortens a condition of each type for a row', () => {
        assert.equal(conditionShort({ sensor: 'mood', op: 'is_not', value: 'angry' }, typed), 'Mood is not angry');
        assert.equal(conditionShort({ sensor: 'danger', op: 'below', value: 0.25 }, typed), 'Danger below 25%');
    });
});

describe('scoreLine', () => {
    it('writes the name, the score and the words of one sensor', () => {
        assert.equal(scoreLine(sensors[1], 2.44, { words: 'Clear.' }), 'Tension: 2.4 - Clear.');
        assert.equal(scoreLine(sensors[1], 3), 'Tension: 3');
    });

    it('falls back to the id when the sensor has no name', () => {
        assert.equal(scoreLine(sensors[2], null), 'bare: not measured');
    });
});

describe('rescanSentence', () => {
    it('reports the successes on their own when nothing failed', () => {
        assert.equal(rescanSentence({ measured: 1, failed: 0 }), 'Measured 1 message.');
        assert.equal(rescanSentence({ measured: 12, failed: 0 }), 'Measured 12 messages.');
    });

    it('names the failures beside the successes', () => {
        assert.equal(rescanSentence({ measured: 3, failed: 2 }), 'Measured 3 messages, and 2 failed.');
        assert.equal(rescanSentence({ measured: 1, failed: 1 }), 'Measured 1 message, and 1 failed.');
    });

    it('says why nothing was measured when every call failed', () => {
        assert.equal(rescanSentence({ measured: 0, failed: 4 }), 'Nothing was measured, because 4 messages failed.');
        assert.equal(rescanSentence({ measured: 0, failed: 1 }), 'Nothing was measured, because 1 message failed.');
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

describe('stripChart', () => {
    const columns = [
        { index: 2, scores: { tone: 1, tension: 3 } },
        { index: 4, scores: { tone: 1, tension: 1 } },
        { index: 6, scores: {} },
    ];
    const rules = [rule(), rule({ id: 'off', enabled: false, conditions: [{ sensor: 'tension', op: 'above', value: 3.5 }] })];

    it('builds one row per sensor with a cell per column', () => {
        const chart = stripChart({ columns, sensors, rules });
        assert.deepEqual(chart.rows.map(row => row.id), ['tone', 'tension', 'bare', 'scene']);
        assert.equal(chart.rows[0].cells.length, 3);
        assert.deepEqual(chart.rows[0].cells.map(cell => cell.value), [1, 1, null]);
    });

    it('marks a missing answer', () => {
        const [tone] = stripChart({ columns, sensors, rules }).rows;
        assert.deepEqual(tone.cells.map(cell => cell.value === null), [false, false, true]);
    });

    it('takes a tick from every enabled rule that names the sensor', () => {
        const chart = stripChart({ columns, sensors, rules });
        assert.deepEqual(chart.rows[0].ticks, [{ rule: 'flat', condition: { sensor: 'tone', op: 'below', value: 1.5 } }]);
        assert.deepEqual(chart.rows[1].ticks, []);
    });

    it('accents a choice cell only where the tick matches it', () => {
        const picked = [
            { index: 2, scores: { mood: 'calm' } },
            { index: 4, scores: { mood: 'angry' } },
        ];
        const watch = [rule({ conditions: [{ sensor: 'mood', op: 'is', value: 'angry' }] })];
        const [row] = stripChart({ columns: picked, sensors: typed, rules: watch }).rows;
        assert.deepEqual(row.cells.map(cell => cell.matching), [false, true]);
        assert.deepEqual(row.cells.map(cell => cell.value), ['calm', 'angry']);
    });

    it('does not accent a cell whose confidence is below what the tick asks for', () => {
        const picked = [
            { index: 2, scores: { tone: 1 }, confidence: { tone: 0.9 } },
            { index: 4, scores: { tone: 1 }, confidence: {} },
        ];
        const sure = [rule({ conditions: [{ sensor: 'tone', op: 'below', value: 1.5, minConfidence: 0.8 }] })];
        const [row] = stripChart({ columns: picked, sensors, rules: sure }).rows;
        assert.deepEqual(row.cells.map(cell => cell.matching), [true, false]);
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

    it('names the script action once and ignores the instruction it carries', () => {
        assert.match(ruleSummary(rule({ action: 'script', script: '/echo hi' }), sensors), /replies, run its script\.$/);
        assert.match(ruleSummary(rule({ action: 'script', directive: '(OOC)', script: '/echo hi' }), sensors), /replies, run its script\.$/);
        assert.match(ruleSummary(rule({ action: 'script', script: '' }), sensors), /replies, do nothing\.$/);
    });

    it('says when a rule names a sensor that is gone, or has no conditions', () => {
        const orphan = rule({ conditions: [{ sensor: 'tensoin', op: 'below', value: 1 }] });
        assert.equal(ruleSummary(orphan, sensors), 'This rule is skipped because no sensor is named tensoin.');
        assert.equal(ruleSummary(rule({ conditions: [] }), sensors), 'This rule has no conditions, so it never fires.');
    });

    it('waits one reply in the singular', () => {
        assert.match(ruleSummary(rule({ cooldown: 1 }), sensors), /waits 1 reply before/);
    });

    it('states a choice rule and a yes or no rule in the same shape', () => {
        const picked = rule({
            need: 1,
            window: 1,
            conditions: [{ sensor: 'mood', op: 'is_not', value: 'calm' }],
            skipWhen: { sensor: 'danger', op: 'above', value: 0.8 },
        });
        assert.equal(
            ruleSummary(picked, typed),
            'When Mood is not calm on the latest reply, except when Danger is above 80% on the latest reply, nudge the next turn.',
        );
    });

    it('names the least confidence inside the rule sentence', () => {
        const sure = rule({ need: 1, window: 1, conditions: [{ sensor: 'mood', op: 'is', value: 'angry', minConfidence: 0.6 }] });
        assert.equal(
            ruleSummary(sure, typed),
            'When Mood is angry with at least 60% confidence on the latest reply, nudge the next turn.',
        );
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

    it('names a script action by its own words, with no instruction to show', () => {
        const decision = { index: 6, fired: [{ rule: 'flat', action: 'script', reason: 'r' }] };
        assert.equal(decisionSentence(decision, rules), 'On message #6, Flat ran its script.');
    });

    it('names a swipe', () => {
        const decision = { index: 4, fired: [{ rule: 'flat', action: 'swipe', text: '(OOC)' }] };
        assert.equal(decisionSentence(decision, rules), 'On message #4, Flat rerolled the reply.');
    });
});

describe('badgeFor', () => {
    const stamp = (mes, entries) => entries.map(entry => ({ ...entry, hash: hashText(mes) }));
    const user = (mes, fired) => ({
        mes,
        is_user: true,
        extra: fired ? { jeved: { decided: true, decidedHash: hashText(mes), fired: stamp(mes, fired) } } : undefined,
    });
    const reply = (mes, swipeId) => (swipeId === undefined ? { mes } : { mes, swipe_id: swipeId });

    it('badges the user message that carried an instruction', () => {
        const chat = [user('hi', [{ rule: 'flat', action: 'nudge', text: '(OOC)' }]), reply('r')];
        const item = badgeFor(chat, 0);
        assert.equal(item.kind, 'nudge');
        assert.equal(item.entries.length, 1);
        assert.equal(badgeFor(chat, 1), null);
    });

    it('does not badge an entry left over from the text before an edit', () => {
        const chat = [user('hi', [{ rule: 'flat', action: 'nudge', text: '(OOC)' }]), reply('r')];
        chat[0].mes = 'hi again';
        assert.equal(badgeFor(chat, 0), null);
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
