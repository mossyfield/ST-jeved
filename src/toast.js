const SAFE = { escapeHtml: true };

export function toast(kind, message, title = 'Jeved') {
    globalThis.toastr?.[kind]?.(String(message ?? ''), title, SAFE);
}
