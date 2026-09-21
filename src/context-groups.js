export const NO_CONTEXT = 'none';
export const ALL_CONTEXT = 'all';
export const CUSTOM_CONTEXT = 'custom';

const CONTEXT_MODES = [NO_CONTEXT, ALL_CONTEXT, CUSTOM_CONTEXT];

export const PROMPT_PREFIX = 'prompt:';

export const WORLD_INFO_BEFORE = 'world_info_before';
export const WORLD_INFO_AFTER = 'world_info_after';
export const CHAT_EXAMPLES = 'chat_examples';

export const CONTEXT_GROUPS = [
    { key: 'main_prompt', label: 'Main prompt', trim: false },
    { key: WORLD_INFO_BEFORE, label: 'World info (before)', trim: false },
    { key: 'description', label: 'Character description', trim: true },
    { key: 'personality', label: 'Personality', trim: false },
    { key: 'scenario', label: 'Scenario', trim: false },
    { key: 'character_note', label: 'Character note', trim: false },
    { key: 'persona', label: 'Persona', trim: false },
    { key: CHAT_EXAMPLES, label: 'Chat examples', trim: false },
    { key: WORLD_INFO_AFTER, label: 'World info (after)', trim: false },
    { key: 'post_history', label: 'Post-history prompt', trim: false },
];

export const TRIM_KEY = CONTEXT_GROUPS.find(group => group.trim)?.key ?? '';

export function groupLabel(key) {
    return CONTEXT_GROUPS.find(group => group.key === key)?.label ?? String(key ?? '');
}

export function isPromptKey(key) {
    return String(key ?? '').startsWith(PROMPT_PREFIX);
}

export function pieceLabel(key) {
    const name = String(key ?? '');
    return isPromptKey(name) ? name.slice(PROMPT_PREFIX.length) : groupLabel(name);
}

export function contextMode(sensor) {
    const stored = sensor?.context;
    if (CONTEXT_MODES.includes(stored)) {
        return stored;
    }
    return stored === true ? ALL_CONTEXT : NO_CONTEXT;
}

export function contextKeys(sensor) {
    const stored = Array.isArray(sensor?.contextPieces) ? sensor.contextPieces : [];
    return [...new Set(stored.map(key => String(key ?? '')).filter(key => key))].sort();
}

export function sendsContext(sensor) {
    return contextMode(sensor) !== NO_CONTEXT;
}

export function contextKey(sensor) {
    const mode = contextMode(sensor);
    return mode === CUSTOM_CONTEXT ? `${mode}:${contextKeys(sensor).join(',')}` : mode;
}
