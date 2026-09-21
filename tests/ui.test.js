import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { narrator, user } from './helpers/chat.js';
import { buttonNamed, installDom, settle } from './helpers/dom.js';
import { hostStub } from './helpers/host.js';

const body = installDom();
globalThis.IntersectionObserver = class { observe() {} };

const context = hostStub({});

const { HOSTS } = await import('../src/classifier.js');
const { CONFIDENCE } = await import('../src/limits.js');
const { getPreset, getSettings, initSettings, normaliseSettings } = await import('../src/settings.js');
const { addCost, addTokens } = await import('../src/engine/status.js');
const { addFired, writeScores } = await import('../src/store.js');
const { hashText } = await import('../src/util.js');
const { changeProblems, optionChanges, optionNames, sensorsTab, spreadText } = await import('../src/ui/sensors-tab.js');
const { conditionRow, latestLines, rulesTab } = await import('../src/ui/rules-tab.js');
const { activityTab } = await import('../src/ui/activity-tab.js');
const { answersFor } = await import('../src/ui/badge.js');
const { hostPicker } = await import('../src/ui/hosts.js');
const { settingsTab } = await import('../src/ui/settings-tab.js');

const moods = () => [
    { name: 'calm', description: 'Settled.' },
    { name: 'angry', description: 'Furious.' },
    { name: 'bored', description: 'Flat.' },
];

const choiceSensor = () => ({
    id: 'mood', label: 'Mood', watch: true, type: 'choice', user: 1, assistant: 1, context: false,
    question: 'Which mood fits `latest_turn`?', levels: [],
    options: moods(),
});

const scoreSensor = () => ({
    id: 'tone', label: 'Tone', watch: true, type: 'score', user: 1, assistant: 1, context: false,
    question: 'How does `latest_turn` read?',
    levels: ['a', 'b', 'c', 'd', 'e'], options: [],
});

function usingCalm() {
    return {
        id: 'flat', label: 'Flat', enabled: true, action: 'nudge',
        conditions: [{ sensor: 'mood', op: 'is', value: 'calm' }],
        need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '(OOC)', script: '',
    };
}

function setup(rules = []) {
    context.extensionSettings = {};
    context.chat = [];
    context.chatMetadata = {};
    initSettings();
    const settings = getSettings();
    settings.presets.Test = {
        description: '', sensors: [choiceSensor(), scoreSensor()], rules,
    };
    settings.activePreset = 'Test';
    normaliseSettings(settings);
    return settings;
}

async function openSensor() {
    const tab = sensorsTab({ refreshAll: () => {}, refreshOthers: () => {}, newRuleFrom: () => {} });
    body.replaceChildren(tab.element);
    tab.element.querySelectorAll('.jeved-sensor-row')[0].fire('click');
    await settle();
    return tab;
}

const nameFields = tab => tab.element.querySelector('.jeved-scale').querySelectorAll('.jeved-input');
const problemText = tab => tab.element.querySelector('.jeved-problems').childNodes.map(item => item.textContent).join(' ');
const save = async tab => {
    buttonNamed(tab.element, 'Save').fire('click');
    await settle();
};

const drawn = () => {
    const tab = activityTab({ refreshAll: () => {} });
    body.replaceChildren(tab.element);
    return tab;
};

const detailLines = (tab, at, className) => {
    const cells = tab.element.querySelectorAll('.jeved-cell');
    cells.at(at).fire('click', { type: 'click' });
    return tab.element.querySelector('.jeved-detail').querySelectorAll(className).map(line => line.textContent);
};

describe('what changed in the option list of an open sensor', () => {
    it('reports a rename and leaves an untouched name alone', () => {
        const draft = choiceSensor();
        const before = optionNames(draft);
        draft.options[0].name = 'settled';
        const changes = optionChanges(before, draft);
        assert.deepEqual([...changes.renames], [['calm', 'settled']]);
        assert.deepEqual(changes.removed, []);
    });

    it('reports a removal, and counts a new row as neither', () => {
        const draft = choiceSensor();
        const before = optionNames(draft);
        draft.options.splice(1, 1);
        draft.options.push({ name: 'tense', description: '' });
        const changes = optionChanges(before, draft);
        assert.deepEqual(changes.removed, ['angry']);
        assert.equal(changes.renames.size, 0);
    });
});

