import { ALL_CONTEXT, NO_CONTEXT } from './context-groups.js';
import { blankSensor } from './defaults.js';
import { MESSAGES } from './limits.js';
import { entryKey, listResolver } from './lists.js';
import { NOUL, entryText, findSensor, isKnownType, macroText, repeatOf, typeIds } from './sensor-types.js';
import { getPreset } from './settings.js';
import { currentChat, latestScores } from './store.js';
import { clamp } from './util.js';

const MACRO_NAME = 'jeved';
const LIST_MACRO_NAME = 'jeved-list';
const REFERENCE = /\{\{jeved::([A-Za-z0-9_]+)(?:::([^{}]*))?\}\}/g;
const LIST_REFERENCE = /\{\{jeved-list::([A-Za-z0-9_]+)\}\}/g;
const TRUE_WORDS = ['true', 'on', 'yes', '1'];

export function answerText(sensorId, entry = '') {
    const preset = getPreset();
    const sensor = findSensor(preset.sensors, String(sensorId ?? '').trim());
    if (!sensor) {
        return '';
    }
    const chat = currentChat();
    const stored = latestScores(chat, [sensor.id], chat.length, preset.sensors)[sensor.id];
    const list = repeatOf(sensor);
    if (!list) {
        return macroText(sensor, stored);
    }
    if (String(entry ?? '').trim()) {
        return entryText(sensor, stored, entryKey(entry));
    }
    return listResolver(preset)(list)
        .map(one => [one, entryText(sensor, stored, entryKey(one))])
        .filter(([, value]) => value)
        .map(([one, value]) => `${one}: ${value}`)
        .join('\n');
}

export function listText(name) {
    return listResolver(getPreset())(String(name ?? '').trim()).join(', ');
}

let hostMacro = false;

export function fillMacros(text) {
    if (hostMacro) {
        return text;
    }
    return String(text ?? '')
        .replace(REFERENCE, (whole, id, entry) => answerText(id, entry ?? ''))
        .replace(LIST_REFERENCE, (whole, name) => listText(name));
}

export function initMacros() {
    const macros = SillyTavern.getContext().macros;
    hostMacro = typeof macros?.register === 'function';
    if (!hostMacro) {
        return false;
    }
    macros.register(MACRO_NAME, {
        category: macros.category?.MISC ?? 'misc',
        unnamedArgs: [
            { name: 'sensor', description: 'The id of the sensor to read.' },
            { name: 'entry', optional: true, description: 'One entry of the list a repeating sensor runs over.' },
        ],
        description: 'The newest answer Jeved holds for that sensor in this chat. It makes no API call.',
        returns: 'the answer, or an empty text when the sensor has no answer yet',
        exampleUsage: ['{{jeved::scene}}', '{{jeved::house::no cliffhangers}}'],
        handler: ({ unnamedArgs }) => answerText(unnamedArgs?.[0], unnamedArgs?.[1] ?? ''),
    });
    macros.register(LIST_MACRO_NAME, {
        category: macros.category?.MISC ?? 'misc',
        unnamedArgs: [{ name: 'list', description: 'The name of the list to read.' }],
        description: 'The entries of that Jeved list in this chat, joined with commas.',
        returns: 'the entries, or an empty text when the list is empty',
        exampleUsage: ['{{jeved-list::rules}}'],
        handler: ({ unnamedArgs }) => listText(unnamedArgs?.[0]),
    });
    return true;
}

function countOf(value, fallback) {
    return value === undefined || value === null || value === '' ? fallback : clamp(value, { ...MESSAGES, fallback });
}

function namedList(value, separator) {
    return String(value ?? '')
        .split(separator)
        .map(item => item.trim())
        .filter(item => item);
}

export function askSensor(args = {}, question = '') {
    const type = String(args.type ?? NOUL).trim().toLowerCase() || NOUL;
    if (!isKnownType(type)) {
        throw new Error(`The type must be ${typeIds().join(', ')}.`);
    }
    return {
        ...blankSensor('ask'),
        label: 'Ask',
        watch: true,
        type,
        user: countOf(args.user, 0),
        assistant: countOf(args.assistant, 1),
        context: TRUE_WORDS.includes(String(args.context ?? '').trim().toLowerCase()) ? ALL_CONTEXT : NO_CONTEXT,
        question: String(question ?? '').trim(),
        levels: namedList(args.levels, '|'),
        options: namedList(args.options, ',').map(name => ({ name, description: '' })),
    };
}
