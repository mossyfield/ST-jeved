# Contributing to Jeved

## Set up

- Clone `https://github.com/mossyfield/ST-jeved` into `data/<your user>/extensions/ST-jeved` in your
  SillyTavern install.
- There is no build step and there are no dependencies. Reload SillyTavern in the browser to load a
  change.

## Run the tests

- Run `node --test` in the extension folder. Use Node 20.11 or newer.
- The suite runs in about one second. Keep it that fast: no browser, no network, no long waits.
- `tests/helpers` has a host stub, a DOM stub and a stand-in STscript parser. Use them. Do not write
  another.
- Test behaviour: branches, edge cases, state changes, error paths. No test that only repeats the
  code.

## Code rules

- Write no code comments. If a line needs a comment, rename an identifier.
- Keep the logic pure. Only these places can use `SillyTavern` or `document`: `index.js`, `src/ui`,
  `src/engine`, `src/engine.js`, `src/settings.js`, `src/store.js` and `src/instructions.js`. A
  pure module that needs the host takes it as an argument, as `src/reroll.js` does.
- Use an existing helper before you write a new one. Shared numbers are in `src/limits.js`. Shared
  functions are in `src/util.js`.
- User-facing text: short noun labels, the unit in the label, few hints, one plain sentence for each
  hint. Use the word "sensor", not "signal".

## Where to make a change

- A new rule action. Add one entry to `ACTIONS` in `src/actions.js`. Validation, the rule form and
  the rule texts read its fields (`usesDirective`, `needsScript`, `needsReplySensor`, `runsInGroup`, `about`), so
  put the behaviour there and do not branch on the action id in another module. An action that runs
  before the generation needs no engine change. Reroll and Run script run after the reply, and
  `afterReply` in `src/engine/decide.js` handles each of them by name, so a third one needs a
  change there. `style.css` names nudge and reroll for the chart marks and the badge.
- A sensor's moment. A sensor with `assistant` at 0 is measured on the user's message inside the
  generate interceptor. Any other sensor is measured on the reply. `momentOf` and `momentOfRule` in
  `src/sensors.js` decide this. A rule is evaluated on the history of its moment (`getHistory` in
  `src/store.js`). Decisions and firing receipts are stored on the user message, answers on the
  message that was measured.
- A new sensor type. Add one entry to `SENSOR_TYPES` in `src/sensor-types.js`. Validation and the
  classifier read from that list. Then make the sensor pane in `src/ui/sensors-tab.js` show the
  fields that the type needs.
- A new context group. Add one entry to `src/context-groups.js`, with `since` set to the schema
  version that adds it. Read its text in `src/instructions.js`. A new group stays off in presets
  that already exist.
- A new host. If it uses the same wire format, add one entry to `HOSTS` in `src/classifier.js`. A
  host that blocks browser calls needs a SillyTavern proxy route as its `endpoint` and a `hint` that
  says so. The TypeSafe entry is the example. A different wire format needs a second `provider`
  object in the same file, a provider picker in Settings, and generic text where the UI names Jev.
- A new field. Add its default to `blankSensor` or `blankRule` in `src/defaults.js`. Import keeps
  only the fields that are there. Increase `SCHEMA_VERSION` in `src/limits.js`. Add one entry to
  `MIGRATIONS` in `src/presets.js`, keyed by the version you migrate from, that gives older presets
  the default. The built-in presets in `src/defaults.js` carry the current version. Add a
  check to `validatePreset` if the field needs one. Jeved must never change settings or files from
  a newer schema.

## Propose a change

- For a bug, open an issue at `https://github.com/mossyfield/ST-jeved/issues`. Write what you did,
  what happened, what you expected, and what the status chip showed. Give your SillyTavern version,
  your browser, and the console output.
- For a feature, open an issue first. Send a pull request with one change and its tests.
- Do not paste your API key. Read each preset or chat excerpt before you paste it.
