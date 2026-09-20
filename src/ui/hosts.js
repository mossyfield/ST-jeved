import { HOSTS, hostOf } from '../classifier.js';
import { getSettings, saveSettings } from '../settings.js';
import { column, help, picker } from './dom.js';

const CUSTOM = '';

const OPTIONS = [
    ...HOSTS.map(host => ({ value: host.endpoint, label: host.label })),
    { value: CUSTOM, label: 'Custom' },
];

const valueFor = endpoint => hostOf(endpoint)?.endpoint ?? CUSTOM;

export function hostPicker({ id = '', onPick } = {}) {
    const hint = help('');
    const paint = () => {
        hint.textContent = hostOf(control.value)?.hint ?? '';
        hint.hidden = !hint.textContent;
    };
    const control = picker(OPTIONS, valueFor(getSettings().endpoint), value => {
        const host = hostOf(value);
        if (host) {
            const settings = getSettings();
            settings.endpoint = host.endpoint;
            settings.model = host.model;
            saveSettings();
        }
        paint();
        onPick?.(host);
    });
    if (id) {
        control.id = id;
    }
    paint();
    return {
        element: column('', control, hint),
        refresh() {
            control.value = valueFor(getSettings().endpoint);
            paint();
        },
    };
}