describe('saving a sensor that a rule reads', () => {
    beforeEach(() => setup([usingCalm()]));

    it('refuses a type change and names the rules that hold it', () => {
        const preset = getPreset();
        const problems = changeProblems(preset, preset.sensors[0], { ...choiceSensor(), type: 'score' }, { renames: new Map(), removed: [] });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /used by Flat, so its type can't change/);
    });

    it('refuses the removal of an option a rule names, and allows any other', () => {
        const preset = getPreset();
        const gone = name => changeProblems(preset, preset.sensors[0], choiceSensor(), { renames: new Map(), removed: [name] });
        assert.match(gone('calm')[0], /The option calm is used by Flat/);
        assert.deepEqual(gone('bored'), []);
    });

    it('refuses to take the assistant messages off a sensor an after-reply rule reads', () => {
        const preset = setup([
            { ...usingCalm(), id: 'puppet', label: 'Puppet', action: 'swipe' },
        ]).presets.Test;
        const early = { ...choiceSensor(), assistant: 0 };
        const problems = changeProblems(preset, preset.sensors[0], early, { renames: new Map(), removed: [] });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /used by Puppet, which needs a sensor that reads an assistant message/);

        assert.deepEqual(changeProblems(preset, preset.sensors[0], choiceSensor(), { renames: new Map(), removed: [] }), []);
    });

    it('refuses the same change for a Run script rule and allows it for a nudge rule', () => {
        const scripted = setup([
            { ...usingCalm(), id: 'shot', label: 'Shot', action: 'script', directive: '', script: '/echo hi' },
        ]).presets.Test;
        const early = { ...choiceSensor(), assistant: 0 };
        assert.match(
            changeProblems(scripted, scripted.sensors[0], early, { renames: new Map(), removed: [] })[0],
            /used by Shot, which needs a sensor that reads an assistant message/,
        );

        const nudging = setup([usingCalm()]).presets.Test;
        assert.deepEqual(changeProblems(nudging, nudging.sensors[0], early, { renames: new Map(), removed: [] }), []);
    });

    it('allows both changes once no rule reads the sensor', () => {
        const preset = setup([]).presets.Test;
        const changes = { renames: new Map(), removed: ['calm'] };
        assert.deepEqual(changeProblems(preset, preset.sensors[0], { ...choiceSensor(), type: 'score' }, changes), []);
    });

    it('carries a rename into the rules on the same save', async () => {
        const tab = await openSensor();
        const field = nameFields(tab)[0];
        field.value = 'settled';
        field.fire('input');
        await save(tab);

        assert.deepEqual(getPreset().sensors[0].options.map(option => option.name), ['settled', 'angry', 'bored']);
        assert.equal(getPreset().rules[0].conditions[0].value, 'settled');
    });

    it('stops the save and says why when a used option is removed', async () => {
        const tab = await openSensor();
        tab.element.querySelector('.jeved-scale').querySelectorAll('.jeved-btn--icon')[0].fire('click');
        await save(tab);

        assert.match(problemText(tab), /The option calm is used by Flat/);
        assert.deepEqual(getPreset().sensors[0].options.map(option => option.name), ['calm', 'angry', 'bored']);
    });

    it('stops the save and says why when the type changes', async () => {
        const tab = await openSensor();
        tab.element.querySelectorAll('.jeved-segment').find(item => item.dataset.jevedValue === 'score').fire('click');
        await save(tab);

        assert.match(problemText(tab), /its type can't change/);
        assert.equal(getPreset().sensors[0].type, 'choice');
    });
});

