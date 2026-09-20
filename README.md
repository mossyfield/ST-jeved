# Jeved

Jeved is a SillyTavern extension. The narrator is the model that writes the story. Jeved measures
each narrator reply. It sends an instruction to the narrator only when a rule matches.

A large preset sends every instruction to the narrator on every turn. Examples are "stay in tone",
"raise the tension" and "do not speak for the player". Most of those instructions are not needed on
most turns, and they take attention away from the character card.

Jeved replaces that list with rules. After each reply, Jeved sends a few sensors to a small decision
model named Jev. Each sensor is one question, and Jev answers it with a score from 0 to 4. When a
rule matches the scores, Jeved does one of two things. It adds one short instruction to the copy of
your next message that goes into the prompt, or it rerolls the reply. When no rule matches, Jeved
sends nothing to the narrator.

## Install and set up

1. In SillyTavern, open the Extensions panel. Press "Install extension". Paste the Git URL
   `https://github.com/mossyfield/ST-jeved`. Jeved needs SillyTavern 1.18.0 or newer. An older
   SillyTavern does not load it.
2. Open the Jeved drawer in the Extensions panel. Paste an OpenRouter API key.
3. Press Test. Jeved makes one small API call to check the key.
4. Tick "Enabled".

Jeved sends nothing until you tick Enabled, press Test, or press one of the Measure buttons. Pause
blocks all three in that chat.

The status chip in the drawer header shows the state of Jeved: Off, No API key, Waiting, Measured 12
replies, or an error with the next step.

## The workspace

The drawer contains the status chip, Enabled, Pause for this chat, the preset picker and the Open
Jeved button. All other controls are in the workspace. To open the workspace, press Open Jeved, use
the wand menu, or type `/jeved`. The workspace has four tabs.

- Rules. The list on the left is in priority order, with the highest priority at the top. Each row
  has two lines. The first line shows the switch, the name of the rule and its status. The second
  line shows the action and the conditions in short form. The pane on the right edits the selected
  rule. It opens with the rule in one sentence, and it holds Preview with a gauge of the latest
  score against the threshold, and the Move up, Move down and Delete rule buttons. Save and Revert
  are at the bottom of the pane.
- Sensors. One sensor is one question and five score descriptions. Each row shows the name and the
  latest score. A second line shows what the sensor reads and which rules use it. A sensor that no
  rule uses has a Measure anyway box on its row. The pane works the same way as on the Rules tab.
- Activity. A strip chart shows the last 20 replies, with one row for each measured sensor. A row
  above the chart marks the replies that a rule fired on. Click a column to see that reply, its
  scores, and which rules fired.
- Settings. This tab contains the connection, the context sent to Jev, the cost, the nudge limits
  and the preset.

If you switch preset while a rule or a sensor has unsaved changes, Jeved asks before it discards
them. The pane then opens the same item in the new preset.

## What Jev reads

Each sensor sets how much text Jev reads.

- History (replies). 1 sends the latest reply only. 5 sends the last five replies, oldest first.
- Include my messages. Off sends the replies only. On sends each reply with the message before it.
- Include context. On also sends the character card and the prompts.
- Interval (replies). 1 measures every reply. 3 measures every third reply, and Jeved carries the
  last score forward for the replies between.

"What Jev sees" below those fields shows these settings as one sentence. It also shows how many
tokens the call uses.

The question names the text in backticks. One reply is `latest_turn`. When your messages are
included, your message is `player_message`. Two or more replies are `latest_turns`. The character
card and the prompts are `context`.

The context is a checklist in Settings, and each preset has its own. The groups are: main prompt,
other preset prompts, character description, personality, scenario, character note, persona and
post-history prompt. Each row shows its size in tokens. Preview shows the exact text that Jeved
sends. Jev accepts about 32,000 tokens, so the context has a cap. When the context is over the cap,
Jeved removes complete groups in this order: other preset prompts, persona, character note,
scenario, personality. Then it shortens the character description. Jeved never shortens the main
prompt or the post-history prompt. The line below the checklist shows what Jeved removed. When a
later version of Jeved adds a group, that group is unticked in the presets you already have. Jeved
sends a new group only after you tick it.

## Cost

Sensors that have the same History, Include my messages and Include context settings share one API
call. For example, four sensors that read the latest reply use one call. Two more sensors that read
the last five replies with context use a second call. Settings shows how many calls the next reply
makes and which sensors are in each call. With the default model, one API call costs about $0.0005.

