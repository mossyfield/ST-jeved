# Jeved

Jeved is a SillyTavern extension. It uses Jev, a small and cheap decision model, to read the
messages in your chat and answer questions that you write. A rule on the answers can add one line to
the prompt, reroll the reply, or run an STscript.

Some things you can build with it:

- Pacing. Tell the narrator to make something happen when the story has been calm for several
  replies, or to slow down when each reply is a new crisis.
- Same-turn steering. Read the message you are sending and shape the reply to it, before the reply
  is written.
- Rerolls. Reroll a reply when the narrator speaks for your character, contradicts the character
  card, or includes something that you do not want in your story.
- Genre and voice. Correct the narrator when a horror story stops being frightening, or when a
  character stops sounding like their card.
- A world that pushes back. Notice when your character's actions never fail and never cost
  anything, and ask for a setback.
- Scene automation with STscript. Change the background when the location changes, make a picture
  at a dramatic moment, switch to a stronger model for an important scene, or keep a variable such
  as a danger level up to date.
- Measurement only. Put a mood or a relationship on the Activity chart and see how it moves through
  the chat. Tick "Measure anyway" in the sensor form to measure a sensor that no rule uses. The
  built-in Closeness sensor is an example.

Any question that Jev can answer from the text can be a sensor. The answer is a score, a choice
from your list, or the chance that a statement is true. The built-in preset rerolls a reply that
speaks for your character, and it watches attention, repeated wording, tone and pacing. It also
shapes each reply to the kind of scene your message asks for. You can change it, write your own,
and share a preset as one file.

When no rule matches, Jeved adds nothing to your prompt, so you do not need a list of standing
instructions that costs tokens on every turn. Jev costs a fraction of a cent for each reply.

## Install

Jeved needs SillyTavern 1.18.0 or newer.

1. In SillyTavern, open the Extensions panel and press "Install extension". Paste
   `https://github.com/mossyfield/ST-jeved`.
2. Open the Jeved drawer in the Extensions panel. Pick a host and paste its API key.
3. Press Test. Jeved makes one small call to check the key.
4. Tick "Enabled".

The built-in preset, Director, measures from the next reply. Press "Open Jeved" to see it.

## How it works

There are three sensor types.

- Score. You describe a scale of 2 to 10 steps. Jev answers with a number from 0 up. The answer can
  be between two steps, such as 1.4.
- Choice. You name 2 to 255 options. Jev answers with one option.
- Noul. You write a statement. Jev answers with the chance, from 0 to 100%, that the statement is
  true.

Each sensor chooses what Jev reads with three controls: "User messages", "Assistant messages" and
"Context". The counts go from 0 to 50 and at least one must be above 0. Name the text in your
question: `latest_turn` is the newest reply, `player_message` is your newest message, `history`
holds the older messages the counts asked for, oldest first, and `context` is the card and the
prompts you ticked under "Context sent to Jev".

"Assistant messages" also decides when the sensor runs, and the form says which it is. At 1 or more
it runs after each reply and judges that reply. At 0 it runs before the reply, on the message you
are sending, so a rule on it can steer that same reply.

A rule fires when its conditions match on N of the last M messages it reads. A condition tests one
sensor. Score and Noul use "below" or "above" a value. Choice uses "is" or "is not" an option. A
Score or Choice condition can also require a minimum confidence. If the host sends no confidence for
an answer, that condition does not match there.

An example from the built-in preset. The Tension sensor asks "How much tension or pressure is in
`latest_turn`?" on a scale from "None. Everyone is relaxed and safe." to "Extreme. Someone faces
disaster right now." The Change sensor asks how much the situation changes. The Flat rule, which is
off until you turn it on, fires when 3 of the last 4 replies have Change below 2.5 and Tension below
1.5. It then adds this line to your
next message: "The story has been calm for many turns. In this reply, something puts {{user}} under
pressure or tension. How is your choice. Do not resolve it in this reply."

A rule can also have an exception, a cooldown, and a script. The order of the rules is the priority,
with the first rule highest. The cooldown is the only limiter: after a rule fires it waits that many
replies before it can fire again. Other rules are not affected.

There are three actions.

- Nudge. Jeved adds the instruction to the copy of the message that goes into the prompt. It does
  not change your message in the chat, so old instructions do not collect in the context.
- Reroll. Jeved swipes the reply one time and adds the instruction to that generation. Jeved rerolls
  at most one time for each of your turns, so a rule cannot loop. Jeved cancels the reroll if you
  start to type, edit the reply, swipe, or change chat. Rerolls do not run in group chats. A reroll
  rule needs at least one sensor that reads an assistant message.