describe('one condition row', () => {
    const rowFor = condition => {
        setup();
        const block = conditionRow(getPreset(), condition, () => {}, null);
        return { block, pickers: block.querySelectorAll('.jeved-picker') };
    };

    it('starts a fresh condition when the sensor changes', () => {
        const condition = { sensor: 'tone', op: 'below', value: 2, minConfidence: 0.9 };
        const { pickers } = rowFor(condition);
        pickers[0].value = 'mood';
        pickers[0].fire('change');
        assert.deepEqual(condition, { sensor: 'mood', op: 'is', value: 'calm', minConfidence: null });
    });

    it('offers the tests and the values of the sensor type', () => {
        const { pickers } = rowFor({ sensor: 'mood', op: 'is', value: 'calm', minConfidence: null });
        assert.deepEqual(pickers[1].childNodes.map(item => item.value), ['is', 'is_not']);
        assert.deepEqual(pickers[2].childNodes.map(item => item.value), ['calm', 'angry', 'bored']);

        const numeric = rowFor({ sensor: 'tone', op: 'below', value: 2, minConfidence: null });
        assert.deepEqual(numeric.pickers[1].childNodes.map(item => item.value), ['below', 'above']);
        assert.equal(numeric.block.querySelector('.jeved-range').max, '4');
    });

    it('stores null when the confidence switch goes off', () => {
        const condition = { sensor: 'tone', op: 'below', value: 2, minConfidence: null };
        const { block } = rowFor(condition);
        const control = () => block.querySelector('.jeved-toggle');

        control().checked = true;
        control().fire('change');
        assert.equal(condition.minConfidence, CONFIDENCE.fallback);

        control().checked = false;
        control().fire('change');
        assert.equal(condition.minConfidence, null);
    });

    it('offers trimmed option names, and skips one with no name at all', () => {
        setup();
        getPreset().sensors.push({
            id: 'rough', label: 'Rough', type: 'choice',
            options: [{ name: ' calm ', description: '' }, { name: '  ', description: '' }],
        });
        const block = conditionRow(getPreset(), { sensor: 'rough', op: 'is', value: 'calm', minConfidence: null }, () => {}, null);
        const values = block.querySelectorAll('.jeved-picker')[2].childNodes.map(item => item.value);
        assert.deepEqual(values, ['calm']);
    });

    it('offers no confidence at all on a noul sensor', () => {
        setup();
        getPreset().sensors.push({ id: 'danger', label: 'Danger', type: 'noul', levels: [], options: [] });
        const condition = { sensor: 'danger', op: 'above', value: 0.5, minConfidence: 0.8 };
        const block = conditionRow(getPreset(), condition, () => {}, null);
        assert.equal(block.querySelector('.jeved-toggle'), null);
        assert.equal(condition.minConfidence, null);
    });

    it('shows a noul threshold as whole percents and stores the fraction', () => {
        setup();
        getPreset().sensors.push({ id: 'danger', label: 'Danger', type: 'noul', levels: [], options: [] });
        const condition = { sensor: 'danger', op: 'above', value: 0.5, minConfidence: null };
        const block = conditionRow(getPreset(), condition, () => {}, null);
        const bar = block.querySelector('.jeved-range');
        assert.deepEqual([bar.min, bar.max, bar.step, bar.value], ['0', '100', '1', '50']);

        bar.value = '80';
        bar.fire('input');
        assert.equal(condition.value, 0.8);
    });

    it('explains the confidence switch only while it is on', () => {
        const condition = { sensor: 'tone', op: 'below', value: 2, minConfidence: null };
        const { block } = rowFor(condition);
        const hints = () => block.querySelectorAll('.jeved-hint').map(item => item.textContent).join(' ');
        assert.doesNotMatch(hints(), /favoured/);

        const control = block.querySelector('.jeved-toggle');
        control.checked = true;
        control.fire('change');
        assert.match(hints(), /Jev reports how strongly it favoured its answer over the others/);
        assert.equal(block.querySelectorAll('.jeved-range').at(-1).max, '100');
    });
});

