# playtest notes — 2026-08-28 (afternoon test, night game)

a walkthrough of one game as the harness stands, with the points where it will strain. written after reading rules/trouble-brewing.md and the server/UI code end to end.

## the shape of the evening

12 players: 8 humans on lavs 1–8, 4 AIs on speakers. adam storytells, margot wrangles from the laptop + phone. two side laptops open `/whisper`. one hidden speaker runs `ambience.py`. auto-tick every 45 s: every AI gets the last 40 lines + everything new since its last tick, answers in JSON, its `say` lands in a queue, margot presses **speak**.

## night 1 (~10 min)

- deal happens in setup → server fires night choosers (fortune teller, poisoner, butler on night 1). imp/monk don't act night 1. their choice arrives as a pink card within ~20 s. adam reads it off the laptop (flash view), does the thing, margot types the result into the AI's private box.
- info roles (washerwoman, librarian, investigator, chef, empath) get nothing unless margot types it privately. **write the night-1 info for every AI info role before dawn** — the storyteller decides it, margot relays it. this is the busiest 5 minutes of the evening for the two of you.
- the minions/demon wake-up: if an AI is the imp it needs "your minions are X and Y; your bluffs are A, B, C" typed privately. if an AI is a minion it needs "the demon is X". easy to forget; it's the single most important private message of the game.
- ambient: rain + clock strike. the lavs are live all night (people whisper in the dark). that's fine — night speech is dropped to the AIs? no: it isn't. **transcript keeps flowing into ctx at night**, and the night header tells AIs they can't speak, but they still read it. adam should say "eyes closed, mouths closed" and mean it, or margot pauses the mics at night (mics panel → stop) — i'd stop them; it also kills the risk of a sleepy human saying "wait am I the imp" into a lav.

## day 1 (~20–30 min) — the strain points

**1. speech lag.** a human says something at t=0. it's transcribed by t≈4 s. the next tick fires somewhere in the next 45 s. the model takes 8–25 s (fable ~15, gemini/gpt/kimi via openrouter 10–40). synthesis 2–4 s. then the line sits in the queue until margot presses speak. realistic AI reaction time to a specific remark: **45–90 s**. humans will have moved on. two mitigations, in order of value:
   - tick on *lull*, not on a timer: fire a push when every mic has been quiet ≥3 s and it's been ≥15 s since the last push. the AIs then answer the beat that just ended, not a random slice of it. (the server already has `speech_ago` per mic; ~30 lines to build.)
   - auto-speak: when the queue is non-empty and the room is quiet ≥1.5 s and nobody's speaking, play the oldest line without a click; drop lines older than ~90 s that aren't directed at a named player. margot stops being the bottleneck for 4 mouths. keep the manual button as override and the pause button as the kill switch.

**2. line length.** template says 1–2 spoken sentences; kokoro at 1.2× → 5–8 s per line. good. alligator's ceremonial wrapper ("I will speak the following words… I have spoken") adds ~3 s per line — funny for 20 minutes, a tax after an hour. consider letting it drop the wrapper when replying to a direct question.

**3. four AIs answering the same beat.** all 4 tick together and often all want to speak. queue holds 4 lines; if margot plays them back-to-back that's 30 s of machine monologue. the "silence is a strong move" instruction helps; auto-speak with a "one AI line per beat unless directed" rule would help more. also: AIs hear each other only after delivery, so two AIs can make the same claim independently. fine — humans do too.

**4. human whispers get overheard.** the lavs are on the humans, not on the table. when two humans huddle in the alcove, their mics still carry, and the dominance gate only decides *which* mic wins, not whether it's private. **every human-to-human whisper reaches all four AIs as public text.** options: (a) declare it — "the machines hear every lav, all the time; take it off to whisper" — which is honestly a great mechanic and the simplest; (b) a per-mic mute button in the mics panel that a runner toggles; (c) tell people to cup the capsule. i'd do (a) and say it at the rules briefing, loudly.

**5. the rain will be heard.** threshold is 0.0004 with normalization — set for a lav at whisper level. the ambience speaker at church volume will keep mics "active" and feed whisper 20 s chunks of rain, which is exactly what makes it hallucinate ("thank you for watching", sinhala, the vocab prompt parroted back). the filter catches the obvious ones. **test this in the afternoon**: run ambience at the volume you want, sit silent for 2 minutes, watch the context view. if junk appears: raise CT_MIC_THRESHOLD (0.001–0.002), check the PAD buttons aren't pressed (they were suspected), and move the ambience speaker further from the table. the bell before each AI line is also picked up but it's inside the echo guard window.

