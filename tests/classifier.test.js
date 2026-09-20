import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { classify, endpointWarning, errorKind, isCancelled, provider, readScores } from '../src/classifier.js';

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

describe('readScores', () => {
    it('keeps a finite number in range', () => {
        assert.deepEqual({ ...readScores({ answers: { tone: { score: 2.5 } } }, questions) }, { tone: 2.5 });
        assert.deepEqual({ ...readScores({ answers: { tone: { score: 0 } } }, questions) }, { tone: 0 });
        assert.deepEqual({ ...readScores({ answers: { tone: { score: 4 } } }, questions) }, { tone: 4 });
    });

    it('does not turn null, false or an empty string into a zero', () => {
        for (const score of [null, false, '', '2', undefined, NaN, [], {}]) {
            assert.deepEqual({ ...readScores({ answers: { tone: { score } } }, questions) }, {}, String(score));
        }
    });

    it('drops a score outside the range of its descriptions', () => {
        assert.deepEqual({ ...readScores({ answers: { tone: { score: 5 } } }, questions) }, {});
        assert.deepEqual({ ...readScores({ answers: { tone: { score: -1 } } }, questions) }, {});
    });

    it('builds a map that a reserved key cannot reach through', () => {
        const scores = readScores({ answers: { tone: { score: 1 } } }, questions);
        assert.equal(Object.getPrototypeOf(scores), null);
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

    it('says nothing when the endpoint is empty or not a URL', () => {
        assert.equal(endpointWarning(''), '');
        assert.equal(endpointWarning('not a url'), '');
        assert.equal(endpointWarning(null), '');
    });
});

describe('classify', () => {
    it('returns the scores and the cost', async () => {
        globalThis.fetch = reply({ answers: { tone: { score: 3 } }, usage: { cost: 0.5 } });
        const result = await classify(base);
        assert.deepEqual({ ...result.scores }, { tone: 3 });
        assert.equal(result.cost, 0.5);
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

    it('refuses an answer with no usable score', async () => {
        globalThis.fetch = reply({ answers: { tone: { score: null } } });
        const error = await fails(() => classify(base));
        assert.equal(error.message, 'The endpoint returned no usable scores.');
    });
});
