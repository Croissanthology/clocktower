# Blood on the Clocktower — Trouble Brewing Rules Reference

Authoritative source: wiki.bloodontheclocktower.com and the official Trouble Brewing rulebook. This document is written for an LLM that will play as a seated player (not Storyteller). Ability text below is quoted exactly as printed on character tokens/almanac. Get it right — wrong ability text breaks the game for everyone at the table.

## 1. Core Game Loop

Blood on the Clocktower is a social deduction game for 5–15 players (Trouble Brewing edition; 5 is the minimum). One player is the **Storyteller**, who runs the game and does not play a character. Everyone else is secretly assigned one **character** with a hidden **alignment**: good (Townsfolk, Outsiders) or evil (Minions, Demon). Good wins by executing the Demon. Evil wins by reducing the town to two living players. The game alternates **night** and **day** phases until one team wins.

**Night phase.** All players close their eyes. The Storyteller wakes players one at a time, in a fixed order (see Section 4), to use abilities or receive information via silent hand signals (nod/shake head, finger counts, pointing). No one else knows who was woken or what happened. On the first night only, if there are 7+ players, all Minions wake together and learn who the Demon is; the Demon then wakes and learns who the Minions are, plus 3 good characters not in play (to use as bluffs). On other nights, the Demon typically chooses a player to kill. After all night actions resolve, the Storyteller declares dawn and any deaths from the night are announced (only that the player died — never how, and never their character).

**Day phase.** Players talk freely — in the open, in private huddles, in pairs — to share (or fake) information and build a theory of who is evil. This is the bulk of play. Eventually the Storyteller calls for nominations.

**Nominations.** Any living player may nominate any other player (including themselves) for execution by saying "I nominate [player]." Rules:
- Only one nomination is voted on at a time.
- Only living players may nominate.
- Each player may nominate only **once per day**, and each player may be nominated only **once per day**.
- Dead players may be nominated but this is almost never useful (they have no ability to lose).

**Voting.** The Storyteller tallies votes by pointing at each player clockwise starting from the nominee; a raised hand counts as a vote. Rules:
- **Living players** may vote for as many nominees as they like per day (no limit).
- **Dead players** get exactly **one ghost vote** for the entire rest of the game — once spent, they can never vote again.
- A nomination succeeds ("is about to die") if the vote total is **at least half the number of living players, rounded up**, and it is strictly more votes than any earlier nomination that day.
- **Ties**: if a nomination ties the current highest vote count, neither player is executed as a result of that tie — the later nominee must exceed, not just match, the leading count to become "about to die."
- Multiple nominations can happen per day, but there is a maximum of **one execution per day**.

**Execution.** Whoever is "about to die" at the end of the day (i.e., has the highest qualifying vote count when nominations close) is executed. Execution is not guaranteed — if no one is nominated, or no nomination reaches the threshold, the day ends with no execution. Executed players immediately lose their ability and become a ghost with one vote token.

**Win conditions.**
- **Good wins immediately if the Demon dies** (by execution or certain abilities), regardless of anything else — this check happens first if multiple win conditions would trigger at once.
- **Evil wins if only two players remain alive** (the Demon and one other) — Travelers, if used, don't count toward this threshold.
- Some characters add extra win conditions (e.g., the Mayor: if only 3 players live and no execution occurs that day, good wins immediately). The Saint being executed causes evil to win instantly regardless of the Demon's status.
- Death is not the end: if your team wins, you win whether you're alive or dead at that point. There are no neutral players.

## 2. Setup Chart (Trouble Brewing, 5–15 players)

| Players | Townsfolk | Outsiders | Minions | Demon |
|---|---|---|---|---|
| 5 | 3 | 0 | 1 | 1 |
| 6 | 3 | 1 | 1 | 1 |
| 7 | 5 | 0 | 1 | 1 |
| 8 | 5 | 1 | 1 | 1 |
| 9 | 5 | 2 | 1 | 1 |
| 10 | 7 | 0 | 2 | 1 |
| 11 | 7 | 1 | 2 | 1 |
| **12** | **7** | **2** | **2** | **1** |
| 13 | 9 | 0 | 3 | 1 |
| 14 | 9 | 1 | 3 | 1 |
| 15 | 9 | 2 | 3 | 1 |

**This game uses 12 players: 7 Townsfolk, 2 Outsiders, 2 Minions, 1 Demon.** There is always exactly one Demon regardless of player count. Note: the Baron (a Minion) modifies this at setup by adding 2 Outsiders and removing 2 Townsfolk from whatever the chart says — so a 12-player game with the Baron in play would actually run 5 Townsfolk / 4 Outsiders / 2 Minions / 1 Demon.

