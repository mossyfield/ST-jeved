import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { narrator, user } from './helpers/chat.js';
import { hostStub } from './helpers/host.js';
import { settle } from './helpers/settle.js';

let chatId = 'a';
const swipes = [];
const seen = [];
const events = [];
const card = { system: 's', jailbreak: '', description: 'd', personality: '', scenario: '', charDepthPrompt: '', persona: '' };
let onCount = null;

const basePrompts = () => ({
    prompts: [{ identifier: 'main', content: 'Preset main.' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
});

const notices = [];
globalThis.toastr = { info: message => notices.push(message), error() {}, success() {}, warning() {} };

const context = hostStub({
    chatCompletionSettings: basePrompts(),
    getCurrentChatId: () => chatId,
    getCharacterCardFields: () => card,
    getTokenCountAsync: async text => {
        const hook = onCount;
        onCount = null;
        hook?.();
        return text.length;
    },
    eventSource: { emit: (name, detail) => events.push({ name, detail, kind: status().kind }), on: () => {} },
    swipe: { isAllowed: () => true, right: async () => { swipes.push(chatId); } },
});

globalThis.document = { getElementById: () => null };

const engine = await import('../src/engine.js');
const { cancelEditTimers, chatPreset, clearChatScores, evaluationContext, historyStamp, interceptGeneration, invalidateMeasured, measureBlockReason, measuredCount, onCharacterMessage, onChatChanged, onMessageEdited, planMeasurement, rescan, status, targetAt, testConnection, testSensor } = engine;
const { rescanSentence } = await import('../src/describe.js');
const { replayRule } = await import('../src/rules.js');
const { call, measure, messageTarget } = await import('../src/engine/measure.js');
const { setRerolling } = await import('../src/engine/status.js');
const { buildContext } = await import('../src/instructions.js');
const { getSettings, initSettings } = await import('../src/settings.js');
const { fired, getHistory, getRecord, getScores, writeDecision, writeScores } = await import('../src/store.js');
const { hashText } = await import('../src/util.js');

let gate = null;
function hold() {
    let open = null;
    const wait = new Promise(resolve => { open = resolve; });
    gate = { wait, open };
    return gate;
}

let breakOn = '';
let breakStatus = 500;

const answerFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const ids = Object.keys(body.questions);
    seen.push({ chatId, ids, state: body.state, questions: body.questions });
    if (gate) {
        await gate.wait;
    }
    if (options.signal?.aborted) {
        throw new Error('the request was aborted');
    }
    if (breakOn && ids.includes(breakOn)) {
        return { ok: false, status: breakStatus, json: async () => ({ error: { message: 'the endpoint broke' } }) };
    }
    const answers = {};
    for (const id of ids) {
        const { type, criteria } = body.questions[id];
        if (type === 'choice') {
            answers[id] = { choice: Object.keys(criteria)[0] };
        } else if (type === 'noul') {
            answers[id] = { noul: 0.5 };
        } else {
            answers[id] = { score: 1, confidence: 0.75, probabilities: { 1: 0.75 } };
        }
    }
    return { ok: true, status: 200, json: async () => ({ answers, usage: { cost: 0 } }) };
};

globalThis.fetch = answerFetch;

function setChat(id, messages) {
    chatId = id;
    context.chat = messages;
    context.chatMetadata = {};
    invalidateMeasured();
}

const sceneSensor = {
    id: 'scene', label: 'Scene', watch: false, type: 'choice', user: 1, assistant: 0, context: false,
    question: 'What kind of scene does `player_message` ask for?', levels: [],
    options: [{ name: 'combat', description: 'A fight.' }, { name: 'talk', description: 'A conversation.' }],
};

const sceneRule = (overrides = {}) => ({
    id: 'scene_combat', label: 'Scene: combat', enabled: true, action: 'nudge',
    conditions: [{ sensor: 'scene', op: 'is', value: 'combat' }],
    need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '(OOC: short beats.)', script: '',
    ...overrides,
});

function withScene(rules = [sceneRule()]) {
    const preset = getSettings().presets.Director;
    preset.sensors.splice(preset.sensors.findIndex(sensor => sensor.id === 'scene'), 1, { ...sceneSensor });
    preset.rules = rules;
    return preset;
}

function replyRulesOnly(preset) {
    for (const rule of preset.rules) {
        rule.enabled = rule.enabled && !rule.id.startsWith('scene_');
    }
    return preset;
}

beforeEach(() => {
    context.extensionSettings = {};
    initSettings();
    const settings = getSettings();
    replyRulesOnly(settings.presets.Director);
    settings.enabled = true;
    settings.apiKey = 'k';
    settings.timeoutMs = 5000;
    gate = null;
    breakOn = '';
    breakStatus = 500;
    onCount = null;
    card.system = 's';
    card.description = 'd';
    context.chatCompletionSettings = basePrompts();
    context.executeSlashCommandsWithOptions = async () => {};
    swipes.length = 0;
    seen.length = 0;
    events.length = 0;
    notices.length = 0;
    cancelEditTimers();
    setChat('a', []);
});

describe('work is bound to the chat it started in', () => {
    it('does not reroll a reply in another chat when a measurement lands late', async () => {
        const preset = getSettings().presets.Director;
        preset.rules.push({
            id: 'always', label: 'Always', enabled: true, action: 'swipe',
            conditions: [{ sensor: 'change', op: 'below', value: 99 }],
            need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '(OOC)', script: '',
        });

        setChat('a', [user('hello'), narrator('first reply')]);
        hold();
        onCharacterMessage(1, 'normal');
        await Promise.resolve();

        const other = [user('other'), narrator('other reply')];
        setChat('b', other);
        onChatChanged();

        gate.open();
        await settle();

        assert.deepEqual(swipes, []);
        assert.equal(getScores(other[1]), null);
    });

    it('does not write the scores of one chat into another', async () => {
        const first = [user('u0'), narrator('c0'), user('u1'), narrator('c1')];
        setChat('c', first);
        const plan = planMeasurement({ all: true });
        assert.equal(plan.tasks.length, 2);

        hold();
        const running = rescan(plan.tasks);
        await Promise.resolve();

        const second = [user('u0'), narrator('d0'), user('u1'), narrator('d1')];
        setChat('d', second);
        onChatChanged();

        gate.open();
        await running;

        assert.equal(getScores(second[1]), null);
        assert.equal(getScores(second[3]), null);
        assert.ok(seen.every(call => call.chatId === 'c'), JSON.stringify(seen));
    });
});

describe('the status chip after a measurement', () => {
    it('is not still measuring when the update arrives', async () => {
        setChat('a', [user('hello'), narrator('a reply')]);
        onCharacterMessage(1, 'normal');
        await settle();

        const last = events.at(-1);
        assert.ok(last, 'an update was emitted');
        assert.notEqual(last.kind, 'working');
        assert.equal(status().kind, 'measured');
    });
});

describe('planMeasurement', () => {
    it('counts the calls it is about to make and asks only for what is missing', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        const full = planMeasurement({ all: true });
        assert.equal(full.calls, 6);

        await rescan(full.tasks);
        assert.equal(planMeasurement().calls, 0);

        const preset = getSettings().presets.Director;
        preset.sensors.push({
            id: 'pace', label: 'Pace', watch: true, user: 1, assistant: 1, context: false,
            question: 'How fast is `latest_turn`?', levels: ['a', 'b', 'c', 'd', 'e'],
        });

        const topUp = planMeasurement({ sensorId: 'pace' });
        assert.equal(topUp.calls, 2);
        seen.length = 0;
        await rescan(topUp.tasks);
        assert.deepEqual(seen.map(one => one.ids), [['pace'], ['pace']]);
    });

    it('plans a call on every user message once the preset has a message sensor', async () => {
        const kept = getSettings().presets.Director.rules.find(rule => rule.id === 'drift');
        withScene([sceneRule(), kept]);
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        const plan = planMeasurement({ all: true });
        assert.deepEqual(plan.tasks.map(task => task.index), [0, 1, 2]);

        seen.length = 0;
        await rescan(plan.tasks);
        assert.deepEqual(seen.filter(one => one.ids.includes('scene')).map(one => one.state), [
            { player_message: 'u0' },
            { player_message: 'u1' },
        ]);
        assert.equal(getScores(context.chat[0]).scores.scene, 'combat');
        assert.equal(planMeasurement().calls, 0);
    });

    it('plans nothing for a chat with no replies', () => {
        setChat('a', [user('only me')]);
        assert.deepEqual(planMeasurement({ all: true }), { tasks: [], calls: 0 });
    });

    it('does not ask for a choice sensor a second time once it has an option', async () => {
        const preset = getSettings().presets.Director;
        preset.sensors.push({
            id: 'vibe', label: 'Vibe', watch: true, type: 'choice', turns: 1, includeContext: false, includeUser: true,
            measureEvery: 1, question: 'Which vibe fits `latest_turn`?', levels: [],
            options: [{ name: 'calm', description: 'Settled.' }, { name: 'angry', description: 'Furious.' }],
        });
        setChat('a', [user('u0'), narrator('c0')]);

        await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(getScores(context.chat[1]).scores.vibe, 'calm');
        assert.equal(planMeasurement().calls, 0);

        preset.sensors.find(sensor => sensor.id === 'vibe').options = [{ name: 'bored', description: 'Flat.' }, { name: 'angry', description: 'Furious.' }];
        assert.equal(planMeasurement({ sensorId: 'vibe' }).calls, 1);
    });

    it('stores the confidence that came with a score', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(getScores(context.chat[1]).confidence.tension, 0.75);
    });

    it('makes exactly as many calls as it planned, live and on a rescan', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        onCharacterMessage(1, 'normal');
        await settle();
        assert.equal(seen.length, 3);

        context.chat.push(user('u1'), narrator('c1'), user('u2'), narrator('c2'));
        invalidateMeasured();
        const missing = planMeasurement({});
        seen.length = 0;
        await rescan(missing.tasks);
        assert.equal(seen.length, missing.calls);

        const all = planMeasurement({ all: true });
        seen.length = 0;
        await rescan(all.tasks);
        assert.equal(seen.length, all.calls);
    });

    it('asks in one call per group, however many sensors share it', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        await rescan(planMeasurement({ all: true }).tasks);
        assert.deepEqual(seen.map(one => one.ids).sort(), [['repeats'], ['tension', 'cost', 'speaks', 'attention'], ['tone']]);
    });

    it('measures one sensor on its own without touching the others', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const plan = planMeasurement({ sensorId: 'tone' });
        assert.equal(plan.calls, 1);
        await rescan(plan.tasks);
        assert.deepEqual(seen.map(one => one.ids), [['tone']]);
    });

    it('skips a task whose reply has changed since it was planned', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const plan = planMeasurement({ all: true });
        context.chat[1].mes = 'edited after planning';
        await rescan(plan.tasks);
        assert.deepEqual(seen, []);
        assert.equal(getScores(context.chat[1]), null);
    });

    it('keeps the scores of the call that worked when the other one fails', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        breakOn = 'tone';
        await rescan(planMeasurement({ all: true }).tasks);
        const stored = getScores(context.chat[1]).scores;
        assert.deepEqual(Object.keys(stored).sort(), ['attention', 'cost', 'repeats', 'speaks', 'tension']);
        assert.match(engine.lastError(), /broke/);
    });

    it('does not let a narrow request swallow a wider one', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        hold();
        const narrow = rescan(planMeasurement({ sensorId: 'tone' }).tasks);
        await Promise.resolve();
        onCharacterMessage(1, 'normal');
        gate.open();
        await narrow;
        await settle();
        assert.ok(seen.some(one => one.ids.includes('tension')), JSON.stringify(seen.map(one => one.ids)));
    });
});

