import { rescanSentence } from './src/describe.js';
import { ADD, REMOVE, listNames, listResolver, manualChange, ruleChange } from './src/lists.js';
import { momentCount } from './src/sensors.js';
import { MESSAGE_MOMENT } from './src/store.js';
import { askOnce, cancelRescan, describeError, forceRule, initEngine, invalidateMeasured, isRescanning, measureBlockReason, onCharacterMessage, onChatChanged, planMeasurement, rescan, saveChatSoon, scriptRun, runTarget, setPaused } from './src/engine.js';
import { answerText, askSensor, initMacros } from './src/macros.js';
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

function namedList(name) {
    const preset = getPreset();
    const wanted = String(name ?? '').trim();
    if (!listNames(preset).includes(wanted)) {
        throw new Error(`No list is named ${wanted}.`);
    }
    return { preset, name: wanted };
}

function changeList(args, value, op) {
    const { name } = namedList(args?.list);
    const text = String(value ?? '').trim();
    if (!text) {
        throw new Error('Give the entry to change.');
    }
    const run = scriptRun(args?._scope);
    if (run) {
        const target = runTarget(run);
        if (!target) {
            return '';
        }
        ruleChange(target, name, op, text);
        saveChatSoon();
    } else {
        manualChange(name, op, text);
    }
    invalidateMeasured();
    return text;
}

function listCommand(name, op, about) {
    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name,
        helpString: about,
        returns: 'the entry that was changed',
        namedArgumentList: [
            context.SlashCommandNamedArgument.fromProps({
                name: 'list',
                description: 'The name of the list, as the preset declares it.',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        unnamedArgumentList: [
            context.SlashCommandArgument.fromProps({
                description: 'the entry',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        callback: (args, value) => changeList(args, value, op),
    }));
}

function addListCommands() {
    listCommand('jeved-list-add', ADD, 'Add one entry to a Jeved list in this chat. A rule script writes a change that rolls back with the message it fired on; anywhere else the change stays until you take it out.');
    listCommand('jeved-list-remove', REMOVE, 'Take one entry out of a Jeved list in this chat. A rule script writes a change that rolls back with the message it fired on; anywhere else the change stays until you put the entry back.');

    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name: 'jeved-list',
        helpString: 'Return the entries of a Jeved list in this chat, as a JSON array.',
        returns: 'a JSON array of entries',
        unnamedArgumentList: [
            context.SlashCommandArgument.fromProps({
                description: 'the name of the list',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        callback: (_args, value) => {
            const { preset, name } = namedList(value);
            return JSON.stringify(listResolver(preset)(name));
        },
    }));
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
        helpString: 'Pause Jeved in this chat, or start it again. Jeved measures nothing while a chat is paused. /jeved-ask is a manual command and sends its one call in any case.',
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
        name: 'jeved-get',
        helpString: 'Return the newest answer Jeved holds for one sensor in this chat. It makes no API call.',
        returns: 'the answer, or an empty text',
        namedArgumentList: [
            context.SlashCommandNamedArgument.fromProps({
                name: 'entry',
                description: 'One entry of the list a repeating sensor runs over.',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            context.SlashCommandArgument.fromProps({
                description: 'the id of the sensor',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        callback: (args, value) => answerText(value, args?.entry ?? ''),
    }));

    addListCommands();

    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name: 'jeved-ask',
        helpString: 'Ask Jev one question about the newest reply, or about your newest message when assistant is 0. It makes one API call and stores nothing.',
        returns: 'the answer, or an empty text',
        namedArgumentList: [
            context.SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'The sensor type to use.',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'noul',
                enumList: ['score', 'choice', 'noul'].map(name => new context.SlashCommandEnumValue(name)),
            }),
            context.SlashCommandNamedArgument.fromProps({
                name: 'options',
                description: 'The options of a choice question, separated by commas.',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            context.SlashCommandNamedArgument.fromProps({
                name: 'levels',
                description: 'The score descriptions, lowest first, separated by vertical bars.',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            context.SlashCommandNamedArgument.fromProps({
                name: 'user',
                description: 'How many of your messages to send.',
                typeList: [context.ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                defaultValue: '0',
            }),
            context.SlashCommandNamedArgument.fromProps({
                name: 'assistant',
                description: 'How many replies to send. 0 asks about your newest message instead.',
                typeList: [context.ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                defaultValue: '1',
            }),
            context.SlashCommandNamedArgument.fromProps({
                name: 'context',
                description: 'Send the card and the prompts as well.',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'false',
                enumList: [new context.SlashCommandEnumValue('true'), new context.SlashCommandEnumValue('false')],
            }),
        ],
        unnamedArgumentList: [
            context.SlashCommandArgument.fromProps({
                description: 'the question or statement to ask',
                typeList: [context.ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        callback: async (args, value) => {
            try {
                return await askOnce(askSensor(args, value));
            } catch (error) {
                toast('error', describeError(error));
                return '';
            }
        },
    }));

    context.SlashCommandParser.addCommandObject(context.SlashCommand.fromProps({
        name: 'jeved-rescan',
        helpString: 'Measure the recent messages that have no answer. The count applies to your messages and to replies separately. Run the command again while it works to stop it.',
        returns: 'the number of messages measured',
        namedArgumentList: [
            context.SlashCommandNamedArgument.fromProps({
                name: 'count',
                description: 'How many recent messages of each kind to check.',
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
                toast('info', 'Every recent message is already measured.');
                return '0';
            }
            if (!await ask(`Measure ${momentCount(MESSAGE_MOMENT, plan.tasks.length)}? That costs ${plan.calls} API calls.`)) {
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
    initMacros();
    addWandButton();
    addDrawer();
})();
