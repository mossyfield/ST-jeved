import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { HOSTS, classify, endpointWarning, errorKind, hostOf, isCancelled, provider, readScores } from '../src/classifier.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const questions = { tone: { question: 'How?', levels: ['a', 'b', 'c', 'd', 'e'] } };
const base = { endpoint: 'https://x', apiKey: 'k', model: 'm', state: {}, questions, timeoutMs: 50 };

function reply(body, { status = 200, bodyDelay = 0 } = {}) {
    return (_url, options) => new Promise((resolve, reject) => {
        const fail = () => reject(new Error('aborted'));
        if (options.signal.aborted) {
            fail();
            return;
        }
        options.signal.addEventListener('abort', fail);
        resolve({
            ok: status >= 200 && status < 300,
            status,
            json: () => new Promise((done, stop) => {
                if (!bodyDelay) {
                    done(body);
                    return;
                }
                const timer = setTimeout(() => done(body), bodyDelay);
                options.signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    stop(new Error('aborted'));
                });
            }),
        });
    });
}

async function fails(run) {
    try {
        await run();
    } catch (error) {
        return error;
    }
    return null;
}

const choice = { mood: { type: 'choice', question: 'Which?', options: [{ name: 'calm', description: 'a' }, { name: 'angry', description: 'b' }] } };
const noul = { danger: { type: 'noul', question: 'Is it?', levels: ['Safe.', 'Risky.'] } };

const scoresOf = (data, asked = questions) => ({ ...readScores(data, asked).scores });

describe('readScores', () => {
    it('keeps a finite number in range', () => {
        assert.deepEqual(scoresOf({ answers: { tone: { score: 2.5 } } }), { tone: 2.5 });
        assert.deepEqual(scoresOf({ answers: { tone: { score: 0 } } }), { tone: 0 });
        assert.deepEqual(scoresOf({ answers: { tone: { score: 4 } } }), { tone: 4 });
    });

    it('does not turn null, false or an empty string into a zero', () => {
        for (const score of [null, false, '', '2', undefined, NaN, [], {}]) {
            assert.deepEqual(scoresOf({ answers: { tone: { score } } }), {}, String(score));
        }
    });

    it('drops a score outside the range of its descriptions', () => {
        assert.deepEqual(scoresOf({ answers: { tone: { score: 5 } } }), {});
        assert.deepEqual(scoresOf({ answers: { tone: { score: -1 } } }), {});
        assert.deepEqual(scoresOf({ answers: { tone: { score: 2 } } }, { tone: { question: 'How?', levels: ['a', 'b'] } }), {});
    });

    it('builds a map that a reserved key cannot reach through', () => {
        const answers = readScores({ answers: { tone: { score: 1 } } }, questions);
        assert.equal(Object.getPrototypeOf(answers.scores), null);
        assert.equal(Object.getPrototypeOf(answers.confidence), null);
        assert.equal(Object.getPrototypeOf(answers.probabilities), null);
    });

    it('takes a choice by name and refuses one that was not offered', () => {
        assert.deepEqual(scoresOf({ answers: { mood: { choice: 'angry' } } }, choice), { mood: 'angry' });
        assert.deepEqual(scoresOf({ answers: { mood: { choice: 'furious' } } }, choice), {});
        assert.deepEqual(scoresOf({ answers: { mood: { choice: 1 } } }, choice), {});
        assert.deepEqual(scoresOf({ answers: { mood: { score: 1 } } }, choice), {});
    });

    it('takes a yes or no probability and refuses one outside 0 to 1', () => {
        assert.deepEqual(scoresOf({ answers: { danger: { noul: 0.72 } } }, noul), { danger: 0.72 });
        assert.deepEqual(scoresOf({ answers: { danger: { noul: 0 } } }, noul), { danger: 0 });
        assert.deepEqual(scoresOf({ answers: { danger: { noul: 1.2 } } }, noul), {});
        assert.deepEqual(scoresOf({ answers: { danger: { noul: '0.5' } } }, noul), {});
    });

    it('trusts the type of the sensor, not the type the host echoes', () => {
        assert.deepEqual(scoresOf({ answers: { mood: { type: 'score', choice: 'calm' } } }, choice), { mood: 'calm' });
        assert.deepEqual(scoresOf({ answers: { tone: { score: 3 } } }), { tone: 3 });
    });

    it('keeps the confidence and the probabilities only when they arrive', () => {
        const rich = readScores({ answers: { tone: { score: 3, confidence: 0.8, probabilities: { 3: 0.8 } } } }, questions);
        assert.equal(rich.confidence.tone, 0.8);
        assert.deepEqual(rich.probabilities.tone, { 3: 0.8 });

        const bare = readScores({ answers: { tone: { score: 3 } } }, questions);
        assert.equal(bare.confidence.tone, undefined);
        assert.equal(bare.probabilities.tone, undefined);

        const odd = readScores({ answers: { tone: { score: 3, confidence: 4, probabilities: 'no' } } }, questions);
        assert.equal(odd.confidence.tone, undefined);
        assert.equal(odd.probabilities.tone, undefined);
    });

    it('reads no confidence for a yes or no answer, because the protocol sends none', () => {
        const answers = readScores({ answers: { danger: { noul: 0.5, confidence: 0.9 } } }, noul);
        assert.equal(answers.scores.danger, 0.5);
        assert.equal(answers.confidence.danger, undefined);
    });
});

