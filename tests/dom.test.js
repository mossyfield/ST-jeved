import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installDom } from './helpers/dom.js';

installDom();

const { activate, activates, button, busy, node, withReason } = await import('../src/ui/dom.js');

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
