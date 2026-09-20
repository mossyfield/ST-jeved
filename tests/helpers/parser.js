import { ALLOWED_COMMANDS } from '../../src/script-gate.js';

const ALIASES = {
    '#': '/',
    addchatvar: 'addvar',
    call: 'run',
    cont: 'continue',
    decchatvar: 'decvar',
    exec: 'run',
    flushchatvar: 'flushvar',
    getchatvar: 'getvar',
    image: 'imagine',
    img: 'imagine',
    imp: 'impersonate',
    incchatvar: 'incvar',
    length: 'len',
    nar: 'sys',
    'qr-presetadd': 'qr-set-create',
    regen: 'regenerate',
    return: 'pass',
    sd: 'imagine',
    setchatvar: 'setvar',
    sleep: 'delay',
    wait: 'delay',
};

const REFUSED = [
    'ask', 'breakpoint', 'buttons', 'closure-deserialize', 'closure-serialize', 'comment', 'continue',
    'delay', 'gen', 'genraw', 'impersonate', 'import', 'inject', 'input', 'parser-flag', 'pick-icon',
    'popup', 'qr', 'qr-create', 'qr-set-create', 'regenerate', 'run', 'send', 'sendas', 'summarize',
    'swipe', 'sys', 'sysgen', 'translate', 'trigger',
];

const KNOWN = new Set([...ALLOWED_COMMANDS, ...REFUSED, ...Object.keys(ALIASES)]);

const SPLIT = new Map([['if', 0], ['while', 0], ['times', 1]]);

const NAMED_ARG = /([A-Za-z_][A-Za-z0-9_-]*)=/y;

function canonical(name) {
    return ALIASES[name] ?? name;
}

function textValue(raw) {
    return { text: raw, macro: raw.includes('{{') };
}

class Reader {
    constructor(text) {
        this.text = text;
        this.index = 0;
        this.commands = [];
    }

    get char() {
        return this.text[this.index];
    }

    get done() {
        return this.index >= this.text.length;
    }

    at(symbol, ahead = 0) {
        return this.text.startsWith(symbol, this.index + ahead);
    }

    take() {
        return this.text[this.index++];
    }

    space() {
        while (!this.done && /\s/.test(this.char)) {
            this.index++;
        }
    }

    commandEnd() {
        return this.done || this.at('|') || this.at(':}');
    }

    quoted() {
        let raw = this.take();
        while (!this.done && this.char !== '"') {
            raw += this.char === '\\' ? this.take() + (this.take() ?? '') : this.take();
        }
        return raw + (this.done ? '' : this.take());
    }

    namedArgument() {
        NAMED_ARG.lastIndex = this.index;
        const found = NAMED_ARG.exec(this.text);
        if (!found) {
            return null;
        }
        this.index = NAMED_ARG.lastIndex;
        return { name: found[1], value: this.singleValue() };
    }

    singleValue() {
        if (this.at('{:')) {
            return this.closureValue();
        }
        if (this.char === '"') {
            return textValue(this.quoted());
        }
        let raw = '';
        while (!this.done && !/\s/.test(this.char) && !this.commandEnd()) {
            raw += this.char === '\\' ? (this.index++, this.take()) : this.take();
        }
        return textValue(raw);
    }

    closureValue() {
        const value = { closure: this.closure(false) };
        if (this.at('()')) {
            this.index += 2;
        }
        return value;
    }

    blob() {
        let raw = '';
        while (!this.commandEnd() && !this.at('{:')) {
            if (this.char === '"') {
                raw += this.quoted();
            } else if (this.char === '\\') {
                this.index++;
                raw += this.take() ?? '';
            } else {
                raw += this.take();
            }
        }
        return raw;
    }

    unnamedArguments(name) {
        const values = [];
        const limit = SPLIT.get(name);
        const flush = raw => {
            if (raw.trim()) {
                values.push(textValue(raw.trim()));
            }
        };
        if (limit === undefined) {
            let raw = '';
            while (!this.commandEnd()) {
                if (this.at('{:')) {
                    flush(raw);
                    raw = '';
                    values.push(this.closureValue());
                } else {
                    raw += this.blobStep();
                }
            }
            flush(raw);
            return values;
        }
        while (!this.commandEnd()) {
            this.space();
            if (this.commandEnd()) {
                break;
            }
            if (this.at('{:')) {
                values.push(this.closureValue());
            } else if (limit && values.length >= limit) {
                flush(this.blob());
            } else if (this.char === '"') {
                flush(this.quoted().replace(/^"|"$/g, ''));
            } else {
                let raw = '';
                while (!this.done && !/\s/.test(this.char) && !this.commandEnd()) {
                    raw += this.take();
                }
                flush(raw);
            }
        }
        return values;
    }

