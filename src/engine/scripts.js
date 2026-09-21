import { SCRIPT_LIMIT_MS } from '../limits.js';
import { fillEntries } from '../lists.js';
import { toast } from '../toast.js';
import { hashText } from '../util.js';
import { SCRIPT_ERROR, describeError, notify, setErrorText } from './status.js';

const TIMED_OUT = Symbol('timed out');
const RUN_KEY = 'jeved_run';

const runs = new Map();
let counter = 0;

export function scriptParser() {
    const Parser = SillyTavern.getContext()?.SlashCommandParser;
    if (typeof Parser !== 'function') {
        return null;
    }
    return text => {
        try {
            new Parser().parse(text, true);
            return '';
        } catch (error) {
            return error?.message || 'the script could not be read';
        }
    };
}

function failed(label, detail) {
    setErrorText(`The script in ${label} ${detail}`, SCRIPT_ERROR);
    notify();
}

let scopeClass = null;

function hostScopeClass() {
    if (scopeClass) {
        return scopeClass;
    }
    try {
        const Parser = SillyTavern.getContext()?.SlashCommandParser;
        const found = typeof Parser === 'function' ? new Parser().parse('/echo', true)?.scope?.constructor : null;
        scopeClass = typeof found === 'function' ? found : null;
    } catch {
        scopeClass = null;
    }
    return scopeClass;
}

function scopeOf(values) {
    const Scope = hostScopeClass();
    if (!Scope) {
        return null;
    }
    const scope = new Scope(null);
    for (const [key, value] of Object.entries(values)) {
        scope.letVariable(key, value);
    }
    return scope;
}

export function scriptRun(scope) {
    try {
        return scope?.existsVariable?.(RUN_KEY) ? runs.get(String(scope.getVariable(RUN_KEY))) ?? null : null;
    } catch {
        return null;
    }
}

export function runTarget(run) {
    const message = run?.message;
    if (!message) {
        return null;
    }
    const context = SillyTavern.getContext();
    if (context.getCurrentChatId() !== run.chatId) {
        return null;
    }
    if (hashText(message.mes) !== run.hash || (message.swipe_id ?? null) !== run.swipeId) {
        return null;
    }
    return message;
}

export async function runScript(hit, target = null) {
    const rule = hit?.rule ?? hit;
    const entries = hit?.entries ?? [];
    const script = fillEntries(String(rule?.script ?? '').trim(), entries);
    if (!script) {
        return;
    }
    const label = rule.label || rule.id;
    counter++;
    const token = `${Date.now().toString(36)}${counter.toString(36)}`;
    runs.set(token, {
        rule,
        entries,
        message: target,
        chatId: SillyTavern.getContext().getCurrentChatId(),
        hash: hashText(target?.mes),
        swipeId: target?.swipe_id ?? null,
    });
    let timer = null;
    try {
        const running = SillyTavern.getContext().executeSlashCommandsWithOptions(script, {
            handleParserErrors: false,
            handleExecutionErrors: false,
            scope: scopeOf({
                [RUN_KEY]: token,
                jeved_rule: String(rule.id ?? ''),
                jeved_entry: entries[0] ?? '',
                jeved_entries: entries.join('\n'),
                jeved_entries_json: JSON.stringify(entries),
            }),
        });
        const settled = Promise.resolve(running).then(() => null, error => error ?? new Error('The script failed.'));
        settled.then(() => runs.delete(token));
        const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), SCRIPT_LIMIT_MS); });
        const outcome = await Promise.race([settled, deadline]);
        if (outcome === TIMED_OUT) {
            toast('info', `The script in ${label} is still running after ${SCRIPT_LIMIT_MS / 1000} seconds, so Jeved stopped waiting for it.`);
            settled.then(late => {
                if (late) {
                    failed(label, `failed: ${describeError(late)}`);
                }
            });
        } else if (outcome) {
            throw outcome;
        }
    } catch (error) {
        runs.delete(token);
        failed(label, `failed: ${describeError(error)}`);
    } finally {
        clearTimeout(timer);
    }
}