When a call fails or the connection is not set up, Jeved sends no instruction, and your chat is not
affected. Jeved does not block a generation. These three cases can add a short wait or an
instruction that you did not expect.

- If a measurement is still in progress when you send a message, Jeved waits up to 2 seconds for it.
  After that, Jeved decides with the scores it has.
- A rule script has 5 seconds. After 5 seconds, Jeved stops waiting and the generation continues.
  The script continues to run, and Jeved shows one message about it. Jeved does not count this as an
  error.
- A sensor with an Interval above 1 carries its last score forward. As a result, a rule can fire on
  a reply whose own measurement failed.

## Privacy

Jeved sends its own requests to one endpoint, which you set in Settings. The default is the
OpenRouter decisions API at `https://openrouter.ai/api/alpha/decisions`. If the endpoint is a plain
`http` address that is not on this machine, Settings shows a warning. With such an address, the key
and the chat text go over the network without encryption.

Jeved sends nothing until you tick Enabled, press Test, or press one of the Measure buttons. Each of
those buttons shows how many API calls it costs before you press it. Pause blocks all of them in
that chat, even when Enabled is ticked. Pause does not stop a rule script that already runs. Each
call contains:

- the last N replies for that sensor, where N is its History setting, and your messages with them
  when "Include my messages" is on
- the context groups that you ticked in Settings, when the sensor has "Include context" on: the main
  prompt, the other preset prompts, the character description, personality, scenario, character
  note, your persona and the post-history prompt
- the question and the five score descriptions of each sensor in that call. Jeved resolves macros
  in them first, so `{{user}}` sends your persona name.

Jeved sends nothing else from SillyTavern to the endpoint.

A rule script is the one exception to the one-endpoint rule. `/imagine` makes SillyTavern call your
image backend, and SillyTavern can call the narrator to write the picture prompt.

- Jeved stores the API key as plain text in your SillyTavern settings file. The key is also in each
  backup of that file. Use a key that you can revoke.
- Jeved stores scores on the messages in the chat file. It stores nothing outside SillyTavern.

## Presets and sharing

A preset contains the sensors, the rules, the context checklist and the nudge limits. A preset is
one file.

- Export writes `jeved-<name>.json`. The file never contains the key, the endpoint or the model.
- Import checks the file first and lists each problem it finds. If the file is valid, a dialog shows
  the name, the description, the rule labels and the full text of each script before Jeved adds the
  preset. Jeved turns off each imported rule that has a script.
- If the name is already in use, Jeved imports the preset as "<name> (2)". Import never replaces a
  preset.
- Import keeps only the fields that this version of Jeved knows. Unknown fields do not go into your
  settings.
- Jeved refuses a file from a newer Jeved with one message and does not change the file. Jeved
  handles settings from a newer Jeved the same way. It shows a message, stops measuring, and does
  not save over them.
- The Preset section of the Settings tab has Duplicate, Rename, Delete and Restore built-in.
- An update of Jeved does not change the Director preset that you already have. Press Restore
  built-in to get the new version. Duplicate your preset first if you changed it.

Jeved stores each score under its sensor id, not under a preset. If you switch preset, the scores
stay. When the scores in a chat come from a different preset, the Activity tab shows a message and a
button that measures the chat again.

## Scripts

A rule can run an STscript when it fires. The script can replace the instruction or run with it.

The script runs inside the turn that is about to generate. Jeved gives the script to the SillyTavern
parser. Jeved then checks each command that the parser finds, including commands inside closures and
after pipes. Jeved refuses the script unless each command is on this list:

- `/echo`
- the variable commands: `/setvar`, `/getvar`, `/addvar`, `/incvar`, `/decvar`, `/flushvar`, the
  global version of each, `/let` and `/var`
- `/if`, `/while`, `/times`, `/pass`, `/return`, `/abort` and `/break`
- the number commands: `/len`, `/add`, `/sub`, `/mul`, `/div`, `/mod`, `/min`, `/max` and `/round`
- `/imagine`
- a comment

An alias counts as its command. For example, `/setchatvar` counts as `/setvar` and `/img` counts as
`/imagine`. Jeved refuses all other commands. This includes commands that start a generation, wait
for input, post a message during the turn, call another model, or build script text from a string.
`/imagine` is the one allowed command that calls a model.
Jeved also refuses a command that SillyTavern does not know, because the parser stops at it.

