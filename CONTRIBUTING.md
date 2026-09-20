# Contributing to Jeved

## Get the code

- Clone `https://github.com/mossyfield/ST-jeved` into your SillyTavern install, under
  `data/<your user>/extensions/ST-jeved`. An install from the Extensions panel uses the same folder,
  so you can also work in that folder.
- There is no build step and there are no dependencies. SillyTavern loads `index.js` directly from
  the folder.
- Reload SillyTavern in the browser to load a change.

## Run the tests

- Run `node --test` in the extension folder. Use Node 20.11 or newer.
- The full suite runs in less than one second. Keep it that fast. The tests use no browser, no
  network. Waits are a few milliseconds.
- `tests/helpers` contains one host stub, one DOM stub and one stand-in STscript parser. Use them.
  Do not write another. The stand-in parser supports only what the cases in `tests/gate-cases.js`
  need. If a gate change depends on parser detail, also check it in SillyTavern.
- Test behaviour: branches, edge cases, state changes, error paths. Do not write a test that only
  repeats the code.

## Code rules

- Write no code comments. If a line needs a comment, rename an identifier. Delete a comment that
  only repeats the code.
- These modules must not use `SillyTavern` or `document`: `src/actions.js`,
  `src/rules.js`, `src/sensors.js`, `src/presets.js`, `src/classifier.js`, `src/describe.js`,
  `src/util.js`, `src/limits.js`, `src/script-gate.js` and `src/context-groups.js`.
  `src/reroll.js` follows the same rule. It takes a host object as an argument and does not access the host
  directly. Keep all of them pure, so that the tests need no stub for them. Each other module
  outside `src/ui` is a host adapter:
  - `src/settings.js` reads and writes the stored settings object.
  - `src/store.js` reads and writes fields on chat messages.
  - `src/instructions.js` reads the prompt manager and the character card.
  - `src/engine/status.js` reads chat metadata and the event bus.
  - `src/engine/measure.js` calls the classifier and saves the chat.
  - `src/engine/decide.js` drives generation and reads `document.getElementById('send_textarea')`.
  - `src/engine/scripts.js` parses a rule script with the host parser and runs it. `scriptParser`
    converts a parsed closure into the plain structure that `src/script-gate.js` checks. Each
    function that needs the gate takes `scriptParser` as an argument.
  The DOM code is in `src/ui`. `index.js` connects the host.
- Use an existing helper before you write a new one. Shared numbers are in `src/limits.js`. Shared
  functions are in `src/util.js`.
- User-facing text: short noun labels, the unit in the label, few hints, one plain sentence for each
  hint. Use the word "sensor". Do not use "signal".

## Where to make a change

- A new rule action. Add one entry to `src/actions.js`. Validation and normalisation read from that
  list. A new before-generation action needs no other change in `src/engine/decide.js`, because
  `beforeGeneration` dispatches by phase. The after-reply phase hardcodes the reroll, so a second
  after-reply action also needs changes to `maybeReroll` and `rerollHost`. Also change:
  - `src/describe.js`: `stripChart` has columns for a nudge field and a reroll field only, by name.
    `badgeFor` labels each non-swipe badge as the default action.
  - `src/ui/rules-tab.js`: the action picker has a special case for the reroll action that sets a
    one-reply window.
  - `src/ui/activity-tab.js`: the strip draws an icon only for `item.nudge` or `item.reroll`.
  - `style.css`: the classes `jeved-badge--reroll`, `jeved-mark--reroll` and `jeved-mark--nudge`
    style those two actions. A different action needs its own class.
  The tests are `tests/rules.test.js`, `tests/describe.test.js`, `tests/reroll.test.js`,
  `tests/engine.test.js` and `tests/engine-chat.test.js`.
- A command that a rule script can run. Add one name to `ALLOWED_COMMANDS` in `src/script-gate.js`.
  That list is the complete policy for command names. Use the name that SillyTavern registers, not
  an alias, because the gate resolves aliases through the command object of the parser. Add a
  command only if its callback cannot do any of these: run a string as script, start a generation,
  call a model, post or edit a chat message, store a script. `/imagine` is the one exception, and
  the gate requires `quiet=true` on it. If the command takes a closure, also
  add an entry to `CLOSURE_ONLY`. The gate then requires a literal closure and checks the commands
  inside it. In both cases, add a line to the list in `tests/gate-cases.js`. That list is the entry
  point for the gate tests.
- A new context group. Add one entry to `src/context-groups.js`, with `since` set to the schema
  version that adds it. Read its text in `src/instructions.js`. The Settings checklist, the preset
  defaults and the preview labels come from the list. `since` keeps the new group off in presets
  that already exist.
- A new classifier provider. The wire format is only in `src/classifier.js`, in the `provider`
  object (`buildRequest`, `classify`, `testRequest`, `defaults`). Sensors build provider-neutral
  questions. The provider converts them into the wire body and reads the answer. There is no
  provider selection. There is one hardcoded provider, OpenRouter with the Jev model. Outside
  `src/classifier.js`, these files name OpenRouter or Jev: `src/engine/status.js` (the error text),
  `src/ui/drawer.js` (the first-run hint), and `src/ui/settings-tab.js`, `src/ui/sensors-tab.js`
  and `src/ui/dialogs.js` (labels and hints that say "Jev"). A second provider needs generic text
  in all of those files and a provider picker in Settings.
- A new schema version. A new field needs a default in `blankSensor` or `blankRule` in
  `src/defaults.js`. `src/presets.js` reads those defaults to select the fields that an import
  keeps. Increase `SCHEMA_VERSION` in `src/presets.js`. If the change is a new context group, set
  its `since` to the new version in `src/context-groups.js`. Add one entry to `MIGRATIONS`, keyed by
  the version you migrate from. The entry supplies the defaults that were implicit at the old
  schema. For example, `upgradeSensor` fills the reading fields from the old `scope` field, and
  `historicalDefaults` turns on each context group that existed at the old version and leaves a new
  group off. Normalisation also sets a context group that is missing from the stored list of a
  preset to off, so a new group stays off without a migration. Add a check to `validatePreset` if
  the field needs one. `src/settings.js` uses the stored `schema` number (`storedVersion`) to decide
  whether to migrate. It runs `upgradePreset` one time for each preset, then `normalisePreset` and
  `normaliseSettings`. `stampVersion` writes the new version. Migrations run one time when settings
  load and one time on import. They do not run on save. Jeved does not change settings or files
  from a newer schema.

## Report a problem

- Open an issue at `https://github.com/mossyfield/ST-jeved/issues`.
- Write what you did, what happened, what you expected, and what the status chip showed.
- Give your SillyTavern version, your browser, and the console output if there was an error.
- Do not paste your API key. Read each preset or chat excerpt before you paste it.