describe('the sensor editor for each type', () => {
    const labels = tab => tab.element.querySelectorAll('.jeved-form-label').map(item => item.textContent);
    const titles = tab => tab.element.querySelectorAll('.jeved-section-title').map(item => item.textContent);
    const hints = tab => tab.element.querySelectorAll('.jeved-hint').map(item => item.textContent);
    const pickType = (tab, type) => tab.element.querySelectorAll('.jeved-segment')
        .find(item => item.dataset.jevedValue === type).fire('click');

    it('asks for a question, and says what the type does', async () => {
        setup();
        const tab = await openSensor();
        assert.ok(labels(tab).includes('Question'));
        assert.ok(labels(tab).includes('Call size'));
        assert.ok(titles(tab).includes('Options'));
        assert.ok(hints(tab).includes('Jev picks the one option that fits the reply best.'));
    });

    it('asks a noul sensor for a statement instead', async () => {
        setup();
        const tab = await openSensor();
        pickType(tab, 'noul');
        assert.ok(labels(tab).includes('Statement'));
        assert.equal(labels(tab).includes('Question'), false);
        assert.ok(titles(tab).includes('Descriptions (optional)'));
        assert.ok(hints(tab).includes('Jev gives the chance, from 0 to 100%, that your statement is true.'));
    });

    it('offers the three input rows and says when the sensor runs', async () => {
        setup();
        const tab = await openSensor();
        const hintWithId = id => tab.element.querySelectorAll('.jeved-hint').find(item => item.id === id);
        assert.ok(labels(tab).includes('User messages'));
        assert.ok(labels(tab).includes('Assistant messages'));
        assert.ok(labels(tab).includes('Context'));
        assert.ok(hints(tab).includes('The card and your prompts.'));
        assert.equal(hintWithId('jeved_sensor_runs').textContent, 'Runs after each reply.');
        assert.equal(hintWithId('jeved_sensor_hint').textContent, 'Refer to the reply as `latest_turn` and your message as `player_message`.');

        const assistant = tab.element.querySelectorAll('.jeved-slider').find(item => item.id === 'jeved_sensor_assistant');
        const bar = assistant.querySelector('.jeved-range');
        assert.deepEqual([bar.min, bar.max, bar.step], ['0', '50', '1']);
        bar.value = '0';
        bar.fire('input');
        assert.equal(hintWithId('jeved_sensor_runs').textContent, 'Runs before the reply, on your message.');
        assert.equal(hintWithId('jeved_sensor_hint').textContent, 'Refer to your message as `player_message`.');
    });

    it('asks for at least one message once both sliders reach zero', async () => {
        setup();
        const tab = await openSensor();
        for (const id of ['jeved_sensor_user', 'jeved_sensor_assistant']) {
            const bar = tab.element.querySelectorAll('.jeved-slider').find(item => item.id === id).querySelector('.jeved-range');
            bar.value = '0';
            bar.fire('input');
        }
        const runs = tab.element.querySelectorAll('.jeved-hint').find(item => item.id === 'jeved_sensor_runs');
        assert.equal(runs.textContent, 'Pick at least one message.');
        await save(tab);
        assert.match(problemText(tab), /Pick at least one message/);
    });

    it('drops the old scale hint from every type', async () => {
        setup();
        const tab = await openSensor();
        for (const type of ['score', 'choice', 'noul']) {
            pickType(tab, type);
            assert.doesNotMatch(hints(tab).join(' '), /means the most possible/, type);
        }
    });
});

describe('the rule form for each action', () => {
    const openRule = async () => {
        const tab = rulesTab({ refreshAll: () => {}, refreshOthers: () => {} });
        body.replaceChildren(tab.element);
        tab.element.querySelectorAll('.jeved-rule-row')[0].fire('click');
        await settle();
        return tab;
    };
    const labels = tab => tab.element.querySelectorAll('.jeved-form-label').map(item => item.textContent);
    const pickAction = async (tab, id) => {
        tab.element.querySelectorAll('.jeved-segment').find(item => item.dataset.jevedValue === id).fire('click');
        await settle();
    };

    it('offers the three actions and swaps the instruction field for the script field', async () => {
        setup([usingCalm()]);
        const tab = await openRule();
        assert.deepEqual(
            tab.element.querySelectorAll('.jeved-segment').map(item => item.dataset.jevedValue),
            ['nudge', 'swipe', 'script'],
        );
        assert.ok(labels(tab).includes('Instruction (OOC)'));

        await pickAction(tab, 'script');
        assert.equal(labels(tab).includes('Instruction (OOC)'), false);
        assert.ok(labels(tab).includes('Script (STscript)'));
        assert.ok(tab.element.querySelectorAll('.jeved-hint')
            .some(item => item.textContent.startsWith("Runs the rule's script right after the reply.")));

        await pickAction(tab, 'nudge');
        assert.ok(labels(tab).includes('Instruction (OOC)'));
    });

    it('counts in messages for a rule on message sensors, and follows a condition change', async () => {
        const settings = setup([usingCalm()]);
        settings.presets.Test.sensors.find(sensor => sensor.id === 'mood').assistant = 0;
        const tab = await openRule();
        const inline = () => tab.element.querySelectorAll('.jeved-inline-label').map(item => item.textContent);
        const hints = () => tab.element.querySelectorAll('.jeved-hint').map(item => item.textContent);

        assert.ok(inline().includes('messages match'));
        assert.ok(hints().some(line => line.startsWith('If your latest message matches this')));

        const sensorPicker = tab.element.querySelectorAll('.jeved-picker')[0];
        sensorPicker.value = 'tone';
        sensorPicker.fire('change');
        await settle();
        assert.ok(inline().includes('replies match'));
        assert.ok(hints().some(line => line.startsWith('If the latest reply matches this')));
    });

    it('refuses to save a script rule with no script', async () => {
        setup([usingCalm()]);
        const tab = await openRule();
        await pickAction(tab, 'script');
        buttonNamed(tab.element, 'Save').fire('click');
        await settle();
        assert.match(problemText(tab), /It needs a script/);
        assert.equal(getPreset().rules[0].action, 'nudge');
    });
});