describe('the wire format of each sensor type', () => {
    const wire = asked => provider.buildRequest('m', { state: {}, questions: asked }).questions;

    it('sends a score question with its descriptions as criteria', () => {
        assert.deepEqual(wire(questions).tone, { type: 'score', instructions: 'How?', criteria: ['a', 'b', 'c', 'd', 'e'] });
    });

    it('sends a choice question with its options as a map', () => {
        assert.deepEqual(wire(choice).mood, {
            type: 'choice',
            instructions: 'Which?',
            criteria: { calm: 'a', angry: 'b' },
        });
    });

    it('sends both yes and no texts, and no criteria when either is empty', () => {
        assert.deepEqual(wire(noul).danger, {
            type: 'noul',
            instructions: 'Is it?',
            criteria: { false: 'Safe.', true: 'Risky.' },
        });
        assert.deepEqual(wire({ danger: { type: 'noul', question: 'Is it?', levels: ['Safe.', ' '] } }).danger, {
            type: 'noul',
            instructions: 'Is it?',
        });
    });
});

describe('the provider seam', () => {
    it('turns a provider-neutral question into the wire format', () => {
        const body = provider.buildRequest('m', { state: { text: 'hi' }, questions });
        assert.deepEqual(body, {
            model: 'm',
            state: { text: 'hi' },
            questions: { tone: { type: 'score', instructions: 'How?', criteria: ['a', 'b', 'c', 'd', 'e'] } },
        });
    });

    it('sends that wire format and nothing of the neutral shape', async () => {
        let sent = null;
        globalThis.fetch = (url, options) => {
            sent = JSON.parse(options.body);
            return reply({ answers: { tone: { score: 1 } } })(url, options);
        };
        await classify(base);
        assert.equal(sent.questions.tone.instructions, 'How?');
        assert.equal(sent.questions.tone.question, undefined);
        assert.equal(sent.questions.tone.levels, undefined);
    });

    it('offers a smoke test that names the question it asks', async () => {
        const request = provider.testRequest();
        assert.ok(request.questions[request.id]);
        globalThis.fetch = reply({ answers: { [request.id]: { score: 2 } } });
        const result = await classify({ ...base, ...request });
        assert.equal(result.scores[request.id], 2);
    });

});

describe('endpointWarning', () => {
    it('warns about plain http to somewhere else', () => {
        assert.match(endpointWarning('http://example.test/decisions'), /without encryption/);
        assert.match(endpointWarning('http://192.168.1.4:8080/decisions'), /without encryption/);
    });

    it('says nothing about https, or about http on this machine', () => {
        assert.equal(endpointWarning('https://openrouter.ai/api/alpha/decisions'), '');
        assert.equal(endpointWarning('http://localhost:5000/decisions'), '');
        assert.equal(endpointWarning('http://127.0.0.1:5000/decisions'), '');
    });

    it('says nothing when the endpoint is empty, relative or not a URL', () => {
        assert.equal(endpointWarning(''), '');
        assert.equal(endpointWarning('not a url'), '');
        assert.equal(endpointWarning(null), '');
        assert.equal(endpointWarning('/proxy/https://api.typesafe.ai/v1/systemone'), '');
    });
});

describe('hosts', () => {
    it('matches an endpoint to the host that serves it', () => {
        assert.equal(hostOf(provider.defaults.endpoint).id, 'openrouter');
        assert.equal(hostOf('/proxy/https://api.typesafe.ai/v1/systemone').model, 'jev-1.13.0');
        assert.equal(hostOf('https://example.test/decisions'), null);
        assert.equal(hostOf(''), null);
    });

    it('carries a hint only for the host that needs the proxy', () => {
        const proxied = HOSTS.filter(host => host.hint);
        assert.deepEqual(proxied.map(host => host.id), ['typesafe']);
        assert.match(proxied[0].hint, /enableCorsProxy/);
        assert.ok(proxied[0].endpoint.startsWith('/'));
    });
});

