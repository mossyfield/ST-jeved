import { checkScript } from '../presets.js';
import { toast } from '../toast.js';
import { SCRIPT_ERROR, describeError, notify, setErrorText } from './status.js';

const SCRIPT_LIMIT_MS = 5000;
const TIMED_OUT = Symbol('timed out');

function valueOf(value) {
    if (value && Array.isArray(value.executorList)) {
        return { closure: closureOf(value) };
    }
    const text = String(value ?? '');
    return { text, macro: text.includes('{{') };
}

function stepOf(executor) {
    return {
        typed: String(executor?.name ?? ''),
        name: String(executor?.command?.name ?? executor?.name ?? ''),
        named: (executor?.namedArgumentList ?? []).map(arg => ({ name: String(arg?.name ?? ''), value: valueOf(arg?.value) })),
        unnamed: (executor?.unnamedArgumentList ?? []).map(arg => valueOf(arg?.value)),
    };
}

function closureOf(closure) {
    return {
        args: (closure?.argumentList ?? []).map(arg => ({ name: String(arg?.name ?? ''), value: valueOf(arg?.value) })),
        steps: (closure?.executorList ?? []).map(stepOf),
    };
}

export function scriptParser() {
    const Parser = SillyTavern.getContext()?.SlashCommandParser;
    if (typeof Parser !== 'function') {
        return null;
    }
    return text => {
        const parser = new Parser();
        let closure = null;
        try {
            closure = parser.parse(text, true);
        } catch (error) {
            return { error: error?.message || 'the script could not be read' };
        }
        return {
            error: '',
            commands: (parser.commandIndex ?? []).map(stepOf),
            ...closureOf(closure),
        };
    };
}

function failed(label, detail) {
    setErrorText(`The script in ${label} ${detail}`, SCRIPT_ERROR);
    notify();
}

export async function runScript(rule) {
    const script = String(rule?.script ?? '').trim();
    if (!script) {
        return;
    }
    const label = rule.label || rule.id;
    const problem = checkScript(script, scriptParser());
    if (problem) {
        failed(label, `didn't run. ${problem}`);
        return;
    }
    let timer = null;
    try {
        const running = SillyTavern.getContext().executeSlashCommandsWithOptions(script, {
            handleParserErrors: false,
            handleExecutionErrors: false,
        });
        const settled = Promise.resolve(running).then(() => null, error => error ?? new Error('The script failed.'));
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
        failed(label, `failed: ${describeError(error)}`);
    } finally {
        clearTimeout(timer);
    }
}
