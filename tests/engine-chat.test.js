import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { hostStub } from './helpers/host.js';

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
const { chatPreset, clearChatScores, evaluationContext, historyStamp, interceptGeneration, invalidateMeasured, measureBlockReason, measuredCount, onCharacterMessage, onChatChanged, planMeasurement, rescan, status, targetAt, testConnection, testSensor } = engine;
const { rescanSentence } = await import('../src/describe.js');
const { explain } = await import('../src/rules.js');
const { buildContext } = await import('../src/instructions.js');
const { carryForwardIds } = await import('../src/sensors.js');
const { getSettings, initSettings } = await import('../src/settings.js');
const { getHistory, getScores, writeDecision, writeScores } = await import('../src/store.js');

let gate = null;
function hold() {
    let open = null;
    const wait = new Promise(resolve => { open = resolve; });
    gate = { wait, open };
    return gate;
}

let breakOn = '';
let breakStatus = 500;

globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    const ids = Object.keys(body.questions);
    seen.push({ chatId, ids, state: body.state, questions: body.questions });
    if (gate) {
        await gate.wait;
    }
    if (breakOn && ids.includes(breakOn)) {
        return { ok: false, status: breakStatus, json: async () => ({ error: { message: 'the endpoint broke' } }) };
    }
    const answers = {};
    for (const id of ids) {
        answers[id] = { score: 1 };
    }
    return { ok: true, status: 200, json: async () => ({ answers, usage: { cost: 0 } }) };
};

const user = mes => ({ mes, is_user: true });
const narrator = mes => ({ mes });

function setChat(id, messages) {
    chatId = id;
    context.chat = messages;
    context.chatMetadata = {};
    invalidateMeasured();
}

beforeEach(() => {
    context.extensionSettings = {};
    initSettings();
    const settings = getSettings();
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
        await new Promise(resolve => setTimeout(resolve, 10));

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
        await new Promise(resolve => setTimeout(resolve, 10));

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
        assert.equal(full.calls, 4);

        await rescan(full.tasks);
        assert.equal(planMeasurement().calls, 0);

        const preset = getSettings().presets.Director;
        preset.sensors.push({
            id: 'pace', label: 'Pace', watch: true, turns: 1, includeContext: false, includeUser: true, measureEvery: 1,
            question: 'How fast is `latest_turn`?', levels: ['a', 'b', 'c', 'd', 'e'],
        });

        const topUp = planMeasurement({ sensorId: 'pace' });
        assert.equal(topUp.calls, 2);
        seen.length = 0;
        await rescan(topUp.tasks);
        assert.deepEqual(seen.map(call => call.ids), [['pace'], ['pace']]);
    });

    it('plans nothing for a chat with no replies', () => {
        setChat('a', [user('only me')]);
        assert.deepEqual(planMeasurement({ all: true }), { tasks: [], calls: 0 });
    });

    it('makes exactly as many calls as it planned, live and on a rescan', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        onCharacterMessage(1, 'normal');
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(seen.length, 2);

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
        assert.deepEqual(seen.map(one => one.ids).sort(), [['change', 'tension'], ['tone']]);
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
        assert.deepEqual(Object.keys(stored).sort(), ['change', 'tension']);
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
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(seen.some(one => one.ids.includes('change')), JSON.stringify(seen.map(one => one.ids)));
    });
});

describe('what a rescan reports', () => {
    it('counts a rejected key as a failure, not as a measured reply', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        breakOn = 'change';
        breakStatus = 401;
        const plan = planMeasurement({ sensorId: 'change' });
        assert.equal(plan.calls, 2);

        const counts = await rescan(plan.tasks);
        assert.deepEqual(counts, { measured: 0, failed: 2, skipped: 0, total: 2 });
        assert.equal(measuredCount(), 0);
        assert.equal(engine.lastErrorKind(), 'key');
        assert.equal(rescanSentence(counts), 'Nothing was measured, because 2 replies failed.');
    });

    it('counts the call that worked beside the one that did not', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        breakOn = 'tone';
        const counts = await rescan(planMeasurement({ all: true }).tasks);
        assert.deepEqual(counts, { measured: 0, failed: 1, skipped: 0, total: 1 });
        assert.deepEqual(Object.keys(getScores(context.chat[1]).scores).sort(), ['change', 'tension']);
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
        const withoutContext = seen.find(one => one.ids.includes('change'));
        assert.deepEqual(withContext.state.context, shown.context);
        assert.deepEqual(shown.context, { main_prompt: 's', description: 'd' });
        assert.equal(withoutContext.state.context, undefined);
        assert.equal(withoutContext.state.latest_turn, 'c0');
        assert.equal(withContext.state.latest_turns, 'c0');
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
        await new Promise(resolve => setTimeout(resolve, 10));

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
        await new Promise(resolve => setTimeout(resolve, 10));

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
        await new Promise(resolve => setTimeout(resolve, 5));
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
        await new Promise(resolve => setTimeout(resolve, 5));
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
});

