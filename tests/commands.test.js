import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { narrator, user } from './helpers/chat.js';
import { installDom } from './helpers/dom.js';
import { hostStub } from './helpers/host.js';
import { settle } from './helpers/settle.js';

let chatId = 'a';
let popupAnswer = 0;
const toasts = [];
const asked = [];

const context = hostStub({
    getCurrentChatId: () => chatId,
    callGenericPopup: async body => {
        asked.push(body?.childNodes?.[0]?.textContent ?? String(body ?? ''));
        return popupAnswer;
    },
});

installDom();
globalThis.toastr = {
    info: message => toasts.push(['info', message]),
    error: message => toasts.push(['error', message]),
    success: message => toasts.push(['success', message]),
    warning: message => toasts.push(['warning', message]),
};

let gate = null;
const sent = [];
let broken = false;

globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    if (gate) {
        await gate;
    }
    if (broken) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'the endpoint broke' } }) };
    }
    const answers = {};
    for (const [id, question] of Object.entries(body.questions)) {
        if (question.type === 'choice') {
            answers[id] = { choice: Object.keys(question.criteria)[0] };
        } else if (question.type === 'noul') {
            answers[id] = { noul: 0.85 };
        } else {
            answers[id] = { score: 1 };
        }
    }
    return { ok: true, status: 200, json: async () => ({ answers, usage: { cost: 0 } }) };
};

const { jevedCleanUp } = await import('../index.js');
const { forcedRule, isPaused, isRescanning, planMeasurement, rescan } = await import('../src/engine.js');
const { getSettings } = await import('../src/settings.js');
const { writeScores } = await import('../src/store.js');

const command = name => context.commands.find(item => item.name === name);

beforeEach(() => {
    chatId = 'a';
    popupAnswer = 0;
    toasts.length = 0;
    asked.length = 0;
    gate = null;
    broken = false;
    sent.length = 0;
    context.chatMetadata = {};
    const settings = getSettings();
    settings.enabled = true;
    settings.apiKey = 'k';
    settings.activePreset = 'Director';
    for (const rule of settings.presets.Director.rules) {
        rule.enabled = rule.enabled && !rule.id.startsWith('scene_');
    }
    context.chat = [user('u0'), narrator('c0')];
});

describe('the commands Jeved registers', () => {
    it('registers one callback per command', () => {
        assert.deepEqual(
            context.commands.map(item => item.name).sort(),
            ['jeved', 'jeved-ask', 'jeved-get', 'jeved-nudge', 'jeved-pause', 'jeved-rescan'],
        );
    });

    it('opens the workspace on the tab it was given', () => {
        assert.equal(command('jeved').callback({}, 'Sensors'), 'sensors');
        assert.equal(command('jeved').callback({}, ''), 'rules');
    });
});

describe('/jeved-pause', () => {
    const pause = (...args) => command('jeved-pause').callback(...args);

    it('pauses and starts the chat again', () => {
        assert.equal(pause({}, 'on'), 'true');
        assert.equal(isPaused(), true);
        assert.equal(pause({}, 'off'), 'false');
        assert.equal(isPaused(), false);
    });

    it('pauses when no word is given', () => {
        assert.equal(pause({}, undefined), 'true');
        assert.equal(isPaused(), true);
    });

    it('refuses a word it does not know, and changes nothing', () => {
        assert.throws(() => pause({}, 'maybe'), /jeved-pause on or \/jeved-pause off/);
        assert.equal(isPaused(), false);
    });
});

describe('/jeved-nudge', () => {
    const nudge = args => command('jeved-nudge').callback(args);

    it('forces a rule that exists', () => {
        assert.equal(nudge({ rule: 'drift' }), 'drift');
        assert.equal(forcedRule(), 'drift');
        assert.deepEqual(toasts.at(-1), ['info', 'Jeved will add the drift instruction to your next message.']);
    });

    it('refuses a rule id it does not know and forces nothing', () => {
        assert.equal(nudge({ rule: 'drift' }), 'drift');
        assert.throws(() => nudge({ rule: 'nope' }), /No rule is named nope\./);
        assert.throws(() => nudge({}), /No rule is named \./);
        assert.equal(forcedRule(), 'drift');
    });
});

describe('/jeved-rescan', () => {
    const run = args => command('jeved-rescan').callback(args);

    it('refuses while the chat is paused', async () => {
        context.chatMetadata.jeved_muted = true;
        await assert.rejects(() => run({}), /paused/);
    });

    it('stops a scan that is already running instead of starting another', async () => {
        let open = null;
        gate = new Promise(resolve => { open = resolve; });
        const running = rescan(planMeasurement({ all: true }).tasks);
        await settle();
        assert.equal(isRescanning(), true);

        assert.equal(await run({}), '0');
        assert.deepEqual(toasts.at(-1), ['info', 'Rescan stopped.']);

        open();
        await running;
        assert.equal(isRescanning(), false);
    });

    it('says so when every recent reply already has its scores', async () => {
        await rescan(planMeasurement({ all: true }).tasks);
        assert.equal(await run({ count: 20 }), '0');
        assert.deepEqual(toasts.at(-1), ['info', 'Every recent message is already measured.']);
    });

    it('measures nothing when you decline the cost', async () => {
        popupAnswer = 0;
        assert.equal(await run({ count: 20 }), '0');
        assert.equal(toasts.length, 0);
    });

    it('measures and reports the count when you accept', async () => {
        popupAnswer = 1;
        assert.equal(await run({ count: 20 }), '1');
        assert.deepEqual(toasts.at(-1), ['success', 'Measured 1 message.']);
        assert.match(asked.at(-1), /^Measure 1 message\? That costs \d+ API calls\.$/);
    });

    it('counts your messages beside the replies and calls them messages', async () => {
        getSettings().presets.Director.sensors.push({
            id: 'beat', label: 'Beat', watch: true, type: 'choice', user: 1, assistant: 0, context: false,
            question: 'Which scene?', levels: [],
            options: [{ name: 'combat', description: '' }, { name: 'talk', description: '' }],
        });
        popupAnswer = 1;
        assert.equal(await run({ count: 20 }), '2');
        assert.deepEqual(toasts.at(-1), ['success', 'Measured 2 messages.']);
        assert.match(asked.at(-1), /^Measure 2 messages\? That costs \d+ API calls\.$/);
    });
});

