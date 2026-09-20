import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GATE_CASES } from './gate-cases.js';
import { stubParser } from './helpers/parser.js';
import { ALLOWED_COMMANDS, GATE_OFFLINE, checkWalk } from '../src/script-gate.js';
import { checkScript } from '../src/presets.js';

const parse = stubParser();

describe('the script gate', () => {
    it('answers every case in the table', () => {
        for (const item of GATE_CASES) {
            const problem = checkScript(item.script, parse);
            if (item.accepted) {
                assert.equal(problem, '', item.script);
            } else {
                assert.notEqual(problem, '', item.script);
                assert.ok(problem.includes(item.reasonContains ?? ''), `${item.script} gave: ${problem}`);
            }
        }
    });

    it('fails closed when the host parser is missing', () => {
        assert.equal(checkScript('/echo hi'), GATE_OFFLINE);
        assert.equal(checkScript('/echo hi', null), GATE_OFFLINE);
        assert.equal(checkScript('', null), '');
    });

    it('refuses a script when the parser itself throws', () => {
        const problem = checkScript('/echo hi', () => { throw new Error('parser died'); });
        assert.match(problem, /can't read this script: parser died\./);
    });

    it('judges a walked structure without a parser', () => {
        const step = (name, extra = {}) => ({ typed: name, name, named: [], unnamed: [], ...extra });
        assert.equal(checkWalk({ steps: [step('echo')] }), '');
        assert.match(checkWalk({ steps: [step('gen')] }), /isn't on the list/);
        assert.match(checkWalk({ commands: [step('parser-flag')], steps: [] }), /isn't on the list/);
        assert.match(
            checkWalk({ steps: [step('if', { unnamed: [{ text: '{{pipe}}', macro: true }] })] }),
            /can only run a closure/,
        );
        assert.equal(
            checkWalk({ steps: [step('if', { unnamed: [{ closure: { args: [], steps: [step('echo')] } }] })] }),
            '',
        );
        assert.match(
            checkWalk({ steps: [step('if', { unnamed: [{ closure: { args: [], steps: [step('swipe')] } }] })] }),
            /\/swipe isn't on the list/,
        );
        assert.match(
            checkWalk({ steps: [step('echo', { named: [{ name: 'onClick', value: { closure: { args: [], steps: [step('gen')] } } }] })] }),
            /\/gen isn't on the list/,
        );
        assert.match(
            checkWalk({ args: [{ name: 'a', value: { closure: { args: [], steps: [step('gen')] } } }], steps: [] }),
            /\/gen isn't on the list/,
        );
    });

    it('keeps one list a contributor can add to', () => {
        assert.ok(ALLOWED_COMMANDS.includes('echo'));
        assert.equal(ALLOWED_COMMANDS.includes('gen'), false);
        assert.equal(ALLOWED_COMMANDS.includes('run'), false);
        assert.equal(new Set(ALLOWED_COMMANDS).size, ALLOWED_COMMANDS.length);
    });
});
