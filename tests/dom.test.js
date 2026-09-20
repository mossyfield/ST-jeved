import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installDom } from './helpers/dom.js';

installDom();

const { activate, activates, button, busy, node, slider, withReason } = await import('../src/ui/dom.js');

const click = { type: 'click' };
const key = name => ({ type: 'keydown', key: name });

describe('what activates a Jeved button', () => {
    it('takes a click, Enter and Space while the button is live', () => {
        assert.equal(activates(click, false), true);
        assert.equal(activates(key('Enter'), false), true);
        assert.equal(activates(key(' '), false), true);
    });

    it('ignores every other key', () => {
        for (const name of ['Tab', 'a', 'Escape', 'ArrowDown', 'Spacebar']) {
            assert.equal(activates(key(name), false), false, name);
        }
    });

    it('ignores the keyboard as well as the mouse while the button is busy', () => {
        assert.equal(activates(click, true), false);
        assert.equal(activates(key('Enter'), true), false);
        assert.equal(activates(key(' '), true), false);
    });
});

describe('activate', () => {
    const wired = () => {
        const hits = [];
        const element = node('div', 'thing', { tabIndex: 0 });
        activate(element, () => hits.push(1));
        return { element, hits };
    };

    it('reaches the handler from the mouse and from the keyboard alike', () => {
        const { element, hits } = wired();
        element.fire('click', { type: 'click' });
        element.fire('keydown', { key: 'Enter' });
        element.fire('keydown', { key: ' ' });
        assert.equal(hits.length, 3);
    });

    it('leaves other keys alone', () => {
        const { element, hits } = wired();
        for (const name of ['Tab', 'Escape', 'a']) {
            element.fire('keydown', { key: name });
        }
        assert.equal(hits.length, 0);
    });

    it('does nothing at all while the element is disabled', () => {
        const { element, hits } = wired();
        element.classList.add('disabled');
        element.fire('click', { type: 'click' });
        element.fire('keydown', { key: 'Enter' });
        assert.equal(hits.length, 0);
    });
});

describe('a Jeved button', () => {
    const wired = () => {
        const hits = [];
        const element = button('Go', '', () => hits.push(1));
        return { element, hits };
    };

    it('runs its handler on click', () => {
        const { element, hits } = wired();
        element.fire('click', { type: 'click' });
        assert.equal(hits.length, 1);
    });

    it('does not run its handler on click while busy', () => {
        const { element, hits } = wired();
        busy(element, true);
        element.fire('click', { type: 'click' });
        assert.equal(hits.length, 0);
    });

    it('runs its handler again once it stops being busy', () => {
        const { element, hits } = wired();
        busy(element, true);
        busy(element, false);
        element.fire('click', { type: 'click' });
        assert.equal(hits.length, 1);
    });
});

describe('a slider over a given range', () => {
    const parts = element => ({
        bar: element.querySelector('.jeved-range'),
        box: element.querySelector('.jeved-number'),
    });

    it('takes its bounds and its step from the range it is given', () => {
        const { bar, box } = parts(slider(2, () => {}, { range: { min: 0, max: 9, step: 0.1, decimals: 1 } }));
        assert.deepEqual([bar.min, bar.max, bar.step], ['0', '9', '0.1']);
        assert.deepEqual([box.min, box.max], ['0', '9']);
    });

    it('pulls the starting value inside the range and rounds it to the given places', () => {
        assert.equal(parts(slider(4, () => {}, { range: { min: 0, max: 1, step: 0.05, decimals: 2 } })).bar.value, '1');
        assert.equal(parts(slider(0.666, () => {}, { range: { min: 0, max: 1, step: 0.05, decimals: 2 } })).bar.value, '0.67');
    });

    it('reports a typed value only while it sits inside the range', () => {
        const seen = [];
        const { box } = parts(slider(0.5, value => seen.push(value), { range: { min: 0, max: 1, step: 0.05, decimals: 2 } }));
        box.value = '0.8';
        box.fire('input');
        box.value = '4';
        box.fire('input');
        assert.deepEqual(seen, [0.8]);
    });

    it('shows a percent range as whole percents and still reports the stored fraction', () => {
        const seen = [];
        const percent = { min: 0, max: 1, step: 0.05, decimals: 2, percent: true };
        const { bar, box } = parts(slider(0.7, value => seen.push(value), { range: percent }));
        assert.deepEqual([bar.min, bar.max, bar.step], ['0', '100', '5']);
        assert.equal(bar.value, '70');
        assert.equal(box.value, '70');

        bar.value = '45';
        bar.fire('input');
        assert.deepEqual(seen, [0.45]);
        assert.equal(box.value, '45');
    });

    it('pulls a percent value that is out of range back to the end', () => {
        const seen = [];
        const percent = { min: 0, max: 1, step: 0.05, decimals: 2, percent: true };
        const { box } = parts(slider(4, value => seen.push(value), { range: percent }));
        assert.equal(box.value, '100');

        box.value = '120';
        box.fire('change');
        assert.deepEqual(seen, [1]);
    });
});

describe('a button that cannot be pressed', () => {
    it('shows the reason in text beside it, because a disabled button has no tooltip', () => {
        const target = button('Measure', 'Score the replies', () => {});
        const wrap = withReason(target, 'Jeved is paused in this chat.');
        assert.notEqual(wrap, target);
        assert.equal(wrap.querySelector('.jeved-try-note').textContent, 'Jeved is paused in this chat.');
        assert.equal(target.disabled, true);
    });

    it('hands the button back untouched when nothing blocks it', () => {
        const target = button('Measure', 'Score the replies', () => {});
        assert.equal(withReason(target, ''), target);
        assert.equal(target.disabled, false);
    });
});