describe('what a rescan reports', () => {
    it('counts a rejected key as a failure, not as a measured reply', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        breakOn = 'tension';
        breakStatus = 401;
        const plan = planMeasurement({ sensorId: 'tension' });
        assert.equal(plan.calls, 2);

        const counts = await rescan(plan.tasks);
        assert.deepEqual(counts, { measured: 0, failed: 2, skipped: 0, total: 2 });
        assert.equal(measuredCount(), 0);
        assert.equal(engine.lastErrorKind(), 'key');
        assert.equal(rescanSentence(counts), 'Nothing was measured, because 2 messages failed.');
    });

    it('counts the call that worked beside the one that did not', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        breakOn = 'tone';
        const counts = await rescan(planMeasurement({ all: true }).tasks);
        assert.deepEqual(counts, { measured: 0, failed: 1, skipped: 0, total: 1 });
        assert.deepEqual(Object.keys(getScores(context.chat[1]).scores).sort(), ['attention', 'cost', 'repeats', 'speaks', 'tension']);
    });

    it('counts a call that answered only some of the sensors it asked for as a failure', async () => {
        const preset = withScene();
        preset.sensors.push({ ...sceneSensor, id: 'vibe', label: 'Vibe', watch: true });
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        const plan = planMeasurement({ all: true });
        const messages = plan.tasks.filter(task => task.index !== 1);
        assert.equal(messages.length, 2);

        globalThis.fetch = async (_url, options) => {
            seen.push({ chatId, ids: Object.keys(JSON.parse(options.body).questions) });
            return { ok: true, status: 200, json: async () => ({ answers: { scene: { choice: 'combat' } }, usage: {} }) };
        };
        let counts = null;
        try {
            counts = await rescan(messages);
        } finally {
            globalThis.fetch = answerFetch;
        }

        assert.deepEqual(counts, { measured: 0, failed: 2, skipped: 0, total: 2 });
        assert.equal(getScores(context.chat[2]).scores.scene, 'combat');
        assert.equal(measuredCount(), 0);
    });

    it('counts a reply that changed after planning as skipped', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const plan = planMeasurement({ all: true });
        context.chat[1].mes = 'edited after planning';
        assert.deepEqual(await rescan(plan.tasks), { measured: 0, failed: 0, skipped: 1, total: 1 });
    });
});