## 3. All 22 Trouble Brewing Characters

### Townsfolk (13) — good, help the good team

**Washerwoman** — "You start knowing that 1 of 2 players is a particular Townsfolk." Learned on night 1 only. Play advice: this is a strong opening claim because it confirms one of two players is a specific good role — publicly narrowing the field builds trust fast, but remember the shown character could be a Drunk mimicking that Townsfolk. Evil players sometimes bluff this claim since it's unfalsifiable without a Fortune Teller or later cross-checks.

**Librarian** — "You start knowing that 1 of 2 players is a particular Outsider. (Or that zero are in play.)" Learned on night 1 only. Play advice: with only 0–2 Outsiders in most games, "zero Outsiders" is itself informative and worth claiming publicly. Watch for the target being the Drunk — the Librarian can accidentally point at the Drunk if the Drunk's true (fake) identity happens to be Outsider-flavored in other scripts, though in Trouble Brewing the shown player genuinely is the named Outsider.

**Investigator** — "You start knowing that 1 of 2 players is a particular Minion." Learned on night 1 only. Play advice: strong evil-hunting information, but only points at a Minion, not the Demon — don't over-conclude. Evil loves to bluff Investigator claims that finger-point at each other to seed confusion, since a false "Minion" claim is hard for good to disprove early.

**Chef** — "You start knowing how many pairs of evil players there are." A "pair" means two evil players sitting in adjacent seats. Play advice: a Chef claim of "0" is powerful reassurance that evil is spread out; a Chef claim of "1" or "2" should trigger scanning of the seating chart for adjacent suspects. This ability is seat-order dependent, so it's most useful cross-referenced against who's sitting next to whom.

**Empath** — "Each night, you learn how many of your 2 alive neighbors are evil." Updates every night as neighbors die (dead neighbors are skipped — it looks past them to the next living player each side). Play advice: track the Empath's nightly number across the game; a change signals a neighbor died or the Empath is being poisoned. This is one of the most trusted and frequently claimed roles because its information self-corrects each night.

**Fortune Teller** — "Each night, choose 2 players: you learn if either is a Demon. There is a good player that registers as a Demon to you." Player chooses 2 targets each night; that last sentence means one good player (the "red herring") will always ping as a false positive. Play advice: claim quickly and start triangulating — a consistent "no" on two players across nights is strong evidence they're both good (barring poisoning); a "yes" on a pair could be the real Demon or the red herring, so retest one of the pair against a third player next night to isolate.

**Undertaker** — "Each night*, you learn which character died by execution today." Only triggers the night after an execution happened; does nothing on nights with no execution. Play advice: extremely valuable once an execution occurs, since it directly reveals a role — but only executions, never night deaths. Poisoning the Undertaker on the night before an execution is a classic evil play to feed false character info.

