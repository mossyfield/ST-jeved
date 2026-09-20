export const ALLOWED_COMMANDS = [
    '/',
    '*',
    'abort',
    'add',
    'addglobalvar',
    'addvar',
    'break',
    'decglobalvar',
    'decvar',
    'div',
    'echo',
    'flushglobalvar',
    'flushvar',
    'getglobalvar',
    'getvar',
    'if',
    'imagine',
    'incglobalvar',
    'incvar',
    'len',
    'let',
    'max',
    'min',
    'mod',
    'mul',
    'pass',
    'round',
    'setglobalvar',
    'setvar',
    'sub',
    'times',
    'var',
    'while',
];

const ALLOWED = new Set(ALLOWED_COMMANDS);

const CLOSURE_ONLY = new Map([
    ['if', { least: 1, named: ['else'] }],
    ['while', { least: 1, named: [] }],
    ['times', { least: 2, named: [] }],
    ['echo', { least: 0, named: ['onClick'] }],
]);

const PLAIN_NAME_ONLY = new Set(['flushvar', 'flushglobalvar']);

export const GATE_OFFLINE = "Jeved can't reach SillyTavern's script reader, so a rule's script doesn't run.";

function isClosure(value) {
    return !!value && typeof value === 'object' && !!value.closure;
}

function named(step, name) {
    return (step.named ?? []).find(arg => arg?.name === name) ?? null;
}

function notAllowed(typed) {
    return `/${typed} isn't on the list of commands a rule can run.`;
}

function notAClosure(typed) {
    return `/${typed} can only run a closure like {: /echo hi :}, so Jeved can read it before it runs.`;
}

function nothingToRun(typed) {
    return `/${typed} has nothing to run, so SillyTavern would give it the piped value instead.`;
}

function checkStep(step) {
    const typed = String(step.typed || step.name || '');
    if (!ALLOWED.has(step.name)) {
        return notAllowed(typed);
    }
    const unnamed = step.unnamed ?? [];
    const rule = CLOSURE_ONLY.get(step.name);
    if (rule) {
        if (rule.least && unnamed.length < rule.least) {
            return nothingToRun(typed);
        }
        if (rule.least && !isClosure(unnamed[unnamed.length - 1])) {
            return notAClosure(typed);
        }
        for (const name of rule.named) {
            const arg = named(step, name);
            if (arg && !isClosure(arg.value)) {
                return notAClosure(typed);
            }
        }
    }
    if (PLAIN_NAME_ONLY.has(step.name) && unnamed.some(value => isClosure(value) || value?.macro)) {
        return `/${typed} needs a plain variable name, because a macro there can give it a closure to run.`;
    }
    if (step.name === 'imagine') {
        const quiet = named(step, 'quiet');
        if (!quiet || isClosure(quiet.value) || String(quiet.value?.text ?? '').trim().toLowerCase() !== 'true') {
            return `/${typed} needs quiet=true, or it posts the picture into the chat in the middle of your turn.`;
        }
    }
    return '';
}

function checkValue(value) {
    return isClosure(value) ? checkClosure(value.closure) : '';
}

function checkClosure(closure) {
    for (const arg of closure?.args ?? []) {
        const problem = checkValue(arg?.value);
        if (problem) {
            return problem;
        }
    }
    for (const step of closure?.steps ?? []) {
        const problem = checkStep(step)
            || (step.named ?? []).map(arg => checkValue(arg?.value)).find(found => found)
            || (step.unnamed ?? []).map(value => checkValue(value)).find(found => found);
        if (problem) {
            return problem;
        }
    }
    return '';
}

export function checkWalk(walk) {
    if (!walk) {
        return GATE_OFFLINE;
    }
    if (walk.error) {
        return `Jeved can't read this script: ${String(walk.error).replace(/\.$/, '')}.`;
    }
    for (const found of walk.commands ?? []) {
        if (!ALLOWED.has(found?.name)) {
            return notAllowed(String(found?.typed || found?.name || ''));
        }
    }
    return checkClosure(walk);
}