- Run script. Jeved runs the rule's script right after the reply is measured, so the script acts on
  the reply that made the rule fire. It adds no instruction and does not change the reply by itself.
  It runs one time for each reply text, it obeys the cooldown, it needs a sensor that reads an
  assistant message, and it works in group chats.

## Same-turn steering

The built-in preset carries four Scene rules, on from the start. The Scene sensor is a Choice with
"Assistant messages" at 0, so it reads only the message you are sending and answers combat,
conversation, travel, intimate or downtime before the reply is written.

Four rules read it, each on the latest message. "Scene: combat" adds "Write this reply as short,
fast beats. One exchange only. Do not end the fight in this reply." "Scene: conversation", "Scene:
travel" and "Scene: intimate" do the same for their kind of scene. Send a message that asks for a
fight, and the instruction is in that same generation. A downtime message adds nothing.

A sensor that runs before the reply costs one extra API call on each of your messages, and it cannot
see the previous reply. Jeved waits at most 3 seconds for the answer. If it is late, the reply goes
out without the instruction and the chip in the drawer says so.

## Writing good sensors and instructions

Sensors:

- Ask about one thing. If a question contains "and", split it into two sensors.
- Use general terms. "How much tension or pressure is in the reply" works for every story. "Is
  someone holding a knife" works for one scene.
- Ask what the text shows. Put the decision in a rule.
- Name the text in backticks, such as `latest_turn`. The hint below the question box lists the
  names.
- For a Score sensor, write a scale with no gaps and no overlap. The first step means none. The last
  step means the most possible.
- Name something visible at each step. "A real setback. The character fails, is refused, or loses
  ground" gives better answers than "medium".
- For a Choice sensor, keep the options far enough apart that no reply fits two of them.

Instructions:

- Describe the result you want in the story. Do not mention Jeved or a sensor's answer. Bad: "Your
  tension score has been below 1.5 for four replies, raise it."
- Ask for one change, in this reply. Use one or two sentences.
- Let the narrator choose the method. "How is your choice" gives a scene that fits the story.
- Say what the narrator must not do when that matters. "Do not resolve it in this reply" stops the
  narrator from starting and ending a problem in one paragraph.

Tuning:

- Play 20 to 30 replies, then read the chart on the Activity tab. Find a sensor whose answer changes
  together with the problem you want to correct.
- A sensor that gives the same answer to each reply carries no information. Rewrite it.
- Preview on a rule applies your draft to the answers that the chat already has, with no API call.
  Use it to set the threshold.

## Hosts, cost, and privacy

The host picker fills in the endpoint and the model for OpenRouter, NanoGPT and TypeSafe. Pick
"Custom" to type your own.

- TypeSafe blocks calls from a browser, so its entry goes through the SillyTavern CORS proxy. Set
  `enableCorsProxy: true` in your SillyTavern `config.yaml`. This route does not work when your
  SillyTavern server uses basic authentication.
- OpenRouter reports the cost of each call. The other hosts report tokens only.

Sensors with the same "User messages", "Assistant messages" and "Context" settings share one API
call. The Cost section on the Settings tab lists the calls and the sensors in each. The built-in
preset makes three calls for each reply and one call for each of your messages.

A failed call never stops your chat. Jeved decides with the answers that it has. If a measurement is
still in progress when you send a message, Jeved waits at most 2 seconds for it.

Jeved sends nothing until you tick Enabled, press Test, or press a Measure button. "Pause for this
chat" blocks all of them in that chat. `/jeved-ask` is a manual command and sends its one call in
any case. Each call goes to the endpoint you set, and it contains only:

- the messages that the sensor asked for, which can be replies, your own messages, or both
- the character card, your persona and the prompts that you ticked under "Context sent to Jev" in
  Settings, when the sensor has Context on. Preview there shows the exact text.
- the questions and descriptions of the sensors. Jeved resolves SillyTavern macros in them first, so
  `{{user}}` sends your persona name.

Jeved stores the API key as plain text in your SillyTavern settings file. Use a key that you can
revoke. Jeved stores the answers and its decisions on the messages in the chat file. It stores
nothing outside SillyTavern.

## Presets and sharing

A preset contains the sensors, the rules and the context checklist. The preset buttons are on the
Settings tab.

- Export writes one JSON file. The file never contains your key, endpoint or model.
- Import lists each problem it finds in the file. It never replaces a preset. If the name is in use,
  the new preset gets a number after its name.
- An update of Jeved keeps the sensors and rules of your presets as you made them. Press "Restore
  built-in" to load the new Director preset. Duplicate your copy first if you changed it.
- Answers are stored for each sensor, not for each preset, so they stay when you switch preset. If
  you edit a sensor so that a stored answer no longer fits it, that answer reads as "not measured".

