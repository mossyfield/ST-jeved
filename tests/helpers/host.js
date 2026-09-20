import { hostParserClass } from './parser.js';

export function hostStub(overrides = {}) {
    const host = {
        chat: [],
        chatMetadata: {},
        extensionSettings: {},
        groupId: null,
        mainApi: 'openai',
        chatCompletionSettings: {},
        powerUserSettings: {},
        commands: [],
        saveCount: 0,
        getCurrentChatId: () => 'chat',
        saveChat: async () => {},
        saveSettingsDebounced: () => { host.saveCount++; },
        saveMetadataDebounced: () => {},
        substituteParams: value => String(value ?? ''),
        executeSlashCommandsWithOptions: async () => {},
        getCharacterCardFields: () => ({}),
        getTokenCountAsync: async value => String(value ?? '').length,
        callGenericPopup: async () => null,
        POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3 },
        POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001 },
        SlashCommandParser: hostParserClass(command => host.commands.push(command)),
        SlashCommand: { fromProps: props => props },
        SlashCommandArgument: { fromProps: props => props },
        SlashCommandNamedArgument: { fromProps: props => props },
        SlashCommandEnumValue: class { constructor(value) { this.value = value; } },
        ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number' },
        eventSource: { emit: () => {}, on: () => {}, removeListener: () => {} },
        eventTypes: {},
        ...overrides,
    };
    globalThis.SillyTavern = {
        getContext: () => host,
        libs: { lodash: { debounce: fn => Object.assign((...args) => fn(...args), { cancel() {} }) } },
    };
    globalThis.toastr ??= { info() {}, error() {}, success() {}, warning() {} };
    return host;
}