`/if`, `/while` and `/times` run the argument that you give them. Jeved accepts only a closure
there, such as `{: /echo hi :}`. SillyTavern parses a closure before the script runs, so Jeved can
check the commands inside it. Jeved refuses a quoted command, a macro, a variable and an empty
argument there. SillyTavern builds such a script during the turn, and Jeved cannot check it first.
The same rule applies to `else=` on `/if` and to `onClick=` on `/echo`. A macro is accepted where
the command only reads it, as in `/echo {{user}}`.

`/imagine` must have `quiet=true`. Without it, SillyTavern posts the picture into the chat during
your turn.

Example: the Picture rule in the built-in preset makes a picture of a tense scene. It is turned off,
and it needs an image backend in SillyTavern. Its condition is Tension above 3 on the latest reply,
its instruction is empty, and its script is:

```
/imagine quiet=true scene
```

Jeved checks the script when you save the rule, when you import a preset, and immediately before the
script runs. The list controls command names only. A command on the list can still write your chat
variables, and Jeved cannot know what a macro expands to. Read a script before you turn its rule on.
If SillyTavern does not give Jeved its parser, no rule script runs, and the status chip shows the
reason.

If a script is still running after 5 seconds, Jeved stops waiting and the script continues. Jeved
shows which rule the script belongs to and does not change the status chip. If the script fails
later, the status chip shows the failure then.

A script that posts a message into the chat during the turn cancels a pending reroll, because the
reply is then not the last message. `/imagine` posts a message unless it has `quiet=true`. Use
`quiet=true` in the script of a rule that rerolls.

When you import a preset, Jeved turns off each rule that has a script, even if the file turns it on.
The import dialog names those rules and shows each full script. Each rule stays off until you turn
it on with the switch on its row. Import does not change your own rules or the built-in preset.

## Reroll

A rule can reroll the reply. Such a rule does not nudge the next turn. Jeved waits until SillyTavern
is idle and then swipes one time. The first reply stays one swipe to the left. A badge on the new
reply shows which rule rerolled it.

Jeved rerolls at most one time for each user turn. Jeved accepts the second reply whatever its
scores are, so a rule cannot loop. Jeved cancels a reroll when you start to type, when the reply is
edited, when you swipe, when the chat changes, when you pause, and when you turn Jeved off. Jeved
shows one message for a cancelled reroll and does not change the status chip.

Rerolls do not run in group chats.

## Slash commands

- `/jeved` opens the workspace. `/jeved sensors`, `/jeved activity` and `/jeved settings` open the
  workspace on that tab.
- `/jeved-nudge rule=<rule id>` adds the instruction of that rule to your next message. It skips the
  conditions, the cooldown and the nudge spacing one time. It applies to one message, and it is
  cancelled when you change chat.
- `/jeved-pause on` stops measurements and instructions in the current chat. `/jeved-pause off`
  starts them again.
- `/jeved-rescan count=<n>` checks the last n narrator replies and measures each reply that has no
  score for a sensor that a rule needs. It shows how many API calls this costs and asks you to
  confirm. Run the command again while it works to stop it. At the end it shows how many replies it
  measured. If some replies failed, it also shows how many.

## Tune a preset

Start with the built-in preset. Play 20 to 30 replies. Then open the Activity tab and read the strip
chart. Find a sensor whose score changes together with the problem you want to correct.

- Each rule row ends with its status. The status shows Off, Fired, Blocked, how many more replies
  need a score, how many replies the rule must wait, or a count such as "1 of 4" for the replies in
  the window that match every condition. Point at the status for one sentence that explains it. Use
  it to find why a rule does not fire.
- Open a rule and read Preview. While you edit, Preview applies your draft to the scores that are
  saved in the chat. It shows how many times the rule would have fired and lists those replies under
  "Show replies". Use it to set a threshold. It makes no API call.
- Open a sensor and press Test. Test measures the recent replies with your wording and saves
  nothing. The button shows how many API calls it costs. A sensor that gives the same score to each
  reply carries no information, and a rule cannot use it.
- Raise "Nudge spacing (replies)" if nudges come too often. Lower it while you test.
- Pause a chat that you do not want Jeved to measure. While the chat is paused, the Measure buttons
  and Test are disabled and show the reason.

## Write a sensor