    blobStep() {
        if (this.char === '"') {
            return this.quoted();
        }
        if (this.char === '\\') {
            this.index++;
            return this.take() ?? '';
        }
        return this.take();
    }

    command() {
        this.index++;
        let typed = '';
        while (!this.done && !/\s/.test(this.char) && !this.commandEnd()) {
            typed += this.take();
        }
        this.space();
        if (!KNOWN.has(typed)) {
            throw new Error(`Unknown command at position ${this.index - typed.length}: "/${typed}"`);
        }
        const step = { typed, name: canonical(typed), named: [], unnamed: [] };
        for (let arg = this.namedArgument(); arg; arg = this.namedArgument()) {
            step.named.push(arg);
            this.space();
        }
        if (!this.commandEnd()) {
            step.unnamed = this.unnamedArguments(step.name);
        }
        this.commands.push(step);
        return step;
    }

    marker(typed, skip, until) {
        this.index += skip;
        while (!this.done && !until()) {
            this.index++;
        }
        const step = { typed, name: canonical(typed), named: [], unnamed: [] };
        this.commands.push(step);
        return step;
    }

    closure(root) {
        const closure = { args: [], steps: [] };
        if (!root) {
            this.index += 2;
        }
        this.space();
        for (let arg = this.namedArgument(); arg; arg = this.namedArgument()) {
            closure.args.push(arg);
            this.space();
        }
        while (!(root ? this.done : this.at(':}'))) {
            const before = this.index;
            if (this.done) {
                throw new Error(`Unclosed closure at position ${this.index}`);
            }
            if (this.at('/*')) {
                this.marker('*', 2, () => this.at('*|'));
                this.index += 2;
            } else if (this.at('//') || this.at('/#')) {
                this.marker(this.text[this.index + 1], 2, () => this.at('|'));
            } else if (this.at('/parser-flag ')) {
                this.marker('parser-flag', 13, () => this.commandEnd());
            } else if (this.at('/:') && !this.at(':}', 1)) {
                this.marker(':', 2, () => this.commandEnd()).name = 'run';
            } else if (this.at('/')) {
                closure.steps.push(this.command());
            } else {
                while (!this.commandEnd()) {
                    this.index++;
                }
            }
            this.space();
            if (this.at('|')) {
                this.index++;
                if (this.at('|')) {
                    this.index++;
                }
                this.space();
            }
            if (this.index === before) {
                this.index++;
            }
        }
        if (!root) {
            this.index += 2;
        }
        return closure;
    }
}

export function stubParser() {
    return text => {
        const reader = new Reader(String(text));
        try {
            return { error: '', commands: reader.commands, ...reader.closure(true) };
        } catch (error) {
            return { error: error.message };
        }
    };
}

function hostValue(value) {
    return value.closure ? hostClosure(value.closure) : value.text;
}

function hostStep(step) {
    return {
        name: step.typed,
        command: { name: step.name },
        namedArgumentList: step.named.map(arg => ({ name: arg.name, value: hostValue(arg.value) })),
        unnamedArgumentList: step.unnamed.map(value => ({ value: hostValue(value) })),
    };
}

function hostClosure(closure) {
    return {
        argumentList: closure.args.map(arg => ({ name: arg.name, value: hostValue(arg.value) })),
        executorList: closure.steps.map(hostStep),
    };
}

export function hostParserClass(onAdd) {
    const parse = stubParser();
    return class StubSlashCommandParser {
        static commands = {};

        static addCommandObject(command) {
            onAdd(command);
        }

        parse(text) {
            const walk = parse(text);
            if (walk.error) {
                throw new Error(walk.error);
            }
            this.commandIndex = walk.commands.map(hostStep);
            return hostClosure(walk);
        }
    };
}
