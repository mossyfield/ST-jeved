# Jeved

Jeved is a SillyTavern extension. It sends chat messages to Jev, a small decision model, with
questions that you write. A rule reads the answers and acts: it adds one instruction to the prompt,
rerolls the reply, changes a list, or runs an STscript. When no rule matches, Jeved adds nothing.

What you can build:

- Pacing: ask for an event when the story stays calm.
- Steering: read the message you send and shape the reply to it.
- Rerolls: reroll a reply that speaks for your character or breaks a rule that you wrote.
- Voice: correct the narrator when the tone drifts from the card.
- State: keep an inventory, a quest log, or a meter for each character in a list.
- Automation: run an STscript to change the background, make a picture, or set a variable.

## Install

Needs SillyTavern 1.18.0 or later.

1. Extensions panel > "Install extension" > paste `https://github.com/mossyfield/ST-jeved`.
2. Open the Jeved drawer. Pick a host. Paste its API key.
3. Press Test. Jeved makes one small call to check the key.
4. Tick "Enabled".

"Open Jeved", the wand menu and `/jeved` open the workspace. It has five tabs: Rules, Sensors, Lists,
Activity, Settings. The built-in preset is Director. Open its rules to read what each one does.

## Sensors

A sensor is one question. There are three types.

- Score: you write a scale of 2 to 10 steps. The answer is a number from 0 to the last step, such as 1.4.
- Choice: you write 2 to 255 options. The answer is one option name.
- Noul: you write a statement. The answer is the chance, 0 to 100 percent, that it is true.

Jeved measures a sensor when an enabled rule uses it. Tick "Measure anyway" to measure a sensor
that no rule uses.

### What a sensor reads

- Three controls: "User messages" (0 to 50), "Assistant messages" (0 to 50), "Context".
- At least one count must be above 0.
- Names for the question: `latest_turn` (newest reply), `player_message` (your newest message),
  `history` (the older messages, oldest first), `context`.
- The hint below the question box lists the names that this sensor has.

### When it runs

- "Assistant messages" 1 or more: after each reply. The sensor reads that reply.
- "Assistant messages" 0: before the reply, on the message you send. A rule on it steers that same reply.
- A sensor that runs before the reply adds one call for each of your messages.
- Jeved waits at most 3 seconds for it. After that the reply goes out with no instruction.

### Context

- None: the sensor sends no context.
- Everything: the sensor sends each piece that is on and has text. This includes prompts that you add later.
- Custom: "Select Prompts" opens a checklist. The sensor sends the pieces that you tick.
- Chat completion API: the checklist is your prompt manager list, in its order, with its names.
  Chat History has no row. The character note is one more row at the end.
- Text completion API: the checklist is a fixed list of the same pieces.
- "(off)": the row is off in the prompt manager. "empty": the row has no text. You can tick both.
  Jeved sends them when they are on and have text.
- "not found": a piece that you ticked is not in the preset. Jeved keeps the tick and sends nothing.
- World info: the entries that the last generation activated, "before" and "after" positions only.
  A sensor that runs before the reply reads the entries of the turn before.
- Preview shows the exact text that the sensor sends.

## Rules

A rule fires when its conditions match on N of the last M messages that it reads.

- A condition tests one sensor. Score and Noul: "below" or "above". Choice: "is" or "is not".
- A Score or Choice condition can need a minimum confidence. Noul answers have no confidence.
- An exception blocks the rule when the latest message matches it.
- A cooldown holds the rule for that many replies after it fires. It does not affect other rules.
- Rule order is priority. The first reroll rule that matches is the one reroll of the turn.
- Preview in the rule form applies your draft to the stored answers. It makes no API call.

A rule has one action.

- Nudge: adds the instruction to the copy of your message in the prompt. Your message in the chat
  does not change.
- Reroll: swipes the reply one time and adds the instruction to that generation. One reroll for each
  of your turns. Cancelled when you type, edit, swipe or change chat. Does not run in group chats.
- Add to list, Remove from list: change one list of this chat. See "Lists".
- Run script: runs the rule's script after the reply is measured. One time for each reply text.
  Runs in group chats.
- Reroll and Run script need a sensor that reads a reply.

## Lists

A list is a named set of text lines. Each chat keeps its own entries.

- The Lists tab declares a list and edits its entries. The same entries block is in the sensor form
  and in the rule form, so you can edit a list where you use it.
