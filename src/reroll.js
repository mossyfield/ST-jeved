import { REROLL } from './actions.js';
import { MAX_WAIT_MS, POLL_MS } from './limits.js';

const NOT_STARTED = ['skipped', 'none'];

export function rerollStarted(status) {
    return !NOT_STARTED.includes(String(status ?? ''));
}

function cancelReason(host, start) {
    if (!host.isActive()) {
        return 'Jeved stopped measuring this chat';
    }
    if (host.getChatId() !== start.chatId) {
        return 'the chat changed';
    }
    if (!host.isLast()) {
        return 'the reply is no longer the last message';
    }
    if (host.hash() !== start.hash) {
        return 'the reply text changed';
    }
    if (host.swipeId() !== start.swipeId) {
        return 'the reply was swiped';
    }
    if (host.inputHasText()) {
        return 'you started typing';
    }
    return '';
}

export async function runReroll(host) {
    if (!host.isLast() || !host.onLastSwipe() || host.hasSwipeEntry()) {
        return { status: 'skipped' };
    }
    const hits = host.evaluate();
    if (!hits.length) {
        return { status: 'none' };
    }

    const start = { chatId: host.getChatId(), hash: host.hash(), swipeId: host.swipeId() };
    const { rule, reason } = hits[0];
    const entry = { rule: rule.id, action: REROLL, reason };
    if (String(rule.directive ?? '').trim()) {
        entry.text = rule.directive;
    }
    const scores = host.scores?.();
    if (scores && Object.keys(scores).length) {
        entry.scores = scores;
    }
    host.addFired(entry);
    await host.save();
    host.report({ status: 'started', rule, reason });
    await host.runScript(rule);

    const before = host.swipeCount();
    let waited = 0;
    let cancel = cancelReason(host, start);
    let ready = false;
    while (!cancel && waited <= MAX_WAIT_MS) {
        if (host.isAllowed()) {
            ready = true;
            break;
        }
        await host.sleep(POLL_MS);
        waited += POLL_MS;
        cancel = cancelReason(host, start);
    }

    let result = { status: 'done', rule, reason };
    if (cancel) {
        result = { status: 'cancelled', rule, reason, detail: cancel };
    } else if (!ready) {
        result = { status: 'timeout', rule, reason, detail: 'SillyTavern stayed busy' };
    } else {
        try {
            await host.swipeRight();
        } catch (error) {
            result = { status: 'failed', rule, reason, detail: error instanceof Error ? error.message : String(error) };
        }
        if (result.status === 'done' && host.swipeCount() <= before) {
            result = { status: 'failed', rule, reason, detail: 'SillyTavern did not add an alternative' };
        }
    }

    if (result.status === 'done') {
        host.markSwipe?.(rule.id, host.swipeId());
        await host.save();
    } else {
        host.stripText(rule.id);
        await host.save();
    }
    host.report(result);
    return result;
}