describe('the context a call carries', () => {
    it('sends what the Preview would show, and only to the sensors that asked', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const settings = getSettings();
        const shown = await buildContext(settings.presets.Director.contextGroups, settings.instructionsCap);
        await rescan(planMeasurement({ all: true }).tasks);

        const withContext = seen.find(one => one.ids.includes('tone'));
        const withoutContext = seen.find(one => one.ids.includes('tension'));
        assert.deepEqual(withContext.state.context, shown.context);
        assert.deepEqual(shown.context, { main_prompt: 's', description: 'd' });
        assert.equal(withoutContext.state.context, undefined);
        assert.equal(withoutContext.state.latest_turn, 'c0');
        assert.equal(withContext.state.latest_turn, 'c0');
    });

    it('leaves out a group the preset turned off', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        getSettings().presets.Director.contextGroups.description = false;
        await rescan(planMeasurement({ sensorId: 'tone' }).tasks);
        assert.deepEqual(seen[0].state.context, { main_prompt: 's' });
    });
});

describe('a reply deleted while the context is being counted', () => {
    it('scores the reply it was asked about, not the one that moved into its place', async () => {
        const target = narrator('target reply');
        const neighbour = narrator('a different reply');
        setChat('a', [user('u0'), target, neighbour]);
        card.system = 'a one-off system prompt that has not been counted before';
        onCount = () => context.chat.splice(0, 1);

        onCharacterMessage(1, 'normal');
        await settle();

        assert.equal(context.chat.length, 2, 'the user message was deleted');
        assert.ok(seen.length, 'a call went out');
        for (const call of seen) {
            const sent = call.state.latest_turn ?? call.state.latest_turns;
            assert.equal(sent, 'target reply', JSON.stringify(call.state));
        }
        assert.ok(getScores(target), 'the target kept its scores');
        assert.equal(getScores(neighbour), null);
    });
});

describe('a prompt that only belongs to one generation type', () => {
    it('stays out of the context for a normal reply', async () => {
        context.chatCompletionSettings = {
            prompts: [
                { identifier: 'main', content: 'Preset main.' },
                { identifier: 'carry', content: 'Carry on from the last word.', injection_trigger: ['continue'] },
            ],
            prompt_order: [{
                character_id: 100001,
                order: [{ identifier: 'main', enabled: true }, { identifier: 'carry', enabled: true }],
            }],
        };
        setChat('a', [user('u0'), narrator('c0')]);
        onCharacterMessage(1, 'normal');
        await settle();

        const withContext = seen.find(one => one.ids.includes('tone'));
        assert.ok(withContext, 'the sensor that reads context was measured');
        assert.equal(withContext.state.context.other_prompts, undefined);
        assert.equal(withContext.state.context.main_prompt, 's');
    });
});

describe('a sensor Test that is edited while it runs', () => {
    const draft = () => ({
        id: 'draft', label: 'Draft', watch: true, turns: 1, includeContext: false, includeUser: false, measureEvery: 1,
        question: 'How tense is `latest_turn`?', levels: ['none at all', 'a little', 'a lot', '', ''],
    });

    it('asks every reply with the wording the Test started with', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        const editable = draft();
        hold();
        const running = testSensor(editable, 2);
        await Promise.resolve();

        editable.levels[0] = 'edited while the Test was running';
        editable.levels[1] = 'edited too';
        editable.question = 'an edited question';

        gate.open();
        const rows = await running;

        assert.equal(rows.length, 2);
        assert.equal(seen.length, 2);
        for (const call of seen) {
            assert.equal(call.questions.draft.instructions, 'How tense is `latest_turn`?');
            assert.deepEqual(call.questions.draft.criteria, ['none at all', 'a little', 'a lot', '', '']);
        }
    });
});

describe('a paused chat', () => {
    const draft = {
        id: 'draft', label: 'Draft', watch: true, turns: 1, includeContext: false, includeUser: false, measureEvery: 1,
        question: 'How tense is `latest_turn`?', levels: ['none', 'some', 'a lot', '', ''],
    };

    it('says why nothing here is measured', () => {
        setChat('a', [user('u0'), narrator('c0')]);
        assert.equal(measureBlockReason(), '');
        context.chatMetadata.jeved_muted = true;
        assert.match(measureBlockReason(), /paused/);
    });

    it('measures nothing, however you ask for it', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const plan = planMeasurement({ all: true });
        assert.ok(plan.tasks.length);
        context.chatMetadata.jeved_muted = true;

        assert.deepEqual(await rescan(plan.tasks), {
            measured: 0, failed: 0, skipped: plan.tasks.length, total: plan.tasks.length,
        });
        await assert.rejects(() => testSensor(draft, 2), /paused/);
        assert.deepEqual(seen, []);
        assert.equal(measuredCount(), 0);
    });

    it('sends no further request when you pause it half way through a scan', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1'), user('u2'), narrator('c2')]);
        const plan = planMeasurement({ sensorId: 'tone' });
        assert.equal(plan.calls, 3);

        hold();
        const running = rescan(plan.tasks);
        await settle();
        const sentFirst = seen.length;
        assert.ok(sentFirst > 0, 'the scan had started');

        context.chatMetadata.jeved_muted = true;
        gate.open();
        await running;

        assert.equal(seen.length, sentFirst);
        assert.equal(getScores(context.chat[5]), null);
    });

    it('counts the replies it never reached as skipped, so the tally adds up', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1'), user('u2'), narrator('c2')]);
        const plan = planMeasurement({ sensorId: 'tone' });
        assert.equal(plan.tasks.length, 3);

        hold();
        const running = rescan(plan.tasks);
        await settle();
        context.chatMetadata.jeved_muted = true;
        gate.open();
        const counts = await running;

        assert.ok(counts.skipped > 0, 'the replies it never reached were counted');
        assert.equal(counts.measured + counts.failed + counts.skipped, counts.total);
    });

    it('makes no call from a Connection Test', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        context.chatMetadata.jeved_muted = true;
        await assert.rejects(() => testConnection(), /paused/);
        assert.deepEqual(seen, []);
    });

    it('still measures by hand while Jeved is turned off', async () => {
        getSettings().enabled = false;
        setChat('a', [user('u0'), narrator('c0')]);
        const counts = await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(counts.measured, 1);
        assert.ok(seen.length);
        assert.ok(getScores(context.chat[1]));

        seen.length = 0;
        const rows = await testSensor(draft, 1);
        assert.equal(rows.length, 1);
        assert.equal(seen.length, 1);
    });

    it('reports the value, the confidence and the probabilities of a test row', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const [row] = await testSensor(draft, 1);
        assert.equal(row.value, 1);
        assert.equal(row.confidence, 0.75);
        assert.deepEqual(row.probabilities, { 1: 0.75 });
    });

    it('says what a sensor of this type still needs before it can be tested', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const [bare] = await testSensor({ ...draft, levels: [] }, 1);
        assert.match(bare.error, /two score descriptions/);
        const [picker] = await testSensor({ ...draft, type: 'choice', options: [] }, 1);
        assert.match(picker.error, /two options/);
    });
});

