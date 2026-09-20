export const CONTEXT_GROUPS = [
    { key: 'main_prompt', label: 'Main prompt', trim: false, since: 1 },
    { key: 'other_prompts', label: 'Other preset prompts', trim: false, since: 1 },
    { key: 'description', label: 'Character description', trim: true, since: 1 },
    { key: 'personality', label: 'Personality', trim: false, since: 1 },
    { key: 'scenario', label: 'Scenario', trim: false, since: 1 },
    { key: 'character_note', label: 'Character note', trim: false, since: 1 },
    { key: 'persona', label: 'Persona', trim: false, since: 1 },
    { key: 'post_history', label: 'Post-history prompt', trim: false, since: 1 },
];

export const CONTEXT_KEYS = CONTEXT_GROUPS.map(group => group.key);

export function groupsUpTo(version) {
    return CONTEXT_GROUPS.filter(group => group.since <= version).map(group => group.key);
}

export const TRIM_KEY = CONTEXT_GROUPS.find(group => group.trim)?.key ?? '';

export function defaultContextGroups() {
    return Object.fromEntries(CONTEXT_KEYS.map(key => [key, true]));
}

export function groupLabel(key) {
    return CONTEXT_GROUPS.find(group => group.key === key)?.label ?? String(key ?? '');
}
