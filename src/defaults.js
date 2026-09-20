import { DEFAULT_ACTION, NUDGE, REROLL } from './actions.js';
import { defaultContextGroups } from './context-groups.js';
import { MAX_NUDGES, NUDGE_GAP } from './limits.js';
import { SCORE, blankLevels, seedCondition } from './sensor-types.js';

export const BUILT_IN = 'Director';

export function blankSensor(id) {
    return {
        id,
        label: '',
        watch: false,
        type: SCORE,
        turns: 1,
        includeContext: false,
        includeUser: true,
        measureEvery: 1,
        question: '',
        levels: blankLevels(),
        options: [],
    };
}

export function blankRule(id, sensor) {
    return {
        id,
        label: '',
        enabled: false,
        action: DEFAULT_ACTION,
        conditions: [seedCondition(sensor)],
        need: 3,
        window: 4,
        skipWhen: null,
        cooldown: 0,
        directive: '',
        script: '',
    };
}

const reply = { type: SCORE, turns: 1, includeContext: false, includeUser: true, measureEvery: 1 };
const story = { type: SCORE, turns: 5, includeContext: true, includeUser: false, measureEvery: 1 };
const recent = { type: SCORE, turns: 5, includeContext: false, includeUser: false, measureEvery: 3 };

const builtInSensors = [
    {
        id: 'change',
        label: 'Change',
        watch: false,
        ...reply,
        question: 'How much does the situation change in `latest_turn`?',
        levels: [
            'Nothing changes. The scene stays as it was.',
            'Small talk or routine activity. The situation is the same at the end.',
            'The scene moves forward a little. Someone learns something, or a minor thing changes.',
            'The situation changes in a way that matters. Someone gains or loses power, makes a real decision, or reveals something important.',
            'A major turning point. The situation at the end is very different from the start.',
        ],
    },
    {
        id: 'tension',
        label: 'Tension',
        watch: false,
        ...reply,
        question: 'How much tension or pressure is in `latest_turn`?',
        levels: [
            'None. Everyone is relaxed and safe.',
            'Mild. Some unease, awkwardness, or anticipation.',
            'Clear. Someone is under pressure, in conflict, or has something to lose.',
            'High. Open confrontation, serious risk, or someone is being forced.',
            'Extreme. Someone faces disaster right now.',
        ],
    },
    {
        id: 'cost',
        label: 'Cost',
        watch: false,
        ...reply,
        question: 'How badly do things go for {{user}} in `latest_turn`?',
        levels: [
            'Things go well for {{user}}, or nothing is at stake.',
            'A minor annoyance or discomfort for {{user}}.',
            'A real setback for {{user}}. {{user}} fails, is refused, or loses ground.',
            'A serious loss or harm for {{user}}.',
            'A disaster for {{user}}.',
        ],
    },
    {
        id: 'speaks',
        label: 'Speaks for you',
        watch: false,
        ...reply,
        question: 'How much does `latest_turn` write what {{user}} does, says, or thinks?',
        levels: [
            'It writes nothing that {{user}} does, says, or thinks.',
            'It restates only what {{user}} already did or said.',
            'It adds a small reaction or movement for {{user}}.',
            'It writes new speech, thoughts, or a clear action for {{user}}.',
            'It makes decisions for {{user}}, or writes several actions or lines for {{user}}.',
        ],
    },
    {
        id: 'repeats',
        label: 'Repeats',
        watch: false,
        ...recent,
        question: 'How much does the newest reply in `latest_turns` reuse phrases or sentence patterns from the earlier replies?',
        levels: [
            'Nothing is reused.',
            'A few common words return.',
            'One distinctive phrase or image from an earlier reply returns.',
            'Several phrases or the same sentence pattern return.',
            'The reply follows the structure and wording of an earlier reply.',
        ],
    },
    {
        id: 'tone',
        label: 'Tone',
        watch: false,
        ...story,
        question: 'How well do the tone and themes of `latest_turns` match the intent of `context`?',
        levels: [
            'The tone and themes are unrelated to the intent.',
            'Mostly different from the intent.',
            'Partly matches the intent.',
            'Mostly matches the intent.',
            'Fully matches the intended tone and themes.',
        ],
    },
    {
        id: 'world',
        label: 'World',
        watch: false,
        ...story,
        question: 'How much does `latest_turns` build on the world that `context` establishes?',
        levels: [
            'It ignores the world. It could be from a generic story.',
            'It uses only names and places from the world.',
            'It uses some specific rules or elements of the world.',
            'It clearly builds on the specific rules, elements, and premise of the world.',
            'The premise of the world drives what happens.',
        ],
    },
];