**6. attribution.** a mic is a name. when someone speaks off-mic (walked away, mic fell), their words land on the loudest nearby lav — as someone else. with real names in the vocab the "Margaret" problem shrinks but doesn't vanish. **restart the mics after setup** — the vocab is computed when the transcriber starts, so human names typed later never reach whisper otherwise.

**7. nominations and votes.** adam says "nominations open". margot types `!nominations open — X nominates Y, vote now` and pushes; each AI returns an action card {vote, target} or nothing. that's 10–30 s per nomination during which the table waits on four machines. with 3–5 nominations a day that's a couple of minutes of dead air per day. mitigations: adam counts human hands first, AIs are read last (the cards will be there by then); or margot asks the AIs *before* the vote ("Y is about to be nominated by X — how will you vote?") during the debate. also each AI must be told the outcome: `executed: Y` as a GAME event, or they'll never know. a one-tap "executed / died at night / nominations open" row would save typing under pressure.

**8. death.** the server has **no dead flag**. an executed AI keeps getting "you are Alligator, secretly the Slayer" every tick and will happily keep planning to use an ability it lost. today the only signal is a margot note. this needs a per-player dead toggle that (a) rewrites the reminder line ("you are DEAD: ability gone, one ghost vote left, you may still talk"), (b) strikes the box, (c) tells the others via a GAME line. cheap; worth doing before tonight.

**9. the whisper laptops.** the human walks over, picks their name, picks an AI, types. the AI answers in ~20 s (a full tick, with its whole context). expect people to stand there waiting — put a chair. the reply is text; the human reads it and walks back. the AI's next public tick includes a digest of all its threads, so it remembers. things to say at the briefing: "the machines can whisper back, but only in writing; they may lie; anyone can pretend to be anyone at the laptop, same as you can lie about what someone told you." identity is on the honour system, deliberately. if two people whisper to the same AI at once, both get answered in one tick.

**10. the storyteller's view.** adam needs: AI night actions (flash), AI votes (cards), AI whispers (whispers view, optional). all on the laptop screen. if the laptop faces margot, adam is leaning over her shoulder all night. **put The Machine where adam can see it**, margot drives from the phone (the secret `?k=` url). the phone UI is the same page; the 4 boxes are legible on a phone in landscape.

**11. pace and cost.** a 12-player TB game runs 90–150 min. at 45 s ticks that's ~150 ticks × 4 = 600 model calls plus whispers, plus one call per nomination vote. fable rides the subscription; the three openrouter models are billed — ~6k-token system prompt each call, so think $10–30 for the night depending on the models picked. lull-triggered ticks would roughly halve it.

**12. failure modes to have a reflex for.**
   - a box goes red (bad JSON / timeout): press its private box with "you dropped a tick, carry on" — it re-syncs from its sheet next tick. sheets are on disk, nothing is lost.
   - openrouter model down: swap the model in setup? no — setup redeals. mid-game model swap needs `/api/edit`; margot can't from the UI. if a model is flaky in the afternoon test, don't use it tonight.
   - UMC disappears (it did this morning): mics panel → start again after replugging; phantom LEDs must be on.
   - the AI says something out of character about being an AI: pause, note, resume. the template is strong on this.
   - the room laughs for 30 s: the mics hear laughter → whisper writes "[laughter]" or hallucinates. harmless.

## what i'd build before tonight, in order

1. dead toggle (correctness; 20 lines)
2. tick-on-lull + auto-speak-when-quiet (the lag and the bottleneck; ~80 lines, testable this afternoon)
3. one-tap GAME events: executed / died / nominations open (typing under pressure)
4. per-mic mute (only if you reject "the machines hear everything")

## for the afternoon test, in this order

1. UMC on, phantom on, speakers on, check PAD. mics start. everyone says their name into their own lav; read the context view; fix any mic↔name swap.
2. speaker test buttons: which box is which speaker; type the channel numbers.
3. ambience at real volume, 2 minutes of silence, watch for junk.
4. one full fake day: a human claims something, an AI responds, a whisper from the side laptop, a nomination + vote, an execution typed as GAME. time each step with a phone stopwatch.
5. night: eyes closed, storyteller wake-ups for each AI role in play; measure how long night takes with 4 AIs.

## rules the AIs might get wrong (from the rules file)

- votes needed = ceil(alive/2), and a later nominee must *exceed* the current leader, not tie.
- dead players: one ghost vote total, can talk, cannot nominate, can be nominated.
- imp doesn't kill night 1; monk doesn't act night 1; undertaker only after an execution.
- fortune teller has a red herring; recluse/spy misregister. an AI FT that gets a "yes" will want to execute immediately — that's normal player error, not a harness bug.
- the AIs assume 12 players / 7-2-2-1 unless the baron's in play — if adam uses the baron, tell them the outsider count changed.