**Monk** — "Each night*, choose a player (not yourself): they are safe from the Demon tonight." Does not act on the first night. Play advice: a good Monk quietly protects whoever seems most valuable or most likely to be targeted (claimed Empath/Fortune Teller, or themself's suspected ally) — protecting the same obvious target every night is predictable and lets the Demon route around it. The Monk cannot protect themselves.

**Ravenkeeper** — "If you die at night, you are woken to choose a player: you learn their character." Only triggers if killed at night (not by execution); if the Demon never kills you, this ability never fires. Play advice: the strongest information in the game if it triggers, so a smart Ravenkeeper sometimes signals mild vulnerability to bait the Demon into killing them rather than a more dangerous target — the rulebook itself flags this as underrated by new players.

**Virgin** — "The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately." One-time trigger, only on the very first nomination of this player, and only if the nominator is (or registers as) a Townsfolk — nominations by Outsiders, Minions, or the Demon do not trigger it. Play advice: this instantly and publicly confirms two things at once — that the Virgin is who they claim, and that the nominator was good — making it a huge trust anchor; evil should be very cautious about nominating a claimed Virgin, and a savvy Virgin claims openly to deter frivolous nominations.

**Slayer** — "Once per game, during the day, publicly choose a player: if they are the Demon, they die." Single use per game, day-only, public. Play advice: usually held in reserve as a late-game insurance shot once the Demon suspect list narrows to 1–2 names; firing early on a hunch burns the ability for nothing and reveals the Slayer's identity to evil with no payoff.

**Soldier** — "You are safe from the Demon." Passive, always on, no action required. Play advice: a Soldier can safely reveal late in the game once trust is needed, since it explains any survived Demon attacks; but revealing early just makes the Soldier a safe, boring nomination target for evil since executing them removes no protection risk to the Demon.

**Mayor** — "If only 3 players live & no execution occurs, your team wins. If you die at night, another player might die instead." Two effects: an alternate good win condition, and a chance the Storyteller redirects a night kill away from the Mayor to someone else. Play advice: in the endgame with exactly 3 players alive, good should consider *not* executing anyone if the Mayor might be one of the three — an execution forfeits this win path. The Mayor's night-redirect means their survival doesn't prove Soldier or Monk protection.

### Outsiders (4) — good, but hinder the good team

**Butler** — "Each night, choose a player (not yourself): tomorrow, you may only vote if they are voting too." Self-restricting: the Butler's vote is conditional on their chosen "master" also voting that day. Play advice: pick a trustworthy-seeming player as master to avoid being locked out of important votes; being unable to vote is a minor handicap for good, so the Butler should reveal if it helps resolve confusion about a stalled vote.

**Saint** — "If you die by execution, your team loses." Only triggers on execution, not night death. Play advice: the Saint's existence is a strong deterrent to executing anyone whose claim is uncertain, and evil loves to accuse good players of being the Saint to create execution paralysis; a Saint should generally stay quiet about their role since revealing it makes them un-executable "for free" and thus a huge tempo loss for good's ability to test suspects by execution.

**Recluse** — "You might register as evil & as a Minion or Demon, even if dead." A good character whose abilities-facing "registration" can falsely appear evil (to Fortune Teller, Undertaker's revealed character, Investigator, etc.), Storyteller's choice each time. Play advice: this is the single biggest reason not to blindly trust Fortune Teller/Investigator "Demon" or "Minion" pings — a Recluse can absorb suspicion for the real Demon for an entire game, and a clever evil team will sometimes let a Recluse take the execution instead of the real Demon.

**Drunk** — "You do not know you are the Drunk. You think you are a Townsfolk character, but you are not." The Storyteller secretly assigns this player a Townsfolk token; they play the whole game believing they have that Townsfolk's ability, but it never actually functions and the Storyteller may feed them false information. Play advice: as an AI player, if your character ability produces suspiciously inconsistent or contradicted results across the game, consider that you may be the Drunk — you will never be told, and you should keep playing your claimed role's optimal strategy exactly as if it worked, since outwardly nothing distinguishes you from the real Townsfolk.

### Minions (4) — evil, help the Demon

**Poisoner** — "Each night, choose a player: they are poisoned tonight and tomorrow day." Poisoning disables the target's ability (they still believe it works) and may cause the Storyteller to feed them false info, lasting through the following day. Play advice: prime targets are information roles (Empath, Fortune Teller, Chef, Undertaker) right before their info would matter, or a Slayer right before they might guess correctly; as the Poisoner, vary targets so a pattern of "everyone's info keeps flip-flopping" doesn't point straight at the same suspects.

**Spy** — "Each night, you see the Grimoire. You might register as good & as a Townsfolk or Outsider, even if dead." Seeing the Grimoire means the Spy player literally learns everyone's true character and alignment each night — the most information-dense role in the game. It can also falsely register as good/Townsfolk/Outsider to detection abilities. Play advice: use full-Grimoire knowledge to craft precise, plausible lies and to know exactly which good claims are true or false; the false-registration clause means a Spy can safely claim to be almost any Townsfolk role the Fortune Teller/Undertaker/Washerwoman would confirm.

**Baron** — "There are extra Outsiders in play. [+2 Outsiders]" A setup-modifier only, applied once before the game begins: swaps 2 Townsfolk tokens for 2 Outsider tokens before dealing. Play advice: as an AI player you cannot detect the Baron's effect directly during play — its only signature is an unusually high Outsider count for the player total, which can misdirect Librarian-based Outsider-counting logic; the Baron itself otherwise plays like a generic evil Minion with no other ability.

**Scarlet Woman** — "If there are 5 or more players alive & the Demon dies, you become the Demon. (Travellers don't count.)" Triggers automatically and secretly the instant the Demon dies (execution or otherwise) while 5+ players are alive; the Scarlet Woman becomes the new Imp immediately, silently, without acting that same night. Play advice: good should never assume the game is safely won the moment "the Demon" is executed — if 5+ players remain, check who's newly acting like a Demon; the Scarlet Woman as a player should be ready to seamlessly pick up Imp bluffing and killing the very next night.

### Demon (1)

**Imp** — "Each night*, choose a player: they die. If you kill yourself this way, a Minion becomes the Imp." Does not act on the first night. The self-kill clause lets a cornered Imp deliberately suicide to pass the Demon role to a Minion (an alive one is chosen to become the new Imp), which is a legitimate strategic move, not just flavor. Play advice: the Imp should use the first-night bluff tokens (3 not-in-play good characters shown by the Storyteller) to claim a safe Townsfolk role during the day; killing yourself to pass to a Minion is a real tactic when you're about to be executed and want to preserve the Demon-hood for the team rather than let good win outright.

## 4. Night Order (Trouble Brewing)

The Storyteller wakes characters in this fixed sequence. Not every character acts every night — e.g., Undertaker only wakes if there was an execution the prior day; Ravenkeeper only wakes if killed at night. Bluff/setup steps are included for completeness.

**First Night:**
1. Minion info (if 7+ players — Minions learn each other and the Demon)
2. Demon info (if 7+ players — Demon learns Minions and 3 not-in-play bluff characters)
3. Poisoner
4. Spy
5. Washerwoman
6. Librarian
7. Investigator
8. Chef
9. Empath
10. Fortune Teller
11. Butler
12. Dawn (end of night)

**Other Nights:**
1. Poisoner
2. Monk
3. Spy
4. Scarlet Woman (if she just became the Imp)
5. Imp
6. Ravenkeeper (only if killed tonight)
7. Undertaker (only if there was an execution today)
8. Empath
9. Fortune Teller
10. Butler
11. Dawn (end of night)

Characters with day-only or passive abilities (Virgin, Slayer, Soldier, Mayor, Saint, Recluse's registration, Baron's setup effect, Drunk) never appear on the night order because they either trigger on other events or have no active night step.

## 5. Key Rules an AI Player Must Not Get Wrong

- **Drunkenness and poisoning disable abilities silently.** A drunk or poisoned player's ability does not function, but they are never told this and continue to believe it works. If you are drunk or poisoned, you still "go through the motions" of your ability exactly as if healthy.
- **The Storyteller may lie to the Drunk/poisoned.** If your ability would normally give you information and you are drunk or poisoned, the Storyteller is permitted (and encouraged) to give you false information instead. This means information from a possibly-drunk-or-poisoned player is never 100% reliable — including your own, if you can't rule out being the Drunk.
- **Evil players know each other.** On the first night (with 7+ players), all Minions wake together and learn who the Demon is; the Demon wakes and learns all Minions, plus 3 good characters not in play to use as bluffs. Evil should coordinate consistent lies; good players never get this shared-knowledge advantage.
- **Registration can lie about alignment/type.** The Recluse (good) may register as evil and as a Minion or Demon to detection abilities, even while dead. The Spy (evil) may register as good and as a Townsfolk or Outsider, even while dead. Never treat a single detection result (Fortune Teller ping, Undertaker reveal, Investigator/Washerwoman/Librarian match) as absolute proof — always weigh the possibility of a Recluse or Spy explaining it.
- **Dead players keep participating.** Dead players keep their eyes closed at night same as anyone (they are not woken for abilities — those are lost immediately on death) but they remain fully able to talk during the day and get exactly **one ghost vote** for the rest of the game. A dead player without a remaining vote token cannot vote at all.
- **Nomination limits.** Each living player may nominate exactly once per day; each player (living or dead) may be nominated exactly once per day. A second nomination attempt against the same target, or a second nomination by the same nominator, is not allowed that day.
- **Abilities resolve immediately and silently.** When an ability is used, its effect happens right away (e.g., a Monk's protection blocks a later Demon attack the same night); players are never told the mechanism behind an outcome — only that someone died, never how or by which ability.
- **"Once per game" abilities are truly one-shot**, even if used while drunk or poisoned (in which case they're wasted with no effect and cannot be used again).
- **Good wins take priority.** If the Demon's death and evil's "two players left" condition would somehow both be satisfied simultaneously, good wins.

## 6. Glossary

- **Demon** — the single evil character whose death wins the game for good; typically kills a player each night.
- **Minion** — an evil character (1–3 in play) whose ability supports the Demon or spreads chaos for evil; knows the Demon's identity from night 1.
- **Townsfolk** — a good character whose ability helps good; the most numerous character type.
- **Outsider** — a good character whose ability actively hinders or complicates the good team's task.
- **Grimoire** — the Storyteller's private tracking tool (physically a box) holding every player's true character, alignment, and status; players never see it, except the Spy.
- **Ghost vote** — the single vote a dead player retains for the rest of the game, spent once and never regained.
- **Alignment** — whether a player is currently good or evil; can change during play even though a player's character does not.
- **Register** — what a character's ability "reads" a player as (for detection purposes), which is not always the same as their true character or alignment — the source of most misdirection in the game.
