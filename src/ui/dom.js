const FULL_RANGE = { min: 0, max: 1, step: 0.1, decimals: 1 };

export function clampNumber(value, min, max, decimals = 0) {
    const factor = 10 ** decimals;
    const number = Math.round(Number(value) * factor) / factor;
    return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : min;
}

export function detach(result) {
    if (result && typeof result.then === 'function') {
        result.catch(error => console.error('Jeved', error));
    }
}

export function node(tag, className, props = {}) {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    Object.assign(element, props);
    return element;
}

export function text(tag, className, value) {
    return node(tag, className, { textContent: String(value ?? '') });
}

function classes(...names) {
    return names.filter(name => name).join(' ');
}

export function activates(event, disabled) {
    if (disabled) {
        return false;
    }
    return event?.type === 'click' || event?.key === 'Enter' || event?.key === ' ';
}

export function activate(element, onClick) {
    const run = event => {
        if (activates(event, element.classList.contains('disabled'))) {
            detach(onClick(event));
        }
    };
    element.addEventListener('click', run);
    element.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            run(event);
        }
    });
    return element;
}

export function row(...children) {
    const element = node('div', 'jeved-row');
    element.append(...children.filter(child => child));
    return element;
}

export function column(className, ...children) {
    const element = node('div', classes('jeved-column', className));
    element.append(...children.filter(child => child));
    return element;
}

export function actions(...children) {
    const element = node('div', 'jeved-actions');
    element.append(...children.filter(child => child));
    return element;
}

export function help(line) {
    return text('div', 'jeved-hint', line);
}

export function button(caption, title, onClick, { variant = '', icon = '' } = {}) {
    const element = node('button', classes('menu_button', 'jeved-btn', variant && `jeved-btn--${variant}`), {
        type: 'button',
        title: title ?? caption,
    });
    if (icon) {
        element.append(node('i', `fa-solid ${icon}`));
    }
    element.append(text('span', 'jeved-btn-label', caption));
    element.addEventListener('click', event => detach(onClick(event)));
    return element;
}

export function iconButton(icon, title, onClick) {
    const element = node('button', `menu_button jeved-btn jeved-btn--icon fa-solid ${icon}`, { type: 'button', title });
    element.addEventListener('click', event => detach(onClick(event)));
    return element;
}

export function busy(element, working) {
    element.classList.toggle('disabled', !!working);
    element.disabled = !!working;
}

export function withReason(element, reason) {
    busy(element, !!reason);
    if (!reason) {
        return element;
    }
    const wrap = node('span', 'jeved-blocked');
    wrap.append(element, note(reason));
    return wrap;
}

export function toggle(checked, title, onChange) {
    const input = node('input', 'jeved-toggle', { type: 'checkbox', checked: !!checked, title });
    input.addEventListener('change', () => onChange(input.checked));
    return input;
}

export function checkbox(caption, checked, onChange) {
    const label = node('label', 'checkbox_label jeved-check-label');
    const input = node('input', '', { type: 'checkbox', checked: !!checked });
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, text('span', '', caption));
    return label;
}

export function field(type, value, placeholder, onChange, { min, max, step, clamp } = {}) {
    const input = node('input', 'text_pole jeved-input', { type, value: value ?? '', placeholder });
    if (type === 'number') {
        input.step = step ?? 'any';
        input.classList.add('jeved-number');
        if (min !== undefined) {
            input.min = String(min);
        }
        if (max !== undefined) {
            input.max = String(max);
        }
    }
    input.addEventListener('input', () => onChange(type === 'number' ? Number(input.value) : input.value));
    if (clamp) {
        input.addEventListener('change', () => {
            const clamped = clamp(input.value);
            input.value = String(clamped);
            onChange(clamped);
        });
    }
    return input;
}

export function area(value, placeholder, rows, onChange) {
    const element = node('textarea', 'text_pole textarea_compact jeved-area', { value: value ?? '', placeholder, rows });
    element.addEventListener('input', () => onChange(element.value));
    return element;
}

function fillOptions(select, options, value) {
    const known = options.some(option => option.value === value);
    const list = known || !value ? [...options] : [...options, { value, label: `${value} (missing)` }];
    select.replaceChildren(...list.map(option => node('option', '', {
        value: option.value,
        textContent: option.label,
    })));
    select.value = list.some(option => option.value === value) ? value : (list[0]?.value ?? '');
}

export function picker(options, value, onChange) {
    const element = node('select', 'text_pole jeved-picker');
    fillOptions(element, options, value);
    element.addEventListener('change', () => onChange(element.value));
    return element;
}

export function segmented(options, value, onChange) {
    const group = node('div', 'jeved-segmented');
    const paint = current => {
        for (const child of group.children) {
            child.classList.toggle('jeved-segment--on', child.dataset.jevedValue === current);
        }
    };
    for (const option of options) {
        const item = node('button', 'jeved-segment', { type: 'button', title: option.label, textContent: option.label });
        item.dataset.jevedValue = option.value;
        item.addEventListener('click', () => {
            paint(option.value);
            detach(onChange(option.value));
        });
        group.append(item);
    }
    paint(value);
    return group;
}