describe('the latest reply in the rule preview', () => {
    const sensorsOf = () => getPreset().sensors;
    const entry = scores => ({ index: 0, scores, confidence: {} });

    it('lists every condition with its latest answer and whether it matches', () => {
        setup();
        const rule = {
            conditions: [
                { sensor: 'tone', op: 'below', value: 2, minConfidence: null },
                { sensor: 'mood', op: 'is', value: 'calm', minConfidence: null },
            ],
        };
        const lines = latestLines(rule, entry({ tone: 1.2, mood: 'angry' }), sensorsOf());
        assert.deepEqual(lines, [
            { words: 'Tone: 1.2', match: 'Matches' },
            { words: 'Mood: angry', match: 'Does not match' },
        ]);
    });

    it('says not measured and offers no verdict for a sensor with no answer', () => {
        setup();
        const rule = { conditions: [{ sensor: 'tone', op: 'below', value: 2, minConfidence: null }] };
        assert.deepEqual(latestLines(rule, entry({}), sensorsOf()), [{ words: 'Tone: not measured', match: '' }]);
        assert.deepEqual(latestLines(rule, null, sensorsOf()), [{ words: 'Tone: not measured', match: '' }]);
    });

    it('reads a noul answer as a percent and honours the minimum confidence', () => {
        setup();
        getPreset().sensors.push({ id: 'danger', label: 'Danger', type: 'noul', levels: [], options: [] });
        const noul = { conditions: [{ sensor: 'danger', op: 'above', value: 0.5, minConfidence: null }] };
        assert.deepEqual(latestLines(noul, entry({ danger: 0.72 }), sensorsOf()), [{ words: 'Danger: 72%', match: 'Matches' }]);

        const sure = { conditions: [{ sensor: 'tone', op: 'below', value: 2, minConfidence: 0.8 }] };
        const shaky = { index: 0, scores: { tone: 1 }, confidence: { tone: 0.4 } };
        assert.deepEqual(latestLines(sure, shaky, sensorsOf()), [{ words: 'Tone: 1', match: 'Does not match' }]);
    });

    it('lists nothing for a rule with no conditions', () => {
        setup();
        assert.deepEqual(latestLines({ conditions: [] }, entry({}), sensorsOf()), []);
        assert.deepEqual(latestLines(null, entry({}), sensorsOf()), []);
    });
});

describe('the probabilities of a test row', () => {
    const many = count => Object.fromEntries(Array.from({ length: count }, (_, at) => [`o${at}`, (count - at) / 100]));

    it('lists every share while the list is short', () => {
        assert.equal(spreadText({ calm: 0.84, tense: 0.16 }), 'calm 84%, tense 16%');
        assert.equal(spreadText(many(10)).split(', ').length, 10);
    });

    it('cuts a long list to the top few and says how many are left', () => {
        const long = spreadText(many(12));
        assert.equal(long.split(', ').length, 5);
        assert.match(long, / and 7 more$/);
    });

    it('says nothing when there is nothing to show', () => {
        assert.equal(spreadText(null), '');
        assert.equal(spreadText({}), '');
        assert.equal(spreadText({ calm: 'most' }), '');
    });
});

