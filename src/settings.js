import { DEFAULT_ACTION, isKnownAction } from './actions.js';
import { provider } from './classifier.js';
import { BUILT_IN, builtInPresets } from './defaults.js';
import { CONTEXT_CAP, MAX_NUDGES, NUDGE_GAP, RULE_COOLDOWN, RULE_COUNTS, TIMEOUT_MS, TURNS } from './limits.js';
import { SCHEMA_VERSION, isReservedKey, normaliseContextGroups, presetVersion, stampVersion, upgradePreset } from './presets.js';
import { normaliseCondition, normaliseSensor } from './sensor-types.js';
import { clamp, isRecord } from './util.js';

const settingsKey = 'jeved';
const EMPTY_PRESET = {
    description: '', sensors: [], rules: [], contextGroups: {},
    gap: NUDGE_GAP.fallback, maxNudges: MAX_NUDGES.fallback,
};

let schemaAhead = 0;
let shadow = null;

const defaultSettings = Object.freeze({
    schema: SCHEMA_VERSION,
    enabled: false,
    endpoint: provider.defaults.endpoint,
    model: provider.defaults.model,
    apiKey: '',
    timeoutMs: TIMEOUT_MS.fallback,
    instructionsCap: CONTEXT_CAP.fallback,
    showBadge: true,
    activePreset: BUILT_IN,
    presets: builtInPresets,
});

const NUMBERS = { timeoutMs: TIMEOUT_MS, instructionsCap: CONTEXT_CAP };
const PRESET_NUMBERS = { gap: NUDGE_GAP, maxNudges: MAX_NUDGES };
const SENSOR_NUMBERS = { turns: TURNS, measureEvery: TURNS };

export function normalisePreset(preset) {
    stampVersion(preset);
    normaliseContextGroups(preset);
    for (const [key, spec] of Object.entries(PRESET_NUMBERS)) {
        preset[key] = clamp(preset[key], spec);
    }
    preset.description = String(preset.description ?? '');
    preset.sensors = (Array.isArray(preset.sensors) ? preset.sensors : []).filter(isRecord);
    preset.rules = (Array.isArray(preset.rules) ? preset.rules : []).filter(isRecord);

    preset.sensors = preset.sensors.filter(sensor => !isReservedKey(sensor.id));
    preset.rules = preset.rules.filter(rule => !isReservedKey(rule.id));

    for (const sensor of preset.sensors) {
        sensor.id = String(sensor.id ?? '');
        sensor.label = String(sensor.label ?? '');
        sensor.watch = !!sensor.watch;
        sensor.includeContext = !!sensor.includeContext;
        sensor.includeUser = !!sensor.includeUser;
        for (const [key, spec] of Object.entries(SENSOR_NUMBERS)) {
            sensor[key] = clamp(sensor[key], spec);
        }
        normaliseSensor(sensor);
    }

    for (const rule of preset.rules) {
        rule.id = String(rule.id ?? '');
        rule.label = String(rule.label ?? '');
        rule.action = String(rule.action ?? DEFAULT_ACTION);
        rule.enabled = !!rule.enabled && isKnownAction(rule.action);
        rule.conditions = (Array.isArray(rule.conditions) ? rule.conditions : []).filter(isRecord);
        rule.window = clamp(rule.window, RULE_COUNTS);
        rule.need = Math.min(clamp(rule.need, RULE_COUNTS), rule.window);
        rule.cooldown = clamp(rule.cooldown, RULE_COOLDOWN);
        rule.directive = String(rule.directive ?? '');
        rule.script = String(rule.script ?? '');
        if (!isRecord(rule.skipWhen)) {
            rule.skipWhen = null;
        }
        for (const condition of [...rule.conditions, rule.skipWhen]) {
            if (condition) {
                normaliseCondition(condition, preset.sensors.find(sensor => sensor.id === condition.sensor) ?? null);
            }
        }
    }
    return preset;
}

export function normaliseSettings(settings) {
    for (const [key, spec] of Object.entries(NUMBERS)) {
        settings[key] = clamp(settings[key], spec);
    }
    settings.enabled = !!settings.enabled;
    settings.showBadge = !!settings.showBadge;

    if (!isRecord(settings.presets)) {
        settings.presets = structuredClone(builtInPresets);
    }
    for (const [name, preset] of Object.entries(settings.presets)) {
        if (!isRecord(preset) || isReservedKey(name)) {
            delete settings.presets[name];
            continue;
        }
        normalisePreset(preset);
    }
    if (!Object.keys(settings.presets).length) {
        settings.presets = structuredClone(builtInPresets);
    }
    if (!Object.hasOwn(settings.presets, String(settings.activePreset ?? ''))) {
        settings.activePreset = Object.keys(settings.presets)[0];
    }
    return settings;
}

function storedPresets(settings) {
    return Object.values(isRecord(settings.presets) ? settings.presets : {}).filter(isRecord);
}

function storedVersion(settings) {
    const stated = Number(settings.schema);
    if (Number.isFinite(stated) && stated >= 1) {
        return Math.trunc(stated);
    }
    const presets = storedPresets(settings);
    return presets.length ? Math.min(...presets.map(presetVersion)) : SCHEMA_VERSION;
}

export function schemaProblem() {
    return schemaAhead
        ? `A newer Jeved wrote these settings (schema ${schemaAhead}), so Jeved does not change them. Update Jeved to use them.`
        : '';
}

export function initSettings() {
    const context = SillyTavern.getContext();
    if (!isRecord(context.extensionSettings[settingsKey])) {
        context.extensionSettings[settingsKey] = structuredClone(defaultSettings);
        context.saveSettingsDebounced();
    }
    const settings = context.extensionSettings[settingsKey];
    const version = storedVersion(settings);
    schemaAhead = version > SCHEMA_VERSION ? version : 0;
    shadow = schemaAhead ? structuredClone(settings) : null;
    if (schemaAhead) {
        return shadow;
    }
    for (const preset of storedPresets(settings)) {
        upgradePreset(preset);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(defaultSettings[key]);
        }
    }
    settings.schema = SCHEMA_VERSION;
    normaliseSettings(settings);
    if (version !== SCHEMA_VERSION) {
        context.saveSettingsDebounced();
    }
    return settings;
}

export function getSettings() {
    return schemaAhead ? shadow : SillyTavern.getContext().extensionSettings[settingsKey];
}

export function getPreset(settings = getSettings()) {
    const presets = isRecord(settings?.presets) ? settings.presets : {};
    const name = String(settings?.activePreset ?? '');
    const found = Object.hasOwn(presets, name) ? presets[name] : Object.values(presets)[0];
    return isRecord(found) ? found : EMPTY_PRESET;
}

export function saveSettings() {
    if (schemaAhead) {
        return;
    }
    SillyTavern.getContext().saveSettingsDebounced();
}
