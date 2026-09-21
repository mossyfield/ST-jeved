import { typeOf } from './sensor-types.js';
import { isRecord } from './util.js';

export const HOSTS = [
    {
        id: 'openrouter',
        label: 'OpenRouter',
        endpoint: 'https://openrouter.ai/api/alpha/decisions',
        model: 'typesafe/jev-1.13',
        hint: '',
    },
    {
        id: 'nanogpt',
        label: 'NanoGPT',
        endpoint: 'https://nano-gpt.com/api/v1/decisions',
        model: 'typesafe/jev-1.13',
        hint: '',
    },
    {
        id: 'typesafe',
        label: 'TypeSafe',
        endpoint: '/proxy/https://api.typesafe.ai/v1/systemone',
        model: 'jev-1.13.0',
        hint: 'This route needs enableCorsProxy: true in your SillyTavern config.yaml.',
    },
];

export function hostOf(endpoint) {
    const wanted = String(endpoint ?? '');
    return HOSTS.find(host => host.endpoint === wanted) ?? null;
}

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
    return typeOf(question).wire(question);
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

function headersFor(call) {
    const shared = String(call.endpoint).startsWith('/') ? call.headers?.() : null;
    const headers = new Headers(isRecord(shared) ? shared : {});
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${call.apiKey}`);
    return headers;
}

async function send(call) {
    const reason = stopped(call.signal, call.controller);
    if (reason) {
        throw reason;
    }
    try {
        return await fetch(call.endpoint, {
            method: 'POST',
            headers: headersFor(call),
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
    const confidence = Object.create(null);
    const probabilities = Object.create(null);
    for (const [id, question] of Object.entries(questions)) {
        const found = typeOf(question).read(data?.answers?.[id], question);
        if (!found) {
            continue;
        }
        scores[id] = found.value;
        if (found.confidence !== undefined) {
            confidence[id] = found.confidence;
        }
        if (found.probabilities !== undefined) {
            probabilities[id] = found.probabilities;
        }
    }
    return { scores, confidence, probabilities };
}

function errorFrom(data) {
    const found = [data?.error, data?.detail].find(value => isRecord(value) || (typeof value === 'string' && value));
    if (found === undefined) {
        return null;
    }
    return typeof found === 'string' ? { message: found } : found;
}

function tokensIn(usage) {
    return (Number(usage?.input_tokens) || 0) + (Number(usage?.output_tokens) || 0);
}

export async function classify({ endpoint, apiKey, model, state, questions, timeoutMs, signal, headers }) {
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
        headers,
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

        const problem = errorFrom(data);
        if (problem || !response.ok) {
            const code = problem?.code;
            const kind = kindFor(typeof code === 'number' && Number.isFinite(code) ? code : response.status);
            throw new ClassifierError(
                messageFor(kind, String(problem?.message ?? '') || `The endpoint returned ${response.status}.`),
                kind,
            );
        }

        const answers = readScores(data, questions);
        if (Object.keys(answers.scores).length === 0) {
            throw new ClassifierError('The endpoint returned no usable answers.', 'other');
        }
        return { ...answers, cost: Number(data?.usage?.cost) || 0, tokens: tokensIn(data?.usage) };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forward);
    }
}

export const provider = {
    id: HOSTS[0].id,
    defaults: {
        endpoint: HOSTS[0].endpoint,
        model: HOSTS[0].model,
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