describe('/jeved-get', () => {
    const get = value => command('jeved-get').callback({}, value);

    it('makes no API call', () => {
        writeScores(context.chat[1], { change: 1 });
        assert.equal(get('change'), '1.0');
        assert.deepEqual(sent, []);
    });
});

describe('/jeved-ask', () => {
    const ask = (args, question) => command('jeved-ask').callback(args, question);

    it('asks about the newest reply and returns a noul answer as whole percents', async () => {
        assert.equal(await ask({}, 'The reply ends a scene.'), '85');
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].state, { latest_turn: 'c0' });
        assert.equal(sent[0].questions.ask.type, 'noul');
    });

    it('asks about your newest message when assistant is 0', async () => {
        context.chat.push(user('u1'));
        assert.equal(await ask({ assistant: 0, user: 1 }, 'The player asks for a fight.'), '85');
        assert.deepEqual(sent[0].state, { player_message: 'u1' });
    });

    it('sends both speakers when user and assistant are both set', async () => {
        context.chat = [user('u0'), narrator('c0'), user('u1'), narrator('c1')];
        await ask({ user: 1, assistant: 1 }, 'The reply answers the player.');
        assert.deepEqual(sent[0].state, { latest_turn: 'c1', player_message: 'u1' });
    });

    it('works while the chat is paused, and while Jeved is turned off', async () => {
        context.chatMetadata.jeved_muted = true;
        assert.equal(await ask({}, 'The reply ends a scene.'), '85');
        assert.equal(sent.length, 1);

        context.chatMetadata.jeved_muted = false;
        getSettings().enabled = false;
        assert.equal(await ask({}, 'The reply ends a scene.'), '85');
        assert.equal(sent.length, 2);
    });

    it('is named as the exception in the pause help', () => {
        assert.match(
            command('jeved-pause').helpString,
            /\/jeved-ask is a manual command and sends its one call in any case\./,
        );
    });

    it('works while another measurement is pending', async () => {
        let open = null;
        gate = new Promise(resolve => { open = resolve; });
        const running = rescan(planMeasurement({ all: true }).tasks);
        await settle();

        const asking = ask({}, 'The reply ends a scene.');
        open();
        assert.equal(await asking, '85');
        await running;
    });

    it('says why and makes no call when the chat has no message of that kind', async () => {
        context.chat = [user('u0')];
        assert.equal(await ask({}, 'The reply ends a scene.'), '');
        assert.deepEqual(toasts.at(-1), ['error', 'This chat has no reply to ask about.']);

        context.chat = [narrator('c0')];
        assert.equal(await ask({ assistant: 0, user: 1 }, 'The player asks for a fight.'), '');
        assert.deepEqual(toasts.at(-1), ['error', 'This chat has no message to ask about.']);
        assert.deepEqual(sent, []);
    });

    it('refuses a type it does not know and a question that reads nothing', async () => {
        assert.equal(await ask({ type: 'vibe' }, 'Anything?'), '');
        assert.match(toasts.at(-1)[1], /The type must be score, choice, noul\./);

        assert.equal(await ask({ user: 0, assistant: 0 }, 'Anything?'), '');
        assert.deepEqual(toasts.at(-1), ['error', 'Pick at least one message.']);
        assert.deepEqual(sent, []);
    });

    it('refuses a scale or an option list the type cannot use', async () => {
        assert.equal(await ask({ type: 'score' }, 'How tense is it?'), '');
        assert.match(toasts.at(-1)[1], /two score descriptions/);

        assert.equal(await ask({ type: 'choice', options: 'calm' }, 'Which mood fits?'), '');
        assert.match(toasts.at(-1)[1], /two options/);
        assert.deepEqual(sent, []);
    });

    it('returns an empty text with no key and when the call fails', async () => {
        getSettings().apiKey = '';
        assert.equal(await ask({}, 'The reply ends a scene.'), '');
        assert.deepEqual(toasts.at(-1), ['error', 'No API key is set.']);

        getSettings().apiKey = 'k';
        broken = true;
        assert.equal(await ask({}, 'The reply ends a scene.'), '');
        assert.match(toasts.at(-1)[1], /broke/);
    });

    it('stores nothing on the message it asked about', async () => {
        await ask({}, 'The reply ends a scene.');
        assert.equal(context.chat[1].extra, undefined);
    });
});

describe('jevedCleanUp', () => {
    it('takes the settings away and saves, and leaves other extensions alone', () => {
        context.extensionSettings.other = { keep: true };
        const before = context.saveCount;
        jevedCleanUp();
        assert.equal(context.extensionSettings.jeved, undefined);
        assert.deepEqual(context.extensionSettings.other, { keep: true });
        assert.equal(context.saveCount, before + 1);
    });
});
