import { TRIM_KEY, groupLabel } from '../context-groups.js';
import { column, node, text } from './dom.js';

export async function ask(question, { ok = 'Yes', cancel = 'Cancel' } = {}) {
    const context = SillyTavern.getContext();
    const body = column('jeved-dialog');
    body.append(text('div', 'jeved-ask', String(question)));
    const result = await context.callGenericPopup(body, context.POPUP_TYPE.CONFIRM, '', {
        okButton: ok,
        cancelButton: cancel,
    });
    return result === context.POPUP_RESULT.AFFIRMATIVE;
}

export function confirmDiscard() {
    return ask('Discard changes?', { ok: 'Discard', cancel: 'Keep editing' });
}

export async function problemsPopup(title, problems) {
    const context = SillyTavern.getContext();
    const body = column('jeved-dialog');
    body.append(text('h3', '', title));
    body.append(...problems.map(problem => text('div', 'jeved-hint', problem)));
    await context.callGenericPopup(body, context.POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        allowVerticalScrolling: true,
    });
}

export async function contextPopup(built) {
    const context = SillyTavern.getContext();
    const body = column('jeved-dialog');
    body.append(text('h3', '', 'Context sent to Jev'));
    const keys = Object.keys(built?.context ?? {});
    if (!keys.length) {
        body.append(text('div', 'jeved-hint', 'This preset sends no context right now.'));
    }
    for (const key of keys) {
        body.append(text('div', 'jeved-context-key', `${groupLabel(key)} (${key})`));
        body.append(text('pre', 'jeved-script-text', built.context[key]));
    }
    if (built?.trimmed) {
        body.append(text('div', 'jeved-hint', `The ${groupLabel(TRIM_KEY).toLowerCase()} is cut short here because the context is over the cap.`));
    }
    await context.callGenericPopup(body, context.POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        allowVerticalScrolling: true,
    });
}

export async function askForName(title, current) {
    const context = SillyTavern.getContext();
    const body = column('jeved-dialog');
    body.append(text('h3', '', title));
    const typed = await context.callGenericPopup(body, context.POPUP_TYPE.INPUT, current, {
        okButton: 'Save',
        cancelButton: 'Cancel',
    });
    return typeof typed === 'string' ? typed.trim() : '';
}

export async function confirmImport(name, preset, disabled = []) {
    const context = SillyTavern.getContext();
    const body = column('jeved-dialog');
    body.append(text('h3', '', 'Import this preset?'));
    body.append(text('div', '', `Name: ${name}`));
    body.append(text('div', 'jeved-hint', preset.description));
    body.append(text('div', '', `Rules: ${preset.rules.length}`));
    for (const rule of preset.rules) {
        body.append(text('div', 'jeved-hint', rule.label || rule.id));
    }
    if (disabled.length) {
        body.append(text('div', '', `Rules that run a script: ${disabled.join(', ')}`));
        for (const rule of preset.rules.filter(item => String(item.script ?? '').trim())) {
            body.append(text('div', 'jeved-hint', `${rule.label || rule.id}:`));
            body.append(text('pre', 'jeved-script-text', rule.script));
        }
        body.append(text('div', 'jeved-hint', 'Jeved imports these rules turned off. The scripts run on their own when the rule fires, so read each one before you turn its rule on.'));
    }
    const result = await context.callGenericPopup(body, context.POPUP_TYPE.CONFIRM, '', {
        okButton: 'Import',
        cancelButton: 'Cancel',
        allowVerticalScrolling: true,
    });
    return result === context.POPUP_RESULT.AFFIRMATIVE;
}

export function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 4)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = node('a', '', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(onFile) {
    const input = node('input', 'displayNone', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.remove();
        if (file) {
            await onFile(file);
        }
    });
    document.body.append(input);
    input.click();
}
