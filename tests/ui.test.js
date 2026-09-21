import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { narrator, user } from './helpers/chat.js';
import { buttonNamed, installDom, settle } from './helpers/dom.js';
import { hostStub } from './helpers/host.js';

const body = installDom();
globalThis.IntersectionObserver = class { observe() {} };

let popupAnswer = 0;
const context = hostStub({ callGenericPopup: async () => popupAnswer });

const { HOSTS } = await import('../src/classifier.js');
const { CONFIDENCE } = await import('../src/limits.js');
const { getPreset, getSettings, initSettings, normaliseSettings } = await import('../src/settings.js');
const { JEVED_UPDATED, addCost, addTokens, historyStamp } = await import('../src/engine/status.js');
const { addFired, writeScores } = await import('../src/store.js');
const { hashText } = await import('../src/util.js');
const { changeProblems, optionChanges, optionNames, sensorsTab, spreadText } = await import('../src/ui/sensors-tab.js');
const { listsTab } = await import('../src/ui/lists-tab.js');
const { chatEntries } = await import('../src/ui/entries.js');
const { manualChange, ruleChange } = await import('../src/lists.js');
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
    id: 'mood', label: 'Mood', watch: true, type: 'choice', user: 1, assistant: 1, context: 'none', contextPieces: [],
    question: 'Which mood fits `latest_turn`?', levels: [],
    options: moods(),
});