describe('an answer a reply never got', () => {
    it('stays missing, because nothing is carried forward any more', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        const preset = getSettings().presets.Director;
        await rescan(planMeasurement({ all: true }).tasks);
        delete context.chat[3].extra.jeved.scores.tone;

        const history = evaluationContext(context.chat, preset).historyOf(null);
        assert.equal(history.at(-1).scores.tone, undefined);
        assert.equal(history.at(-2).scores.tone, 1);
    });
});

describe('the preset marker on a chat', () => {
    it('stays on the old preset while old scores remain', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(chatPreset(), 'Director');

        const settings = getSettings();
        settings.presets.Other = structuredClone(settings.presets.Director);
        settings.activePreset = 'Other';

        context.chat.push(user('u2'), narrator('c2'));
        invalidateMeasured();
        onCharacterMessage(5, 'normal');
        await settle();

        assert.ok(getScores(context.chat[5]), 'the new reply was measured');
        assert.equal(chatPreset(), 'Director');
    });

    it('does not let a score that was in flight come back after Clear', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        hold();
        const running = rescan(planMeasurement({ all: true }).tasks);
        await settle();
        assert.ok(seen.length, 'the scan had started');

        clearChatScores();
        gate.open();
        await running;
        await settle();

        assert.equal(getScores(context.chat[1]), null);
        assert.equal(measuredCount(), 0);
    });

    it('keeps a replacement measurement when the one it replaced lands late', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const stale = hold();
        onCharacterMessage(1, 'normal');
        await settle();

        clearChatScores();
        const fresh = hold();
        onCharacterMessage(1, 'normal');
        await settle();
        const sent = seen.length;

        stale.open();
        await settle();
        assert.equal(status().text, 'Measuring', 'the replacement was still counted as in flight');

        onCharacterMessage(1, 'normal');
        await settle();
        assert.equal(seen.length, sent, 'the replacement was reused instead of asked again');

        fresh.open();
        await settle();
        assert.ok(getScores(context.chat[1]), 'the replacement wrote its score');
    });

    it('moves to the active preset once the scores are cleared', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        await rescan(planMeasurement({ all: true }).tasks);
        const settings = getSettings();
        settings.presets.Other = structuredClone(settings.presets.Director);
        settings.activePreset = 'Other';

        clearChatScores();
        assert.equal(chatPreset(), 'Other');
    });
});

describe('pause stops the work that is already under way', () => {
    it('drops a score that lands after the chat was paused', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        hold();
        onCharacterMessage(1, 'normal');
        await settle();
        assert.ok(seen.length, 'the call had gone out');

        engine.setPaused(true);
        gate.open();
        await settle();

        assert.equal(getScores(context.chat[1]), null);
        assert.equal(measuredCount(), 0);
    });

    it('does not run the next rule script when the first one pauses the chat', async () => {
        const ran = [];
        context.executeSlashCommandsWithOptions = async script => {
            ran.push(script);
            if (script === '/echo one') {
                engine.setPaused(true);
            }
        };
        const scripted = (id, script) => ({
            id, label: id, enabled: true, action: 'nudge',
            conditions: [{ sensor: 'change', op: 'below', value: 99 }],
            need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '', script,
        });
        getSettings().presets.Director.rules = [scripted('one', '/echo one'), scripted('two', '/echo two')];
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        writeScores(context.chat[1], { change: 1 });

        await interceptGeneration(context.chat, 0, null, 'normal');

        assert.deepEqual(ran, ['/echo one']);
    });
});

describe('evaluationContext', () => {
    it('reads the cooldown and the reply history from one chat', async () => {
        const preset = getSettings().presets.Director;
        preset.rules.find(rule => rule.id === 'drift').cooldown = 5;
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        await rescan(planMeasurement({ all: true }).tasks);
        writeDecision(context.chat[2], [{ rule: 'drift', action: 'nudge', reason: 'r', text: 't' }]);

        const built = evaluationContext(context.chat, preset);
        assert.deepEqual(built.sensorIds, preset.sensors.map(sensor => sensor.id));
        assert.equal(built.sinceRule('drift'), 1);
        assert.deepEqual(built.historyOf(null).map(entry => entry.index), [1, 3]);
        assert.equal(typeof built.historyOf(null)[1].scores.tone, 'number');
    });

    it('hands each rule the history of its own moment', async () => {
        const preset = withScene([
            sceneRule({ window: 2 }),
            sceneRule({ id: 'echo', window: 2, conditions: [{ sensor: 'repeats', op: 'above', value: 1 }] }),
        ]);
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await rescan(planMeasurement({ all: true }).tasks);

        const built = evaluationContext(context.chat, preset);
        assert.deepEqual(built.historyOf(preset.rules[0]).map(entry => entry.index), [0, 2]);
        assert.deepEqual(built.historyOf(preset.rules[1]).map(entry => entry.index), [1]);
    });

    it('looks back as far as the widest window of the rules that are on', () => {
        const preset = getSettings().presets.Director;
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1'), user('u2'), narrator('c2')]);
        for (const rule of preset.rules) {
            rule.enabled = rule.id === 'drift';
            rule.window = 2;
        }
        assert.deepEqual(evaluationContext(context.chat, preset).historyOf(null).map(entry => entry.index), [3, 5]);
    });
});

describe('live measurement and a rescan share one task', () => {
    it('reuses the request that is already in flight instead of asking twice', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        hold();
        onCharacterMessage(1, 'normal');
        await Promise.resolve();

        const running = rescan(planMeasurement({ all: true }).tasks);
        gate.open();
        await running;
        await settle();

        assert.deepEqual(seen.map(one => one.ids).sort(), [['repeats'], ['tension', 'cost', 'speaks', 'attention'], ['tone']]);
    });

    it('sends the wording a task was planned with, even when the sensor is edited mid-scan', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1'), user('u2'), narrator('c2')]);
        const preset = getSettings().presets.Director;
        const plan = planMeasurement({ all: true });
        hold();
        const running = rescan(plan.tasks);
        await Promise.resolve();

        const change = preset.sensors.find(sensor => sensor.id === 'tension');
        change.turns = 3;
        change.question = 'How much changes in `latest_turns`?';

        gate.open();
        await running;

        const asked = seen.filter(one => one.ids.includes('tension'));
        assert.equal(asked.length, 3);
        for (const call of asked) {
            assert.equal(call.questions.tension.instructions, 'How much tension or pressure is in `latest_turn`?');
            assert.equal(typeof call.state.latest_turn, 'string');
            assert.equal(call.state.latest_turns, undefined);
        }
    });
});