const builtInRules = [
    {
        id: 'drift',
        label: 'Drift',
        enabled: true,
        action: NUDGE,
        conditions: [{ sensor: 'tone', op: 'below', value: 1.5 }],
        need: 5,
        window: 5,
        skipWhen: { sensor: 'tension', op: 'above', value: 2.5 },
        cooldown: 0,
        directive: '(OOC: The tone and themes of the story have drifted from the initial intent of the instructions at the beginning of the prompt. Recalibrate in your next reply.)',
        script: '',
    },
    {
        id: 'flat',
        label: 'Flat',
        enabled: true,
        action: NUDGE,
        conditions: [
            { sensor: 'change', op: 'below', value: 2.5 },
            { sensor: 'tension', op: 'below', value: 1.5 },
        ],
        need: 3,
        window: 4,
        skipWhen: null,
        cooldown: 0,
        directive: '(OOC: The story has been calm for many turns. In this reply, something puts {{user}} under pressure or tension. How is your choice. Do not resolve it in this reply.)',
        script: '',
    },
    {
        id: 'gentle',
        label: 'Gentle',
        enabled: false,
        action: NUDGE,
        conditions: [{ sensor: 'cost', op: 'below', value: 1.0 }],
        need: 18,
        window: 20,
        skipWhen: null,
        cooldown: 0,
        directive: '(OOC: Things have gone {{user}}\'s way for a long time. In this reply, let something go against {{user}}. How is your choice. Do not resolve it in this reply.)',
        script: '',
    },
    {
        id: 'puppet',
        label: 'Puppet',
        enabled: false,
        action: REROLL,
        conditions: [{ sensor: 'speaks', op: 'above', value: 2.5 }],
        need: 1,
        window: 1,
        skipWhen: null,
        cooldown: 0,
        directive: '(OOC: The last reply wrote actions, speech, or thoughts for {{user}}. Write only the other characters and the world. Stop where {{user}} must act.)',
        script: '',
    },
    {
        id: 'echo',
        label: 'Echo',
        enabled: true,
        action: NUDGE,
        conditions: [{ sensor: 'repeats', op: 'above', value: 2.5 }],
        need: 4,
        window: 6,
        skipWhen: null,
        cooldown: 0,
        directive: '(OOC: Recent replies reuse the same phrases and sentence patterns. In this reply, use new wording and a different structure.)',
        script: '',
    },
    {
        id: 'lore',
        label: 'Lore',
        enabled: false,
        action: REROLL,
        conditions: [{ sensor: 'world', op: 'below', value: 2 }],
        need: 5,
        window: 5,
        skipWhen: null,
        cooldown: 0,
        directive: '(OOC: The story has stopped using the established world and its rules. In this reply, make the rules and premise of the world matter.)',
        script: '',
    },
    {
        id: 'picture',
        label: 'Picture',
        enabled: false,
        action: NUDGE,
        conditions: [{ sensor: 'tension', op: 'above', value: 3 }],
        need: 1,
        window: 1,
        skipWhen: null,
        cooldown: 10,
        directive: '',
        script: '/imagine quiet=true scene',
    },
];

export const builtInPresets = {
    [BUILT_IN]: {
        description: 'Checks each reply for three problems: the tone no longer fits the character card, nothing happens for several replies, or the wording repeats. When a problem lasts, Jeved tells the narrator to fix it. Four more rules are off until you turn them on: Gentle, Puppet, Lore and Picture.',
        sensors: builtInSensors,
        rules: builtInRules,
        contextGroups: defaultContextGroups(),
        gap: NUDGE_GAP.fallback,
        maxNudges: MAX_NUDGES.fallback,
    },
};

export function builtInPreset(name = BUILT_IN) {
    return builtInPresets[name] ? structuredClone(builtInPresets[name]) : null;
}
