import { CONTEXT_KEYS, TRIM_KEY } from './context-groups.js';

const GLOBAL_PROMPT_ORDER_ID = '100001';
const MARGIN = 0.05;
const TRIM_STEPS = 6;
const CUT_ORDER = ['other_prompts', 'persona', 'character_note', 'scenario', 'personality'];
const TRIGGER_TYPES = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];

export async function countTokens(text) {
    if (!text) {
        return 0;
    }
    try {
        return Number(await SillyTavern.getContext().getTokenCountAsync(text)) || 0;
    } catch {
        return null;
    }
}

function generationType(type) {
    const name = String(type ?? '').toLowerCase().trim();
    return TRIGGER_TYPES.includes(name) ? name : 'normal';
}

function triggered(prompt, type) {
    const triggers = prompt?.injection_trigger;
    return !Array.isArray(triggers) || !triggers.length || triggers.includes(type);
}

function promptGroups(context, type) {
    const settings = context.chatCompletionSettings ?? {};
    const prompts = Array.isArray(settings.prompts) ? settings.prompts : [];
    const orders = Array.isArray(settings.prompt_order) ? settings.prompt_order : [];
    const order = orders.find(entry => String(entry?.character_id) === GLOBAL_PROMPT_ORDER_ID)?.order ?? orders[0]?.order ?? [];
    const byId = new Map(prompts.map(prompt => [prompt?.identifier, prompt]));

    const main = [];
    const rest = [];
    let postHistory = '';
    let allowMain = false;
    let allowPostHistory = false;
    for (const entry of order) {
        if (!entry?.enabled) {
            continue;
        }
        const prompt = byId.get(entry.identifier);
        if (!prompt || prompt.marker || !triggered(prompt, type)) {
            continue;
        }
        if (prompt.identifier === 'main') {
            allowMain = prompt.forbid_overrides !== true;
        }
        if (prompt.identifier === 'jailbreak') {
            allowPostHistory = prompt.forbid_overrides !== true;
        }
        const content = String(prompt.content ?? '').trim();
        if (!content) {
            continue;
        }
        if (prompt.identifier === 'jailbreak') {
            postHistory = content;
        } else if (prompt.identifier === 'main') {
            main.push(content);
        } else {
            rest.push(content);
        }
    }
    return { main: main.join('\n\n'), other: rest.join('\n\n'), postHistory, allowMain, allowPostHistory };
}

function sysPromptGroups(context) {
    const sysprompt = context.powerUserSettings?.sysprompt ?? {};
    if (!sysprompt.enabled) {
        return { main: '', other: '', postHistory: '', allowMain: false, allowPostHistory: false };
    }
    return {
        main: String(sysprompt.content ?? '').trim(),
        other: '',
        postHistory: String(sysprompt.post_history ?? '').trim(),
        allowMain: true,
        allowPostHistory: true,
    };
}

export function readContextGroups(type) {
    const context = SillyTavern.getContext();
    const card = context.getCharacterCardFields() ?? {};
    const base = context.mainApi === 'openai' ? promptGroups(context, generationType(type)) : sysPromptGroups(context);
    const substitute = value => String(context.substituteParams(String(value ?? '')) ?? '');
    const override = (value, original) => String(context.substituteParams(String(value ?? ''), { original: String(original ?? '') }) ?? '');
    const cardSystem = String(card.system ?? '').trim();
    const cardPostHistory = String(card.jailbreak ?? '').trim();
    const mainOverride = !!cardSystem && base.allowMain;
    const postOverride = !!cardPostHistory && base.allowPostHistory;

    return {
        main_prompt: { text: mainOverride ? override(cardSystem, base.main) : substitute(base.main), replaced: mainOverride && !!base.main },
        other_prompts: { text: substitute(base.other) },
        description: { text: String(card.description ?? '').trim() },
        personality: { text: String(card.personality ?? '').trim() },
        scenario: { text: String(card.scenario ?? '').trim() },
        character_note: { text: String(card.charDepthPrompt ?? '').trim() },
        persona: { text: String(card.persona ?? '').trim() },
        post_history: {
            text: postOverride ? override(cardPostHistory, base.postHistory) : substitute(base.postHistory),
            replaced: postOverride && !!base.postHistory,
        },
    };
}

async function fitText(text, budget, tokens) {
    let kept = Math.max(0, Math.floor(text.length * (budget / tokens) * (1 - MARGIN)));
    for (let step = 0; step < TRIM_STEPS && kept > 0; step++) {
        const count = await countTokens(text.slice(0, kept));
        if (count === null) {
            return null;
        }
        if (count <= budget) {
            return { text: text.slice(0, kept), count };
        }
        kept = Math.floor(kept * (budget / count) * (1 - MARGIN));
    }
    return { text: '', count: 0 };
}

export async function assembleContext(groups, contextGroups, cap) {
    const present = CONTEXT_KEYS.filter(key => groups?.[key]?.text);
    const chosen = present.filter(key => contextGroups?.[key] !== false);
    const counted = {};
    let available = true;
    for (const key of present) {
        counted[key] = await countTokens(groups[key].text);
        if (counted[key] === null && chosen.includes(key)) {
            available = false;
        }
    }

    const context = {};
    for (const key of chosen) {
        context[key] = groups[key].text;
    }
    const result = { context, counts: counted, total: null, cut: [], trimmed: false, over: false };
    if (!available) {
        return result;
    }

    let total = chosen.reduce((sum, key) => sum + counted[key], 0);
    if (cap > 0 && total > cap) {
        for (const key of CUT_ORDER) {
            if (total <= cap || context[key] === undefined) {
                continue;
            }
            delete context[key];
            result.cut.push(key);
            total -= counted[key];
        }
        if (total > cap && context[TRIM_KEY] !== undefined && counted[TRIM_KEY] > 0) {
            const budget = Math.max(0, cap - (total - counted[TRIM_KEY]));
            const fitted = await fitText(context[TRIM_KEY], budget, counted[TRIM_KEY]);
            if (!fitted) {
                return result;
            }
            total -= counted[TRIM_KEY];
            if (fitted.text) {
                context[TRIM_KEY] = fitted.text;
                result.trimmed = true;
                total += fitted.count;
            } else {
                delete context[TRIM_KEY];
                result.cut.push(TRIM_KEY);
            }
        }
    }

    result.total = total;
    result.over = cap > 0 && total > cap;
    return result;
}

export async function buildContext(contextGroups, cap, type) {
    return assembleContext(readContextGroups(type), contextGroups, cap);
}