describe('carried scores', () => {
    it('carries a story score over a reply that has none, and never carries for a reroll', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        const preset = getSettings().presets.Director;
        await rescan(planMeasurement({ all: true }).tasks);
        delete context.chat[3].extra.jeved.scores.tone;

        const carried = getHistory(context.chat, 5, carryForwardIds(preset));
        assert.equal(carried.at(-1).scores.tone, 1);
        assert.equal(carried.at(-1).own.tone, undefined);

        const own = getHistory(context.chat, 5);
        assert.equal(own.at(-1).scores.tone, undefined);
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
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.ok(getScores(context.chat[5]), 'the new reply was measured');
        assert.equal(chatPreset(), 'Director');
    });

    it('does not let a score that was in flight come back after Clear', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        hold();
        const running = rescan(planMeasurement({ all: true }).tasks);
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(seen.length, 'the scan had started');

        clearChatScores();
        gate.open();
        await running;
        await new Promise(resolve => setTimeout(resolve, 5));

        assert.equal(getScores(context.chat[1]), null);
        assert.equal(measuredCount(), 0);
    });

    it('keeps a replacement measurement when the one it replaced lands late', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        const stale = hold();
        onCharacterMessage(1, 'normal');
        await new Promise(resolve => setTimeout(resolve, 5));

        clearChatScores();
        const fresh = hold();
        onCharacterMessage(1, 'normal');
        await new Promise(resolve => setTimeout(resolve, 5));
        const sent = seen.length;

        stale.open();
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(status().text, 'Measuring', 'the replacement was still counted as in flight');

        onCharacterMessage(1, 'normal');
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(seen.length, sent, 'the replacement was reused instead of asked again');

        fresh.open();
        await new Promise(resolve => setTimeout(resolve, 10));
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
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(seen.length, 'the call had gone out');

        engine.setPaused(true);
        gate.open();
        await new Promise(resolve => setTimeout(resolve, 10));

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
    it('reads the gap, the cooldown and the carried history from one chat', async () => {
        const preset = getSettings().presets.Director;
        preset.rules.find(rule => rule.id === 'drift').cooldown = 5;
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        await rescan(planMeasurement({ all: true }).tasks);
        writeDecision(context.chat[2], { fired: [{ rule: 'drift', action: 'nudge', reason: 'r', text: 't' }] });

        const built = evaluationContext(context.chat, preset);
        assert.equal(built.gap, preset.gap);
        assert.equal(built.maxNudges, preset.maxNudges);
        assert.deepEqual(built.sensorIds, preset.sensors.map(sensor => sensor.id));
        assert.equal(built.sinceAnyNudge, 1);
        assert.equal(built.sinceRule('drift'), 1);
        assert.deepEqual(built.history.map(entry => entry.index), [1, 3]);
        assert.equal(typeof built.history[1].scores.tone, 'number');
    });

    it('looks back as far as the widest window of the rules that are on', () => {
        const preset = getSettings().presets.Director;
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1'), user('u2'), narrator('c2')]);
        for (const rule of preset.rules) {
            rule.enabled = rule.id === 'flat';
            rule.window = 2;
        }
        assert.deepEqual(evaluationContext(context.chat, preset).history.map(entry => entry.index), [3, 5]);
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
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.deepEqual(seen.map(one => one.ids).sort(), [['change', 'tension'], ['tone']]);
    });

    it('sends the wording a task was planned with, even when the sensor is edited mid-scan', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1'), user('u2'), narrator('c2')]);
        const preset = getSettings().presets.Director;
        const plan = planMeasurement({ all: true });
        hold();
        const running = rescan(plan.tasks);
        await Promise.resolve();

        const change = preset.sensors.find(sensor => sensor.id === 'change');
        change.turns = 3;
        change.question = 'How much changes in `latest_turns`?';

        gate.open();
        await running;

        const asked = seen.filter(one => one.ids.includes('change'));
        assert.equal(asked.length, 3);
        for (const call of asked) {
            assert.equal(call.questions.change.instructions, 'How much does the situation change in `latest_turn`?');
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

describe('the history a reroll reads', () => {
    it('leaves carried scores out, so the list and the engine agree', async () => {
        setChat('a', [user('u0'), narrator('c0'), user('u1'), narrator('c1')]);
        const preset = getSettings().presets.Director;
        await rescan(planMeasurement({ all: true }).tasks);
        delete context.chat[3].extra.jeved.scores.tone;

        const built = evaluationContext(context.chat, preset);
        assert.equal(built.history.at(-1).scores.tone, 1);
        assert.equal(built.historyFor('nudge'), built.history);
        assert.equal(built.historyFor('swipe').at(-1).scores.tone, undefined);

        const rule = {
            id: 'r', label: 'R', enabled: true, action: 'swipe',
            conditions: [{ sensor: 'tone', op: 'below', value: 2 }],
            need: 1, window: 1, skipWhen: null, cooldown: 0, directive: '', script: '',
        };
        const seeing = action => explain(rule, { ...built, history: built.historyFor(action) }).text;
        assert.equal(seeing('nudge'), 'Fires next turn');
        assert.equal(seeing('swipe'), 'Needs 1 more reply');
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
    it('is held until something invalidates it', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(measuredCount(), 1);

        const extra = narrator('c1');
        writeScores(extra, { change: 2 });
        context.chat.push(user('u1'), extra);
        assert.equal(measuredCount(), 1);

        invalidateMeasured();
        assert.equal(measuredCount(), 2);
    });

    it('counts a reply again after it is measured', async () => {
        setChat('a', [user('u0'), narrator('c0')]);
        assert.equal(measuredCount(), 0);
        await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(measuredCount(), 1);
        assert.ok(targetAt(1));
    });
});
