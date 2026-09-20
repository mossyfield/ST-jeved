import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runReroll } from '../src/reroll.js';
import { firedRule } from '../src/store.js';

const rule = { id: 'long', label: 'Too long', action: 'swipe', directive: '(OOC: keep it short.)' };

function fake(overrides = {}) {
    const world = {
        chatId: 'chat',
        active: true,
        last: true,
        lastSwipe: true,
        swipes: 1,
        swipeId: 0,
        hash: 'h1',
        typed: false,
        allowedAfter: 0,
        addsSwipe: true,
        ticks: 0,
        saves: 0,
        scripts: 0,
        entries: [],
        reports: [],
        scores: {},
        onTick: null,
        ...overrides,
    };
    const host = {
        isGroup: !!world.isGroup,
        isActive: () => world.active,
        getChatId: () => world.chatId,
        isLast: () => world.last,
        onLastSwipe: () => world.lastSwipe,
        hasSwipeEntry: () => world.entries.some(entry => entry.action === 'swipe'),
        hash: () => world.hash,
        swipeId: () => world.swipeId,
        swipeCount: () => world.swipes,
        evaluate: () => (world.hits ?? [{ rule, reason: 'reason' }]),
        scores: () => world.scores,
        addFired: entry => world.entries.push(entry),
        markSwipe: (id, swipe) => {
            const entry = world.entries.find(item => item.rule === id);
            if (entry) {
                entry.swipe = swipe;
            }
        },
        stripText: id => {
            const entry = world.entries.find(item => item.rule === id);
            if (entry) {
                delete entry.text;
            }
        },
        save: () => { world.saves++; },
        runScript: async () => {
            world.scripts++;
            world.onScript?.(world);
        },
        isAllowed: () => world.ticks >= world.allowedAfter,
        swipeRight: async () => {
            if (world.throwOnSwipe) {
                throw new Error('the host refused');
            }
            if (world.addsSwipe) {
                world.swipes++;
                world.swipeId++;
            }
        },
        inputHasText: () => world.typed,
        sleep: async () => {
            world.ticks++;
            world.onTick?.(world);
        },
        report: result => world.reports.push(result),
    };
    return { host, world };
}

const entryOf = world => world.entries.find(entry => entry.rule === rule.id);

function assertCleanedUp(world) {
    assert.equal(world.entries.length, 1);
    assert.equal(entryOf(world).text, undefined);
    assert.equal(entryOf(world).action, 'swipe');
    assert.equal(firedRule(rule.id)({ fired: world.entries }), true);
}