describe('a script that takes too long', () => {
    const slowScript = () => {
        let started = null;
        const reached = new Promise(resolve => { started = resolve; });
        context.executeSlashCommandsWithOptions = () => {
            started();
            return new Promise(() => {});
        };
        return reached;
    };
    const drain = async () => {
        for (let turn = 0; turn < 50; turn++) {
            await Promise.resolve();
        }
    };
    const scripted = action => ({
        id: 'always', label: 'Always', enabled: true, action,
        conditions: [{ sensor: 'change', op: 'below', value: 99 }],
        need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '', script: '/echo hi',
    });

    it('lets the next reply go out when a nudge script never finishes', async () => {
        getSettings().presets.Director.rules.push(scripted('nudge'));
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        writeScores(context.chat[1], { change: 1 });
        const reached = slowScript();

        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const running = interceptGeneration(context.chat, 0, null, 'normal');
            await reached;
            mock.timers.tick(5000);
            await running;
        } finally {
            mock.timers.reset();
        }

        assert.equal(engine.lastError(), '');
        assert.equal(engine.lastErrorKind(), '');
        assert.equal(notices.filter(note => /still running after 5 seconds/.test(note)).length, 1);
    });

    it('lets a reroll go ahead when its script never finishes', async () => {
        getSettings().timeoutMs = 600000;
        getSettings().presets.Director.rules.push(scripted('swipe'));
        setChat('a', [user('u0'), narrator('c0')]);
        const reached = slowScript();
        const right = context.swipe.right;
        context.swipe.right = async () => {
            swipes.push(chatId);
            const reply = context.chat.at(-1);
            reply.swipes = [reply.mes, 'another'];
            reply.swipe_id = 1;
        };

        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            onCharacterMessage(1, 'normal');
            await reached;
            mock.timers.tick(5000);
            await drain();
        } finally {
            mock.timers.reset();
            context.swipe.right = right;
        }

        assert.equal(engine.lastError(), '');
        assert.deepEqual(swipes, ['a']);
    });

    it('still reports a script that fails long after Jeved stopped waiting', async () => {
        getSettings().presets.Director.rules.push(scripted('nudge'));
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        writeScores(context.chat[1], { change: 1 });
        let breakScript = null;
        const reached = new Promise(resolve => {
            context.executeSlashCommandsWithOptions = () => {
                resolve();
                return new Promise((_ok, stop) => { breakScript = stop; });
            };
        });

        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const running = interceptGeneration(context.chat, 0, null, 'normal');
            await reached;
            mock.timers.tick(5000);
            await running;
            assert.equal(engine.lastError(), '');
            breakScript(new Error('the command blew up'));
            await drain();
        } finally {
            mock.timers.reset();
        }

        assert.match(engine.lastError(), /failed: the command blew up/);
        assert.equal(engine.lastErrorKind(), 'script');
    });
});

describe('what a finished reroll reports', () => {
    const rule = { id: 'long', label: 'Too long' };

    it('says nothing at all when the reroll worked', () => {
        assert.deepEqual(engine.rerollOutcome({ status: 'done', rule }), {});
    });

    it('announces the reroll when it starts', () => {
        assert.deepEqual(engine.rerollOutcome({ status: 'started', rule }).toast, ['info', 'Rerolling (Too long)']);
    });

    it('treats a cancelled reroll as news, not as an error', () => {
        const outcome = engine.rerollOutcome({ status: 'cancelled', rule, detail: 'you started typing' });
        assert.equal(outcome.error, undefined);
        assert.deepEqual(outcome.toast, ['info', 'The reroll in Too long stopped because you started typing.']);
    });

    it('gives a busy host its own error, apart from a refused swipe', () => {
        const busy = engine.rerollOutcome({ status: 'timeout', rule, detail: 'SillyTavern stayed busy' });
        const refused = engine.rerollOutcome({ status: 'failed', rule, detail: 'the host refused' });
        assert.equal(busy.error[1], 'swipeBusy');
        assert.equal(refused.error[1], 'swipe');
        assert.equal(busy.toast, undefined);
    });

    it('turns each of those kinds into a chip with its own next step', () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const chipFor = kind => {
            engine.setErrorText('something', kind);
            return status();
        };
        assert.equal(chipFor('swipeBusy').text, 'Reroll timed out');
        assert.equal(chipFor('swipe').text, 'Reroll failed');
        assert.notEqual(chipFor('swipeBusy').next, chipFor('swipe').next);
        engine.setErrorText('', '');
    });
});

