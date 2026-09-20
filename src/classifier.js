import { SCALE_MAX } from './limits.js';

const RETRY_STATUS = new Set([429, 529]);
const RETRY_DELAY = 1200;

class ClassifierError extends Error {
    constructor(message, kind) {
        super(message);
        this.name = 'ClassifierError';
        this.kind = kind;
    }
}

export function isCancelled(error) {
    return error instanceof ClassifierError && error.kind === 'cancelled';
}

export function cancelled(message) {
    return new ClassifierError(message, 'cancelled');
}

export function errorKind(error) {
    return error instanceof ClassifierError ? error.kind : 'other';
}

function kindFor(status) {
    if (status === 401 || status === 403) {
        return 'key';
    }
    if (status === 402) {
        return 'credit';
    }
    return 'other';
}

function messageFor(kind, fallback) {
    if (kind === 'key') {
        return 'The API key was rejected.';
    }
    if (kind === 'credit') {
        return 'The account has no credit left.';
    }
    return fallback;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function endpointWarning(endpoint) {
    let url = null;
    try {
        url = new URL(String(endpoint ?? ''));
    } catch {
        return '';
    }
    return url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)
        ? 'This endpoint is plain http, so your key and your chat text go over the network without encryption.'
        : '';
}

function wireQuestion(question) {
    return {
        type: 'score',
        instructions: String(question?.question ?? ''),
        criteria: (question?.levels ?? []).map(level => String(level ?? '')),
    };
}

function wireBody(model, request) {
    return {
        model,
        state: request.state,
        questions: Object.fromEntries(Object.entries(request.questions ?? {})
            .map(([id, question]) => [id, wireQuestion(question)])),
    };
}

function wait(ms, signal) {
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done);
    });
}

function stopped(signal, controller) {
    if (signal?.aborted) {
        return new ClassifierError('The request was cancelled.', 'cancelled');
    }
    if (controller.signal.aborted) {
        return new ClassifierError('The request timed out.', 'timeout');
    }
    return null;
}

async function send(call) {
    const reason = stopped(call.signal, call.controller);
    if (reason) {
        throw reason;
    }
    try {
        return await fetch(call.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${call.apiKey}`,
            },
            body: call.body,
            signal: call.controller.signal,
        });
    } catch {
        throw stopped(call.signal, call.controller)
            ?? new ClassifierError('The request could not reach the endpoint.', 'other');
    }
}

async function readBody(response, call) {
    try {
        return await response.json();
    } catch {
        throw stopped(call.signal, call.controller)
            ?? new ClassifierError(`The endpoint returned ${response.status} without JSON.`, kindFor(response.status));
    }
}

export function readScores(data, questions) {
    const scores = Object.create(null);
    for (const [id, question] of Object.entries(questions)) {
        const raw = data?.answers?.[id]?.score;
        const max = Array.isArray(question?.levels) ? question.levels.length - 1 : SCALE_MAX;
        if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= max) {
            scores[id] = raw;
        }
    }
    return scores;
}

export async function classify({ endpoint, apiKey, model, state, questions, timeoutMs, signal }) {
    if (!endpoint) {
        throw new ClassifierError('No endpoint is set.', 'config');
    }
    if (!apiKey) {
        throw new ClassifierError('No API key is set.', 'config');
    }

    const controller = new AbortController();
    const forward = () => controller.abort();
    const timer = setTimeout(forward, timeoutMs);
    signal?.addEventListener('abort', forward);
    const call = {
        endpoint,
        apiKey,
        body: JSON.stringify(provider.buildRequest(model, { state, questions })),
        controller,
        signal,
    };

    try {
        let response = await send(call);
        if (RETRY_STATUS.has(response.status)) {
            await wait(RETRY_DELAY, controller.signal);
            response = await send(call);
        }
        const data = await readBody(response, call);

        if (data?.error || !response.ok) {
            const status = Number(data?.error?.code) || response.status;
            const kind = kindFor(status);
            throw new ClassifierError(
                messageFor(kind, String(data?.error?.message ?? '') || `The endpoint returned ${response.status}.`),
                kind,
            );
        }

        const scores = readScores(data, questions);
        if (Object.keys(scores).length === 0) {
            throw new ClassifierError('The endpoint returned no usable scores.', 'other');
        }
        return { scores, cost: Number(data?.usage?.cost) || 0 };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forward);
    }
}

export const provider = {
    id: 'openrouter',
    defaults: {
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        model: 'typesafe/jev-1.13',
    },
    buildRequest: (model, request) => wireBody(model, request),
    classify,
    testRequest: () => ({
        id: 'openness',
        state: { text: 'The door is open.' },
        questions: {
            openness: { question: 'How open is the door in `text`?', levels: ['Shut.', 'Ajar.', 'Wide open.'] },
        },
    }),
};