describe('the headers a call carries', () => {
    const capture = body => {
        let sent = null;
        globalThis.fetch = (url, options) => {
            sent = options.headers;
            return reply(body)(url, options);
        };
        return () => sent;
    };

    it('adds the host headers to a relative endpoint and to nothing else', async () => {
        const sent = capture({ answers: { tone: { score: 1 } } });
        const headers = () => ({ 'X-CSRF-Token': 'token' });
        await classify({ ...base, endpoint: '/proxy/https://api.typesafe.ai/v1/systemone', headers });
        assert.equal(sent().get('X-CSRF-Token'), 'token');

        await classify({ ...base, headers });
        assert.equal(sent().get('X-CSRF-Token'), null);
    });

    it('keeps its own key, whatever case the host headers use', async () => {
        const sent = capture({ answers: { tone: { score: 1 } } });
        await classify({ ...base, endpoint: '/proxy/x', headers: () => ({ Authorization: 'Bearer theirs' }) });
        assert.equal(sent().get('authorization'), 'Bearer k');

        await classify({
            ...base,
            endpoint: '/proxy/x',
            headers: () => ({ authorization: 'Bearer theirs', 'content-type': 'text/plain' }),
        });
        assert.equal(sent().get('Authorization'), 'Bearer k');
        assert.equal(sent().get('Content-Type'), 'application/json');
    });

    it('does not break when the host offers no headers', async () => {
        const sent = capture({ answers: { tone: { score: 1 } } });
        await classify({ ...base, endpoint: '/proxy/x', headers: () => null });
        assert.equal(sent().get('Content-Type'), 'application/json');
    });
});

describe('classify', () => {
    it('returns the scores, the cost and the token count', async () => {
        globalThis.fetch = reply({ answers: { tone: { score: 3 } }, usage: { cost: 0.5, input_tokens: 900, output_tokens: 20 } });
        const result = await classify(base);
        assert.deepEqual({ ...result.scores }, { tone: 3 });
        assert.equal(result.cost, 0.5);
        assert.equal(result.tokens, 920);
    });

    it('counts tokens on a host that sends no cost', async () => {
        globalThis.fetch = reply({ answers: { tone: { score: 3 } }, usage: { input_tokens: 40 } });
        const result = await classify(base);
        assert.equal(result.cost, 0);
        assert.equal(result.tokens, 40);
    });

    it('times out while the body is still coming', async () => {
        globalThis.fetch = reply({ answers: { tone: { score: 3 } } }, { bodyDelay: 5000 });
        const error = await fails(() => classify({ ...base, timeoutMs: 30 }));
        assert.equal(errorKind(error), 'timeout');
    });

    it('refuses to send when the caller has already cancelled', async () => {
        let calls = 0;
        globalThis.fetch = (...args) => { calls++; return reply({})(...args); };
        const controller = new AbortController();
        controller.abort();
        const error = await fails(() => classify({ ...base, signal: controller.signal }));
        assert.ok(isCancelled(error));
        assert.equal(calls, 0);
    });

    it('does not retry after the caller cancels between attempts', async () => {
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = (...args) => {
            calls++;
            if (calls === 1) {
                controller.abort();
            }
            return reply({}, { status: 429 })(...args);
        };
        const error = await fails(() => classify({ ...base, signal: controller.signal }));
        assert.ok(isCancelled(error));
        assert.equal(calls, 1);
    });

    it('stops waiting out the retry delay as soon as the caller cancels', async () => {
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = async () => {
            calls++;
            setTimeout(() => controller.abort(), 5);
            return { ok: false, status: 429, json: async () => ({}) };
        };
        const started = Date.now();
        const error = await fails(() => classify({ ...base, signal: controller.signal, timeoutMs: 60000 }));
        assert.ok(isCancelled(error));
        assert.equal(calls, 1);
        assert.ok(Date.now() - started < 1000, 'it sat out the whole retry delay');
    });

    it('reports a rejected key', async () => {
        globalThis.fetch = reply({ error: { message: 'nope' } }, { status: 401 });
        const error = await fails(() => classify(base));
        assert.equal(errorKind(error), 'key');
    });

    it('reads the numeric code of an error envelope over the HTTP status', async () => {
        globalThis.fetch = reply({ error: { code: 402, message: 'broke' } }, { status: 200 });
        assert.equal(errorKind(await fails(() => classify(base))), 'credit');
    });

    it('falls back to the HTTP status when the code is a word', async () => {
        globalThis.fetch = reply({ error: { message: 'no balance', type: 'payment', code: 'insufficient_balance' } }, { status: 402 });
        assert.equal(errorKind(await fails(() => classify(base))), 'credit');
    });

    it('does not read a code that only looks like a number', async () => {
        globalThis.fetch = reply({ error: { message: 'rejected', code: '402' } }, { status: 401 });
        assert.equal(errorKind(await fails(() => classify(base))), 'key');
    });

    it('reads an envelope that names the problem under detail', async () => {
        globalThis.fetch = reply({ detail: { error_type: 'bad_request', message: 'the state is too long' } }, { status: 400 });
        const error = await fails(() => classify(base));
        assert.equal(errorKind(error), 'other');
        assert.equal(error.message, 'the state is too long');

        globalThis.fetch = reply({ detail: { error_type: 'auth', message: 'check your API key' } }, { status: 401 });
        assert.equal(errorKind(await fails(() => classify(base))), 'key');
    });

    it('refuses an answer with no usable score', async () => {
        globalThis.fetch = reply({ answers: { tone: { score: null } } });
        const error = await fails(() => classify(base));
        assert.equal(error.message, 'The endpoint returned no usable answers.');
    });
});
