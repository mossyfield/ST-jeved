import {
    ALL_CONTEXT, CHAT_EXAMPLES, NO_CONTEXT, PROMPT_PREFIX, TRIM_KEY, WORLD_INFO_AFTER, WORLD_INFO_BEFORE, contextKeys,
    contextMode, groupLabel, isPromptKey,
} from './context-groups.js';

const GLOBAL_PROMPT_ORDER_ID = '100001';
const MARGIN = 0.05;
const TRIM_STEPS = 6;
const CUT_ORDER = ['persona', 'character_note', 'scenario', 'personality'];
const EARLY_CUT = [WORLD_INFO_AFTER, WORLD_INFO_BEFORE, CHAT_EXAMPLES];
const TRIGGER_TYPES = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
const WORLD_INFO_POSITIONS = { [WORLD_INFO_BEFORE]: 0, [WORLD_INFO_AFTER]: 1 };

let worldInfo = { [WORLD_INFO_BEFORE]: '', [WORLD_INFO_AFTER]: '' };

export function holdWorldInfo(entries) {
    const joined = position => (Array.isArray(entries) ? entries : [])
        .filter(entry => Number(entry?.position) === position)
        .map(entry => String(entry?.content ?? '').trim())
        .filter(content => content)
        .join('\n');
    worldInfo = Object.fromEntries(Object.entries(WORLD_INFO_POSITIONS)
        .map(([key, position]) => [key, joined(position)]));
}

export function forgetWorldInfo() {
    worldInfo = { [WORLD_INFO_BEFORE]: '', [WORLD_INFO_AFTER]: '' };
}

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

const MARKER_KEYS = {
    personaDescription: 'persona',
    charDescription: 'description',
    charPersonality: 'personality',
    scenario: 'scenario',
    worldInfoBefore: WORLD_INFO_BEFORE,
    worldInfoAfter: WORLD_INFO_AFTER,
    dialogueExamples: CHAT_EXAMPLES,
};

const CARD_KEYS = { main_prompt: 'system', post_history: 'jailbreak' };

const NAMED_PROMPTS = { main: 'main_prompt', jailbreak: 'post_history' };

const FIXED_ORDER = [
    'main_prompt', WORLD_INFO_BEFORE, 'description', 'personality', 'scenario', 'character_note', 'persona',
    CHAT_EXAMPLES, WORLD_INFO_AFTER, 'post_history',
];

function mapped(table, key) {
    return Object.hasOwn(table, String(key ?? '')) ? table[key] : '';
}

function slot(key, label) {
    return { key, label: label || groupLabel(key), off: false, sent: true };
}

function orderedSlots(context, type) {
    const settings = context.chatCompletionSettings ?? {};
    const prompts = Array.isArray(settings.prompts) ? settings.prompts : [];
    const orders = Array.isArray(settings.prompt_order) ? settings.prompt_order : [];
    const order = orders.find(entry => String(entry?.character_id) === GLOBAL_PROMPT_ORDER_ID)?.order ?? orders[0]?.order ?? [];
    const byId = new Map(prompts.map(prompt => [prompt?.identifier, prompt]));

    const slots = [];
    for (const entry of order) {
        const identifier = entry?.identifier;
        const prompt = byId.get(identifier);
        const name = String(prompt?.name ?? '').trim();
        const marker = mapped(MARKER_KEYS, identifier);
        const off = !entry?.enabled;
        if (marker) {
            slots.push({ ...slot(marker, name), off, sent: !off });
            continue;
        }
        if (!prompt || prompt.marker) {
            continue;
        }
        slots.push({
            key: mapped(NAMED_PROMPTS, identifier) || `${PROMPT_PREFIX}${identifier}`,
            label: name || String(identifier ?? ''),
            content: String(prompt.content ?? '').trim(),
            allowOverride: prompt.forbid_overrides !== true,
            off,
            sent: !off && triggered(prompt, type),
        });
    }
    if (!slots.length) {
        return null;
    }
    slots.push(slot('character_note'));
    return slots;
}

function fixedSlots(context) {
    const sysprompt = context.powerUserSettings?.sysprompt ?? {};
    const on = context.mainApi !== 'openai' && !!sysprompt.enabled;
    const content = {
        main_prompt: on ? String(sysprompt.content ?? '').trim() : '',
        post_history: on ? String(sysprompt.post_history ?? '').trim() : '',
    };
    return FIXED_ORDER.map(key => (content[key] === undefined
        ? slot(key)
        : { ...slot(key), content: content[key], allowOverride: on }));
}

