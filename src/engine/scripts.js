import { SCRIPT_LIMIT_MS } from '../limits.js';
import { toast } from '../toast.js';
import { SCRIPT_ERROR, describeError, notify, setErrorText } from './status.js';

const TIMED_OUT = Symbol('timed out');

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

export async function runScript(rule) {
    const script = String(rule?.script ?? '').trim();
    if (!script) {
        return;
    }
    const label = rule.label || rule.id;
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
