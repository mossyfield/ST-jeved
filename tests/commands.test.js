import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { installDom } from './helpers/dom.js';
import { hostStub } from './helpers/host.js';

let chatId = 'a';
let popupAnswer = 0;
const toasts = [];

const context = hostStub({
    getCurrentChatId: () => chatId,
    callGenericPopup: async () => popupAnswer,
});

installDom();
globalThis.toastr = {
    info: message => toasts.push(['info', message]),
    error: message => toasts.push(['error', message]),
    success: message => toasts.push(['success', message]),
    warning: message => toasts.push(['warning', message]),
};

let gate = null;
globalThis.fetch = async (_url, options) => {
    if (gate) {
        await gate;
    }
    const ids = Object.keys(JSON.parse(options.body).questions);
    return {
        ok: true,
        status: 200,
        json: async () => ({ answers: Object.fromEntries(ids.map(id => [id, { score: 1 }])), usage: { cost: 0 } }),
    };
};

const { jevedCleanUp } = await import('../index.js');
const { forcedRule, isPaused, isRescanning, planMeasurement, rescan } = await import('../src/engine.js');
const { getSettings } = await import('../src/settings.js');

const command = name => context.commands.find(item => item.name === name);
const user = mes => ({ mes, is_user: true });
const narrator = mes => ({ mes });

beforeEach(() => {
    chatId = 'a';
    popupAnswer = 0;
    toasts.length = 0;
    gate = null;
    context.chatMetadata = {};
    const settings = getSettings();
    settings.enabled = true;
    settings.apiKey = 'k';
    context.chat = [user('u0'), narrator('c0')];
});

describe('the commands Jeved registers', () => {
    it('registers one callback per command', () => {
        assert.deepEqual(
            context.commands.map(item => item.name).sort(),
            ['jeved', 'jeved-nudge', 'jeved-pause', 'jeved-rescan'],
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
        await new Promise(resolve => setTimeout(resolve, 5));
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
        assert.deepEqual(toasts.at(-1), ['info', 'Every recent reply is already measured.']);
    });

    it('measures nothing when you decline the cost', async () => {
        popupAnswer = 0;
        assert.equal(await run({ count: 20 }), '0');
        assert.equal(toasts.length, 0);
    });

    it('measures and reports the count when you accept', async () => {
        popupAnswer = 1;
        assert.equal(await run({ count: 20 }), '1');
        assert.deepEqual(toasts.at(-1), ['success', 'Measured 1 reply.']);
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