export function promptKeys(type) {
    const context = SillyTavern.getContext();
    if (context.mainApi !== 'openai') {
        return null;
    }
    const slots = orderedSlots(context, generationType(type));
    if (!slots) {
        return undefined;
    }
    return slots.filter(item => !item.off && isPromptKey(item.key)).map(item => item.key);
}

function contextPieces(type, listing) {
    const context = SillyTavern.getContext();
    const card = context.getCharacterCardFields() ?? {};
    const substitute = value => String(context.substituteParams(String(value ?? '')) ?? '');
    const override = (value, original) => String(context.substituteParams(String(value ?? ''), { original: String(original ?? '') }) ?? '');
    const sources = {
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        character_note: card.charDepthPrompt,
        persona: card.persona,
        [CHAT_EXAMPLES]: card.mesExamples,
        [WORLD_INFO_BEFORE]: worldInfo[WORLD_INFO_BEFORE],
        [WORLD_INFO_AFTER]: worldInfo[WORLD_INFO_AFTER],
    };
    const slots = (context.mainApi === 'openai' ? orderedSlots(context, generationType(type)) : null)
        ?? fixedSlots(context);

    return slots.map(item => {
        const shown = listing || item.sent;
        if (item.content === undefined) {
            const text = String(mapped(sources, item.key) ?? '').trim();
            return { key: item.key, label: item.label, text: shown ? text : '', off: item.off };
        }
        const cardKey = mapped(CARD_KEYS, item.key);
        const own = String(card[cardKey] ?? '').trim();
        const replaced = !!cardKey && !!own && item.allowOverride && item.sent;
        const text = replaced ? override(own, item.content) : substitute(item.content);
        const piece = { key: item.key, label: item.label, text: shown ? text : '', off: item.off };
        return cardKey ? { ...piece, replaced: replaced && !!item.content } : piece;
    });
}

export function readContextGroups(type) {
    return contextPieces(type, false);
}

export function contextChecklist(type) {
    return contextPieces(type, true);
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

export function presentPieces(pieces) {
    return (pieces ?? []).filter(piece => piece?.text);
}

export async function countPieces(pieces) {
    const counts = {};
    for (const piece of pieces) {
        counts[piece.key] = await countTokens(piece.text);
    }
    return counts;
}

function chosenPieces(pieces, sensor) {
    const mode = contextMode(sensor);
    if (mode === NO_CONTEXT) {
        return [];
    }
    if (mode === ALL_CONTEXT) {
        return [...pieces];
    }
    const wanted = new Set(contextKeys(sensor));
    return pieces.filter(piece => wanted.has(piece.key));
}

function cutOrder(pieces) {
    const prompts = pieces.filter(piece => isPromptKey(piece.key)).map(piece => piece.key).reverse();
    return [...EARLY_CUT, ...prompts, ...CUT_ORDER];
}

export async function assembleContext(pieces, sensor, cap, counted = null) {
    const present = presentPieces(pieces);
    const counts = counted ?? await countPieces(present);
    const chosen = chosenPieces(present, sensor);

    const context = {};
    for (const piece of chosen) {
        context[piece.key] = piece.text;
    }
    const result = { context, counts, total: null, cut: [], trimmed: false, over: false };
    if (chosen.some(piece => counts[piece.key] === null)) {
        return result;
    }

    let total = chosen.reduce((sum, piece) => sum + counts[piece.key], 0);
    if (cap > 0 && total > cap) {
        for (const key of cutOrder(chosen)) {
            if (total <= cap || context[key] === undefined) {
                continue;
            }
            delete context[key];
            result.cut.push(key);
            total -= counts[key];
        }
        if (total > cap && context[TRIM_KEY] !== undefined && counts[TRIM_KEY] > 0) {
            const budget = Math.max(0, cap - (total - counts[TRIM_KEY]));
            const fitted = await fitText(context[TRIM_KEY], budget, counts[TRIM_KEY]);
            if (!fitted) {
                return result;
            }
            total -= counts[TRIM_KEY];
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

export async function buildContext(sensor, cap, type) {
    return assembleContext(readContextGroups(type), sensor, cap);
}
