export const NUDGE = 'nudge';
export const REROLL = 'swipe';
export const DEFAULT_ACTION = NUDGE;
export const BEFORE_GENERATION = 'before-generation';
export const AFTER_REPLY = 'after-reply';

export const ACTIONS = [
    {
        id: NUDGE,
        label: 'Nudge next turn',
        shortLabel: 'Nudge',
        icon: 'fa-arrow-right',
        phase: BEFORE_GENERATION,
        usesCarriedScores: true,
        fireOffset: 0,
        spaced: true,
        onlyOne: false,
        presentTense: 'nudge the next turn',
        pastTense: 'nudged the next turn',
        replacesReply: false,
        badgeTag: '',
        badgeNote: '',
    },
    {
        id: REROLL,
        label: 'Reroll reply',
        shortLabel: 'Reroll',
        icon: 'fa-rotate',
        phase: AFTER_REPLY,
        usesCarriedScores: false,
        fireOffset: 1,
        spaced: false,
        onlyOne: true,
        presentTense: 'reroll the reply',
        pastTense: 'rerolled the reply',
        replacesReply: true,
        badgeTag: 'rerolled',
        badgeNote: 'The original reply is one swipe to the left.',
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
