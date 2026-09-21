export const SCHEMA_VERSION = 4;

export const LEVEL_COUNT = 5;

export const LEVELS = { min: 2, max: 10 };
export const OPTIONS = { min: 2, max: 255 };
export const CONFIDENCE = { min: 0, max: 1, fallback: 0.7, step: 0.01, decimals: 2, percent: true };

export const MAX_PENDING_WAIT = 2000;
export const PREPASS_TIMEOUT_MS = 3000;
export const SAVE_DELAY = 1000;
export const EDIT_DELAY_MS = 2000;
export const POLL_MS = 100;
export const MAX_WAIT_MS = 10000;
export const SCRIPT_LIMIT_MS = 5000;

export const MESSAGES = { min: 0, max: 50, fallback: 1, step: '1' };
export const RULE_COUNTS = { min: 1, max: 1000, fallback: 1 };
export const RULE_COOLDOWN = { min: 0, max: 500, fallback: 0, step: '1' };
export const TIMEOUT_MS = { min: 1000, max: 600000, fallback: 20000, step: '500' };
export const CONTEXT_CAP = { min: 0, max: 1000000, fallback: 24000, step: '1000' };