const scoreSensor = () => ({
    id: 'tone', label: 'Tone', watch: true, type: 'score', user: 1, assistant: 1, context: 'none', contextPieces: [],
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

const typeInto = (input, value) => {
    input.value = value;
    input.fire('input');
};

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

    it('keeps a sensor that repeats over a list out of the exception picker only', () => {
        setup();
        getPreset().lists = [{ name: 'rules', entries: [] }];
        getPreset().sensors.push({ id: 'house', label: 'House', type: 'noul', repeat: 'rules', levels: [], options: [] });
        const condition = { sensor: 'tone', op: 'below', value: 2, minConfidence: null };
        const names = block => block.querySelectorAll('.jeved-picker')[0].childNodes.map(item => item.value);

        assert.ok(names(conditionRow(getPreset(), condition, () => {}, null)).includes('house'));
        assert.equal(names(conditionRow(getPreset(), condition, () => {}, null, { plainOnly: true })).includes('house'), false);
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
        assert.ok(hints(tab).includes('What Jev reads besides the messages.'));
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

describe('the context a sensor picks', () => {
    const pickContext = async (tab, mode) => {
        tab.element.querySelectorAll('.jeved-segment').find(item => item.dataset.jevedValue === mode).fire('click');
        await settle();
    };
    const pieceLines = tab => tab.element.querySelectorAll('.jeved-piece')
        .map(item => item.childNodes.slice(1).map(part => part.textContent).join(' '));
    const tickPiece = (tab, label) => tab.element.querySelectorAll('.jeved-piece')
        .find(item => item.childNodes[1].textContent === label).querySelector('input');

    function withPreset(pieces = [], { off = [] } = {}) {
        setup();
        context.getCharacterCardFields = () => ({ description: 'A knight.', persona: 'A squire.', mesExamples: '' });
        context.chatCompletionSettings = {
            prompts: [
                { identifier: 'main', name: 'Main Prompt', content: 'Be a narrator.' },
                { identifier: 'style', name: 'Style', content: 'Be terse.' },
                { identifier: 'charDescription', name: 'Char Description', marker: true },
                { identifier: 'chatHistory', name: 'Chat History', marker: true },
                { identifier: 'personaDescription', name: 'Persona Description', marker: true },
            ],
            prompt_order: [{
                character_id: 100001,
                order: ['main', 'style', 'charDescription', 'chatHistory', 'personaDescription']
                    .map(identifier => ({ identifier, enabled: !off.includes(identifier) })),
            }],
        };
        Object.assign(getPreset().sensors[0], { context: 'custom', contextPieces: pieces });
    }

    it('hides the checklist until Custom is picked', async () => {
        withPreset();
        Object.assign(getPreset().sensors[0], { context: 'none', contextPieces: [] });
        const tab = await openSensor();
        assert.equal(tab.element.querySelector('.jeved-fold').hidden, true);

        await pickContext(tab, 'custom');
        assert.equal(tab.element.querySelector('.jeved-fold').hidden, false);
        assert.ok(pieceLines(tab).length > 1);
    });

    it('gives every row of the prompt order a piece, with the character note at the end', async () => {
        withPreset();
        const tab = await openSensor();
        assert.deepEqual(pieceLines(tab), [
            'Main Prompt 14',
            'Style 9',
            'Char Description 9',
            'Persona Description 9',
            'Character note empty',
        ]);
    });

    it('leaves chat history out and marks a switched-off marker row (off)', async () => {
        withPreset([], { off: ['charDescription'] });
        const tab = await openSensor();
        const lines = pieceLines(tab).join(' | ');
        assert.doesNotMatch(lines, /Chat History/);
        assert.match(lines, /Char Description \(off\) 9/);
    });

    it('lists a prompt that is switched off with (off), and lets it be ticked and saved', async () => {
        withPreset([], { off: ['style'] });
        const tab = await openSensor();
        assert.ok(pieceLines(tab).includes('Style (off) 9'));

        tickPiece(tab, 'Style (off)').checked = true;
        tickPiece(tab, 'Style (off)').fire('change');
        await save(tab);
        assert.deepEqual(getPreset().sensors[0].contextPieces, ['prompt:style']);
    });

    it('says empty for a piece with no text, and still lets it be ticked', async () => {
        withPreset();
        const tab = await openSensor();
        assert.ok(pieceLines(tab).includes('Character note empty'));

        tickPiece(tab, 'Character note').checked = true;
        tickPiece(tab, 'Character note').fire('change');
        await save(tab);
        assert.deepEqual(getPreset().sensors[0].contextPieces, ['character_note']);
    });

    it('keeps every row in prompt order, whether it is ticked or not', async () => {
        withPreset(['persona']);
        const tab = await openSensor();
        assert.deepEqual(pieceLines(tab), [
            'Main Prompt 14',
            'Style 9',
            'Char Description 9',
            'Persona Description 9',
            'Character note empty',
        ]);
    });

    it('keeps a ticked piece that is not there right now, and says so', async () => {
        withPreset(['prompt:gone', 'persona']);
        const tab = await openSensor();
        assert.ok(pieceLines(tab).includes('gone not found'));

        await save(tab);
        assert.deepEqual(getPreset().sensors[0].contextPieces, ['persona', 'prompt:gone']);
    });

    it('stores what you tick and what you untick', async () => {
        withPreset(['persona']);
        const tab = await openSensor();
        tickPiece(tab, 'Style').checked = true;
        tickPiece(tab, 'Style').fire('change');
        tickPiece(tab, 'Persona Description').checked = false;
        tickPiece(tab, 'Persona Description').fire('change');
        await save(tab);

        assert.equal(getPreset().sensors[0].context, 'custom');
        assert.deepEqual(getPreset().sensors[0].contextPieces, ['prompt:style']);
    });

    it('holds the pieces while the sensor sends everything, so Custom comes back as it was', async () => {
        withPreset(['persona']);
        const tab = await openSensor();
        await pickContext(tab, 'all');
        await save(tab);

        assert.equal(getPreset().sensors[0].context, 'all');
        assert.deepEqual(getPreset().sensors[0].contextPieces, ['persona']);
    });
});

const entryLines = tab => tab.element.querySelectorAll('.jeved-list-entry').map(item => item.textContent);
const entryTags = tab => tab.element.querySelector('.jeved-entries').querySelectorAll('.jeved-tag').map(item => item.textContent);
const pickScope = (tab, value) => tab.element.querySelectorAll('.jeved-segment')
    .find(item => item.dataset.jevedValue === value).fire('click');
const removeAt = (tab, at) => tab.element.querySelector('.jeved-entries').querySelectorAll('.jeved-btn--icon').at(at).fire('click');

describe('the Lists tab', () => {
    const opened = [];
    const openTab = async (name = '') => {
        opened.length = 0;
        const tab = listsTab({
            refreshAll: () => {}, refreshOthers: () => {}, openList: () => {},
            openTab: item => opened.push(item),
        });
        body.replaceChildren(tab.element);
        if (name) {
            await tab.select(name);
        }
        return tab;
    };
    const rowNames = tab => tab.element.querySelectorAll('.jeved-listing-row').map(line => line.childNodes[0].textContent);
    const hints = tab => tab.element.querySelectorAll('.jeved-hint').map(item => item.textContent);

    beforeEach(() => {
        setup();
        context.chat = [user('u0')];
    });

    it('says what a list is for while the preset has none', async () => {
        const tab = await openTab();
        assert.match(tab.element.querySelector('.jeved-empty').textContent, /^No lists yet\./);
        assert.ok(buttonNamed(tab.element, 'New list'));
    });

    it('declares a list on Save and refuses a name that is not an id', async () => {
        const tab = await openTab();
        buttonNamed(tab.element, 'New list').fire('click');
        await settle();

        typeInto(tab.element.querySelector('.jeved-input'), 'House rules');
        await save(tab);
        assert.match(problemText(tab), /lowercase letters, numbers and underscores/);
        assert.deepEqual(getPreset().lists, []);

        typeInto(tab.element.querySelector('.jeved-input'), 'house_rules');
        typeInto(tab.element.querySelector('.jeved-area'), 'One rule per entry. Example: No time skips.');
        await save(tab);

        assert.deepEqual(getPreset().lists, [
            { name: 'house_rules', description: 'One rule per entry. Example: No time skips.', entries: [] },
        ]);
        assert.deepEqual(rowNames(tab), ['house_rules']);
    });

    it('opens the first list when the tab opens', async () => {
        getPreset().lists = [{ name: 'one', entries: [] }, { name: 'two', entries: [] }];
        const tab = await openTab();
        assert.equal(tab.element.querySelectorAll('.jeved-readout')[0].textContent, 'one');
    });

    it('shows the description in the row and above the entries', async () => {
        getPreset().lists = [{ name: 'house_rules', description: 'One rule per entry.', entries: [] }];
        const tab = await openTab('house_rules');
        assert.deepEqual(tab.element.querySelectorAll('.jeved-sensor-note').map(item => item.textContent), ['One rule per entry.']);
        assert.deepEqual(tab.element.querySelectorAll('.jeved-entry-about').map(item => item.textContent), ['One rule per entry.']);
    });

    it('names what uses the list, and offers the two jumps when nothing does', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: [] }];
        const bare = await openTab('house_rules');
        assert.ok(hints(bare).includes('A sensor asks a question for each entry. Pick this list under Repeat over list.'));
        assert.ok(hints(bare).includes('A rule writes to it. Use Add to list.'));
        buttonNamed(bare.element, 'Open Sensors').fire('click');
        buttonNamed(bare.element, 'Open Rules').fire('click');
        assert.deepEqual(opened, ['sensors', 'rules']);

        getPreset().sensors[0].repeat = 'house_rules';
        const used = await openTab('house_rules');
        assert.equal(buttonNamed(used.element, 'Open Sensors'), null);
        assert.ok(used.element.querySelectorAll('.jeved-readout').map(item => item.textContent).includes('Mood'));
    });

    it('tags each entry with where it came from', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: ['from the preset'] }];
        const tab = await openTab('house_rules');
        manualChange('house_rules', 'add', 'by hand');
        ruleChange(context.chat[0], 'house_rules', 'add', 'by a rule');
        tab.refresh();

        assert.deepEqual(entryLines(tab), ['from the preset', 'by a rule', 'by hand']);
        assert.deepEqual(entryTags(tab), ['every chat', 'added by a rule', 'this chat']);
    });

    it('adds to this chat or to every chat, and the every-chat entry is there in a second chat', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: [] }];
        const tab = await openTab('house_rules');
        const box = tab.element.querySelector('.jeved-entries').querySelector('.jeved-input');

        typeInto(box, 'only here');
        box.fire('keydown', { key: 'Enter' });
        assert.deepEqual(entryTags(tab), ['this chat']);

        pickScope(tab, 'every');
        typeInto(box, 'everywhere');
        box.fire('keydown', { key: 'Enter' });
        assert.deepEqual(getPreset().lists[0].entries, ['everywhere']);

        context.chat = [user('other chat')];
        context.chatMetadata = {};
        tab.refresh();
        assert.deepEqual(entryLines(tab), ['everywhere']);
    });

    it('removes by the scope of the row', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: ['from the preset'] }];
        const tab = await openTab('house_rules');
        manualChange('house_rules', 'add', 'by hand');
        tab.refresh();

        removeAt(tab, 1);
        assert.deepEqual(entryLines(tab), ['from the preset']);
        assert.deepEqual(getPreset().lists[0].entries, ['from the preset']);

        removeAt(tab, 0);
        assert.deepEqual(entryLines(tab), []);
        assert.deepEqual(getPreset().lists[0].entries, []);
    });

    it('strikes an every-chat entry that this chat dropped, and Restore brings it back', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: ['one'] }];
        const tab = await openTab('house_rules');
        manualChange('house_rules', 'remove', 'one');
        tab.refresh();

        const struck = tab.element.querySelectorAll('.jeved-list-entry--gone').map(item => item.textContent);
        assert.deepEqual(struck, ['one']);
        assert.deepEqual(entryTags(tab), ['every chat']);

        buttonNamed(tab.element, 'Restore').fire('click');
        assert.deepEqual(tab.element.querySelectorAll('.jeved-list-entry--gone'), []);
        assert.deepEqual(entryLines(tab), ['one']);
    });

    it('takes the add box placeholder from the example in the description', async () => {
        getPreset().lists = [
            { name: 'house_rules', description: 'One rule per entry. Example: No time skips.', entries: [] },
            { name: 'cast', entries: [] },
        ];
        const shown = await openTab('house_rules');
        assert.equal(shown.element.querySelector('.jeved-entries').querySelector('.jeved-input').placeholder, 'Example: No time skips.');

        const bare = await openTab('cast');
        assert.equal(bare.element.querySelector('.jeved-entries').querySelector('.jeved-input').placeholder, 'New entry');
    });

    it('shows only the every-chat entries and fixes the switch when no chat is open', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: ['one'] }];
        context.getCurrentChatId = () => null;
        try {
            const tab = await openTab('house_rules');
            assert.deepEqual(entryLines(tab), ['one']);
            assert.deepEqual(entryTags(tab), ['every chat']);
            assert.equal(tab.element.querySelector('.jeved-entry-foot').querySelector('.jeved-row').hidden, true);

            const box = tab.element.querySelector('.jeved-entries').querySelector('.jeved-input');
            typeInto(box, 'two');
            box.fire('keydown', { key: 'Enter' });
            assert.deepEqual(getPreset().lists[0].entries, ['one', 'two']);
        } finally {
            context.getCurrentChatId = () => 'chat';
        }
    });

    it('says the list is empty', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: [] }];
        const tab = await openTab('house_rules');
        assert.ok(hints(tab).includes('No entries yet.'));
    });

    it('refuses to delete a list a sensor repeats over', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: [] }];
        getPreset().sensors[0].repeat = 'house_rules';
        const tab = await openTab('house_rules');

        buttonNamed(tab.element, 'Delete list').fire('click');
        await settle();
        assert.match(problemText(tab), /used by Mood, so it can't be deleted/);
        assert.deepEqual(getPreset().lists.map(list => list.name), ['house_rules']);
    });

    it('shows the name of a saved list as text, so it cannot be renamed', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: ['one'] }];
        const tab = await openTab('house_rules');
        assert.equal(tab.element.querySelectorAll('.jeved-readout')[0].textContent, 'house_rules');
        const boxes = tab.element.querySelectorAll('.jeved-input');
        assert.equal(boxes.length, 1, 'only the add box takes text');
        assert.equal(boxes[0], tab.element.querySelector('.jeved-entries').querySelector('.jeved-input'));
    });

    it('keeps a name that the preset validator accepts', async () => {
        const tab = await openTab();
        buttonNamed(tab.element, 'New list').fire('click');
        await settle();
        typeInto(tab.element.querySelector('.jeved-input'), 'two__words_');
        await save(tab);
        assert.deepEqual(getPreset().lists.map(list => list.name), ['two__words_']);
    });

    it('clears the measured counts and tells the rest of the workspace', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: [] }];
        const events = [];
        const kept = context.eventSource;
        context.eventSource = { emit: name => events.push(name), on: () => {}, removeListener: () => {} };
        try {
            const tab = await openTab('house_rules');
            const before = historyStamp();
            typeInto(tab.element.querySelector('.jeved-entries').querySelector('.jeved-input'), 'one');
            buttonNamed(tab.element.querySelector('.jeved-entries'), 'Add').fire('click');
            assert.notEqual(historyStamp(), before);
            assert.deepEqual(events, [JEVED_UPDATED]);
        } finally {
            context.eventSource = kept;
        }
    });

    it('deletes a list nothing uses', async () => {
        getPreset().lists = [{ name: 'house_rules', entries: [] }];
        popupAnswer = 1;
        const tab = await openTab('house_rules');
        buttonNamed(tab.element, 'Delete list').fire('click');
        await settle();
        assert.deepEqual(getPreset().lists, []);
        popupAnswer = 0;
    });
});

