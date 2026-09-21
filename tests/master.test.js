import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { buttonNamed, installDom, settle } from './helpers/dom.js';

installDom();

let discards = [];
let answer = true;
globalThis.SillyTavern = {
    getContext: () => ({
        callGenericPopup: async body => {
            discards.push(body.querySelector('.jeved-ask')?.textContent ?? '');
            return answer ? 1 : 0;
        },
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0 },
    }),
};

const { masterDetail, openDraftPatch } = await import('../src/ui/master.js');
const { text } = await import('../src/ui/dom.js');

const open = (draft, extra = {}) => ({ draft, openId: 'a', itemId: 'a', creating: false, ...extra });

describe('a switch changed in the list while the item is open', () => {
    it('reaches the open draft, so Save cannot put the old value back', () => {
        assert.deepEqual(openDraftPatch({ enabled: false }, open({ id: 'a', enabled: true })), { enabled: false });
        assert.deepEqual(openDraftPatch({ watch: true }, open({ id: 'a', watch: false })), { watch: true });
    });

    it('leaves the draft alone when another item is open', () => {
        assert.equal(openDraftPatch({ enabled: false }, open({ id: 'b', enabled: true }, { itemId: 'b', openId: 'a' })), null);
    });

    it('leaves the draft alone while a new item is being written', () => {
        assert.equal(openDraftPatch({ enabled: false }, open({ enabled: true }, { creating: true })), null);
    });

    it('leaves the draft alone when nothing is open', () => {
        assert.equal(openDraftPatch({ enabled: false }, open(null)), null);
    });

    it('reports no change when the draft already holds that value', () => {
        assert.equal(openDraftPatch({ enabled: true }, open({ id: 'a', enabled: true })), null);
    });

    it('carries only the keys that moved', () => {
        const patch = openDraftPatch({ enabled: false, watch: true }, open({ id: 'a', enabled: false, watch: false }));
        assert.deepEqual(patch, { watch: true });
    });
});

describe('a preset switch under an open editor', () => {
    const presetOf = label => ({ rules: [{ id: 'flat', label }] });
    let preset = null;
    let panes = [];
    let saved = [];
    let controller = null;
    let lastApi = null;
    let lastDraft = null;

    function build() {
        return masterDetail({
            newLabel: 'New rule',
            caption: '',
            emptyText: 'No rules yet.',
            pickText: 'Pick a rule, or add one.',
            items: () => preset.rules,
            identity: () => preset,
            blankDraft: () => ({ id: '', label: '' }),
            draftOf: item => structuredClone(item),
            rowOf: item => text('div', 'jeved-rule-row', item.label),
            paneOf: (draft, api) => {
                panes.push(draft.label);
                lastApi = api;
                lastDraft = draft;
                return text('div', 'jeved-pane-body-stub', draft.label);
            },
            save: draft => {
                const at = preset.rules.findIndex(item => item.id === draft.id);
                Object.assign(preset.rules[at], draft);
                saved.push({ preset, label: draft.label });
                return { problems: [], id: draft.id };
            },
        });
    }

    async function openFirstRule() {
        controller.element.querySelectorAll('.jeved-rule-row')[0].fire('click');
        await settle();
    }

    beforeEach(async () => {
        preset = presetOf('Flat in A');
        panes = [];
        saved = [];
        discards = [];
        answer = true;
        controller = build();
        await openFirstRule();
    });

    it('opens the pane on the item of the preset that was live', () => {
        assert.deepEqual(panes, ['Flat in A']);
    });

    it('rebuilds the pane from the new preset and throws the old draft away', async () => {
        lastDraft.label = 'edited but never saved';
        lastApi.markDirty();

        preset = presetOf('Flat in B');
        controller.refresh();

        assert.deepEqual(panes, ['Flat in A', 'Flat in B']);

        buttonNamed(controller.element, 'Save').fire('click');
        await settle();
        assert.deepEqual(saved, [{ preset, label: 'Flat in B' }]);
        assert.equal(preset.rules[0].label, 'Flat in B');
    });

    it('closes the pane when the new preset has no rule with that id', () => {
        preset = { rules: [{ id: 'other', label: 'Other' }] };
        controller.refresh();
        assert.equal(panes.length, 1);
        assert.ok(controller.element.querySelector('.jeved-empty'));
    });

    it('opens an item by its id, and leaves the pane alone for an id it does not hold', async () => {
        preset = { rules: [{ id: 'flat', label: 'Flat in A' }, { id: 'echo', label: 'Echo' }] };
        controller.refresh();

        await controller.openId('echo');
        assert.equal(panes.at(-1), 'Echo');

        await controller.openId('gone');
        assert.equal(panes.at(-1), 'Echo');
    });

    it('still asks before it drops a dirty draft inside one preset', async () => {
        lastApi.markDirty();
        answer = false;
        buttonNamed(controller.element, 'Back').fire('click');
        await settle();
        assert.deepEqual(discards, ['Discard changes?']);
        assert.equal(controller.element.querySelector('.jeved-pane-body-stub')?.textContent, 'Flat in A');
    });
});