describe('the answers a badge shows', () => {
    it('reads the badged message itself as well as the reply before it', () => {
        setup();
        context.chat = [user('ask')];
        writeScores(context.chat[0], { mood: 'calm' });
        assert.deepEqual(answersFor(context.chat, { index: 0, entries: [{ rule: 'flat' }] }), { mood: 'calm' });

        context.chat = [narrator('one'), user('ask')];
        writeScores(context.chat[0], { tone: 2 });
        writeScores(context.chat[1], { mood: 'calm' });
        assert.deepEqual(answersFor(context.chat, { index: 1, entries: [{ rule: 'flat' }] }), { tone: 2, mood: 'calm' });
    });

    it('prefers the answers the entry carries and says nothing when there are none', () => {
        setup();
        context.chat = [user('ask')];
        writeScores(context.chat[0], { mood: 'calm' });
        const item = { index: 0, entries: [{ rule: 'flat', scores: { mood: 'angry' } }] };
        assert.deepEqual(answersFor(context.chat, item), { mood: 'angry' });

        context.chat = [user('ask')];
        assert.equal(answersFor(context.chat, { index: 0, entries: [{ rule: 'flat' }] }), null);
    });
});

describe('which receipts a column in Activity shows', () => {
    it('puts an after-reply receipt under the reply it names, not under the first of a group', () => {
        setup([{ ...usingCalm(), id: 'shot', label: 'Shot', action: 'script', directive: '', script: '/echo hi' }]);
        context.chat = [user('ask'), narrator('one'), narrator('two')];
        writeScores(context.chat[1], { mood: 'calm', tone: 1 });
        writeScores(context.chat[2], { mood: 'calm', tone: 1 });
        addFired(context.chat[0], { rule: 'shot', action: 'script', reason: 'r', reply: hashText('two') });

        const tab = drawn();
        assert.deepEqual(detailLines(tab, -1, '.jeved-detail-fired'), ['Shot: ran its script']);
        assert.deepEqual(detailLines(tab, -2, '.jeved-detail-fired'), []);
    });

    it('leaves a reroll receipt on the reply that follows your message', () => {
        setup([{ ...usingCalm(), id: 'puppet', label: 'Puppet', action: 'swipe' }]);
        context.chat = [user('ask'), narrator('one'), narrator('two')];
        writeScores(context.chat[1], { mood: 'calm', tone: 1 });
        writeScores(context.chat[2], { mood: 'calm', tone: 1 });
        addFired(context.chat[0], { rule: 'puppet', action: 'swipe', reason: 'r', text: '(OOC)' });

        const tab = drawn();
        assert.deepEqual(detailLines(tab, -2, '.jeved-detail-fired'), ['Puppet: rerolled the reply']);
        assert.deepEqual(detailLines(tab, -1, '.jeved-detail-fired'), []);
    });
});

describe('the columns in Activity', () => {
    it('merges the answers of a reply and of the message before it into one column', () => {
        const settings = setup();
        settings.presets.Test.sensors.find(sensor => sensor.id === 'mood').assistant = 0;
        context.chat = [user('ask'), narrator('one')];
        writeScores(context.chat[0], { mood: 'calm' });
        writeScores(context.chat[1], { tone: 2 });

        assert.deepEqual(detailLines(drawn(), -1, '.jeved-detail-line'), ['Mood: calm - Settled.', 'Tone: 2 - c']);
    });

    it('adds a pending column for a measured message that has no reply yet', () => {
        const settings = setup();
        settings.presets.Test.sensors.find(sensor => sensor.id === 'mood').assistant = 0;
        context.chat = [user('ask'), narrator('one'), user('and then?')];
        writeScores(context.chat[1], { tone: 2 });
        writeScores(context.chat[2], { mood: 'angry' });

        const tab = drawn();
        assert.equal(tab.element.querySelectorAll('.jeved-mark-cell').length, 2);
        assert.deepEqual(detailLines(tab, -1, '.jeved-detail-line'), ['Mood: angry - Furious.']);
    });

    it('leaves out a pending column when the last message has no answers', () => {
        setup();
        context.chat = [user('ask'), narrator('one'), user('and then?')];
        writeScores(context.chat[1], { tone: 2 });

        assert.equal(drawn().element.querySelectorAll('.jeved-mark-cell').length, 1);
    });
});