describe('runReroll', () => {
    it('adds the entry, runs the script and swipes once', async () => {
        const { host, world } = fake();
        const result = await runReroll(host);
        assert.equal(result.status, 'done');
        assert.equal(world.swipes, 2);
        assert.equal(world.scripts, 1);
        assert.equal(entryOf(world).text, rule.directive);
        assert.deepEqual(world.reports.map(report => report.status), ['started', 'done']);
    });

    it('records the swipe it made and the scores that caused it', async () => {
        const { host, world } = fake({ scores: { tension: 0.5, change: 1 } });
        const result = await runReroll(host);
        assert.equal(result.status, 'done');
        assert.equal(entryOf(world).swipe, 1);
        assert.deepEqual(entryOf(world).scores, { tension: 0.5, change: 1 });
    });

    it('records no swipe index when the reroll fails', async () => {
        const { host, world } = fake({ addsSwipe: false });
        assert.equal((await runReroll(host)).status, 'failed');
        assert.equal(entryOf(world).swipe, undefined);
    });

    it('stores no scores when there are none', async () => {
        const { host, world } = fake();
        await runReroll(host);
        assert.equal(entryOf(world).scores, undefined);
    });

    it('does not reroll a reply when the turn already has one', async () => {
        const { host, world } = fake({ entries: [{ rule: 'long', action: 'swipe', reason: 'r' }] });
        assert.equal((await runReroll(host)).status, 'skipped');
        assert.equal(world.swipes, 1);
        assert.equal(world.reports.length, 0);
    });

    it('does nothing in a group chat, on an older reply, or when the reply is not on its last swipe', async () => {
        for (const broken of [{ isGroup: true }, { last: false }, { lastSwipe: false }]) {
            const { host, world } = fake(broken);
            assert.equal((await runReroll(host)).status, 'skipped');
            assert.equal(world.entries.length, 0);
        }
    });

    it('does nothing when no swipe rule matches', async () => {
        const { host, world } = fake({ hits: [] });
        assert.equal((await runReroll(host)).status, 'none');
        assert.equal(world.entries.length, 0);
        assert.equal(world.saves, 0);
    });

    it('gives up when SillyTavern stays busy', async () => {
        const { host, world } = fake({ allowedAfter: Infinity });
        const result = await runReroll(host);
        assert.equal(result.status, 'timeout');
        assert.ok(world.ticks > 1, 'it polled while it waited');
        assert.ok(Number.isFinite(world.ticks), 'it stopped polling instead of waiting for ever');
        assert.equal(world.swipes, 1);
        assertCleanedUp(world);
    });

    it('stops when the user starts typing', async () => {
        const { host, world } = fake({ allowedAfter: 5, onTick: state => { state.typed = state.ticks >= 2; } });
        const result = await runReroll(host);
        assert.equal(result.status, 'cancelled');
        assert.equal(result.detail, 'you started typing');
        assert.equal(world.swipes, 1);
        assertCleanedUp(world);
    });

    it('stops when the reply text changes while it waits', async () => {
        const { host, world } = fake({ allowedAfter: 5, onTick: state => { state.hash = 'h2'; } });
        const result = await runReroll(host);
        assert.equal(result.detail, 'the reply text changed');
        assertCleanedUp(world);
    });

    it('stops when the host swipes first', async () => {
        const { host, world } = fake({ allowedAfter: 5, onTick: state => { state.swipeId = 1; } });
        const result = await runReroll(host);
        assert.equal(result.detail, 'the reply was swiped');
        assertCleanedUp(world);
    });

    it('stops when the reply is deleted while it waits', async () => {
        const { host, world } = fake({ allowedAfter: 5, onTick: state => { state.last = false; } });
        const result = await runReroll(host);
        assert.equal(result.detail, 'the reply is no longer the last message');
        assertCleanedUp(world);
    });

    it('stops without throwing when the user message is gone too', async () => {
        const { host, world } = fake({ allowedAfter: 5, onTick: state => { state.last = false; } });
        host.stripText = () => {};
        const result = await runReroll(host);
        assert.equal(result.status, 'cancelled');
        assert.equal(world.saves, 2);
    });

    it('stops without swiping when the chat is paused while it waits', async () => {
        const { host, world } = fake({ allowedAfter: 5, onTick: state => { state.active = false; } });
        const result = await runReroll(host);
        assert.equal(result.status, 'cancelled');
        assert.equal(result.detail, 'Jeved stopped measuring this chat');
        assert.equal(world.swipes, 1);
        assertCleanedUp(world);
    });

    it('stops when the chat changes while it waits', async () => {
        const { host, world } = fake({ allowedAfter: 5, onTick: state => { state.chatId = 'other'; } });
        assert.equal((await runReroll(host)).detail, 'the chat changed');
        assertCleanedUp(world);
    });

    it('reports a failure when the host adds no alternative', async () => {
        const { host, world } = fake({ addsSwipe: false });
        const result = await runReroll(host);
        assert.equal(result.status, 'failed');
        assert.equal(result.detail, 'SillyTavern did not add an alternative');
        assertCleanedUp(world);
    });

    it('reports a failure when the swipe call throws', async () => {
        const { host, world } = fake({ throwOnSwipe: true });
        const result = await runReroll(host);
        assert.equal(result.status, 'failed');
        assert.equal(result.detail, 'the host refused');
        assertCleanedUp(world);
    });

    it('stops when the reply is edited while the script runs', async () => {
        const { host, world } = fake({ onScript: state => { state.hash = 'h2'; } });
        const result = await runReroll(host);
        assert.equal(result.status, 'cancelled');
        assert.equal(result.detail, 'the reply text changed');
        assert.equal(world.swipes, 1);
        assert.equal(world.ticks, 0);
        assertCleanedUp(world);
    });

    it('stops when the chat changes or the reply is swiped while the script runs', async () => {
        for (const [change, detail] of [
            [state => { state.chatId = 'other'; }, 'the chat changed'],
            [state => { state.swipeId = 3; }, 'the reply was swiped'],
            [state => { state.last = false; }, 'the reply is no longer the last message'],
        ]) {
            const { host, world } = fake({ onScript: change });
            assert.equal((await runReroll(host)).detail, detail);
            assert.equal(world.swipes, 1);
        }
    });

    it('waits until SillyTavern is free before it swipes', async () => {
        const { host, world } = fake({ allowedAfter: 3 });
        const result = await runReroll(host);
        assert.equal(result.status, 'done');
        assert.equal(world.ticks, 3);
        assert.equal(world.swipes, 2);
    });
});