- A list carries a description. It says what one entry holds. End it with "Example: ..." and that
  example becomes the placeholder of the add box.
- Each entry carries a tag: "every chat" is in the preset, "this chat" you added here, "added by a
  rule" a rule added.
- The add box has a switch, "Add to: This chat | Every chat". Every chat writes the entry into the
  preset at once.
- Remove follows the tag. A this-chat or rule entry goes out of this chat. An every-chat entry goes
  out of the preset.
- An every-chat entry that this chat dropped is struck through. Restore puts it back.
- With no chat open, only the every-chat entries show and the switch is fixed to Every chat.
- Two presets that declare the same name share the entries of the chat.
- A match ignores case and extra spaces. There is no cap.

A sensor that repeats over a list:

- Pick the list under "Repeat over list". Write `{{entry}}` in the question, the scale or the options.
- Jev answers one time for each entry, in the call that the sensor already makes.
- An empty list gives the sensor no questions. It adds nothing to the call.
- A rule on it tests each entry, and fires one time for the turn.
- The matching entries reach the instruction, the script and the list value as `{{entry}}` (first
  match), `{{entries}}` (one per line) and `{{entries_json}}`.
- A script also gets the variables `jeved_entry`, `jeved_entries`, `jeved_entries_json`, `jeved_rule`.
- Add to list and Remove from list take a list and a value. With the value `{{entry}}` they apply
  to each matching entry.
- Refused: a rule with repeating sensors over two lists, and a repeating sensor as an exception.

What rolls back:

- A change made by a rule belongs to the message that fired it. It is undone when that message is
  swiped away, edited or deleted. It comes back when you swipe back.
- A list command in a rule's script counts as a change made by that rule. Jeved drops it when the
  reply was swiped away or the chat changed before the command ran.
- A change made by you (Lists tab, or a command that you type) stays until you undo it. It wins
  over the rule changes of its turn.

Director declares one list, `house_rules`, with no entries. Write each entry as a rule the narrator
must follow, such as "No time skips." House rule rerolls a reply that breaks an entry.

## Activity

- The chart shows the last 20 replies, newest on the right. An amber answer met a rule's condition.
- A mark above a column means a rule nudged or rerolled on that turn. Pick a column for details.
- "Measure missing" measures the messages with no answer. It states the cost first.
- "Clear answers" removes every answer of this chat.
- A badge marks each message where a rule fired. Turn badges off on the Settings tab.

## Writing sensors and instructions

- Ask about one thing. Split a question with "and" into two sensors.
- Ask what the text shows. Put the decision in a rule.
- Use general terms. "How much tension is in `latest_turn`" works for every story.
- Score: no gaps and no overlap. The first step means none. Name something visible at each step.
- Choice: keep the options far apart.
- Instruction: describe the result you want in the story, for this reply, in one or two sentences.
  Do not mention Jeved. Say what the narrator must not do when that matters.
- Tuning: play 20 to 30 replies, then read the Activity chart. A sensor that gives the same answer
  to each reply carries no information. Rewrite it.
- Test in the sensor form measures the last 10 replies with your draft. It saves nothing.

## Hosts, cost and privacy

- The host picker sets the endpoint and the model for OpenRouter, NanoGPT and TypeSafe. "Custom"
  lets you type your own.
- TypeSafe needs the SillyTavern CORS proxy: set `enableCorsProxy: true` in `config.yaml`. This
  does not work with basic authentication.
- OpenRouter reports cost. The other hosts report tokens. A reply costs a fraction of a cent.
- Sensors with the same two counts and the same Context share one call. The Cost section on the
  Settings tab lists the calls.
- Jev takes about 32,000 tokens for each call. "Context cap (tokens)" limits the context.
- Over the cap, Jeved leaves out, in order: world info, chat examples, preset prompts (last first),
  persona, character note, scenario, personality. Then it cuts the description short. It never
  cuts the main prompt or the post-history prompt.
- A failed call never stops your chat. Jeved waits at most 2 seconds for a running measurement
  when you send a message.

Privacy:

- Jeved sends nothing until you tick Enabled or press a Test or Measure button. "Pause for this
  chat" blocks all calls in that chat, except `/jeved-ask`.
- Each call goes to the endpoint that you set. It holds the messages and the context that the
  sensor picked, and the questions of the sensors in that call.
