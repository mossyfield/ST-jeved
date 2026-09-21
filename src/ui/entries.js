import { invalidateMeasured, notify } from '../engine.js';
import {
    ADD, FROM_CHAT, FROM_PRESET, FROM_RULE, REMOVE, addStarting, forgetManual, hiddenEntries, listDescription,
    listResolver, listRows, manualChange, normaliseEntry, removeStarting, restoreEntry, startingEntries,
} from '../lists.js';
import { saveSettings, schemaProblem } from '../settings.js';
import { busy, button, column, field, help, iconButton, node, row, segmented, tag, text } from './dom.js';

const TAGS = {
    [FROM_PRESET]: 'every chat',
    [FROM_CHAT]: 'this chat',
    [FROM_RULE]: 'added by a rule',
};

const HERE = 'chat';
const EVERY = 'every';

const SCOPES = [
    { value: HERE, label: 'This chat' },
    { value: EVERY, label: 'Every chat' },
];

export function hasChat() {
    return !!SillyTavern.getContext().getCurrentChatId();
}

export function chatEntries(preset, name) {
    const wanted = String(name ?? '').trim();
    return wanted && hasChat() ? listResolver(preset)(wanted) : [];
}

export function entryPlaceholder(description) {
    const [, example] = /example:\s*(.+)$/i.exec(String(description ?? '').trim()) ?? [];
    return example ? `Example: ${example}` : 'New entry';
}

function entryRow(value, scope, gone, control) {
    const line = row(
        text('span', `jeved-list-entry${gone ? ' jeved-list-entry--gone' : ''}`, value),
        tag(TAGS[scope] ?? scope, scope === FROM_PRESET ? 'on' : ''),
    );
    line.append(control);
    return line;
}

export function entriesBlock(preset, nameOf, onChange = () => {}, { emptyText = '' } = {}) {
    const block = node('div', 'jeved-entries');
    const inner = node('div', 'jeved-entry-inner');
    const note = text('div', 'jeved-entry-about', '');
    let typed = '';
    let source = null;
    let scope = HERE;

    const changed = () => {
        typed = '';
        box.value = '';
        invalidateMeasured();
        onChange();
        notify();
    };

    const take = () => {
        const name = String(nameOf() ?? '').trim();
        if (schemaProblem() || !name || !normaliseEntry(typed)) {
            return;
        }
        if (scope === EVERY || !hasChat()) {
            if (addStarting(preset, name, typed)) {
                saveSettings();
            }
        } else {
            forgetManual(name, typed);
            manualChange(name, ADD, typed);
        }
        changed();
    };

    const box = field('text', '', 'New entry', value => { typed = value; });
    const add = button('Add', 'Add this entry', take, { icon: 'fa-plus' });
    box.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault?.();
            take();
        }
    });
    const picker = segmented(SCOPES, scope, value => { scope = value; });
    const where = row(text('span', 'jeved-inline-label', 'Add to:'), picker);
    const foot = column('jeved-entry-foot', where, row(box, add));
    block.append(note, inner, foot);

    function dropStarting(name, value) {
        if (removeStarting(preset, name, value)) {
            saveSettings();
        }
        changed();
    }

    function rowsFor(name) {
        if (!hasChat()) {
            return startingEntries(preset, name).map(value => ({ value, scope: FROM_PRESET }));
        }
        return listRows(preset, name);
    }

    function draw() {
        const name = String(nameOf() ?? '').trim();
        const mark = `${SillyTavern.getContext().getCurrentChatId() ?? ''}:${name}`;
        if (mark !== source) {
            source = mark;
            typed = '';
            box.value = '';
        }
        const locked = schemaProblem();
        const about = listDescription(preset, name);
        note.textContent = about;
        note.hidden = !about;
        box.placeholder = entryPlaceholder(about);
        box.disabled = !!locked;
        scope = hasChat() ? scope : EVERY;
        where.hidden = !hasChat();
        foot.hidden = !name;
        if (!name) {
            inner.replaceChildren();
            return 0;
        }
        const rows = rowsFor(name);
        const children = rows.map(item => entryRow(item.value, item.scope, false, item.scope === FROM_PRESET
            ? iconButton('fa-xmark', 'Remove from every chat', () => dropStarting(name, item.value))
            : iconButton('fa-xmark', 'Remove from this chat', () => {
                manualChange(name, REMOVE, item.value);
                changed();
            })));
        for (const entry of hiddenEntries(preset, name, rows.map(item => item.value))) {
            children.push(entryRow(entry, FROM_PRESET, true, button('Restore', 'Put this entry back in this chat', () => {
                restoreEntry(preset, name, entry);
                changed();
            })));
        }
        if (!children.length) {
            children.push(help(emptyText || (hasChat() ? 'No entries yet.' : 'No entries in the preset yet.')));
        }
        inner.replaceChildren(column('jeved-entry-rows', ...children));
        if (locked) {
            for (const control of block.querySelectorAll('.jeved-btn')) {
                busy(control, true);
            }
            for (const control of block.querySelectorAll('.jeved-segment')) {
                busy(control, true);
            }
        }
        return rows.length;
    }

    return { element: block, draw, box };
}
