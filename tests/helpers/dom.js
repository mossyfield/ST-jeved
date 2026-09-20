const CLASS = /^\.([A-Za-z0-9_-]+)$/;

class Element {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.childNodes = [];
        this.className = '';
        this.textContent = '';
        this.dataset = {};
        this.style = {};
        this.hidden = false;
        this.parent = null;
        this.handlers = new Map();
    }

    get children() {
        return this.childNodes;
    }

    get childElementCount() {
        return this.childNodes.length;
    }

    get classList() {
        const names = () => this.className.split(/\s+/).filter(name => name);
        const write = list => { this.className = list.join(' '); };
        return {
            add: (...added) => write([...new Set([...names(), ...added])]),
            remove: (...gone) => write(names().filter(name => !gone.includes(name))),
            contains: name => names().includes(name),
            toggle: (name, on) => {
                const wanted = on === undefined ? !names().includes(name) : !!on;
                write(wanted ? [...new Set([...names(), name])] : names().filter(item => item !== name));
            },
        };
    }

    append(...added) {
        for (const child of added.filter(child => child)) {
            child.parent = this;
            this.childNodes.push(child);
        }
    }

    replaceChildren(...added) {
        this.childNodes = [];
        this.append(...added);
    }

    remove() {
        const at = this.parent ? this.parent.childNodes.indexOf(this) : -1;
        if (at >= 0) {
            this.parent.childNodes.splice(at, 1);
        }
    }

    contains(other) {
        return other === this || this.descendants().includes(other);
    }

    setAttribute(name, value) {
        this[name] = value;
    }

    getAttribute(name) {
        return this[name];
    }

    addEventListener(type, handler) {
        this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
    }

    matches(selector) {
        const found = CLASS.exec(selector);
        return found ? this.classList.contains(found[1]) : this.tagName === selector.toUpperCase();
    }

    descendants() {
        return this.childNodes.flatMap(child => [child, ...child.descendants()]);
    }

    querySelectorAll(selector) {
        return this.descendants().filter(item => item.matches(selector));
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    closest(selector) {
        for (let item = this; item; item = item.parent) {
            if (item.matches(selector)) {
                return item;
            }
        }
        return null;
    }

    fire(type, event = {}) {
        if (this.disabled) {
            return;
        }
        for (const handler of [...(this.handlers.get(type) ?? [])]) {
            handler({ type, target: this, preventDefault() {}, ...event });
        }
    }
}

export function installDom() {
    const body = new Element('body');
    globalThis.document = {
        body,
        activeElement: null,
        createElement: tag => new Element(tag),
        getElementById: () => null,
        querySelector: selector => body.querySelector(selector),
        querySelectorAll: selector => body.querySelectorAll(selector),
    };
    return body;
}

export function buttonNamed(root, caption) {
    return root.querySelectorAll('.jeved-btn')
        .find(item => item.querySelector('.jeved-btn-label')?.textContent === caption) ?? null;
}

export async function settle() {
    for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
    }
}
