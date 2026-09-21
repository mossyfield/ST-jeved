export const UNPARSABLE = '/echo ((';

const broken = text => String(text).includes('((');

export function stubParser() {
    return text => (broken(text) ? 'unexpected end of closure' : '');
}

class StubScope {
    constructor(parent = null) {
        this.parent = parent;
        this.variables = {};
        this.variableNames = [];
        this.macros = {};
    }

    get allVariableNames() {
        return [...this.variableNames, ...(this.parent?.allVariableNames ?? [])];
    }

    get macroList() {
        return [...Object.keys(this.macros).map(key => ({ key, value: this.macros[key] })), ...(this.parent?.macroList ?? [])];
    }

    getCopy() {
        const copy = new StubScope(this.parent);
        copy.variables = { ...this.variables };
        copy.variableNames = [...this.variableNames];
        return copy;
    }

    existsVariableInScope(key) {
        return Object.hasOwn(this.variables, key);
    }

    existsVariable(key) {
        return this.existsVariableInScope(key) || !!this.parent?.existsVariable(key);
    }

    letVariable(key, value) {
        if (this.existsVariableInScope(key)) {
            throw new Error(`Variable named "${key}" already exists.`);
        }
        this.variables[key] = value;
    }

    setVariable(key, value) {
        if (this.existsVariableInScope(key)) {
            this.variables[key] = value;
            return value;
        }
        if (this.parent) {
            return this.parent.setVariable(key, value);
        }
        throw new Error(`No such variable: "${key}"`);
    }

    getVariable(key, index = null) {
        if (!this.existsVariableInScope(key)) {
            if (!this.parent) {
                throw new Error(`No such variable: "${key}"`);
            }
            return this.parent.getVariable(key, index);
        }
        const held = this.variables[key];
        if (index === null || index === undefined) {
            return held?.trim?.() === '' || isNaN(Number(held)) ? held || '' : Number(held);
        }
        let value = held;
        try {
            value = JSON.parse(value);
        } catch {
            value = held;
        }
        const at = Number(index);
        const found = Number.isNaN(at) ? value?.[index] : value?.[at];
        return typeof found === 'object' ? JSON.stringify(found) : found ?? '';
    }
}

export function hostParserClass(onAdd) {
    return class StubSlashCommandParser {
        static addCommandObject(command) {
            onAdd(command);
        }

        parse(text) {
            if (broken(text)) {
                throw new Error('unexpected end of closure');
            }
            return { scope: new StubScope(null) };
        }
    };
}