describe('what the Cost section reports', () => {
    const readouts = tab => tab.element.querySelectorAll('.jeved-readout').map(item => item.textContent);

    it('counts the calls of each reply, and of each message once a sensor runs early', () => {
        const settings = setup();
        const plain = settingsTab({ refreshAll: () => {}, refreshOthers: () => {} });
        assert.ok(readouts(plain).includes('Each reply: 1 API call'));
        assert.equal(readouts(plain).some(line => line.startsWith('Each of your messages')), false);

        settings.presets.Test.sensors.find(sensor => sensor.id === 'mood').assistant = 0;
        const early = settingsTab({ refreshAll: () => {}, refreshOthers: () => {} });
        assert.ok(readouts(early).includes('Each reply: 1 API call'));
        assert.ok(readouts(early).includes('Each of your messages: 1 API call, before the reply'));
    });

    it('always shows the tokens, and the cost beside them once there is one', () => {
        setup();
        addTokens(1200);
        const plain = settingsTab({ refreshAll: () => {}, refreshOthers: () => {} });
        const readout = tab => tab.element.querySelectorAll('.jeved-readout').map(item => item.textContent).join(' | ');
        assert.match(readout(plain), /1,200 tokens/);
        assert.doesNotMatch(readout(plain), /\$/);

        addCost(0.25);
        const priced = settingsTab({ refreshAll: () => {}, refreshOthers: () => {} });
        assert.match(readout(priced), /1,200 tokens · \$0\.250000/);
    });
});

describe('the host picker', () => {
    beforeEach(() => setup());

    const built = () => {
        const picker = hostPicker();
        return {
            picker,
            control: picker.element.querySelector('.jeved-picker'),
            hint: picker.element.querySelector('.jeved-hint'),
        };
    };

    it('fills the endpoint and the model of the host you pick', () => {
        const { control } = built();
        const [, nano] = HOSTS;
        control.value = nano.endpoint;
        control.fire('change');
        assert.equal(getSettings().endpoint, nano.endpoint);
        assert.equal(getSettings().model, nano.model);
    });

    it('shows the hint of a host that needs the proxy, and drops it on Custom', () => {
        const proxied = HOSTS.find(host => host.hint);
        const { control, hint } = built();
        assert.equal(hint.hidden, true);

        control.value = proxied.endpoint;
        control.fire('change');
        assert.equal(hint.textContent, proxied.hint);

        control.value = '';
        control.fire('change');
        assert.equal(hint.hidden, true);
    });

    it('follows an endpoint you type by hand', () => {
        const [openrouter, nano] = HOSTS;
        getSettings().endpoint = openrouter.endpoint;
        const { picker, control, hint } = built();
        assert.equal(control.value, openrouter.endpoint);

        getSettings().endpoint = nano.endpoint;
        picker.refresh();
        assert.equal(control.value, nano.endpoint);

        getSettings().endpoint = 'https://example.test/decisions';
        picker.refresh();
        assert.equal(control.value, '');
        assert.equal(hint.hidden, true);
    });

    it('shows the new endpoint and model on the Settings tab at once', () => {
        const tab = settingsTab({ refreshAll: () => {}, refreshOthers: () => {} });
        const control = tab.element.querySelectorAll('.jeved-picker').find(item => item.id === 'jeved_host');
        const [, nano] = HOSTS;
        control.value = nano.endpoint;
        control.fire('change');
        const fields = tab.element.querySelectorAll('.jeved-input').map(item => item.value);
        assert.ok(fields.includes(nano.endpoint), 'the endpoint field moved with the host');
        assert.ok(fields.includes(nano.model), 'the model field moved with the host');
    });

    it('moves the Settings picker when the endpoint field is edited by hand', () => {
        const tab = settingsTab({ refreshAll: () => {}, refreshOthers: () => {} });
        const control = tab.element.querySelectorAll('.jeved-picker').find(item => item.id === 'jeved_host');
        const endpoint = tab.element.querySelectorAll('.jeved-input')
            .find(item => item.value === getSettings().endpoint);
        const [, nano] = HOSTS;

        endpoint.value = nano.endpoint;
        endpoint.fire('input');
        assert.equal(control.value, nano.endpoint);

        endpoint.value = 'https://example.test/decisions';
        endpoint.fire('input');
        assert.equal(control.value, '');
    });

    it('leaves the fields alone on Custom, and reads Custom back from an endpoint of your own', () => {
        getSettings().endpoint = 'https://example.test/decisions';
        getSettings().model = 'mine';
        const { control } = built();
        assert.equal(control.value, '');

        control.value = '';
        control.fire('change');
        assert.equal(getSettings().endpoint, 'https://example.test/decisions');
        assert.equal(getSettings().model, 'mine');
    });
});