## Scripts

A rule can run an STscript when it fires, with the instruction or in place of it. The script is
ordinary STscript. It runs on its own, and it can do anything that you can do from the chat box,
so the responsibility for it is yours.

- Jeved refuses to save a rule whose script SillyTavern cannot parse.
- Imported rules that have a script arrive turned off. The import dialog shows each script in full.
  Read it before you turn the rule on.
- Jeved waits at most 5 seconds for a script. Then the generation continues while the script runs.

When the script runs depends on the action of the rule:

- Nudge, on a rule that reads replies: when you send your next message, before the generation.
- Nudge, on a rule that reads only your message: before the reply to that message.
- Reroll: after the reply, before the swipe.
- Run script: right after the reply is measured.

The Picture rule in the built-in preset is an example. It uses the Run script action, it is off,
and it needs an image backend. Two conditions must hold on the same reply: the Striking image
sensor above 3.6, and the Happening now sensor above 50%, so the picture is of the scene in front
of you and not of a memory or a plan.

```
/imagine scene
```

`/imagine` posts the picture into the chat as a message. Add `quiet=true` if you do not want that.

The Mood rule is a second example. It is off, it needs character sprites, and it runs
`/expression-set {{jeved::mood}}` with the emotion that the Mood sensor picked for the reply.

A Run script rule can run a Quick Reply:

```
/run QuickReplySet.MyRewrite
```

It can also run the slash command of another extension. `{{jeved::sensor_id}}` in a script gives the
newest answer of that sensor.

## Slash commands

- `/jeved` opens the workspace. `/jeved activity` opens it on that tab.
- `/jeved-nudge rule=<rule id>` adds the instruction of that rule to your next message one time,
  even when the rule does not match.
- `/jeved-pause on` stops Jeved in this chat. `/jeved-pause off` starts it again.
- `/jeved-rescan count=<n>` measures the recent messages that have no answer. The count applies to
  your messages and to replies separately. It asks first.
- `/jeved-get <sensor id>` returns the newest answer Jeved holds for that sensor in this chat. It
  makes no API call.
- `/jeved-ask <question>` makes one call and returns the answer without storing it. It works while
  the chat is paused. The named arguments are `type=score|choice|noul` (noul by default),
  `options="a,b,c"` for a choice, `levels="a|b|c"` for a score, `user=<n>` (0), `assistant=<n>` (1)
  and `context=true|false` (false). With `assistant=0` it asks about your newest message. On any
  problem it shows a message and returns an empty text.

## Macro

`{{jeved::<sensor id>}}` gives the newest answer that Jeved has for that sensor in this chat.

- Score: the number with one decimal, such as `2.4`.
- Choice: the option name.
- Noul: a whole percent, such as `85`.
- No answer yet: an empty text.

In a rule instruction, Jeved replaces the macro itself. This works with each macro engine. In a
message, a Quick Reply or an STscript argument, the macro needs the default SillyTavern macro engine.
That engine is on unless you turned it off.

## For coding agents

An agent with file access can edit presets directly. They are in the SillyTavern settings file,
`data/<user>/settings.json`, at `extension_settings.jeved.presets["<preset name>"]`. The same object
holds the API key. Do not print it or copy it.

1. Ask the user to close every SillyTavern tab. An open tab overwrites your edit when it saves.
2. Edit only the `jeved.presets` part of the file. `blankSensor` and `blankRule` in
   `src/defaults.js` show the fields and the defaults. The built-in preset in the same file is a
   complete example. Give each new sensor and rule a unique `id`. If you rename a Choice option,
   also change the rule conditions that use the old name.
3. Validate the preset. Run this in the extension folder:

   ```
   node --input-type=module -e "import { readFileSync } from 'node:fs'; import { validatePreset } from './src/presets.js'; const [file, name] = process.argv.slice(1); console.log(validatePreset(JSON.parse(readFileSync(file, 'utf8')).extension_settings.jeved.presets[name]));" ../../settings.json Director
   ```

   `[]` means the preset is valid. Any other output lists each problem. Only the app checks scripts.
4. Ask the user to open SillyTavern again.

To share a preset, write a file for the user to import. Export a preset to see the exact shape.

## Uninstall

Open the Extensions panel, find Jeved and delete it. Tick "Also clean up extension data" in the
confirmation dialog to remove the Jeved settings, including the API key. If you do not tick it, the
settings and the key stay in the SillyTavern settings file.

The answers and decisions that Jeved wrote on your messages stay in the chat files. "Clear answers"
on the Activity tab removes the answers from the current chat.

## Licence

MIT. See [LICENSE](LICENSE).
