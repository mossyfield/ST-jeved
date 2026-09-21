# Contributing to Jeved

## Set up

- Clone `https://github.com/mossyfield/ST-jeved` into `data/<your user>/extensions/ST-jeved` of your
  SillyTavern install.
- There is no build step and there are no dependencies.
- Reload SillyTavern in the browser to load a change.

## Run the tests

- Run `node --test` in the extension folder. Use Node 20.11 or later.
- The suite takes about one second. Keep it that fast: no browser, no network, no long wait.
- `tests/helpers` holds a host stub, a DOM stub and a stand-in STscript parser. Use them. Do not
  write another.
- Test behaviour: branches, edge cases, state changes, error paths. Write no test that only repeats
  the code.

## Code rules

- Write no code comments. If a line needs a comment, rename an identifier.
- Keep the logic pure. Only these files reach `SillyTavern`, `document` or another host global:
  `index.js`, `src/ui`, `src/engine`, `src/engine.js`, `src/settings.js`, `src/store.js`,
  `src/instructions.js`, `src/macros.js` and `src/toast.js`. A pure module that needs the host takes
  it as an argument, as `src/reroll.js` does.
- Use an existing helper before you write a new one. Shared numbers are in `src/limits.js`. Shared
  functions are in `src/util.js`.
- User-facing text: short noun labels, the unit in the label, few hints, one plain sentence for each
  hint. Use the word "sensor", not "signal".

## Where to make a change

- A rule action. Add one entry to `ACTIONS` in `src/actions.js`. Validation, the rule form and the
  rule texts read its fields, so put the behaviour there and do not branch on the action id in
  another module. An action that fires after the reply also needs a runner in `AFTER_REPLY_RUNNERS`
  in `src/engine/decide.js`. `style.css` names nudge and reroll for the chart marks and the badge.
- A sensor's moment. `momentOf` and `momentOfRule` in `src/sensors.js` decide it. `phaseOfRule` in
  the same file decides when a rule acts.
- Anything about lists. `src/lists.js` holds the entry text rules and both writers. `src/sensors.js`
  expands a repeating sensor into one wire question per entry and maps the answers back.
  `src/engine/scripts.js` gives a script the scope that ties a list command to its rule and its
  message. A caller that needs the entries of the current chat builds one resolver with
  `listResolver(preset)` and hands it to the pure module it calls.
- A sensor type. Add one entry to `SENSOR_TYPES` in `src/sensor-types.js`. Validation and the
  classifier read from that list. Then make the sensor pane in `src/ui/sensors-tab.js` show the
  fields that the type needs.
- A context piece. It needs a label in `src/context-groups.js`, and a source and a place in the
  fixed order in `src/instructions.js`. `readContextGroups` is what a call sends and
  `contextChecklist` is what the sensor form lists. Add the piece to `MARKER_KEYS` when the prompt
  manager has a row for it, and to the cut order when the token cap may drop it.
- A host. If it uses the same wire format, add one entry to `HOSTS` in `src/classifier.js`. A host
  that blocks browser calls needs a SillyTavern proxy route as its `endpoint` and a `hint` that says
  so. The TypeSafe entry is the example. A different wire format needs a second `provider` object in
  the same file, a provider picker in Settings, and generic text where the UI names Jev.
- A preset field. Add its default to `blankSensor` or `blankRule` in `src/defaults.js`. Import keeps
  only the fields that are there. Raise `SCHEMA_VERSION` in `src/limits.js`. Add one entry to
  `MIGRATIONS` in `src/presets.js`, keyed by the version you migrate from, that gives older presets
  the default. Add a check to `validatePreset` if the field needs one. Jeved must never change
  settings or files that carry a newer schema.

## Propose a change

- For a bug, open an issue at `https://github.com/mossyfield/ST-jeved/issues`. Write what you did,
  what happened, what you expected, and what the status chip showed. Give your SillyTavern version,
  your browser, and the console output.
- For a feature, open an issue first. Send a pull request with one change and its tests.
- Do not paste your API key. Read each preset or chat excerpt before you paste it.