describe('the pre-pass in the interceptor', () => {
    const lastUser = () => context.chat.at(-1);

    it('measures a message sensor before it decides, and nudges the same turn', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        const copy = context.chat.map(message => ({ ...message }));
        await interceptGeneration(copy, 0, null, 'normal');

        assert.deepEqual(seen.map(one => one.ids), [['scene']]);
        assert.equal(seen[0].state.player_message, 'u1');
        assert.equal(getScores(lastUser()).scores.scene, 'combat');
        assert.deepEqual(fired(lastUser()).map(entry => entry.rule), ['scene_combat']);
        assert.ok(copy[2].mes.endsWith('(OOC: short beats.)'));
    });

    it('reuses the stored decision on a swipe, on a regenerate and for a second group member', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');
        seen.length = 0;

        for (const type of ['swipe', 'regenerate', 'normal']) {
            const copy = context.chat.map(message => ({ ...message }));
            await interceptGeneration(copy, 0, null, type);
            assert.ok(copy[2].mes.endsWith('(OOC: short beats.)'), type);
        }
        assert.deepEqual(seen, []);
        assert.equal(fired(lastUser()).length, 1);
    });

    it('decides again after the message is edited, and keeps the old entry as a receipt', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');

        lastUser().mes = 'u1 edited';
        const copy = context.chat.map(message => ({ ...message }));
        await interceptGeneration(copy, 0, null, 'normal');

        assert.deepEqual(fired(lastUser()).map(entry => entry.rule), ['scene_combat', 'scene_combat']);
        assert.equal(copy[2].mes, 'u1 edited\n\n(OOC: short beats.)');
    });

    it('keeps going when the call fails, and says so', async () => {
        withScene();
        breakOn = 'scene';
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        const copy = context.chat.map(message => ({ ...message }));
        await interceptGeneration(copy, 0, null, 'normal');

        assert.equal(getScores(lastUser()), null);
        assert.equal(getRecord(lastUser()).decided, true);
        assert.deepEqual(fired(lastUser()), []);
        assert.match(engine.lastError(), /broke/);
    });

    it('stops waiting at the limit, and a late answer cannot land', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        hold();

        mock.timers.enable({ apis: ['setTimeout'] });
        let running = null;
        try {
            running = interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');
            await Promise.resolve();
            mock.timers.tick(2000);
            await Promise.resolve();
            mock.timers.tick(3000);
            await running;
        } finally {
            mock.timers.reset();
        }

        assert.equal(getRecord(lastUser()).decided, true);
        assert.match(engine.lastError(), /did not answer before the reply/);

        gate.open();
        await settle();
        assert.equal(getScores(lastUser()), null);
    });

    it('decides again when you edit the message and then swipe the reply it already has', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');

        const sent = context.chat[2];
        context.chat.push(narrator('c1'));
        sent.mes = 'u1 edited';
        invalidateMeasured();

        const copy = context.chat.map(message => ({ ...message }));
        await interceptGeneration(copy, 0, null, 'swipe');
        assert.equal(getRecord(sent).decidedHash, hashText('u1 edited'));
        assert.equal(copy[2].mes, 'u1 edited\n\n(OOC: short beats.)');
    });

    it('lets a late group of the same measurement land after the limit only when it was not aborted', async () => {
        const preset = withScene();
        preset.sensors.push({ ...sceneSensor, id: 'vibe', label: 'Vibe', watch: true, user: 2 });
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);

        let openOne = null;
        globalThis.fetch = async (url, options) => {
            const ids = Object.keys(JSON.parse(options.body).questions);
            if (ids.includes('vibe')) {
                await new Promise(resolve => { openOne = resolve; });
            }
            return answerFetch(url, options);
        };

        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const running = interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');
            await Promise.resolve();
            mock.timers.tick(2000);
            await Promise.resolve();
            mock.timers.tick(3000);
            await running;
        } finally {
            mock.timers.reset();
            globalThis.fetch = answerFetch;
        }

        assert.match(engine.lastError(), /did not answer before the reply/);
        openOne?.();
        await settle();
        assert.equal(getScores(lastUser()), null);
    });

    it('joins a wider measurement that is still in flight when it stops waiting', async () => {
        const preset = withScene();
        preset.sensors.push({ ...sceneSensor, id: 'vibe', label: 'Vibe', watch: true });
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        writeScores(context.chat[2], { scene: 'combat' });
        invalidateMeasured();

        hold();
        const wider = measure(messageTarget(2));
        await settle();
        assert.deepEqual(seen.map(one => one.ids), [['scene', 'vibe']]);

        let running = null;
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            running = interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');
            await Promise.resolve();
            mock.timers.tick(2000);
            for (let turn = 0; turn < 20; turn++) {
                await Promise.resolve();
            }
        } finally {
            mock.timers.reset();
        }
        gate.open();
        await running;
        await wider;

        assert.deepEqual(seen.map(one => one.ids), [['scene', 'vibe']]);
        assert.equal(getScores(context.chat[2]).scores.vibe, 'combat');
    });

    it('does not join a pending measurement whose input settings have changed since', async () => {
        const preset = withScene();
        preset.sensors.push({ ...sceneSensor, id: 'vibe', label: 'Vibe', watch: true });
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        writeScores(context.chat[2], { scene: 'combat' });
        invalidateMeasured();

        hold();
        const wider = measure(messageTarget(2));
        await settle();
        assert.equal(seen.length, 1);

        preset.sensors.find(sensor => sensor.id === 'vibe').user = 2;
        let running = null;
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            running = interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');
            await Promise.resolve();
            mock.timers.tick(2000);
            for (let turn = 0; turn < 20; turn++) {
                await Promise.resolve();
            }
        } finally {
            mock.timers.reset();
        }
        gate.open();
        await running;
        await wider;

        assert.deepEqual(seen.map(one => one.ids), [['scene', 'vibe'], ['vibe']]);
    });

    it('says so when one answer of a shared call is still missing', async () => {
        const preset = withScene();
        preset.sensors.push({ ...sceneSensor, id: 'vibe', label: 'Vibe', watch: true });
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ answers: { scene: { choice: 'combat' } }, usage: {} }),
        });
        try {
            await interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');
        } finally {
            globalThis.fetch = answerFetch;
        }
        assert.equal(getScores(lastUser()).scores.scene, 'combat');
        assert.match(engine.lastError(), /not fully measured/);
        assert.deepEqual(fired(lastUser()).map(entry => entry.rule), ['scene_combat']);
    });

    it('makes no pre-pass call for a quiet, a continue or an impersonate generation', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        for (const type of ['quiet', 'continue', 'impersonate']) {
            await interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, type);
        }
        assert.deepEqual(seen, []);
        assert.equal(getRecord(lastUser()), null);
    });

    it('makes no pre-pass call when the preset has no message sensor', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await interceptGeneration(context.chat.map(message => ({ ...message })), 0, null, 'normal');
        assert.deepEqual(seen, []);
        assert.equal(getRecord(context.chat[2]).decided, true);
    });

    it('puts the answer of a sensor into the instruction it adds', async () => {
        withScene([sceneRule({ directive: 'The scene is {{jeved::scene}}. Keep {{user}} in it.' })]);
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);

        const copy = context.chat.map(message => ({ ...message }));
        await interceptGeneration(copy, 0, null, 'normal');
        assert.equal(copy[2].mes, 'u1\n\nThe scene is combat. Keep {{user}} in it.');
    });

    it('keeps the instruction lines in preset order across both moments', async () => {
        const preset = withScene([
            { ...sceneRule(), id: 'early', directive: '(OOC: early.)' },
            {
                ...sceneRule(), id: 'late', directive: '(OOC: late.)',
                conditions: [{ sensor: 'change', op: 'below', value: 99 }],
            },
        ]);
        preset.rules.push({ ...sceneRule(), id: 'last', directive: '(OOC: last.)' });
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        writeScores(context.chat[1], { change: 1 });

        const copy = context.chat.map(message => ({ ...message }));
        await interceptGeneration(copy, 0, null, 'normal');
        assert.equal(copy[2].mes, 'u1\n\n(OOC: early.)\n\n(OOC: late.)\n\n(OOC: last.)');
    });
});