describe('the entries of a repeating sensor in the sensor form', () => {
    const jumped = [];
    const openWith = async repeat => {
        getPreset().lists = [{ name: 'rules', entries: ['one'] }];
        getPreset().sensors[0].repeat = repeat;
        const tab = sensorsTab({
            refreshAll: () => {}, refreshOthers: () => {}, newRuleFrom: () => {},
            openList: name => jumped.push(name),
        });
        body.replaceChildren(tab.element);
        tab.element.querySelectorAll('.jeved-sensor-row')[0].fire('click');
        await settle();
        return tab;
    };

    beforeEach(() => {
        jumped.length = 0;
        setup();
        context.chat = [user('u0')];
    });

    it('stays hidden until a list is picked', async () => {
        const tab = await openWith('');
        const held = () => tab.element.querySelectorAll('.jeved-fold').find(item => item.id === 'jeved_sensor_entries');
        assert.equal(held().hidden, true);

        const control = tab.element.querySelectorAll('.jeved-picker').find(item => item.id === 'jeved_sensor_repeat');
        control.value = 'rules';
        control.fire('change');
        assert.equal(held().hidden, false);
        assert.deepEqual(tab.element.querySelectorAll('.jeved-list-entry').map(item => item.textContent), ['one']);
    });

    it('counts the entries in the fold caption and adds and removes them in this chat', async () => {
        const tab = await openWith('rules');
        const caption = () => tab.element.querySelectorAll('.jeved-fold-head').at(-1).textContent;
        assert.equal(caption(), 'In this chat: 1');

        const box = tab.element.querySelector('.jeved-entries').querySelector('.jeved-input');
        typeInto(box, 'two');
        buttonNamed(tab.element.querySelector('.jeved-entries'), 'Add').fire('click');
        assert.equal(caption(), 'In this chat: 2');

        tab.element.querySelector('.jeved-entries').querySelector('.jeved-btn--icon').fire('click');
        assert.equal(caption(), 'In this chat: 1');
    });

    it('jumps to the Lists tab with that list', async () => {
        const tab = await openWith('rules');
        buttonNamed(tab.element, 'Open in Lists').fire('click');
        assert.deepEqual(jumped, ['rules']);
    });

    it('keeps what you typed through a refresh and clears it when the list changes', async () => {
        getPreset().lists = [{ name: 'rules', entries: ['one'] }, { name: 'cast', entries: [] }];
        const tab = await openWith('rules');
        const boxOf = () => tab.element.querySelector('.jeved-entries').querySelector('.jeved-input');
        const box = boxOf();
        typeInto(box, 'half written');

        tab.refresh();
        assert.equal(boxOf(), box, 'the same input node stays in place');
        assert.equal(box.value, 'half written');

        const control = tab.element.querySelectorAll('.jeved-picker').find(item => item.id === 'jeved_sensor_repeat');
        control.value = 'cast';
        control.fire('change');
        assert.equal(box.value, '');

        buttonNamed(tab.element.querySelector('.jeved-entries'), 'Add').fire('click');
        assert.deepEqual(chatEntries(getPreset(), 'cast'), []);
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
            ['nudge', 'swipe', 'list_add', 'list_remove', 'script'],
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

    it('names the list a repeating rule checks, and says when it is empty', async () => {
        const settings = setup([usingCalm()]);
        settings.presets.Test.lists = [{ name: 'house_rules', entries: [] }];
        settings.presets.Test.sensors.find(sensor => sensor.id === 'mood').repeat = 'house_rules';
        const tab = await openRule();

        const hints = () => tab.element.querySelectorAll('.jeved-hint').map(item => item.textContent);
        assert.ok(hints().includes('Checks each entry of house_rules.'));
        assert.ok(hints().includes('No entries. Add one to turn this rule on.'));
        assert.equal(hints().includes('No entries yet.'), false);

        const box = tab.element.querySelector('.jeved-entries').querySelector('.jeved-input');
        typeInto(box, 'no time skips');
        box.fire('keydown', { key: 'Enter' });
        assert.deepEqual(entryLines(tab), ['no time skips']);
        assert.equal(hints().includes('No entries. Add one to turn this rule on.'), false);
    });

    it('counts the entries in the rule row', async () => {
        const settings = setup([usingCalm()]);
        settings.presets.Test.lists = [{ name: 'house_rules', entries: ['one'] }];
        settings.presets.Test.sensors.find(sensor => sensor.id === 'mood').repeat = 'house_rules';
        const tab = rulesTab({ refreshAll: () => {}, refreshOthers: () => {} });
        body.replaceChildren(tab.element);
        assert.match(tab.element.querySelector('.jeved-rule-note').textContent, /Mood · 1 entry$/);
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

    it('gives a repeating sensor one line per entry and checks each against its own answer', () => {
        setup();
        getPreset().lists = [{ name: 'rules', entries: [] }];
        getPreset().sensors.push({ id: 'house', label: 'House', type: 'noul', repeat: 'rules', levels: [], options: [] });
        const rule = { conditions: [{ sensor: 'house', op: 'above', value: 0.5, minConfidence: null }] };
        const latest = { index: 0, scores: { house: { one: 0.9, two: 0.1 } }, confidence: {} };
        const over = () => ['One', 'Two'];

        assert.deepEqual(latestLines(rule, latest, sensorsOf(), over), [
            { words: 'House - One: 90%', match: 'Matches' },
            { words: 'House - Two: 10%', match: 'Does not match' },
        ]);
        assert.deepEqual(latestLines(rule, latest, sensorsOf(), () => []), [
            { words: 'House: the list rules is empty', match: '' },
        ]);
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
