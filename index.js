import { rescanSentence } from './src/describe.js';
import { cancelRescan, forceRule, initEngine, isRescanning, measureBlockReason, onCharacterMessage, onChatChanged, planMeasurement, rescan, setPaused } from './src/engine.js';
import { getPreset, initSettings } from './src/settings.js';
import { toast } from './src/toast.js';
import { initBadges, refreshBadges } from './src/ui/badge.js';
import { ask } from './src/ui/dialogs.js';
import { addDrawer } from './src/ui/drawer.js';
import { openWorkspace } from './src/ui/workspace.js';

export function jevedCleanUp() {
    const host = SillyTavern.getContext();
    delete host.extensionSettings.jeved;
    host.saveSettingsDebounced();
}

const context = SillyTavern.getContext();

function openSafely(tab) {
    openWorkspace(tab).catch(error => console.error('Jeved: the workspace could not open.', error));
}

function addWandButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        return;
    }
    const item = document.createElement('div');
    item.id = 'jeved_wand_button';
    item.classList.add('list-group-item', 'flex-container', 'flexGap5');
    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-sliders', 'extensionsMenuExtensionButton');
    const label = document.createElement('span');
    label.textContent = 'Jeved';
    item.append(icon, label);
    item.addEventListener('click', () => openSafely());
    menu.append(item);
}

function addCommands() {
    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name: 'jeved',
        helpString: 'Open the Jeved workspace. Give a tab name to open that tab.',
        returns: 'the tab that was opened',
        unnamedArgumentList: [
            context.SlashCommandArgument.fromProps({
                description: 'the tab to open',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'rules',
                enumList: ['rules', 'sensors', 'activity', 'settings'].map(name => new context.SlashCommandEnumValue(name)),
            }),
        ],
        callback: (_args, value) => {
            const tab = String(value ?? 'rules').trim().toLowerCase() || 'rules';
            openSafely(tab);
            return tab;
        },
    }));

    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name: 'jeved-nudge',
        helpString: 'Make one rule nudge your next message, even when the rule does not match. This applies to one message, and it is cancelled when you change chat.',
        returns: 'the forced rule id',
        namedArgumentList: [
            context.SlashCommandNamedArgument.fromProps({
                name: 'rule',
                description: 'The id of the rule to use.',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        callback: (args) => {
            const id = String(args.rule ?? '').trim();
            const rule = getPreset().rules.find(item => item.id === id);
            if (!rule) {
                throw new Error(`No rule is named ${id}.`);
            }
            forceRule(rule.id);
            toast('info', `Jeved will add the ${rule.id} instruction to your next message.`);
            return rule.id;
        },
    }));

    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name: 'jeved-pause',
        helpString: 'Pause Jeved in this chat, or start it again. Jeved measures nothing while a chat is paused.',
        returns: 'boolean',
        unnamedArgumentList: [
            context.SlashCommandArgument.fromProps({
                description: 'on to pause this chat, off to start again',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'on',
                enumList: [
                    new context.SlashCommandEnumValue('on'),
                    new context.SlashCommandEnumValue('off'),
                ],
            }),
        ],
        callback: (_args, value) => {
            const word = String(value ?? 'on').trim().toLowerCase();
            if (word !== 'on' && word !== 'off') {
                throw new Error('Use /jeved-pause on or /jeved-pause off.');
            }
            setPaused(word === 'on');
            return String(word === 'on');
        },
    }));

    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name: 'jeved-rescan',
        helpString: 'Measure the recent replies that have no score. Run the command again while it works to stop it.',
        returns: 'the number of replies measured',
        namedArgumentList: [
            context.SlashCommandNamedArgument.fromProps({
                name: 'count',
                description: 'The number of recent replies to check.',
                typeList: [context.ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                defaultValue: '20',
            }),
        ],
        callback: async (args) => {
            if (isRescanning()) {
                cancelRescan();
                toast('info', 'Rescan stopped.');
                return '0';
            }
            const blocked = measureBlockReason();
            if (blocked) {
                throw new Error(blocked);
            }
            const count = Math.max(1, Math.round(Number(args.count) || 20));
            const plan = planMeasurement({ limit: count });
            if (!plan.tasks.length) {
                toast('info', 'Every recent reply is already measured.');
                return '0';
            }
            if (!await ask(`Measure ${plan.tasks.length} replies? That costs ${plan.calls} API calls.`)) {
                return '0';
            }
            const counts = await rescan(plan.tasks);
            toast(counts.failed ? 'warning' : 'success', rescanSentence(counts));
            return String(counts.measured);
        },
    }));
}

(function initExtension() {
    initSettings();
    initEngine();
    initBadges();

    context.eventSource.on(context.eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterMessage);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        onChatChanged();
        refreshBadges();
    });

    addCommands();
    addWandButton();
    addDrawer();
})();