describe('a message that is edited after it was measured', () => {
    it('measures it once, after the last edit, and makes no decision', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await rescan(planMeasurement({ all: true }).tasks);
        seen.length = 0;

        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            context.chat[2].mes = 'first edit';
            onMessageEdited(2);
            mock.timers.tick(1000);
            context.chat[2].mes = 'second edit';
            onMessageEdited(2);
            mock.timers.tick(2000);
        } finally {
            mock.timers.reset();
        }
        await settle();

        assert.deepEqual(seen.map(one => one.ids), [['scene']]);
        assert.equal(seen[0].state.player_message, 'second edit');
        assert.equal(getScores(context.chat[2]).scores.scene, 'combat');
        assert.equal(getRecord(context.chat[2]).decided, undefined);
    });

    it('measures a reply again at the index it moved to', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        await rescan(planMeasurement({ all: true }).tasks);
        seen.length = 0;

        const edited = context.chat[3];
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            edited.mes = 'edited reply';
            onMessageEdited(3);
            context.chat.splice(0, 1);
            mock.timers.tick(2000);
        } finally {
            mock.timers.reset();
        }
        await settle();

        assert.ok(seen.length);
        assert.ok(seen.every(one => one.state.latest_turn === 'edited reply'), JSON.stringify(seen.map(one => one.state)));
        assert.ok(getScores(edited));
    });

    it('forgets the timer when the chat changes', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await rescan(planMeasurement({ all: true }).tasks);
        seen.length = 0;

        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            context.chat[2].mes = 'edited';
            onMessageEdited(2);
            onChatChanged();
            mock.timers.tick(5000);
        } finally {
            mock.timers.reset();
        }
        await settle();
        assert.deepEqual(seen, []);
    });

    it('gives up on the timer when a reroll never ends', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await rescan(planMeasurement({ all: true }).tasks);
        seen.length = 0;

        mock.timers.enable({ apis: ['setTimeout'] });
        setRerolling(true);
        try {
            context.chat[2].mes = 'edited';
            onMessageEdited(2);
            for (let round = 0; round < 6; round++) {
                mock.timers.tick(2000);
            }
            setRerolling(false);
            mock.timers.tick(2000);
        } finally {
            mock.timers.reset();
            setRerolling(false);
        }
        await settle();
        assert.deepEqual(seen, []);
    });

    it('starts no timer when the text still matches the answers it has', async () => {
        withScene();
        setChat('a', [user('u0'), narrator('c0'), user('u1')]);
        await rescan(planMeasurement({ all: true }).tasks);
        seen.length = 0;

        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            onMessageEdited(2);
            onMessageEdited(99);
            mock.timers.tick(5000);
        } finally {
            mock.timers.reset();
        }
        await settle();
        assert.deepEqual(seen, []);
    });
});

describe('a Run script rule', () => {
    const ran = [];
    const scriptRule = (overrides = {}) => ({
        id: 'shot', label: 'Shot', enabled: true, action: 'script',
        conditions: [{ sensor: 'change', op: 'below', value: 99 }],
        need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '', script: '/echo shot',
        ...overrides,
    });
    const withRules = (...rules) => {
        getSettings().presets.Director.rules = rules;
    };
    const arrive = async messageId => {
        onCharacterMessage(messageId, 'normal');
        await settle();
    };

    beforeEach(() => {
        ran.length = 0;
        context.executeSlashCommandsWithOptions = async script => { ran.push(script); };
    });

    it('runs the script once after the reply and puts the receipt on the message before it', async () => {
        withRules(scriptRule());
        setChat('a', [user('u0'), narrator('c0')]);
        await arrive(1);

        assert.deepEqual(ran, ['/echo shot']);
        const [entry] = fired(context.chat[0]);
        assert.deepEqual([entry.rule, entry.action, entry.reply], ['shot', 'script', hashText('c0')]);
        assert.equal(entry.text, undefined);
        assert.equal(typeof entry.reason, 'string');
        assert.equal(entry.scores.change, 1);
        assert.deepEqual(swipes, []);
        assert.deepEqual(engine.lastDecision().fired.map(item => item.rule), ['shot']);
    });

    it('does not run again for the same reply text, and runs again after a swipe', async () => {
        withRules(scriptRule());
        setChat('a', [user('u0'), narrator('c0')]);
        await arrive(1);
        await arrive(1);
        assert.deepEqual(ran, ['/echo shot']);

        context.chat[1].mes = 'c0 swiped';
        await arrive(1);
        assert.deepEqual(ran, ['/echo shot', '/echo shot']);
        assert.equal(fired(context.chat[0]).length, 2);
    });

    it('waits for its cooldown across replies', async () => {
        withRules(scriptRule({ cooldown: 3 }));
        setChat('a', [user('u0'), narrator('c0')]);
        await arrive(1);

        context.chat.push(user('u1'), narrator('c1'));
        invalidateMeasured();
        await arrive(3);
        assert.deepEqual(ran, ['/echo shot']);
        assert.deepEqual(fired(context.chat[2]), []);
    });

    it('runs several rules in preset order and stops when a script changes chat', async () => {
        withRules(scriptRule({ id: 'one', script: '/echo one' }), scriptRule({ id: 'two', script: '/echo two' }));
        setChat('a', [user('u0'), narrator('c0')]);
        await arrive(1);
        assert.deepEqual(ran, ['/echo one', '/echo two']);

        ran.length = 0;
        setChat('b', [user('u0'), narrator('c0')]);
        context.executeSlashCommandsWithOptions = async script => {
            ran.push(script);
            if (script === '/echo one') {
                setChat('c', [user('other'), narrator('other reply')]);
            }
        };
        await arrive(1);
        assert.deepEqual(ran, ['/echo one']);
    });

    it('holds the script rules back when a reroll starts, and runs them on the replacement', async () => {
        const reroll = {
            id: 'puppet', label: 'Puppet', enabled: true, action: 'swipe',
            conditions: [{ sensor: 'change', op: 'below', value: 99 }],
            need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '(OOC)', script: '',
        };
        withRules(reroll, scriptRule());
        setChat('a', [user('u0'), narrator('c0')]);
        const right = context.swipe.right;
        context.swipe.right = async () => {
            swipes.push(chatId);
            const reply = context.chat.at(-1);
            reply.swipes = [reply.mes, 'another'];
            reply.swipe_id = 1;
            reply.mes = 'another';
        };
        try {
            await arrive(1);
            assert.deepEqual(swipes, ['a']);
            assert.deepEqual(ran, []);

            invalidateMeasured();
            await arrive(1);
        } finally {
            context.swipe.right = right;
        }
        assert.deepEqual(ran, ['/echo shot']);
    });

    it('runs in a group chat, where a swipe rule would not', async () => {
        const reroll = {
            id: 'puppet', label: 'Puppet', enabled: true, action: 'swipe',
            conditions: [{ sensor: 'change', op: 'below', value: 99 }],
            need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '(OOC)', script: '',
        };
        withRules(reroll, scriptRule());
        context.groupId = 'group';
        setChat('a', [user('u0'), narrator('c0')]);
        try {
            await arrive(1);
        } finally {
            context.groupId = null;
        }
        assert.deepEqual(ran, ['/echo shot']);
        assert.deepEqual(swipes, []);
        assert.deepEqual(fired(context.chat[0]).map(entry => entry.action), ['script']);
    });

    it('runs on the replacement that arrives while the reroll is still going', async () => {
        const reroll = {
            id: 'puppet', label: 'Puppet', enabled: true, action: 'swipe',
            conditions: [{ sensor: 'change', op: 'below', value: 99 }],
            need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '(OOC)', script: '',
        };
        withRules(reroll, scriptRule());
        setChat('a', [user('u0'), narrator('c0')]);
        const right = context.swipe.right;
        context.swipe.right = async () => {
            swipes.push(chatId);
            const reply = context.chat.at(-1);
            reply.swipes = [reply.mes, 'another'];
            reply.swipe_id = 1;
            reply.mes = 'another';
            invalidateMeasured();
            await arrive(1);
        };
        try {
            onCharacterMessage(1, 'normal');
            await settle(60);
        } finally {
            context.swipe.right = right;
        }

        assert.deepEqual(swipes, ['a']);
        assert.deepEqual(ran, ['/echo shot']);
        assert.deepEqual(
            fired(context.chat[0]).filter(entry => entry.action === 'script').map(entry => entry.reply),
            [hashText('another')],
        );
    });

    it('runs for the second member of a group, because the host waits for the first', async () => {
        withRules(scriptRule({ script: '/echo member' }));
        context.groupId = 'group';
        setChat('a', [user('u0')]);
        try {
            context.chat.push(narrator('c0'));
            const first = onCharacterMessage(1, 'normal');
            assert.ok(first && typeof first.then === 'function', 'the host is handed a promise to wait for');
            await first;

            context.chat.push(narrator('c1'));
            invalidateMeasured();
            await onCharacterMessage(2, 'normal');
        } finally {
            context.groupId = null;
        }

        assert.deepEqual(ran, ['/echo member', '/echo member']);
        assert.deepEqual(fired(context.chat[0]).map(entry => entry.reply), [hashText('c0'), hashText('c1')]);
    });

    it('hands the host no promise outside a group chat', async () => {
        withRules(scriptRule());
        setChat('a', [user('u0'), narrator('c0')]);
        assert.equal(onCharacterMessage(1, 'normal'), undefined);
        await settle();
        assert.deepEqual(ran, ['/echo shot']);
    });

    it('counts its cooldown from the reply it last fired on, and replay agrees', async () => {
        const rule = scriptRule({ cooldown: 3 });
        withRules(rule);
        context.groupId = 'group';
        setChat('a', [user('u0')]);
        try {
            for (let member = 0; member < 6; member++) {
                context.chat.push(narrator(`c${member}`));
                invalidateMeasured();
                await onCharacterMessage(context.chat.length - 1, 'normal');
            }
        } finally {
            context.groupId = null;
        }

        const live = fired(context.chat[0]).map(entry => entry.at);
        assert.deepEqual(live, [0, 2, 4]);

        const preset = getSettings().presets.Director;
        const replayed = replayRule({
            history: getHistory(context.chat, context.chat.length, 'reply', preset.sensors),
            rule,
            sensorIds: preset.sensors.map(sensor => sensor.id),
            sensors: preset.sensors,
        }).map(turn => turn.index - 1);
        assert.deepEqual(replayed, live);
    });

    it('skips a reply that has no message before it', async () => {
        withRules(scriptRule());
        setChat('a', [narrator('greeting')]);
        await arrive(0);
        assert.deepEqual(ran, []);
    });

    it('runs no script on a rescan or after an edit', async () => {
        withRules(scriptRule());
        setChat('a', [user('u0'), narrator('c0')]);
        await rescan(planMeasurement({ all: true }).tasks);
        assert.deepEqual(ran, []);
        assert.deepEqual(fired(context.chat[0]), []);

        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            context.chat[1].mes = 'edited reply';
            onMessageEdited(1);
            mock.timers.tick(2000);
        } finally {
            mock.timers.reset();
        }
        await settle();
        assert.deepEqual(ran, []);
        assert.deepEqual(fired(context.chat[0]), []);
    });

    it('adds no instruction text to the next generation', async () => {
        withRules(scriptRule());
        setChat('a', [user('u0'), narrator('c0')]);
        await arrive(1);

        context.chat.push(user('u1'));
        const copy = context.chat.map(message => ({ ...message }));
        await interceptGeneration(copy, 0, null, 'normal');
        assert.equal(copy[2].mes, 'u1');
    });
});

