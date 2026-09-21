import { JEVED_UPDATED } from '../engine.js';
import { activityTab } from './activity-tab.js';
import { detach, node } from './dom.js';
import { listsTab } from './lists-tab.js';
import { rulesTab } from './rules-tab.js';
import { settingsTab } from './settings-tab.js';
import { sensorsTab } from './sensors-tab.js';

export const TABS = [
    { name: 'rules', label: 'Rules', make: rulesTab },
    { name: 'sensors', label: 'Sensors', make: sensorsTab },
    { name: 'lists', label: 'Lists', make: listsTab },
    { name: 'activity', label: 'Activity', make: activityTab },
    { name: 'settings', label: 'Settings', make: settingsTab },
];

export const tabNames = () => TABS.map(tab => tab.name);

let live = null;

export async function leaveOpenTab() {
    return live ? live.leave() : true;
}

export async function openWorkspace(startTab = 'rules') {
    if (live) {
        await live.go(startTab);
        return;
    }
    const context = SillyTavern.getContext();
    const root = node('div', 'jeved-workspace', { id: 'jeved_workspace' });
    const bar = node('div', 'jeved-tabs');
    const panel = node('div', 'jeved-panel', { id: 'jeved_panel' });
    root.append(bar, panel);

    const buttons = new Map();
    let current = null;
    let name = '';

    const paint = () => {
        for (const [key, element] of buttons) {
            element.classList.toggle('jeved-tab--on', key === name);
        }
    };

    const refresh = () => current?.refresh();

    const host = {
        refreshAll: refresh,
        refreshOthers: () => SillyTavern.getContext().eventSource.emit(JEVED_UPDATED),
        newRuleFrom: async sensorId => {
            if (await go('rules')) {
                await current.startNew(sensorId);
            }
        },
        openList: async name => {
            if (await go('lists')) {
                await current.select(name);
            }
        },
        openTab: go,
    };

    async function go(next) {
        const tab = TABS.find(item => item.name === next);
        if (!tab || tab.name === name) {
            return !!tab;
        }
        if (current && !await current.leave()) {
            return false;
        }
        current?.dispose?.();
        name = tab.name;
        current = tab.make(host);
        panel.replaceChildren(current.element);
        paint();
        return true;
    }

    for (const tab of TABS) {
        const element = node('button', 'jeved-tab', { type: 'button', id: `jeved_tab_${tab.name}`, textContent: tab.label });
        element.addEventListener('click', () => detach(go(tab.name)));
        buttons.set(tab.name, element);
        bar.append(element);
    }

    live = { go, leave: async () => (current ? current.leave() : true) };
    context.eventSource.on(JEVED_UPDATED, refresh);

    try {
        if (!await go(startTab)) {
            await go('rules');
        }
        await context.callGenericPopup(root, context.POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            okButton: 'Close',
            cancelButton: false,
            onClosing: () => (current ? current.leave() : true),
        });
    } finally {
        current?.dispose?.();
        context.eventSource.removeListener(JEVED_UPDATED, refresh);
        live = null;
        context.eventSource.emit(JEVED_UPDATED);
    }
}
