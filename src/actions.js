export const NUDGE = 'nudge';
export const REROLL = 'swipe';
export const RUN_SCRIPT = 'script';
export const DEFAULT_ACTION = NUDGE;
export const BEFORE_GENERATION = 'before-generation';
export const AFTER_REPLY = 'after-reply';

export const ACTIONS = [
    {
        id: NUDGE,
        label: 'Nudge next turn',
        shortLabel: 'Nudge',
        icon: 'fa-arrow-right',
        about: 'Adds the instruction to the copy of your next message that goes into the prompt.',
        phase: BEFORE_GENERATION,
        fireOffset: 0,
        onlyOne: false,
        presentTense: 'nudge the next turn',
        pastTense: 'nudged the next turn',
        replacesReply: false,
        runsInGroup: true,
        usesDirective: true,
        needsScript: false,
        needsReplySensor: false,
        ruleNoun: 'nudge',
        badgeTag: '',
        badgeNote: '',
    },
    {
        id: REROLL,
        label: 'Reroll reply',
        shortLabel: 'Reroll',
        icon: 'fa-rotate',
        about: 'Swipes the reply one time and adds the instruction to that generation.',
        phase: AFTER_REPLY,
        fireOffset: 1,
        onlyOne: true,
        presentTense: 'reroll the reply',
        pastTense: 'rerolled the reply',
        replacesReply: true,
        runsInGroup: false,
        usesDirective: true,
        needsScript: false,
        needsReplySensor: true,
        ruleNoun: 'reroll',
        badgeTag: 'rerolled',
        badgeNote: 'The original reply is one swipe to the left.',
    },
    {
        id: RUN_SCRIPT,
        label: 'Run script',
        shortLabel: 'Script',
        icon: 'fa-terminal',
        about: "Runs the rule's script right after the reply. It adds no instruction and does not change the reply by itself.",
        phase: AFTER_REPLY,
        fireOffset: 1,
        onlyOne: false,
        presentTense: 'run its script',
        pastTense: 'ran its script',
        replacesReply: false,
        runsInGroup: true,
        usesDirective: false,
        needsScript: true,
        needsReplySensor: true,
        ruleNoun: 'Run script',
        badgeTag: '',
        badgeNote: '',
    },
];

const BY_ID = new Map(ACTIONS.map(action => [action.id, action]));

export function actionOf(id) {
    return BY_ID.get(String(id ?? '')) ?? null;
}

export function ruleAction(rule) {
    return actionOf(rule?.action ?? DEFAULT_ACTION);
}

export function isKnownAction(id) {
    return BY_ID.has(String(id ?? ''));
}

export function actionIds() {
    return ACTIONS.map(action => action.id);
}

export function actionsInPhase(phase) {
    return ACTIONS.filter(action => action.phase === phase);
}

export function replacesReply(entry) {
    return !!actionOf(entry?.action)?.replacesReply;
}

export function firesInPhase(rule, phase) {
    return ruleAction(rule)?.phase === phase;
}
