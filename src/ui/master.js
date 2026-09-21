import { confirmDiscard } from './dialogs.js';
import { button, column, detach, node, problemBlock, showProblems, text } from './dom.js';

export function openDraftPatch(patch, { draft, openId, itemId, creating }) {
    if (!draft || creating || !itemId || openId !== itemId) {
        return null;
    }
    const wanted = Object.entries(patch ?? {}).filter(([key, value]) => draft[key] !== value);
    return wanted.length ? Object.fromEntries(wanted) : null;
}

export function masterDetail(config) {
    const element = node('div', 'jeved-master');
    const list = node('div', 'jeved-list', { id: 'jeved_list' });
    const listHead = node('div', 'jeved-list-head');
    const pane = node('div', 'jeved-pane', { id: 'jeved_pane' });

    let selectedId = '';
    let creating = false;
    let draft = null;
    let dirty = false;
    let openIdentity = null;
    let closers = [];
    let refreshers = [];

    const indexOf = id => config.items().findIndex(item => item.id === id);
    const identity = () => config.identity?.() ?? null;

    function selection() {
        const items = config.items();
        const index = creating ? -1 : indexOf(selectedId);
        return {
            index,
            saved: index >= 0 ? items[index] : null,
            otherIds: items.filter((_, other) => other !== index).map(item => item.id),
        };
    }

    function runClosers() {
        for (const closer of closers) {
            closer();
        }
        closers = [];
        refreshers = [];
    }

    const api = {
        markDirty() {
            dirty = true;
            paint();
        },
        refresh: () => drawList(),
        listChanged(itemId, patch) {
            const merged = openDraftPatch(patch, { draft, openId: selectedId, itemId, creating });
            if (merged) {
                Object.assign(draft, merged);
                for (const listener of refreshers) {
                    listener(merged);
                }
            }
            drawList();
        },
        setNotice: content => {
            notice.replaceChildren(...(content ? [content] : []));
            notice.hidden = !content;
        },
        problems: found => showProblems(problems, found),
        onClose: closer => closers.push(closer),
        onRefresh: listener => refreshers.push(listener),
    };

    const problems = problemBlock();
    const notice = node('div', 'jeved-notice', { hidden: true });
    const saveButton = button('Save', 'Save this item', () => detach(commit()), { variant: 'primary' });
    const revertButton = button('Revert', 'Undo your changes', () => {
        if (!draft) {
            return;
        }
        const index = creating ? -1 : indexOf(selectedId);
        draft = index >= 0 ? config.draftOf(config.items()[index]) : config.blankDraft();
        drawPane();
    });
    const footer = node('div', 'jeved-pane-footer', { id: 'jeved_pane_footer' });
    footer.append(notice, saveButton, revertButton);

    function paint() {
        saveButton.classList.toggle('jeved-btn--pending', dirty);
        for (const row of list.querySelectorAll('.jeved-list-row')) {
            row.classList.toggle('jeved-list-row--on', row.dataset.jevedId === selectedId && !creating);
        }
        element.classList.toggle('jeved-master--open', !!draft);
    }

    function drawList() {
        const shared = config.beforeRows?.();
        const rows = config.items().map(item => {
            const row = config.rowOf(item, indexOf(item.id), api, shared);
            row.classList.add('jeved-list-row');
            row.dataset.jevedId = item.id;
            row.addEventListener('click', event => {
                if (event.target.closest('.jeved-list-keep')) {
                    return;
                }
                detach(open(indexOf(item.id)));
            });
            return row;
        });
        list.replaceChildren(
            listHead,
            ...(rows.length ? rows : [text('div', 'jeved-empty', config.emptyText)]),
        );
        paint();
    }

    function drawPane() {
        runClosers();
        showProblems(problems, []);
        api.setNotice(null);
        if (!draft) {
            dirty = false;
            pane.replaceChildren(text('div', 'jeved-empty', config.pickText));
            paint();
            return;
        }
        const head = node('div', 'jeved-pane-head');
        const back = button('Back', 'Back to the list', () => detach(leave()), { icon: 'fa-arrow-left' });
        back.id = 'jeved_back';
        head.append(back);
        if (creating) {
            head.append(text('h3', 'jeved-pane-title', config.newLabel));
        }
        pane.replaceChildren(head, column('jeved-pane-body', problems, config.paneOf(draft, api, selection())), footer);
        dirty = false;
        paint();
    }

    async function leaveCurrent() {
        if (!dirty) {
            return true;
        }
        return confirmDiscard();
    }

    function show(id, creatingNew, next) {
        selectedId = id;
        creating = creatingNew;
        draft = next;
        openIdentity = identity();
        drawPane();
        drawList();
    }

    async function open(index) {
        const item = config.items()[index];
        if (!item) {
            return;
        }
        if (item.id === selectedId && !creating) {
            return;
        }
        if (!await leaveCurrent() || indexOf(item.id) < 0) {
            return;
        }
        show(item.id, false, config.draftOf(item));
    }

    async function startNew(seed) {
        if (!await leaveCurrent()) {
            return;
        }
        show('', true, config.blankDraft(seed));
    }

    async function leave() {
        if (!await leaveCurrent()) {
            return;
        }
        show('', false, null);
    }

    function drop() {
        show('', false, null);
    }

    async function commit() {
        const found = config.save(draft, selection());
        if (found.problems.length) {
            showProblems(problems, found.problems);
            return;
        }
        const wasNew = creating;
        show(found.id, false, config.draftOf(config.items()[indexOf(found.id)]));
        await config.afterSave?.(found.id, wasNew, api);
    }

    listHead.append(
        text('span', 'jeved-list-caption', config.caption ?? ''),
        button(config.newLabel, config.newLabel, () => detach(startNew()), { variant: 'primary', icon: 'fa-plus' }),
    );
    listHead.querySelector('.jeved-btn').id = 'jeved_new';

    element.append(list, pane);
    drawList();
    drawPane();

    return {
        element,
        refresh() {
            if (draft && identity() !== openIdentity) {
                const item = creating ? null : config.items()[indexOf(selectedId)];
                show(item ? item.id : '', false, item ? config.draftOf(item) : null);
                return;
            }
            if (draft && !creating && indexOf(selectedId) < 0) {
                drop();
                return;
            }
            drawList();
            for (const listener of refreshers) {
                listener();
            }
        },
        leave: leaveCurrent,
        drop,
        startNew,
        openId: id => open(indexOf(id)),
        dispose: runClosers,
    };
}