- SillyTavern macros in a question are resolved first, so `{{user}}` sends your persona name.
- The API key is stored as plain text in your SillyTavern settings file. Use a key that you can revoke.
- Answers and decisions are stored on the messages in the chat file. Nothing is stored outside SillyTavern.

## Presets

A preset holds the lists, the sensors and the rules. The buttons are on the Settings tab.

- Export writes one JSON file with no key, endpoint or model.
- Import lists each problem in the file. It never replaces a preset.
- An imported rule with a script arrives off. Read the script before you turn the rule on.
- "Restore built-in" replaces your Director preset with the built-in one. Duplicate your copy first.
  An update of Jeved does not change your stored presets.
- Answers are stored for each sensor id, so they stay when you switch preset.
- Jeved refuses a preset file from a newer Jeved. With stored settings from a newer Jeved, it is
  read-only and the chip says "Newer settings". Update Jeved.

## Scripts

A rule can run an STscript when it fires. The script can do anything that you can do from the chat
box. Jeved refuses a script that SillyTavern cannot parse, and waits at most 5 seconds for it.

When it runs:

- Nudge on a rule that reads replies: when you send your next message.
- Nudge on a rule that reads only your message: before the reply to that message.
- Reroll: after the reply, before the swipe.
- Add to list, Remove from list: with the list change.
- Run script: after the reply is measured, after any reroll and list change of that turn.

Examples:

- `/imagine scene` posts a picture of the scene. Needs an image backend.
- `/expression-set {{jeved::mood}}` sets the sprite from a Choice sensor with the id `mood`.
- `/run QuickReplySet.MyRewrite` runs a Quick Reply.

## Slash commands

- `/jeved [tab]`: opens the workspace. The tab is rules, sensors, lists, activity or settings.
- `/jeved-nudge rule=<rule id>`: adds that rule's instruction to your next message one time. A chat
  change cancels it.
- `/jeved-pause on|off`: stops or starts Jeved in this chat.
- `/jeved-rescan count=<n>`: measures recent messages with no answer. Default 20. It asks first.
  Run it again to stop it.
- `/jeved-get <sensor id>`: the newest answer. No API call. `entry=<text>` reads one entry.
- `/jeved-list <name>`: the entries of the list, as a JSON array.
- `/jeved-list-add list=<name> <text>`, `/jeved-list-remove list=<name> <text>`: change a list.
- `/jeved-ask <question>`: one call. Returns the answer and stores nothing. Works while paused.
  - `type=score|choice|noul` (default noul)
  - `options="a,b,c"` for Choice, `levels="a|b|c"` for Score
  - `user=<n>` (default 0), `assistant=<n>` (default 1), `context=true|false` (default false)

## Macros

- `{{jeved::<sensor id>}}`: the newest answer. Score `2.4`. Choice: the option name. Noul: whole
  percent, `85`. No answer: empty.
- `{{jeved::<sensor id>::<entry>}}`: the answer for one entry of a repeating sensor.
- `{{jeved::<sensor id>}}` on a repeating sensor: one `entry: answer` line for each entry.
- `{{jeved-list::<list name>}}`: the entries, joined with commas.
- They work in an instruction, a message, a Quick Reply and an STscript argument. They need the
  SillyTavern macro engine, which is on by default.

## For automation

A tool with file access can edit presets in `data/<user>/settings.json`, at
`extension_settings.jeved.presets["<preset name>"]`. The same object holds the API key. Do not
print it or copy it.

1. Ask the user to close every SillyTavern tab. An open tab overwrites your edit.
2. Edit only `jeved.presets`. `blankSensor` and `blankRule` in `src/defaults.js` hold the fields.
   Give each sensor and rule a unique `id`.
3. Validate. Run this in the extension folder. `[]` means valid. Only the app checks scripts.

   ```
   node --input-type=module -e "import { readFileSync } from 'node:fs'; import { validatePreset } from './src/presets.js'; const [file, name] = process.argv.slice(1); console.log(validatePreset(JSON.parse(readFileSync(file, 'utf8')).extension_settings.jeved.presets[name]));" ../../settings.json Director
   ```

4. Ask the user to open SillyTavern again.

## Uninstall

- Extensions panel > Jeved > delete. Tick "Also clean up extension data" to remove the settings
  and the API key.
- Answers stay in the chat files. "Clear answers" on the Activity tab removes them for one chat.

## Licence

MIT. See [LICENSE](LICENSE).
