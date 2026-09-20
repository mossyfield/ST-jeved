import { JEVED_UPDATED, describeError, isPaused, lastError, lastErrorKind, measureBlockReason, setPaused, status, testConnection } from '../engine.js';
import { getSettings, normaliseSettings, saveSettings } from '../settings.js';
import { toast } from '../toast.js';
import { actions, busy, button, checkbox, detach, editing, field, node, picker, text, withReason } from './dom.js';
import { hostPicker } from './hosts.js';
import { leaveOpenTab, openWorkspace } from './workspace.js';

const RECOVERY_MS = 20000;
const CHIP_KIND = {
    off: 'idle',
    paused: 'idle',
    config: 'warn',
    nokey: 'warn',
    error: 'error',
    working: 'busy',
    waiting: 'busy',
    measured: 'ok',
};

let root = null;
let content = null;
let chipElement = null;
let nextElement = null;
let bodyElement = null;
let toastedKind = '';
let recovered = false;
let recoveryTimer = null;
let missedRender = false;

function renderStatus() {
    const chip = status();
    chipElement.textContent = chip.text;
    chipElement.className = `jeved-chip jeved-chip--${CHIP_KIND[chip.kind] ?? 'idle'}`;
    const lines = [];
    if (chip.next) {
        lines.push(chip.next);
    }
    if (recovered && chip.kind !== 'error') {
        lines.push('The last error has cleared.');
    }
    nextElement.textContent = lines.join(' ');
}

function noteError() {
    const kind = lastErrorKind();
    if (kind && kind !== toastedKind) {
        toastedKind = kind;
        recovered = false;
        const chip = status();
        toast('error', chip.kind === 'error' ? `${chip.text}. ${chip.next}` : lastError());
        return;
    }
    if (!kind && toastedKind) {
        toastedKind = '';
        recovered = true;
        toast('success', 'Jeved is measuring again.');
        clearTimeout(recoveryTimer);
        recoveryTimer = setTimeout(() => {
            recovered = false;
            renderStatus();
        }, RECOVERY_MS);
    }
}

function firstRun() {
    const block = node('div', 'info-block hint jeved-first-run');
    const hosts = hostPicker({ id: 'jeved_first_host' }).element;
    const key = field('password', '', '', value => {
        getSettings().apiKey = value;
        saveSettings();
    });
    key.id = 'jeved_first_key';
    const paused = isPaused();
    const testButton = button('Test', paused ? measureBlockReason() : 'Make one small call to check the key', async () => {
        if (isPaused()) {
            return;
        }
        busy(testButton, true);
        try {
            const score = await testConnection();
            toast('success', `The endpoint answered with ${Math.round(score * 100) / 100}.`);
        } catch (error) {
            toast('error', describeError(error));
        } finally {
            busy(testButton, false);
            render();
        }
    }, { variant: 'primary' });
    testButton.id = 'jeved_first_test';

    block.append(
        text('div', 'jeved-first-title', 'Pick a host and paste its API key to start.'),
        hosts,
        key,
        actions(withReason(testButton, paused ? measureBlockReason() : '')),
        text('div', 'jeved-hint', 'Each reply costs about two API calls, which is a fraction of a cent.'),
        text('div', 'jeved-hint', 'Jeved sends chat text, the character card and the prompts to the endpoint you set. It sends nothing else.'),
    );
    return block;
}

async function choosePreset(value, element) {
    const settings = getSettings();
    if (value === settings.activePreset) {
        return;
    }
    if (!await leaveOpenTab()) {
        element.value = settings.activePreset;
        return;
    }
    settings.activePreset = value;
    normaliseSettings(settings);
    saveSettings();
    SillyTavern.getContext().eventSource.emit(JEVED_UPDATED);
}

function render() {
    if (!root || root.offsetParent === null) {
        missedRender = true;
        return;
    }
    missedRender = false;
    renderStatus();
    if (!content || content.offsetParent === null || editing(root)) {
        return;
    }
    const settings = getSettings();
    const children = [];

    if (!settings.apiKey) {
        children.push(firstRun());
    }

    const enabled = checkbox('Enabled', settings.enabled, value => {
        getSettings().enabled = value;
        saveSettings();
        renderStatus();
    });
    enabled.querySelector('input').id = 'jeved_enabled';
    const paused = checkbox('Pause for this chat', isPaused(), value => setPaused(value));
    paused.querySelector('input').id = 'jeved_pause';

    const presets = picker(
        Object.keys(settings.presets).map(name => ({ value: name, label: name })),
        settings.activePreset,
        value => detach(choosePreset(value, presets)),
    );
    presets.id = 'jeved_preset';

    const open = button('Open Jeved', 'Open the Jeved workspace', () => openWorkspace(), {
        variant: 'primary',
        icon: 'fa-sliders',
    });
    open.id = 'jeved_open';

    children.push(enabled, paused, presets, actions(open));
    bodyElement.replaceChildren(...children);
}

function build() {
    const drawer = node('div', 'inline-drawer jeved-drawer', { id: 'jeved_drawer' });
    const head = node('div', 'inline-drawer-toggle inline-drawer-header');
    chipElement = node('span', 'jeved-chip', { id: 'jeved_chip' });
    head.append(
        node('b', '', { textContent: 'Jeved' }),
        chipElement,
        node('div', 'inline-drawer-icon fa-solid fa-circle-chevron-down down'),
    );
    nextElement = text('div', 'jeved-next', '');
    nextElement.id = 'jeved_next';
    bodyElement = node('div', 'jeved-drawer-body', { id: 'jeved_drawer_body' });
    const panel = node('div', 'inline-drawer-content');
    panel.append(nextElement, bodyElement);
    drawer.append(head, panel);
    head.addEventListener('click', () => setTimeout(render));
    return drawer;
}

export function addDrawer() {
    if (root) {
        return;
    }
    const context = SillyTavern.getContext();
    const container = document.getElementById('extensions_settings2');
    if (!container) {
        return;
    }
    root = build();
    container.append(root);
    content = root.querySelector('.inline-drawer-content');
    render();

    const refresh = () => {
        noteError();
        render();
    };
    new IntersectionObserver(entries => {
        if (missedRender && entries.some(entry => entry.isIntersecting)) {
            render();
        }
    }).observe(root);
    context.eventSource.on(JEVED_UPDATED, refresh);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, refresh);
}
