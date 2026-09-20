export const LEVEL_COUNT = 5;
export const SCALE_MAX = LEVEL_COUNT - 1;

export const TURNS = { min: 1, max: 50, fallback: 1 };
export const RULE_COUNTS = { min: 1, max: 1000, fallback: 1 };
export const RULE_COOLDOWN = { min: 0, max: 500, fallback: 0, step: '1' };
export const TIMEOUT_MS = { min: 1000, max: 600000, fallback: 20000, step: '500' };
export const CONTEXT_CAP = { min: 0, max: 1000000, fallback: 24000, step: '1000' };
export const NUDGE_GAP = { min: 0, max: 500, fallback: 5, step: '1' };
export const MAX_NUDGES = { min: 1, max: 10, fallback: 1, step: '1' };
