export function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function clamp(value, { min, max, fallback }) {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

export function scoreText(value, missing = 'not measured') {
    return typeof value === 'number' && Number.isFinite(value)
        ? String(Math.round(value * 10) / 10)
        : missing;
}

export function raceTimeout(task, limitMs, value) {
    let timer = null;
    const limit = new Promise(resolve => { timer = setTimeout(() => resolve(value), limitMs); });
    return Promise.race([task, limit]).finally(() => clearTimeout(timer));
}

export function hashText(text) {
    const value = String(text ?? '');
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}
