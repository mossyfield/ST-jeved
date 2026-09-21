import { PARTIAL, holdRescan, isRescanning, measure } from './measure.js';
import { measureBlockReason, notify } from './status.js';

const RESCAN_CONCURRENCY = 2;

export async function rescan(tasks, onProgress = null) {
    const counts = { measured: 0, failed: 0, skipped: 0, total: tasks.length };
    if (isRescanning() || measureBlockReason()) {
        counts.skipped = tasks.length;
        return counts;
    }
    const controller = new AbortController();
    holdRescan(controller);
    notify();
    const queue = [...tasks];
    let done = 0;
    const workers = Array.from({ length: Math.min(RESCAN_CONCURRENCY, queue.length) }, async () => {
        while (queue.length && !controller.signal.aborted && !measureBlockReason()) {
            const outcome = await measure(queue.shift(), controller.signal);
            const bucket = outcome === PARTIAL ? 'failed' : outcome;
            if (counts[bucket] === undefined) {
                counts.skipped++;
            } else {
                counts[bucket]++;
            }
            done++;
            onProgress?.(done, tasks.length);
        }
    });
    try {
        await Promise.all(workers);
    } finally {
        counts.skipped += queue.length;
        queue.length = 0;
        holdRescan(null);
        notify();
    }
    return counts;
}