A sensor is one question and five ordered score descriptions. Jev reads the text and selects the
description that fits. The endpoint returns the expected value, so a reply between two descriptions
gets a score between them.

- Ask about one thing. If a question contains "and", split it into two sensors.
- Use general terms. "How much tension or pressure is in the reply" works for a court story and for
  a horse race. "Is someone holding a knife" works for one scene only.
- Name the text in backticks. The hint below the question box lists the names that your current
  settings produce.
- Ask what the text shows. Put the decision in a rule, not in the question.
- Write the five descriptions as a scale with no gaps and no overlap. 0 means none. 4 means the most
  possible.
- Name something visible in the text at each step. "A real setback. The character fails, is refused,
  or loses ground" gives better scores than "medium".
- Jeved resolves SillyTavern macros in the question and in the descriptions, so `{{user}}` names the
  player.

## Write an instruction

The instruction is the out-of-character line that Jeved adds to your message in the prompt. It is
the only text from Jeved that the narrator sees. Jeved does not change your message in the chat, so
old instructions do not collect in later context.

- Describe the result you want in the story. Do not mention scores or Jeved.
- Good: "The story has been calm for many turns. In this reply, something puts the player under
  pressure." Bad: "Your tension score has been below 1.5 for four replies, raise it."
- Ask for one change, in this reply.
- Let the narrator choose the method. "How is your choice" gives a scene that fits the story.
- Say what the narrator must not do when that matters. "Do not resolve it in this reply" stops the
  narrator from starting and ending the problem in one paragraph.
- Use one or two sentences. A long instruction takes attention away from the character card.

## For coding agents

An agent with file access edits the presets directly. The presets are in the SillyTavern settings
file, `data/<user>/settings.json`, at `extension_settings.jeved.presets["<preset name>"]`. The same
object holds the API key. Do not print it or copy it.

1. Ask the user to close every SillyTavern tab. An open tab saves its own copy of the settings and
   overwrites your edit.
2. Edit the preset. Change only the `jeved.presets` part of the file.
   - A sensor goes in `sensors`. The fields and defaults are in `blankSensor` in `src/defaults.js`.
     A sensor needs a new `id`, one `question`, and five `levels` for the scores 0 to 4. Follow
     "Write a sensor" above.
   - A rule goes in `rules`. The fields and defaults are in `blankRule`. Each condition names a
     sensor `id`, an `op` of `below` or `above`, and a `value`. The rule fires when `need` of the
     last `window` replies match. `action` is `nudge` or `swipe`. `swipe` rerolls the reply. A rule
     needs a `directive`, a `script`, or both. Follow "Write an instruction" above.
   - The order of `rules` is the priority order. The first rule has the highest priority.
   - The built-in preset in `src/defaults.js` is a complete example.
3. Validate the preset. Run this in the extension folder, with the path of the settings file and the
   preset name:

   ```
   node --input-type=module -e "import { readFileSync } from 'node:fs'; import { validatePreset } from './src/presets.js'; const [file, name] = process.argv.slice(1); console.log(validatePreset(JSON.parse(readFileSync(file, 'utf8')).extension_settings.jeved.presets[name]));" ../../settings.json Director
   ```

   `[]` means the preset is valid. Any other output lists each problem. Jeved drops or resets an
   invalid part when it loads, so fix each problem first. A rule that has a script always shows one
   problem here, because only SillyTavern has the script parser. Jeved checks the script in the app.
4. Ask the user to open SillyTavern again. Jeved loads the edited preset.

To share a preset, write it as a file with the keys `jeved`, `name`, `description`, `sensors`,
`rules`, `contextGroups`, `gap` and `maxNudges`. The user imports the file in Settings. An exported
preset shows the exact shape.

## Uninstall

Open the Extensions panel, find Jeved and delete it. The confirmation dialog offers "Also clean up
extension data". If you tick it, Jeved removes its settings, including the API key.

If you do not tick it, the settings stay in the SillyTavern settings file, with the key as plain
text, and a reinstall uses them. To remove the key yourself, empty the API key box on the Settings
tab before you uninstall. The box saves as you type.

In both cases, the scores and decisions that Jeved wrote on your messages stay in the chat files.
"Clear scores" on the Activity tab removes the scores from the current chat and keeps the decisions
on your messages. It also cancels each measurement in progress, so a late score cannot return to a
reply that you cleared.

## Licence

MIT. See LICENSE.
