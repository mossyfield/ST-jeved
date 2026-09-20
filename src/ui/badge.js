import { DEFAULT_ACTION, actionOf } from '../actions.js';
import { badgeFor, levelText, ruleLabel, scoreLine } from '../describe.js';
import { JEVED_UPDATED } from '../engine.js';
import { getPreset, getSettings, saveSettings } from '../settings.js';
import { getScores, narratorIndices } from '../store.js';
import { toast } from '../toast.js';
import { activate, column, node, text } from './dom.js';

const BADGE_CLASS = 'jeved-badge';

function scoreLines(chat, item) {
    const preset = getPreset();
    const stored = item.entries[0]?.scores;
    let scores = stored && Object.keys(stored).length ? stored : null;
    if (!scores) {
        const source = narratorIndices(chat, { from: item.index, limit: 1 })[0];
        scores = source === undefined ? null : getScores(chat[source])?.scores;
    }
    if (!scores) {
        return ["Those scores aren't saved any more."];
    }
    return preset.sensors
        .filter(sensor => typeof scores[sensor.id] === 'number')
        .map(sensor => scoreLine(sensor, scores[sensor.id], {
            words: SillyTavern.getContext().substituteParams(levelText(sensor, scores[sensor.id])),
        }));
}

async function openDetails(item) {
    const context = SillyTavern.getContext();
    const preset = getPreset();
    const entry = item.entries[0];
    const action = actionOf(item.kind) ?? actionOf(DEFAULT_ACTION);
    const body = column('jeved-dialog');
    body.append(text('h3', '', `Jeved: ${ruleLabel(preset.rules, entry.rule)}`));
    if (action.badgeNote) {
        body.append(text('div', '', action.badgeNote));
    }
    body.append(text('h4', 'jeved-section-title', 'Scores'));
    for (const line of scoreLines(context.chat, item)) {
        body.append(text('div', 'jeved-detail-line', line));
    }
    body.append(text('h4', 'jeved-section-title', 'Why'));
    for (const one of item.entries) {
        body.append(text('div', 'jeved-detail-line', one.reason ?? ''));
    }
    body.append(text('h4', 'jeved-section-title', 'Instruction'));
    for (const one of item.entries) {
        body.append(text('pre', 'jeved-script-text', one.text ?? ''));
    }

    const result = await context.callGenericPopup(body, context.POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        allowVerticalScrolling: true,
        customButtons: action.replacesReply
            ? [{ text: 'Turn off this rule', result: context.POPUP_RESULT.CUSTOM1 }]
            : null,
    });
    if (result !== context.POPUP_RESULT.CUSTOM1) {
        return;
    }
    const rule = preset.rules.find(other => other.id === entry.rule);
    if (rule) {
        rule.enabled = false;
        saveSettings();
        toast('info', `Turned off the rule ${ruleLabel(preset.rules, entry.rule)}.`);
        context.eventSource.emit(JEVED_UPDATED);
    }
}

function paint(element, item) {
    const preset = getPreset();
    const action = actionOf(item.kind) ?? actionOf(DEFAULT_ACTION);
    const names = item.entries.map(entry => ruleLabel(preset.rules, entry.rule)).join(', ');
    let badge = element.querySelector(`.${BADGE_CLASS}`);
    if (!badge) {
        badge = node('div', BADGE_CLASS, { tabIndex: 0, title: 'See what Jeved did on this turn' });
        activate(badge, () => openDetails(badge.jevedItem));
        element.querySelector('.mes_block')?.append(badge);
    }
    badge.jevedItem = item;
    badge.classList.toggle('jeved-badge--reroll', action.replacesReply);
    badge.textContent = action.badgeTag ? `Jeved: ${action.badgeTag} (${names})` : `Jeved: ${names}`;
}

export function refreshBadges(index) {
    const chat = SillyTavern.getContext().chat;
    const show = getSettings().showBadge;
    const one = Number(index);
    const elements = Number.isFinite(one)
        ? [one, one + 1]
            .map(position => document.querySelector(`#chat .mes[mesid="${position}"]`))
            .filter(element => element)
        : [...document.querySelectorAll('#chat .mes')];

    for (const element of elements) {
        const item = show ? badgeFor(chat, Number(element.getAttribute('mesid'))) : null;
        if (item) {
            paint(element, item);
        } else {
            element.querySelector(`.${BADGE_CLASS}`)?.remove();
        }
    }
}

export function initBadges() {
    const context = SillyTavern.getContext();
    context.eventSource.on(JEVED_UPDATED, detail => refreshBadges(detail?.index));
    context.eventSource.on(context.eventTypes.USER_MESSAGE_RENDERED, refreshBadges);
    context.eventSource.on(context.eventTypes.MESSAGE_SWIPED, refreshBadges);
    context.eventSource.on(context.eventTypes.MORE_MESSAGES_LOADED, () => refreshBadges());
}