const exact = value => Math.round(value * 1e6) / 1e6;

export function slider(value, onChange, { range = null, label = '' } = {}) {
    const span = { ...FULL_RANGE, ...range };
    const factor = span.percent ? 100 : 1;
    const min = exact(span.min * factor);
    const max = exact(span.max * factor);
    const step = exact(span.step * factor);
    const decimals = span.percent ? 0 : span.decimals;
    const fix = raw => clampNumber(raw, min, max, decimals);
    const report = shown => onChange(exact(shown / factor));
    const wrap = node('div', 'jeved-slider');
    const bar = node('input', 'jeved-range', {
        type: 'range', min: String(min), max: String(max), step: String(step), value: String(fix(value * factor)), title: label,
    });
    const box = node('input', 'text_pole jeved-input jeved-number', {
        type: 'number', min: String(min), max: String(max), step: String(step), value: String(fix(value * factor)), title: label,
    });
    bar.addEventListener('input', () => {
        const next = fix(bar.value);
        box.value = String(next);
        report(next);
    });
    box.addEventListener('input', () => {
        const typed = Number(box.value);
        if (Number.isFinite(typed) && typed >= min && typed <= max) {
            bar.value = String(typed);
            report(fix(typed));
        }
    });
    box.addEventListener('change', () => {
        const next = fix(box.value);
        box.value = String(next);
        bar.value = String(next);
        report(next);
    });
    wrap.append(bar, box);
    return wrap;
}

export function formRow(label, control, hint = '', { wide = false } = {}) {
    const roomy = wide || control?.tagName === 'TEXTAREA' || !!control?.querySelector?.('textarea');
    const wrap = node('div', classes('jeved-form-row', roomy && 'jeved-form-row--wide'));
    wrap.append(text('label', 'jeved-form-label', label));
    const side = node('div', 'jeved-form-control');
    side.append(control);
    if (hint) {
        side.append(help(hint));
    }
    wrap.append(side);
    return wrap;
}

export function section(title, ...children) {
    const block = node('section', 'jeved-section');
    if (title) {
        block.append(text('h4', 'jeved-section-title', title));
    }
    block.append(...children.filter(child => child));
    return block;
}

export function fold(caption, ...children) {
    const element = node('details', 'jeved-fold');
    element.append(text('summary', 'jeved-fold-head', caption), ...children.filter(child => child));
    return element;
}

export function chip(caption, kind = '', title = '') {
    const element = text('span', classes('jeved-chip', kind && `jeved-chip--${kind}`), caption);
    if (title) {
        element.title = title;
    }
    return element;
}

export function tag(caption, kind = '', title = '') {
    const element = text('span', classes('jeved-tag', kind && `jeved-tag--${kind}`), caption);
    if (title) {
        element.title = title;
    }
    return element;
}

export function problemBlock() {
    return node('div', 'info-block error jeved-problems', { hidden: true });
}

export function showProblems(block, problems) {
    block.replaceChildren(...problems.map(problem => text('div', '', problem)));
    block.hidden = !problems.length;
}

export function editing(root) {
    const active = document.activeElement;
    return !!active && root.contains(active) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
}

export function setLabel(element, caption) {
    const label = element.querySelector('.jeved-btn-label');
    if (label) {
        label.textContent = caption;
    }
}

export function note(line) {
    return text('span', 'jeved-try-note', line);
}

export function toolbar(...children) {
    const bar = node('div', 'jeved-try-bar');
    bar.append(...children.filter(child => child));
    return bar;
}

function tryRow(item) {
    const line = node('div', 'jeved-try-row');
    const mark = node('div', 'jeved-try-mark');
    mark.append(text('span', 'jeved-try-index', `#${item.index}`));
    if (item.tag) {
        mark.append(tag(item.tag));
    }
    if (item.note) {
        mark.append(note(item.note));
    }
    line.append(mark, text('div', 'jeved-try-text', item.text));
    return line;
}

export function resultsBox({ clearable = true } = {}) {
    const heading = text('span', 'jeved-try-title', '');
    const rows = node('div', 'jeved-try-rows');
    const element = node('div', 'jeved-try-box', { hidden: true });

    const api = {
        element,
        show(headline, items, emptyLine = '') {
            heading.textContent = headline;
            const children = items.map(tryRow);
            if (!children.length && emptyLine) {
                children.push(text('div', 'jeved-try-empty', emptyLine));
            }
            rows.replaceChildren(...children);
            element.hidden = false;
        },
        foot(line) {
            rows.append(text('div', 'jeved-try-empty', line));
        },
        warn(line) {
            rows.append(text('div', 'jeved-try-empty jeved-try-empty--warn', line));
            element.hidden = false;
        },
        fail(line) {
            api.show('', []);
            api.warn(line);
        },
        clear() {
            heading.textContent = '';
            rows.replaceChildren();
            element.hidden = true;
        },
    };

    if (clearable) {
        const head = node('div', 'jeved-try-head');
        head.append(heading, iconButton('fa-xmark', 'Clear these results', () => api.clear()));
        element.append(head);
    }
    element.append(rows);
    return api;
}