describe('a manual call', () => {
    const request = { state: { latest_turn: 'x' }, questions: { probe: { type: 'noul', question: 'q', levels: [], options: [] } } };

    it('goes out while the chat is paused, and stays blocked with no key', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        context.chatMetadata.jeved_muted = true;
        await assert.rejects(() => call(request), /paused/);

        const result = await call(request, undefined, { manual: true });
        assert.equal(result.scores.probe, 0.5);
        assert.equal(seen.length, 1);

        getSettings().apiKey = '';
        await assert.rejects(() => call(request, undefined, { manual: true }), /No API key/);
    });
});

describe('the history stamp a live Preview watches', () => {
    it('moves when a score lands and when the chat grows', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const before = historyStamp();
        await rescan(planMeasurement({ all: true }).tasks);
        const measured = historyStamp();
        assert.notEqual(measured, before);

        context.chat.push(user('u1'));
        assert.notEqual(historyStamp(), measured);
    });
});

describe('the measured count', () => {
    const everyAnswer = () => ({ tension: 2, cost: 2, speaks: 2, attention: 2, repeats: 2, tone: 2 });

    it('is held until something invalidates it', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(measuredCount(), 1);

        const extra = narrator('c1');
        writeScores(extra, everyAnswer());
        context.chat.push(user('u1'), extra);
        assert.equal(measuredCount(), 1);

        invalidateMeasured();
        assert.equal(measuredCount(), 2);
    });

    it('counts again when the preset asks for another sensor', async () => {
        const preset = getSettings().presets.Director;
        setChat('a', [user('u0'), narrator('c0')]);
        writeScores(context.chat[1], everyAnswer());
        invalidateMeasured();
        assert.equal(measuredCount(), 1);

        preset.sensors.find(sensor => sensor.id === 'world').watch = true;
        assert.equal(measuredCount(), 0);
    });

    it('counts only a message that has every answer its moment needs', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        writeScores(context.chat[1], { tension: 2, cost: 2 });
        invalidateMeasured();
        assert.equal(measuredCount(), 0);

        writeScores(context.chat[1], { speaks: 2, attention: 2, repeats: 2, tone: 2 });
        invalidateMeasured();
        assert.equal(measuredCount(), 1);
    });

    it('counts a reply again after it is measured', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        assert.equal(measuredCount(), 0);
        await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(measuredCount(), 1);
        assert.ok(targetAt(1));
    });
});
