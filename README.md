# Canon Grounding (SillyTavern extension) — v0.1

Keeps source-material characters physically/factually accurate during roleplay,
**with streaming on** and **without manual per-character entry**.

## What it does

- Before each generation, scans your latest message for character names.
- Looks each new name up **once** against the wiki(s) you configure, via the
  MediaWiki API — client-side, so **no server plugin and no CORS setup** needed.
- Caches the canonical facts forever and injects a compact note **before** the
  model generates, so it writes them right from the first token. Nothing is
  rewritten mid-stream, so streaming stays on.
- Silently grounds characters the model introduces on its own; the next mention
  (or a swipe) comes out correct.

## Install (Termux / any self-hosted SillyTavern)

Option A — from the app:
1. Open SillyTavern → Extensions → **Install Extension**.
2. Paste this repo's URL and install.
3. Open the **Canon Grounding** panel in Extensions settings.

Option B — manual:
```
cd SillyTavern/public/scripts/extensions/third-party
git clone <this-repo-url> canon-grounding
```
Then reload SillyTavern.

## Setup (once per story)

In the Canon Grounding panel, set **Wiki subdomains** to the Fandom wiki for your
current universe. Examples:
- Eminence in Shadow → `the-eminence-in-shadow`
- DC / Superman → `dc`
- Multiple at once → `the-eminence-in-shadow,dc`

Find the subdomain in any Fandom URL: `https://SUBDOMAIN.fandom.com/...`

That's the only thing you set — everything after is automatic.

## Known limitations (v0.1)

These are the honest rough edges, in priority order for improvement:

1. **Entity detection is a capitalization heuristic.** It can miss lowercase
   aliases/epithets ("shadow-sama") and occasionally flag non-characters.
   Biggest area to improve next (LLM-based extraction).
2. **Infobox parsing is regex over wikitext.** Field names differ per wiki; if a
   character's facts don't appear, add the wiki's field name(s) in the
   "Physical fields" setting.
3. **Franchise is configured, not auto-detected.** Picking the right wiki from
   freeform RP is unreliable, so it's a one-time setting rather than a guess.
4. **Real-world people (Wikipedia) and alias resolution are deferred.** Very
   famous real people are usually already correct from the model itself; the
   planned fix there is a lightweight identity *pointer*, not a fact dump.

## Changelog — v0.60.0 (✒ Advanced — the AI writes the note, the code verifies it)

Proven by `test/proof.js` (570) + `test/sim.mjs` (370); **7 guards negative-tested**.

The rigid skeleton exists because a model composing canon each turn is the
hallucination path this extension was built to close. ✒ Advanced keeps the
proof and frees the prose: the code still gathers, verifies, budgets and
orders every fact exactly as before — the model only **rewrites the
presentation** as one fluid storyteller briefing shaped by the live scene.
New faces are strangers to your protagonist (who is never a canon character,
so canon relationships never apply); established ones carry their canon;
franchise context the model is certain of may ride along in a clause, and
"unsure" means write nothing.

Trust is enforced, not hoped for. Every composition passes a validator before
it may inject: every cast member still named, every character's appearance
details intact (a wrong face is the failure this extension exists to
prevent), no leaked scaffolding, no JSON, no runaway length. Any failure —
or a slow model — degrades to the assembled note, so the mode can never be
worse than OFF. The composer runs **inside the raced task**, targeting the
facts that actually went out last turn, and the injector swaps a composition
in only when its facts-fingerprint matches what is on screen right now;
header, pins, story position and the ⌀ verdict stay code-written around the
composed body. Compositions are cached per fingerprint (a stable scene costs
no extra model call; a failed one cools down instead of burning a call per
turn), and 👁 Preview composes on demand through the same door. Off by
default — the ✒ checkbox in settings turns it on.

## Changelog — v0.59.0 (⌀ — the wiki's silence is an answer too)

Proven by `test/proof.js` (554) + `test/sim.mjs` (352); **7 guards negative-tested**.

Ask the story "do you remember the Winter Blood Feast?" and, until now, a name
the wikis do not have was swallowed: the miss went into the negative cache and
the storyteller heard nothing — free to invent "canon" for it. Now a settled
`no-page`/`meta-page` miss that your latest message names is reported in the
note: *not found in this story's canon sources — treat it as original to this
story; never import outside facts for it.* Verification became two-directional.

The guard earned its laws the honest way: the first cut reported junk. The
lowercase candidate fallback manufactures bigrams out of plain prose ("you nod
back" → "nod back"), and once such a guess fails a lookup it sits as a settled
miss — the live sim caught the note calling it missing canon. The class fix is
provenance, not a word blacklist: every miss now records **who vouched**
(`trusted` — parser/ledger/pin), a trusted revisit upgrades an untrusted miss
in place, and the notice demands either that stamp **or** visible ask-intent in
the message itself (a question, a trigger word, or the name typed capitalised).
A guess that went nowhere can never read as "verified missing".

One door: the check lives inside `relevantCanonNote`, so the live turn, the
preview (which now reads your latest message exactly like the turn does), and
every future surface agree. A notice-only note still injects — verification IS
an answer. Principals, the blocklist, and names fully owned by found canon stay
silent; freshest ask first, capped at 3; `⌀` lines in the reasons panel;
`reportUnverified` is the switch, on by default.

## Changelog — v0.57.0 (a place has a look too)

Proven by `test/proof.js` (529) + `test/sim.mjs` (328); 1 guard negative-tested.

Canon Grounding has always grounded locations, organisations, events and lore as
first-class entities — the parser is explicitly told to list them. But the section
list feeding the **Appearance** line was written for people: *Appearance, Physical
Appearance, Physical Description, Looks*. So Seireitei, the Gotei 13 and the Kuchiki
Manor came back with an Identity line and **nothing a storyteller could describe**.
A wiki files a place's description under Geography, Layout, Architecture,
Description, Structure or Overview — the same question, a different word. Those are
read now, and a character's own Appearance section still wins for people.

## Changelog — v0.58.0 (AGENTS.md — and a gate that stops it rotting)

Proven by `test/proof.js` (529) + `test/sim.mjs` (341); **3 guards negative-tested**.

This repo had no `AGENTS.md`, so every new session re-derived how to test it and
re-learned the same traps the hard way. That is a large part of why one bug class
survived across many sessions with a green gate the whole time.

`AGENTS.md` now carries the gate commands, the nine-stage pipeline (so a symptom can
be located before anything is edited), the invariants, and the laws this repo paid
for in real bugs — chiefly: *a proof of the function is not a proof of the call*, *a
guard that has never failed is unproven*, *a local heuristic must never override a
signal the system already has*, and *the test suite can encode the bug*.

**It is gated.** A briefing file that drifts is worse than none, because the next
session trusts it. `sim.mjs` now checks that AGENTS.md gives the ESM-copy syntax
command (not `node --check index.js`, which parses as CommonJS and silently accepts
what ESM rejects), names settings that still exist, and lists only pipeline functions
that are really in `index.js`. Negative-tested: corrupt any of those three and the
suite goes red.

It deliberately carries **no test counts** — those live in this changelog and nowhere
else. A number duplicated in two files is a number that will disagree with itself.

## Changelog — v0.57.1 (the guard for v0.57.0 was vacuous)

`test/sim.mjs` 335. v0.57.0's assertion handed `extractSectionRaw` its own section
list, so it proved the extractor and never touched the product's list — deleting
the new sections from `index.js` left the suite green. That is the exact failure
class this repo has a law about: a proof of the function is not a proof of the call.
A wiring witness now reads the product's own argument list, and removing any of the
place sections turns the suite red.

## Changelog — v0.56.0 (a ceiling is not a target; mentioning a place is not moving there; budgets are tokens)

Proven by `test/proof.js` (526) + `test/sim.mjs` (328); **3 guards negative-tested**.

1. **The budget was being spent because it was there.** `need` only *re-ordered*
   categories — an unwanted one sank to the bottom and rode anyway if there was room.
   So a quiet conversation shipped somebody's teacup collection, because the
   allowance had not run out yet. It now **filters as well as ranks**: what the scene
   does not need is dropped. Identity, Appearance, pair dynamics and Secrets are never
   dropped, because every scene needs a face and who is standing with whom. A budget
   is a ceiling, not a target — an unused one is simply not spent.

2. **Mentioning a place is not travelling to it.** Any place the parser returned was
   pinned as the current setting, so a character saying "word from Karakura Town"
   moved the whole story out of Seireitei. The **arc** has had a judge for exactly
   this question since v0.35 — has the story *entered* this, or merely referred to it
   — and the setting never got one. It does now, and only when the place actually
   differs from where we already are, so the common case (setting unchanged) still
   costs nothing and the first place of a chat still pins for free.

3. **Budgets are in TOKENS.** They were in string characters, which is not the unit
   anyone reasons about while watching a context window fill. `maxTokensPerChar`
   (275) and `maxTotalTokens` (1500) replace the character caps at ~4 chars/token,
   with a migration that carries an existing tuned value across instead of resetting
   it. The people-count setting is now labelled **"Max people injected at once"** —
   it always counted people, never letters, and sharing the word "characters" with
   the length caps was its own small trap.

## Changelog — v0.55.0 (the budget follows importance, because the note already knew it)

Proven by `test/proof.js` (523) + `test/sim.mjs` (322); **2 guards negative-tested**.

Since v0.51.0 the note has known exactly who a scene is about — `built` is sorted by
player-named first, then scene recency. It then handed every character the identical
per-character allowance. **The note knew the ranking and spent as if it didn't**: the
person being spoken to got the same room as someone mentioned in passing six messages
ago, and their depth was cut at the same line.

The lead now keeps the full allowance and each following character gets a smaller
share, floored so nobody drops below identity and appearance. The taper reallocates
**depth**, never presence — a trailing bystander is trimmed, not deleted. Pins and
the current setting are decree and are never tapered.

```
maxCharsPerChar 420, same scene, same cache

Smart dynamic ON            Classic (OFF)
  Rukia Kuchiki    310        Rukia Kuchiki    310
  Renji Abarai     308        Renji Abarai     308
  Byakuya Kuchiki  239        Byakuya Kuchiki  314
  Kiyone Kotetsu   199        Kiyone Kotetsu   312
```

Classic mode keeps the flat cap it always had, so the two modes now differ in *what
leads* and in *how the room is divided* — and in nothing else.

## Changelog — v0.54.0 (appearance is never re-ranked, and Smart Dynamic is a real switch)

Proven by `test/proof.js` (518) + `test/sim.mjs` (319); **5 guards negative-tested**.

1. **Appearance sits directly under Identity, in every mode.** It now has its own
   allocation band, ahead of even the relationship pass: a storyteller needs the face
   before it needs the history with the person beside them, and getting a face wrong
   is the failure this extension exists to prevent. A duel does not stop needing
   crimson hair because it needs shikai limits. The scene reorders everything *below*
   those two lines and nothing above them.

2. **Smart dynamic order is a real, switchable mode.** v0.53.0 shipped the setting
   with no UI, which made it a hardcoded default rather than a choice — an honest
   miss. There is now a checkbox, and its hint documents what **off** means, not just
   on.

3. **The parser's read outranks the keyword list.** `abilityLine` only emitted when
   `COMBAT_WORDS` matched the scene text or a technique name appeared in it. So
   *"Renji and Byakuya face each other"* — a duel about to start — produced no
   arsenal, even with the parser reporting `need: powers`. A keyword list cannot see
   an imminent fight; a reader can. When the model says the moment needs powers, the
   arsenal rides. Same failure shape as capitalisation-as-a-name-test and
   watchlist-as-attendance: a local heuristic quietly vetoing the model's read.

**Two guards were caught being untestable and fixed rather than counted.** The
appearance band and the powers override both survived their first negative test —
not because they worked, but because no assertion discriminated: the fixture scene
contained combat words, and no test placed appearance against a pair dynamic. Both
now have behavioural assertions and both turn the suite red when broken.

## Changelog — v0.53.0 (Smart Dynamic: the scene decides which canon leads — for free)

Proven by `test/proof.js` (515) + `test/sim.mjs` (313); **4 guards negative-tested**
(a fifth candidate was found to be a fast path rather than a guard, and is labelled
as such in the source instead of being claimed as coverage).

The note's line order was fixed: Identity → Appearance → Personality → Facts →
Abilities → Voice, the same in a duel as in a courtship. **It is now chosen per
scene, per character, and it costs nothing.**

**Why it is free.** The parser already reads the whole scene every turn. It is now
asked for one more short field per entity — `need`, one to three words from a closed
list (`powers, appearance, personality, relationships, history, secrets, voice`) —
naming what a writer most needs about them *for this moment*. No extra call, no
extra second. A composer that wrote the note as prose would have been a third LLM
round trip on top of the parser and the auditor, which is the latency problem, not a
solution to it.

**Why it cannot hallucinate.** The model only ever picks a CATEGORY. Every word
still comes from the verified cache; the extension does the writing. Reordering a
list cannot invent a fact, so "let the model decide" here carries none of the risk
that letting it compose would.

Same cache, same budget, same two characters — the note reshapes itself:

```
BATTLE                                    REUNION
Renji Abarai:                             Renji Abarai:
  - Identity: …                             - Identity: …
  - Abilities: Zabimaru, Bankai Hihio…      - With Byakuya Kuchiki: Complicated —
  - Appearance: hair: crimson…                Renji wants his captain's recognition.
  - Personality: Brash and loud…            - Personality: Brash and loud…
                                            - Appearance: hair: crimson…
```

One deliberate exception to v0.52.0's relationships-first rule: when a scene needs
**powers** and says nothing about relationships, what a character can do outranks who
they know. A duel briefed on family ties instead of shikai limits is the wrong note.

Degrades safely in every direction: an unrecognised word, an older parser that
returns no `need`, or `dynamicNote` off all produce the previous fixed order byte
for byte. On by default — there is nothing to configure.

## Changelog — v0.52.0 (a relationship belongs to the pair, not to one character's budget)

Proven by `test/proof.js` (504) + `test/sim.mjs` (304); **4 guards negative-tested**.

Who two co-present people are to each other is the single most useful thing canon
can tell a storyteller about a scene — and it was being charged to one character's
line allowance, competing with their trivia. So `Renji — With Rukia Kuchiki`
(married in canon, both standing in the room, the live tension of the moment) lost
to a solo fact, while `Ukitake — With Rukia Kuchiki` — a dead man's — survived.
Exactly backwards.

**A relationship pass now runs between presence and depth.** Pass one gives every
co-present character their anchor; **pass two spends on pair dynamics across all of
them, before any of them gets a second solo line**; pass three fills the rest. A
dynamic can no longer be crowded out by somebody else's teacup collection.

The effect is what an autonomous system should do without being told. Byakuya walks
into a courtyard where Renji and Rukia are standing, and the note assembles itself:

```
Rukia Kuchiki:
  - Identity: …
  - With Renji Abarai: Childhood friend from Inuzuri; in canon they marry.
  - With Byakuya Kuchiki: Adoptive brother; distance she has never fully crossed.
Renji Abarai:
  - Identity: …
  - With Rukia Kuchiki: Childhood friend from Inuzuri; in canon they marry.
  - With Byakuya Kuchiki: Complicated - Renji wants his captain's recognition above all.
```

Nobody configured that. The dynamics appear because those three are in the room
together, and they disappear when they are not — `dynLines()` only ever names a
character who is also present, which is now gated so it cannot drift.

**It informs; it does not script.** The note's own preamble already carries the law
— *"How someone is described here is how they've tended to be — never a script"* and
*"when a 'With <name>' line matches someone in the scene, that dynamic overrides the
baseline"*. The storyteller is told Renji and Rukia are married in canon. It is not
told what Rukia does about the man in front of her. That remains the story's.

Under a budget too tight for everything, the relationship survives and the trivia is
what gets trimmed — asserted directly, with the old behaviour negative-tested.

## Changelog — v0.51.0 (a watchlist is the opposite of attendance)

Proven by `test/proof.js` (498) + `test/sim.mjs` (298); **4 guards negative-tested**.

The injection panel confessed it: *"Isane Kotetsu ← evidence: 'Isane closing
Zaraki's surgery' (from plot momentum)"*. A director-style storyteller ends every
message with machine apparatus — a `<details>` **Plot Momentum** fold, a `{PULSE}`
roster, a `{WATCHLIST}` of who is **off-screen**. `stripMetaBlocks` scrubbed the
`[IST:]` / `[ACW:]` bracket rows but left the `<details>` fold, which is plain
prose naming every off-screen thread. Read as scene text, those people were
"present": grounded, given cast slots, and ranked ahead of the character actually
being spoken to. **That is why Suì-Fēng kept beating Rukia — Suì-Fēng was never in
the scene.** She was in the footer. Verified by running a real turn through the
scrubber: five off-screen names leaked; now none do. `<details>` folds (including
unclosed ones from a stream cut) and paired `{TAG}…{/TAG}` containers are removed.

**`Now:` is no longer printed.** Canon Grounding states what is TRUE of a character
in the source material; what they are doing this minute is the scene's own job and
the storyteller can already see it. The two also openly fought — canon says
*"Rukia Kuchiki is the current Captain of the 13th Division"* while this story has
her as lieutenant under someone else, and a note that contradicts itself in
consecutive lines teaches the model to trust neither. The parser still returns
`now`; it is kept as **salience**, which is the judgement worth spending a call on.

**Ordering follows the scene.** Player-named first, then by how recently the
character appears in the visible prose — whoever just spoke leads, someone mentioned
six messages ago trails. Tier order survives only as the tiebreak. On a turn where
the player names nobody ("of course, let's get to the office") recency is the whole
signal, and its absence is why the note opened with a dead man and reached the woman
standing in front of the player third. Two real bugs fell out of writing this:
player-named was read from `extras.userMsg` only, ignoring the `userNames` tier the
interceptor had already computed; and it compared against the canonical name only,
so a player typing "Isane" never matched cached "Isane Kotetsu".

## Changelog — v0.50.0 (just scan the input: the gate heuristics were the bug source)

Proven by `test/proof.js` (499) + `test/sim.mjs` (290); **4 guards negative-tested**.

1. **A new player message now always earns a parse.** Everything that used to sit
   in front of the parser was a heuristic *guessing* whether a sentence contained a
   name worth an LLM call — capitalisation, adjacent novel tokens, learned words,
   alias coverage. Every one of them has been a bug in this repo, and being wrong
   means the storyteller writes a character blind. The player typing something new
   IS the signal; let the model decide who to look up. The heuristics remain only
   below it, to catch names the AI introduces on turns where the player said nothing
   new. **The waste guard that actually mattered is kept and now tested directly:**
   the same message swiped or regenerated does not spend a second call.

2. **Who leads the note is decided by the player's sentence.** Tier order alone was
   not enough. A ledger character merely lingering in the scene window is admitted
   at tier 2, above the parser's cast at tier 3 — so on the very turn a character is
   first grounded, the person being addressed could still come second. `present` is
   now stably re-sorted: pins and the current setting stay on top (decree), everyone
   the player just named follows, the rest keep their tier order.

3. **"Last injection" is a snapshot again.** The note was captured at injection, but
   the reasons under it read `lastMatchReasons` — module state that every later
   rebuild overwrites: the preview button, the post-generation scan, a background
   catch-up. So the note and its explanation could come from different calls, and the
   panel appeared to keep updating itself after the turn had already been sent. Note,
   time, source and reasons are now captured together, in one place, at the moment
   the note goes out.

## Changelog — v0.49.0 (why it preferred Suì-Fēng: verbosity was deleting people)

Proven by `test/proof.js` (499) + `test/sim.mjs` (281); **4 guards negative-tested**.

The remaining half of "it prefers Suì-Fēng while my input is rukia". Not lookup,
not the gate, not evidence — **the budget allocator**.

1. **One verbose character could delete everyone after them.** Each character's
   whole block was built, then measured against the total budget, and on overflow
   the loop did `break`. Reproduced with the shape of the real cache: six
   fully-dossiered captains (identity + physical + personality + biography +
   abilities + trivia + voice) consumed the 6000-character budget, the seventh
   overflowed, and the loop **abandoned everyone after it** — including a character
   whose entire block was **79 characters** and who was the person being addressed.
   Suì-Fēng is fat and cached; Rukia is thin and last. She was not outranked, she was
   never reached. **Fix — presence before depth:** pass one gives every admitted
   character their anchor line; pass two spends whatever is left deepening them in
   tier order. The note degrades by trimming DEPTH, never by deleting people who are
   in the scene, and the player's own cast gets both presence and detail first.
   Overflow now skips that one block and keeps going — a later, smaller anchor still
   fits. Both caps still hold exactly as before.

2. **The sweep ran in cache insertion order.** `Object.keys(store)` is insertion
   order, so whoever was grounded earliest led the sweep forever — a character from
   ten scenes ago outranked the one who just walked in. The regex-mode fallback had
   sorted by recency since v0.2; the primary path never did. Swept entities are now
   ordered most-recently-mentioned first.

**Also verified, not assumed:** smart-expansion `Context:` lines are emitted inside
the per-character line list, which the two-pass allocator now treats as *depth* —
so background entities can no longer displace a person from the scene, which was
possible under the old single-pass build.

## Changelog — v0.48.0 (why it was worse with the auditor ON, and why the same scene gave different answers)

Proven by `test/proof.js` (490) + `test/sim.mjs` (273); **4 guards negative-tested**.

Live report: Rukia is still inconsistent — sometimes present, sometimes gone,
**noticeably worse with the Cast Auditor ON**, and the note still favours a
character the player never mentioned. Two defects, and the auditor clue named them.

1. **Evidence had to be echoed word-for-word, so the answer depended on phrasing.**
   `verifyCastEvidence` required the parser's evidence to be a literal substring of
   the scene. But canonicalising a partial mention is part of the parser's job: the
   scene says `rukia`, the parser answers `Rukia Kuchiki` and quotes the canonical
   name back as evidence. That was rejected as a *knowledge leak* — so the same
   character in the same scene survived or vanished depending on whether the model
   happened to echo the words or the name. Non-deterministic per call, which is
   exactly "sometimes gone." **Fix:** evidence is grounded if it appears literally
   *or* if a distinctive token of it appears as a **word** in the scene. Ordinary
   vocabulary never counts, so `the captain was there` still proves nothing and an
   entity the model merely knows belongs to this setting still has nothing to point
   at — verified by keeping the ghost-cast assertions green.

2. **The auditor could delete the person being spoken to.** Weak-evidence entries go
   to the Cast Auditor — a second LLM call that fails **closed**: `if (!out) return
   []`. On a slow mobile backend a timeout silently drops every weak item, which is
   precisely why the cast is *less* reliable with the auditor on than off.
   **Fix:** the player's own words are authority. An entity the player just named is
   promoted to strong and never reaches the referee — the player put them in the
   scene. This is asymmetric in the right direction: it saves the character being
   addressed and grants nothing to a character the player never mentioned. On the
   *same* ambiguous evidence, `Rukia` is now strong while `Sui-Feng` still faces the
   auditor. The player's message is threaded as a parameter through all three parse
   call sites rather than held in module state, which overlapping parses could stale.

**Also fixed:** the doc block above `novelNameTokens` still described the old
two-adjacent-token pair rule removed in v0.45.0 — the stranded-doc gate could not
catch it, because the comment *was* attached to a function; it was simply lying. And
a witness that pinned the literal text of a `parseSceneCharacters` call now matches
the call by shape, so adding an argument reads as a signature change rather than a bug.

## Changelog — v0.47.0 (whose to inject: capitalisation was never a test, it was a guess about you)

Proven by `test/proof.js` (483) + `test/sim.mjs` (265); **4 guards negative-tested**.

Live report: *"I'm talking with rukia and rukia is the one literally last to
inject."* Not the wiki, not the gate — **the selection**. And the tier system was
already right; its input was blind.

**Who caused it.** `bfcf568` (v0.30.0, "token resolution can no longer summon the
off-screen") made the first-name sweep require PROPER-NOUN casing. `c7aa102`
(v0.31.0, "injection tiers are decree, not inference") built tier 1 from
`extractCandidateNames`, which is capitals-only. Both were real fixes for real
problems. Both used **capitalisation as a proxy for "this token is a name"** — and
that proxy is not a test of the token, it is a guess about how the player types.
For anyone who writes `you talk to rukia`, every priority path failed at once:

- **Tier 1 was empty on every single turn.** The tiers are correct and their own
  comment says so — *"characters the PLAYER just named outrank everything but pins
  and the setting… Caps always trim from the bottom, so the people you are actually
  talking to survive."* With a capitals-only input, tier 1 had nobody to protect, so
  the character being addressed fell through to the sweep — last — and the cap
  trimmed her.
- **The sweep couldn't see her either.** Its regex carried the `u` flag and not
  `i`, so `rukia` only matched once the *AI* wrote `Rukia` with a capital. That is
  the "it only injects after the scene ended" report, exactly.

**Fix.** One case-blind resolver, `castNamedIn()`, used by tier 1 and shared with
the sweep through a single `nameTokenOwners()` map. The guard the casing rule was
standing in for is done properly, and more strictly, by two conditions that hold in
any language and any typing style: the token must belong to **exactly one** cached
character, and it must not be **ordinary vocabulary**. 45 words that are both common
English and plausible names (`rose`, `hope`, `grace`, `ice`, `will`, `dawn`, `may`…)
were added to the lexicon so that guard has teeth — a cached *Rose Oriana* is not
summoned by "the rose petals fell", while "you greet rose oriana" still reaches her.
Mentions are returned in sentence order, so the note follows what you wrote.

**A test that encoded the bug.** `lowercase prose sharing a name token sweeps
NOBODY` asserted that `"the rukia flowers bloomed"` must not sweep Rukia — a
synthetic string, since `rukia` is not an English word. Passing it *required*
lowercase name mentions to be ignored, which is the regression. It is replaced by
the two protections that are real: a name token that genuinely is ordinary English,
and a surname two cached characters share. Its replacement was also caught being
**vacuous** — no *Rose* was cached at that point, so it blocked nothing; the fixture
now caches her, and removing `rose` from the lexicon turns the suite red.

## Changelog — v0.46.0 (the lexicon only spoke the narrator's voice — and who caused the regression)

Proven by `test/proof.js` (479) + `test/sim.mjs` (257); **3 guards negative-tested**.

**Who caused it.** Not one bad edit — `94e25dd` (v0.13.0, 12 Jul 2026) shipped the
lowercase gate and the thing that rots it *in the same commit*: "novel-pair
detection, **once-only learning**". They are antagonistic. Learning marks every word
of the player's message as known, and the pair rule needs two *adjacent* unknowns —
so each turn the learner ate more of the sentence until no pair could form.
`70ab297` (v0.23.0) then gave the first-meeting wait its own copy of the same law
("converges per name" — it converges to silence). **Both passed every test, because
every harness run starts with an empty `parsedWords`.** A rule that degrades with
accumulated state cannot fail in a suite that never accumulates. That is the real
defect behind "it was smart many versions ago": it was — for the first few turns of
every chat.

1. **The lexicon spoke the narrator's voice, not the player's.** `COMMON_LOWERCASE`
   was grown from narrative prose — `walks`, `smiles`, `talks` — so it held the
   third-person forms and not the base ones. But the player does not write
   narration, they write instructions: `you talk to rukia`, `Jovan take a move on
   her`. Second-person imperative is base forms top to bottom, so **every verb in
   the player's own message looked like a novel name** — which is exactly what fed
   the learner that jammed the gate. 182 base forms and manner adverbs added. **New
   gate:** for a reviewed verb list, a verb must appear in *both* forms or neither;
   a bare third-person entry now fails the suite.

2. **The first-meeting wait kept its own copy of the gate's law.** It read raw
   `parsedWords` (a permanent veto) *plus* every token of every prior scene message.
   So once Rukia had been learned — or had simply appeared two messages earlier —
   naming her was not a "first meeting", the turn fell back to the 2s immersion
   ceiling instead of the 12s introduction wait, and she grounded **one turn late,
   every time**. That is the "it only injects after the scene ended" report.
   **Fix:** one `novelNameTokens()` predicate, used by the gate and the wait. The
   justification for the wait is *zero cache presence*, not literal first utterance,
   so prior mention is no longer a disqualifier — and `prior` had no marginal value
   over `parsedWords` anyway except suppressing exactly the case that must not be
   suppressed: a word seen in the scene but never ruled on.

## Changelog — v0.45.0 (the gate rotted shut: why the parser stopped being asked)

Proven by `test/proof.js` (468) + `test/sim.mjs` (257); **6 guards negative-tested**.

Live report: `you talk to rukia` — Rukia never injects, an unrelated cached
character does. This is a real regression and it is not about the wiki. The parser
was never asked to look. Four failures in the gate, each fixed at its own root.

1. **A failed parse still burned every word in the message.** `parsedWords` means
   "the model has ruled on this word", but the learning ran *above* the `if
   (parsed)` check — and `parsed === null` is a timeout or transport failure, where
   the model saw nothing and ruled on nothing. One slow turn permanently marked
   every word of that message as settled. On a mobile backend that is not an edge
   case. Learning now requires an answer.

2. **The pair rule rotted shut.** The lowercase gate required TWO ADJACENT unknown
   tokens. Every word of the player's message was learned, so the ordinary verbs
   around a name — `talk`, `greet`, `turns` — became "known" after a turn or two,
   and from then on a lone new name was *always* adjacent to a learned word and the
   pair could never form. `you talk to rukia` opened the gate on a fresh chat and
   never again, which is exactly the "it used to be smart" shape. The loop also ran
   to `length - 1`, so a name ending the sentence — the commonest way anyone
   addresses someone — was never even tested. **Fix:** ordinary vocabulary, not
   adjacency, is what separates a name from prose. `COMMON_LOWERCASE`, the 434-word
   lexicon built for precisely this question and never consulted here, now gates it;
   ONE novel token is enough, and once-only learning still bounds the cost.

3. **One word, two laws.** The capitalised path could revisit a ruling
   (`parserMayRevisit`); the lowercase path read `parsedWords` directly, so its
   ruling was permanent for the chat. **Fix:** a single `parserVetoHolds()` used by
   both. A "not found" ruling is a fact about the wiki list and the moment that
   produced it, and holds only while both still stand.

4. **The ledger never spoke.** `ledgerNames()` — Summaryception's curated cast of
   *this* story — was computed on the line directly above the gate and used only for
   injection tiers. It is certainty, not a guess, and costs nothing to consult.
   **Fix:** any ledger character's name token in the player's own message opens the
   gate, whatever the case and whatever the parser once ruled. No capitalisation
   heuristic gets a vote on whether the player just addressed a known character.

## Changelog — v0.44.0 (the addressed character never injected: a fight page, and a day-long sentence)

Proven by `test/proof.js` (468) + `test/sim.mjs` (244); **5 guards negative-tested**.

Live report: the story addresses Rukia. Rukia never injects. An unrelated cached
character injects in her place, and the cache shows her as not found. Three layers
had to fail together, and each is fixed at its own root.

1. **A fight page grounded as the character.** Wikis with heavy battle coverage
   title those articles after their participants — `Rukia Kuchiki & Yasutora Sado
   vs. Shrieker`. That ranks high on a search for "Rukia", passes `isMediaTitle`
   (no subpage slash, no media parenthetical), and passes the coverage guard,
   because every token of the query genuinely is in the title. It carries no
   character infobox — and a **trusted** name skips the character-signal gate, so
   nothing stopped it. **Fix:** a title naming two combatants is an event, not a
   who; `isMediaTitle` rejects `vs.`/`versus` titles. Word-interior matches
   ("Vsevolod") are untouched.

2. **The search took the first acceptable hit, not the best one.** Search rank is
   relevance, not identity: a page mentioning Rukia a hundred times can outrank her
   own article. **Fix:** among non-media hits, prefer those that *cover* the query,
   shortest title first — a character's own page is the tightest title that still
   accounts for the name. Plain relevance order remains the fallback.

3. **One miss was a 24-hour sentence, and nothing could overturn it.** Every miss
   was cached for a full day, and only `not-character` was re-fetched for trusted
   callers. So the moment Rukia resolved to a page that yielded nothing, she was
   `no-facts` — locked out for 24h while the LLM parser named her, correctly, every
   single turn. The note then filled with whoever was still cached. **Fix:** the
   horizon depends on whose failure it was. `no-page` means the wiki genuinely has
   no such article — durable knowledge, and the right answer for an original
   character or a stray capitalised word, so it keeps the full day. Every other
   reason means we found a page and *our own* resolution or extraction failed; that
   is a heuristic failing, not evidence of absence, and now heals in 20 minutes.
   One `negativeTtl()` definition serves both the grounder and the parser gate —
   they previously had to be kept in step by hand, and a name healing in one while
   staying dead in the other is the same bug wearing a different hat.

## Changelog — v0.43.0 (deep audit: a guard nobody called, a default that froze, and a gate that proved neither)

Proven by `test/proof.js` (457) + `test/sim.mjs` (237); **9 guards negative-tested**
(each defect reintroduced in a scratch tree, each turns the gate red with exit 1).

Full-repo audit. Three defects, three canonical fixes, and the gate hole that let
the first one live: history was verified clean first — `index.js` grows
monotonically across every commit, so no old file was ever pushed over newer work.

1. **`isDisambiguation` and `isMetaSeriesPage` were never called.** Both existed,
   both had passing assertions in `proof.js`, and the file header claimed
   "disambiguation pages skipped". Neither had a single call site. `isMediaTitle`
   filters *titles*, which cannot help: a wiki's disambiguation page is titled
   `Rose` and its series page is titled `Bleach`. So `Rose` injected
   *"Rose may refer to: Rose Oriana, the second princess…"* as her canon identity,
   and the franchise page injected *"…is a Japanese manga series written by…"*
   mid-scene. **Fix:** both run immediately after `fetchWikitext`, above the
   character-signal gate and regardless of `trusted` — the caller vouches for the
   NAME, we choose the PAGE, so trust cannot carry. They take their own miss
   reason, `meta-page`, because `not-character` is deliberately re-fetched for
   trusted callers (a place/org is still lore); a meta page never becomes valid, so
   it must settle instead of re-hitting the wiki every turn. `groundArc` gets the
   disambiguation check too — `extractLead` on a router page would otherwise pin
   *"X may refer to: …"* as the story position, permanently, in chat metadata.

2. **A persona-dependent default was captured as a constant.** v0.42.0 made the
   note header resolve `name1` at injection time, but the settings box evaluated
   `defaultPromptHeader()` once, at UI-build time, into `const PROMPTS`. After a
   persona change the box displayed one name while injection used another — and one
   keystroke in that box compared against the *stale* default, storing a frozen
   old-persona header as a literal override, which also opts that user out of every
   future default improvement: exactly what v0.42.0 was built to prevent.
   **Fix:** every default in the table is a thunk, resolved at each use (initial
   value, comparison, reset), and `CHAT_CHANGED` re-resolves any box still showing
   its default. A user-authored override is never touched.

3. **Eleven doc blocks had come adrift.** Across many edit sessions, functions were
   moved or rewritten and their doc comments stayed glued above whichever neighbour
   inherited the position. `cleanWikitext`, `extractLead`, `extractDistinguishing`,
   `groundArc`, `relevantCanonNote`, `abilityLine`, `buildDossier`,
   `verifyCastEvidence`, `llmCall` and `auditCastEvidence` were all undocumented
   while their descriptions sat above their neighbours — which is how an editor ends
   up confidently changing the wrong function. Ten reattached, one deleted as
   obsolete (it described a `string[]` parser superseded by `parseCast`), and the
   parser doc corrected: it still promised a `string[]` return that has not been the
   shape for versions.

**Dead code:** `parseNameArray` lived in `index.js` with no product call site. Its
six assertions were proving a wrapper one indirection away from `parseCast`, which
is what actually runs. The projection moved into the harness; the assertions now
hit `parseCast` direct.

**New gates — the reason defect 1 could exist at all.** A pure-function proof is
only half a proof: `proof.js` proved the guards' *behavior* while nothing proved
they were *called*.
- **The wiring law:** every guard must have a real call site (comments stripped
  first, so a mention cannot pass for a call), and the page-validity check must sit
  *above* the character-signal gate with no `trusted` escape hatch.
- **A behavioral scenario:** the real interceptor runs against a real-shaped
  disambiguation page and a real-shaped franchise page, both named by the parser
  (i.e. trusted — the path that had no gate at all). The note must carry the
  ordinary character from the same turn and neither wrong page, and the settled
  miss must not re-fetch. Negative-tested: unwire the guard and both pages ground
  successfully and reach the note.
- **No stranded doc blocks:** every `/** … */` must be followed by a declaration.
- **Disjoint harness slices.** `proof.js` slices *product* code by text markers,
  several of which are doc comments — so reattaching a comment silently moved a
  boundary and doubled six functions. That is legal JavaScript and therefore
  silent, until a `const` lands in a doubled span and the harness dies with a
  SyntaxError; the history already contains that day. `grab()` now refuses to build
  a body it cannot prove is disjoint, naming both spans and their line ranges. Two
  of the four overlaps it caught pre-dated this release.

## Changelog — v0.42.0 (the canon note speaks in the player's own voice)

Shipped without a changelog entry; recorded here from its commits during the
v0.43.0 audit.

The injected note no longer reads like a bracketed system reference. The
`[CANON NOTES … KNOWLEDGE SCOPE … BEHAVIOR]` header became a short note in the
player's own voice with identical semantics (trust-the-note accuracy,
narrator-knowledge-vs-character-knowledge guard, baseline-not-script behavior,
per-pair dynamics override, voice anti-parroting) — and shorter. `STORY POSITION —`
became `Where our story is —`; pinned canon became `My standing notes…`. The
injection role moved from system to user, since system-role reference blocks are
what defensive persona cards reject.

`noteLabel()` resolves the player's persona (`context.name1`) at injection time, so
the note is titled with *their* name. ST's unset defaults (`User`/`Player`) are
role-words that read as corpo, so they fall back to `Author's note`; the word
"user" never appears. Scene-window filtering generalizes with it: any
`<n>'s note — canon` header counts as a machine note alongside the legacy bracket
markers, so a note committed under a previous persona never counts as visible scene.

## Changelog — v0.41.0 (a block's terminator must be its own; guards above discovery)

Proven by `test/proof.js` (449) + `test/sim.mjs` (220); **8 guards negative-tested**
(each defect reintroduced in a scratch tree, each turns the gate red with exit 1).

Deep audit. Six defects, six canonical fixes — plus one gate that was missing.

1. **v0.40.1 fixed half the meta-block swallow; this fixes the other half.**
   The closed-block branch (`[^\]]*`) was still free to scan PAST a later
   block's opener and borrow the `]` belonging to *it*. With Summaryception
   running, two markers in one message is the normal case — so one stream-cut
   `[IST: …` erased every paragraph up to the next well-formed marker.
   Measured: a 3-line message naming two cached characters stripped to `" "`,
   note EMPTY, reasons `[]`; the same message with the marker closed injected
   1789 chars. Worse, the v0.40.1 diagnosis then blamed `[META:]` for a cast
   that was sitting in the prose all along. A block's terminator must be its
   OWN: the closed branch may cross newlines (blocks legitimately wrap) but
   never another opener. Stream-cut-at-end-of-message still strips whole.
2. **A throw inside the heavy task lost the note entirely.**
   `heavy.then(() => true)` re-rejects, which threw out of the interceptor
   *after* `setInjection("")` had already cleared the turn — canon fully
   absent, and `lastInjection` still holding the previous turn's text, so the
   preview panel lied about it too. The last-known-state fallback exists for
   exactly this. Throw now degrades identically to timeout.
3. **Priority tiers evaporated on slow turns.** `tierUser`/`tierLedger` were
   assigned *inside* the racing task, so any turn that lost the race left them
   `[]`: the player's own typed names silently lost tier 1 and could be trimmed
   out of their own scene by the cap — on precisely the crowded turns where the
   cap bites. They are pure cache filters (no network, no LLM); computed after
   the race they are correct on fresh and stale turns alike, and the `!fresh`
   branch needs no special case.
4. **Discovery ran above both guards.** The 🔭 block sat above the genType
   filter *and* `cgInFlight`, so every quiet/impersonate generation spent a
   discovery LLM call plus a probe storm on an unbound chat and could bind a
   universe behind the user's back. Guards moved above the block; a chat switch
   during the hold is now dropped.
5. **Discovery was not single-flight.** Four entry points (chat change, boot,
   interceptor, Scan) all get "not settled" from an unbound chat until a pin is
   written, so they stacked — two or three full runs, each with its own LLM call
   and probe storm, each racing to bind. Concurrent callers now share the run;
   an explicit `force:true` Scan queues behind rather than merging. The slot is
   released in a `finally` (before resolution), not from a chained promise:
   releasing it a microtask late handed the next caller the finished run's
   stale result — caught by the gate while building this fix.
6. **Two settings that did not mean what they said.** Measured: with a dossier
   present, Personality / Relationships / Biography / Trivia ON = 1698 chars,
   all four OFF = 1698 chars — identical. The dossier path reads only
   `physical`, `voice`, `abilities`, `relationDynamics`, `smartExpansion`, and a
   curated dossier has no categorised content to gate, so the honest fix is to
   say so rather than invent a filter that guesses which fact is "biography".
   Likewise `maxTotalChars`: set to 300 it produced a 3261-char note (10.9×),
   because the ~1.6k header, pinned canon, and story position all ride outside
   the budget — deliberately, since the header carries the rules that make the
   rest safe to use and pins are decrees. Relabelled to what it budgets, floor
   raised from 200 (meaningless) to 600.

**New gate:** manifest version vs `CG_VERSION`. ST decides whether to
auto-update by reading `manifest.version`, so a commit bumping only the code
stamp ships an extension nobody's install will pull. The history contains that
drift; it is now a gate failure.

## Changelog — v0.40.1 (the preview must measure, and the scene must survive a stray bracket)

Proven by `test/proof.js` (440) + `test/sim.mjs` (201); **15/15 guards
negative-tested**. Live report: preview EMPTY (with the canned three-claim
toast) while the cache list showed four found characters and "Why each was
injected" listed them — the panel contradicting itself on one screen.

Four defects, four canonical fixes:

1. **A stray unclosed `[META:` block blinded the entire scene.**
   `stripMetaBlocks`'s unclosed-block fallback ate to end of MESSAGE
   (`[^\]]*` crosses newlines) — one cut-off marker anywhere and every
   paragraph after it vanished before matching, so the matcher saw a blank
   scene while the prose named the whole cast. Unclosed blocks now strip to
   the end of their LINE; the stream-cut case (block runs to end of message)
   the `$` existed for still strips, byte-identical.
2. **The empty-preview toast asserted three facts it never measured** —
   "nothing cached is named in the scene window, cast is empty, and no
   pins/arc are set" was a static string. It is now a measured diagnosis:
   scene size, found-entry count, cast length, pin list, whether the setting
   pin actually resolves — and it hunts the nearest miss, naming the two
   silent scene-killers outright: characters *named ONLY inside `[META:]`
   blocks* (stripped before matching — Summaryception/ACW presence markers
   are exactly this shape), and a *dangling setting pin*.
3. **The ghost panel.** `renderLastInjection` early-returned on an empty
   injection without touching "Why each was injected", so the previous
   non-empty turn's reasons sat on screen under a "Nothing injected" banner
   forever. An empty injection now clears the panel.
4. **The setting pin was exact-key-or-nothing.** A re-keyed entry (canonical
   re-ground, corpse burial) silently darkened the pin. It now resolves
   through `cacheEntryFor` like every other name.

## Changelog — v0.40.0 (the evidence law: a universe must be proven BY THE CHAT)

Proven by `test/proof.js` (430) + `test/sim.mjs` (195); **all ten guards
negative-tested** — each fix reintroduced in a scratch tree, each turns the gate
red. Live report: a brand-new chat, no message sent, nothing written about the
world, and discovery announced a protagonist named *Assistant* and bound
`memory-alpha` / `the-magnus-archives`.

**Root cause: the model was grading its own homework.** Discovery asked the LLM
for candidate wiki slugs AND for the canon names to verify them with, then
probed one against the other. memory-alpha genuinely has a *Spock* page — so the
probe always succeeded. It proved that Star Trek exists. It never proved
anything about this chat. Any hallucinated franchise self-certified with perfect
reliability, and four smaller defects fed it:

1. **Circular verification.** The proposer supplied both the candidate and the
   key. **Fix — one law, the same one the cast parser already lives by:** a
   candidate wiki is bound only when it knows something *this chat actually
   says*. Keys now come from the chat's own distinctive proper nouns, from
   proposer names the chat really mentions (`groundedNames`), and from the
   phrase the proposer quotes back out of the text — verified to be in it.
   memory-alpha does not know *Seireitei*, so it cannot claim this story.
2. **Discovery ran on a blank page.** Boot, chat-change and turn one all fired a
   full discovery pass against an empty chat, and a model asked to name a
   franchise will name one. **Fix:** with no card name and no proper noun
   anywhere in the chat, discovery does not run — no LLM call, no probe, and no
   settled pin, so the next turn re-checks for free and binds the moment the
   story speaks.
3. **`Assistant` was treated as a protagonist.** SillyTavern's neutral card is
   literally named that; it headed the prompt (`Protagonist: Assistant`) and
   became a probe key that matches an "Assistant Director" page on every wiki
   alive. **Fix:** placeholder names (`Assistant`, `AI`, `System`, `Narrator`,
   `User`, `New Character`, …) are never protagonists, never probe keys, and
   never evidence.
4. **Titles matched on raw substrings.** `"Yokoda"` claimed `"Oda"`,
   `"Blade Runner"` claimed `"Zar Blade"`, `"Oda Family"` claimed `"Jovan Oda"`.
   **Fix:** whole-word token matching — one side's words must all be words of
   the other, with at least one substantial (≥3 chars), so two-letter glue can
   never carry a match. (The old proof asserted the shared-surname case as
   *correct*; that assertion encoded the defect and now asserts its rejection.)
5. **The card name became a wiki slug.** Card "Alice" → `alice.fandom.com`,
   proven by searching for *Alice*. **Fix:** candidates carry the chat string
   that generated them and may never be proven by it — a wiki cannot certify
   itself.

Fixed alongside, from the same report:

- **Discovery was reading a keyhole.** It saw a 600-char description slice and
  two 300-char messages — so a world written in the *scenario* field, the
  greeting, the creator notes or the tags was invisible to it, and so was
  anything revealed after message two. It now reads the whole card plus the
  opening *and* the latest scenes.
- **A `#fandom` declaration is a decree.** "#Found Saga" on line one is the user
  naming their own universe: that candidate needs no canon-name proof, only to
  be real. And a chat bound that way re-verifies the way it was *proven* —
  demanding a stricter proof later re-opened a settled chat every single turn.
- **"Scan current scene now" now forces discovery.** The explicit user action
  was being swallowed by the settled-fingerprint short-circuit, so a chat that
  had settled (or failed) could never be re-scanned.
- **The proposer is told that guessing is worse than nothing**, and asked to
  quote its evidence verbatim from the text.
- **Toast names its proof:** `🔭 Universe found via "Seireitei": bleach.fandom.com`.
- **Candidate probing is bounded** (24 fetches) so a total miss cannot grind a turn.

**Gate latency:** `test/sim.mjs` set `maxBlockMs`/`firstMeetWaitMs` to 30000, and
two scenarios deliberately wait the block out to prove the starvation path — 62
seconds of wall clock for two assertions. Lowered to 8000 (the slowest real
scenario, the cache self-heal chain, fails at 3000): identical 195 assertions,
stable across repeated runs, gate down to ~34s. Product defaults untouched.

**Harness defect found on the way:** `test/proof.js` had two overlapping slices,
silently evaluating ~35KB of `index.js` twice. Function redeclaration is legal,
so it never surfaced — the first `const` added there turned it into a hard
SyntaxError. Boundaries fixed; the overlap is now itself negative-tested.

## Changelog — v0.39.1 (the license to break — compression must not cut permissions)

Proven by `test/proof.js` (401) + `test/sim.mjs` (167); the restored clause
negative-tested. Caught by the obvious pressure test: "can a stubborn person
still beg?" The v0.39.0 compression kept the anti-repetition law but silently
dropped the PERMISSION to yield — and a model never told breaking is allowed
plays the wall. Restored, surgically (~25 words, still well under half the
original): traits decide HOW someone responds, never WHETHER they respond
humanly; people bargain, beg, break, or hold at visible cost; and the concrete
private-warmth example (stoic on duty, warm or petty in private) that anchors
the Alpha-with-Cid class of modulation. The 'With <name>' pair-dynamic
injection plus its override law already guaranteed the Cid case at the DATA
layer; this closes the law layer.

## Changelog — v0.39.0 (turn one injects, and the notes stop talking like a robot)

Proven by `test/proof.js` (398) + `test/sim.mjs` (167); the turn-one path
negative-tested end to end. Three live reports, three root fixes.

1. **Turn ONE of a new chat now discovers, binds, parses, grounds, and
   INJECTS — in one interception.** The old hold RACED discovery against a
   12s timer while the discovery LLM had a 30s budget, so on slower backends
   discovery lost, grounding ran unbound, and the injection landed after
   generation had already started — the panel said "injected" while the
   model's context was empty, and canon only appeared from turn two. A brand
   new chat has no story to stall: within the opening (first two messages)
   an unbound chat now WAITS for discovery outright, the discovery call gets
   a snappy 15s-capped budget, and grounding proceeds on the freshly bound
   universe in the same turn. Automatic now feels like manual.
2. **The header speaks the model's language.** "[CANON NOTES — this series'
   wiki, refreshing your memory. You already know this world; the notes
   below are the sharp version of memories gone fuzzy… trust the note: it IS
   the accurate memory." Same authority, zero barked overrides — models
   comply better with a memory they own than with orders to obey. Old chats'
   already-injected blocks still carry the old opener, so the scene-scrub
   marker list detects BOTH.
3. **The behavior block: same laws, a third of the words.** Descriptive-not-
   script, react-to-now, pressure-through-the-trait, the escalation/
   repetition law (kept verbatim), 'With <name>' override, voice lines as
   style samples never recited, fresh behavior with contradictions — all
   retained; the lecture and the torture vignette cut. Fewer, better-chosen
   tokens is the whole doctrine.

## Changelog — v0.38.0 (each chat is its own universe — no more leaks between fandoms)

Proven by `test/proof.js` (398) + `test/sim.mjs` (159); four negative-tested
guards. Root-caused from a live report: a NEW chat still carried the previous
chat's wiki. Called out, correctly, as flex tape — v0.36/0.37 bolted discovery
onto a GLOBAL setting and let it settle against an EMPTY chat. This release
fixes the architecture, not the symptom.

1. **The universe is CHAT-SCOPED state.** Discovery binds the wiki to the
   CHAT (`canon_grounding_wiki` pin) and never writes the global field again.
   Every grounding path — search list, negative-cache keying, arc lookup,
   status UI — reads `activeWikis()`: the chat's own binding first, the
   global field only as the default for unbound chats. One chat's discovery
   can no longer leak canon into another chat. (Same architecture rule as
   Summaryception: each chat is its own universe.)
2. **Settlement is DECLARATION-AWARE.** The settled pin is keyed on a
   fingerprint of what discovery actually SAW — card + the chat's OPENING two
   messages + the effective wiki list. A new chat that settles against an
   empty chat re-opens the moment "#classroom of the elite" (or any opening
   content) arrives; from message three on it is immutable. Re-checks while
   the opening fills remember the canon name that verified last time
   (`via`) and re-verify with ONE fetch and ZERO LLM.
3. **Turn one HOLDS for an unbound chat** (bounded by firstMeetWaitMs) — the
   first-meeting rule applied to universes: a wrong UNIVERSE on the first
   turn costs more immersion than a short pause. Bound chats pay nothing.
4. **Binding purges foreign canon.** When a chat's universe changes
   (discovery, field edit, or a saved-wiki chip tap — both of which are now
   DECREES binding the current chat and never second-guessed), cached
   entries from other universes are deleted; misses were already keyed to
   the wiki list. No stale classroom-of-the-elite entries embedded in a
   Bleach chat, ever.

## Changelog — v0.37.0 (ō is a letter, and discovery triggers everywhere)

Proven by `test/proof.js` (394) + `test/sim.mjs` (144); three negative-tested
guards. Root-caused from a live report: "Ayanokōji at volume x … Preview is
EMPTY". Two independent defects, both fixed at the source.

1. **Unicode names — the extractor no longer truncates at a macron.** The
   capitalized-phrase regex was ASCII (`[A-Z][a-z]…`), so "Ayanokōji" broke
   into fragments at the ō and never reached the wiki whole; every macron name
   (Tōshirō, Kūgo, Ayanokōji) failed the same way. The regex now uses Unicode
   letter classes with explicit letter lookarounds (\b itself is ASCII-blind
   after a trailing ō). Matching folds diacritics end-to-end via `normName`
   and `titleCoversQuery`, so a typed-ASCII "Ayanokoji" covers the wiki's
   "Kiyotaka Ayanokōji" — you never have to type macrons to hit canon.
2. **Discovery had exactly ONE trigger — a chat SWITCH.** The chat already
   open when the extension loads never fires CHAT_CHANGED, so 🔭 never ran for
   it: grounding searched the previous fandom's wiki, missed everything, and
   negative-cached the misses. Discovery now self-heals from every entry
   point: chat change, extension load (for the already-open chat), and the
   interceptor itself on ANY turn — the settled per-chat pin makes the extra
   calls free. "Scan current scene now" AWAITS a discovery pass first, because
   that button means "make canon work NOW" and a wrong wiki is the first thing
   to fix.
3. **An EMPTY preview now says WHY.** When nothing is cached, the preview
   names the wiki state — not yet verified for this chat (and what triggers
   it), or discovery failed (and that the wikis field is the manual override) —
   instead of leaving an empty report to be guessed at.

## Changelog — v0.36.1 (🔭 an original protagonist must never break discovery)

Proven by `test/proof.js` (387) + `test/sim.mjs` (139); both new guards
negative-tested. Root-cause follow-up to v0.36.0, caught by the obvious
question: "my MC is an OC — is that still ok?"

1. **Root defect:** v0.36.0 verified every wiki by searching for the
   PROTAGONIST's name. An original character is, by definition, in no wiki —
   so for OC-driven stories (the primary use case), verification failed and
   discovery then rejected even a CORRECT manual config, ending in a
   misleading "no wiki found".
2. **Root fix — verify with canon, not with the OC.** The discovery call now
   also returns the franchise's most famous CANON character names, and every
   wiki is verified by whether it knows ANY of them ("does this wiki know
   Ichigo Kurosaki", not "does it know Jovan"). The card name remains a probe
   of last resort, so ordinary canon-character cards keep their zero-LLM
   fast path.
3. **A correct manual config settles silently.** Before any candidate is
   probed, the ACTIVE config is re-verified with those canon names — an OC
   card on a right wiki now pins as verified with exactly two probes and no
   candidate machinery, instead of being "not found".

## Changelog — v0.36.0 (🔭 the wiki finds itself: the field becomes an override)

Proven by `test/proof.js` (384) + `test/sim.mjs` (133) — a full live discovery
scenario plus wiring witnesses, with three negative-tested guards. You no longer
type the wiki; you only correct it if you ever disagree.

1. **Verify before anything.** On every chat open, one cheap probe asks the
   ACTIVE wiki whether it actually knows your protagonist. Yes → the chat is
   pinned as settled and discovery never costs another call. This also means an
   already-correct manual config is confirmed silently, with zero LLM spend.
2. **The LLM proposes, the wiki API disposes.** When the config is empty or
   wrong for this chat, a small call proposes candidate wiki slugs from the
   character card — including romaji titles ("Demon Slayer" lives at
   `kimetsu-no-yaiba`, which no string heuristic derives) — and EVERY candidate
   is verified structurally against the real `api.php`: a search for the
   protagonist must actually hit. A hallucinated slug simply fails its probe;
   an existing-but-wrong wiki (fetch-ok, zero relevant results) is rejected the
   same way. Nothing unverified can ever land in your config.
3. **A live wiki.gg beats a frozen Fandom fork.** When both hosts answer for
   the same slug, `recentchanges` timestamps decide: the wiki with the newer
   last edit is the live one (many big fandoms migrated to wiki.gg and left a
   frozen copy behind). Unreadable recency loses to readable; total silence
   defaults to Fandom. Deterministic, documented, witnessed.
4. **Found or failed, the chat settles.** Success fills the field, saves the
   wiki to your library, and pins the chat; failure toasts ONCE and pins a
   failed marker — no nagging, ever, until the chat or the wikis field changes
   (editing the field invalidates the pin, and the negative-miss cache was
   already keyed to the wiki list). The field's hint now says what it is: the
   manual OVERRIDE. Toggle: 🔭 Find the wiki automatically (default on); the
   discovery prompt is visible and editable in 🧾 like every other.

## Changelog — v0.35.0 (📖 the story referee: entering ≠ mentioning, and the position never regresses)

Proven by `test/proof.js` (370) + `test/sim.mjs` (114) — live referee scenarios,
transition-rule witnesses, and three negative-tested guards (high-water skip,
referee-must-be-consulted, manual-wipe decree — each bug reintroduced in a
scratch tree and confirmed to fail its gate red). Root-cause release
for autonomous story tracking; auto-advance is now trustworthy, not just present.

1. **Occurring vs mentioned — judged, not guessed.** Auto-advance used to fire
   whenever a canon event ENTERED THE CAST. But the parser lists remembered,
   discussed, and flashback entities *by design* — so "she missed the Bushin
   Festival" moved the story position exactly like "the Bushin Festival
   begins", and a Summaryception flashback could yank the pin backwards and
   inject a spoiler guard that contradicted the chat's own established history.
   String heuristics cannot tell the two apart; a model can (the Cast Auditor
   argument). A dedicated 📖 story-referee call now rules each NEW candidate:
   only the story actually entering the event advances the position. Fails
   safe — no verdict, no movement. Its prompt joins 🧾 like every other one.
2. **The position is a HIGH-WATER MARK.** Superseded positions are remembered
   per chat (`canon_grounding_arc_reached`; title, query, and triggering
   entity name all count), and a reached event re-entering the scene is
   skipped *before* any referee call is spent — the story never slides
   backward on a memory, and the same event can never re-pin itself in a loop
   (the old `cur.title !== entry.name` compare re-ground "Bushin Festival"
   every parse because the pinned page was "Bushin Festival Arc"). Manual
   pins and Ask Canon are decrees: they wipe the tracker's memory, so a
   deliberate rewind can be replayed forward through the same arcs again.
   Clearing the position clears the memory too.
3. **"Begun" framing — the arc summary stops spoiling its own arc.** The old
   injection asserted the pinned summary as "events up to this point have
   occurred" — but an auto-advanced arc has just STARTED, so the model was
   told the arc's own climax already happened. Auto pins now inject in a
   `(just beginning)` frame: the summary is the narrator's map of canon that
   has NOT yet occurred, quarantined from every character's knowledge, free
   to unfold naturally. Manual/legacy pins keep the original "everything
   above has occurred" semantics byte-for-byte.
4. **The AI's own narration moves the story too.** World-state from the cast
   (current setting + story position) is now ONE function —
   `applyCastWorldState` — called from every parse path: the pre-generation
   interceptor, the post-generation scan of the AI's reply, and the manual
   "Scan current scene now" button. The narrator writing "the Winter Gala
   begins" advances the position on that very reply, instead of waiting for
   you to name the event yourself. One definition, three call sites, witnessed.

## Changelog — v0.34.0 (an extracted fact must actually be a fact)

Reported: every Bleach character came out `[height: 2.3]`. Three defects
stacked, each necessary for the wrong number to reach the prompt.

- **The extractor had no notion of an infobox.** `extractInfoboxFields` was
  named for the infobox but scanned the ENTIRE page, so any template anywhere
  could donate a field. A layout wrapper carrying its own `|height = 2.3`
  outranked the character's real `|height = 187 cm` purely by sitting earlier
  in the source — and did it identically on every page of that wiki, which is
  exactly why every character had the same nonsense height. Extraction is now
  scoped to the infobox (matched by template name, else the first param-dense
  block near the top), falling back to the whole page when no infobox can be
  identified, so nothing that worked before stops working.
- **No value was ever checked for being a fact.** The noise filter rejected
  bare INTEGERS, so every decimal walked straight in. A value that is a naked
  number or a CSS size is layout, never canon; and a measurement field carrying
  digits must name its unit (`187 cm`, `1.87 m`, `6'1"` pass — `2.3` and
  `2.3 (approx)` do not). Prose measurements ("Tall") still pass: the rule is
  about digits without units, not about prose.
- **A rejected value no longer claims its label**, so a junk `height` followed
  by the real one yields the real one rather than shadowing it forever.
- **The cache is permanent, so the fix had to reach entries already poisoned.**
  A stored `height: 2.3` now trips `entryPoisoned` — the same self-heal that
  already rebuilds markup-corrupted sections — and the heal stamp became
  per-fix-generation instead of once-ever, so an entry cleaned by an older
  extractor can still benefit from a newer one. Existing chats repair
  themselves, one entry per turn, with no cache clearing.
- Rejections are logged with the raw field name and value, so the next instance
  of this is a five-second answer instead of an inference.

Proven by `test/proof.js` (354) + `test/sim.mjs` (79, including a poisoned
entry repairing itself across turns). **5 guards negative-verified**, with the
scoping and unit rules given discriminators that isolate them from the
bare-number rule — two earlier assertions passed either way and were replaced.

## Changelog — v0.33.0 (the model can finally read the whole page; wrong facts stop shipping)

An audit of the whole grounding path, from wikitext to injected block. Five of
the eight findings were not gaps in what the extension knew — they were canon
it stated **incorrectly**, silently, with full confidence.

**Wrong facts, fixed at the source**

- **Attribute cross-contamination.** The prose extractor searched the entire
  snippet for "the words before `<noun>`", so a colour belonging to a different
  clause was read as this attribute: *"Her hair is a deep crimson and her eyes
  are pale gold"* reported **eyes: deep crimson**. Each attribute is now
  resolved inside the clause that names it.
- **Predicate forms were invisible.** Only the pre-modifier shape ("silver
  hair") ever matched — *"her hair is X"*, *"his hair, once black, is now
  white"*, *"hair as black as night"* all yielded nothing, on every wiki that
  writes descriptions as sentences. Now handled, and a trailing run with no
  real colour in it is still correctly refused.
- **True facts silently deleted.** Infobox facts were deduped against the look
  prose by raw substring containment, so `hair: red` vanished because the prose
  said "sh**red**ded" and `eyes: tan` because it said "dis**tan**t". The dedupe
  is word-boundary aware now.
- **Relevance scored on accidental letter overlap.** The same substring mistake
  drove every scene-conditional selector: a power called *Wind Read* surfaced
  because the scene mentioned **bread**. One `inPlayScore` helper now serves
  facts, powers, and background context — distinct tokens, word boundaries, so
  repetition can't inflate a score either.
- **Apostrophes split names in two.** Alias extraction stripped every `'`,
  turning *White Room's Masterpiece* into an alias that can never match the text
  naming her; and `'` vs `’` were two different characters everywhere a name is
  keyed or compared. One canonical form (`normName`), and matching tolerates
  every apostrophe dialect.

**Knowing everything**

- **Powers were structurally unreachable.** The dossier curator was shown
  LEAD / APPEARANCE / PERSONALITY / RELATIONSHIPS / HISTORY / TRIVIA / QUOTES —
  no Abilities section, **and no infobox at all**. Once a dossier existed the
  regex abilities line was never emitted either, so a character's signature
  techniques could not reach the model no matter which toggles were on. The
  digest now carries **INFOBOX** (the densest facts on any page: affiliation,
  rank, status, relatives) and **ABILITIES**; the dossier schema gained an
  `abilities` key that asks for techniques *with their stated limits*; existing
  dossiers self-upgrade in the background.
- **Powers cost nothing until they matter.** The new line is scene-conditional:
  a quiet scene pays zero, a scene that names a technique gets that technique,
  a fight gets the arsenal in relevance order. The two triggers compose — a
  partial keyword match can never narrow the answer below what a bare combat
  scene shows. `abilities` now defaults ON (`migrated_v7`); it was off because
  the raw wiki section was 400 characters of noise every turn, and it no longer
  is.

**Decree and waste**

- **"Never inject X" leaked.** The blocklist was enforced at emit time only, so
  a blocked character still reached the present-cast and came back out through
  *other* characters' `With <name>:` dynamics, the Context de-dup set, and the
  reasons panel. Six duplicated admission sites collapsed into one `admit()`
  gate: blocked now means absent, not merely unprinted.
- **Every fact printed twice.** In prose-brief mode the identity line is not
  emitted — the brief is — but facts were deduped against identity. Now deduped
  against what is actually printed.
- **A brief-only dossier was thrown away** as "empty": the test predated the
  field the block opens with.
- **The current setting was invisible.** It is written by the parser, injected
  every turn forever, and had no row in the UI and no code path that clears it —
  so an organisation whose name contains a place word ("Shadow Garden" →
  *garden*) became a permanent block nobody could see or remove. It now has a
  row and a ✕.

Proven by `test/proof.js` (331) + `test/sim.mjs` (76, including end-to-end:
the digest the curator actually receives, and powers appearing only in the
scene that earns them). **13 guards negative-verified** — each fix reverted in
a scratch tree and the corresponding assertion watched to fail.

## Changelog — v0.32.0 (injection depth is a setting; canon rides at the top by default)

The note was hardcoded at depth 1 — glued just above the newest message,
below every other extension's injection. Canon is stable reference, not
recency: it belongs where the model reads it before anything else.

- **New setting: Injection depth** (0–9999). ST clamps depth to the chat,
  so the default **9999 parks the canon note at the very top of chat —
  right after the system prompt**, above Plot Essential and the first
  message. Set 1 to restore the old just-above-newest placement, or any
  depth in between to interleave with other extensions' injections.

Proven by `test/proof.js` (297) + `test/sim.mjs` (71: default depth
observed at the ST API boundary, live setting change honored next turn).
2 guards negative-verified failing on v0.31.0.

## Changelog — v0.31.0 (meta blocks are UI, not scene; injection tiers are decree, not inference)

Whereabouts tickers ("[ACW: Hiyori Shiina | Library | calm]") and similar
status blocks embedded in messages were read as scene prose. The parser —
asked who is present in text that literally lists every tracked character
with a location — answered honestly with the whole roster, and the sweep
saw a page of proper-noun names for people nowhere near the scene. The
actual cast then fought the roster for injection budget.

- **`stripMetaBlocks`** scrubs ALL-CAPS-tag brackets (`[ACW: …]`,
  `[HUD: …]`, `[OOC: …]`) at every text entry point: the scene window, the
  last user message, and inside `relevantCanonNote` itself. Unclosed blocks
  (mid-stream cuts) drop to end of message. `[sic]`, `[laughs]`, and
  name-tagged dialogue (`[Kiyotaka: …]` — mixed case) survive untouched.
  Ticker names never reach the parser, the gates, or the sweep.
- **Injection priority is now explicit tiers**: pins → current setting →
  **player-named this turn** → **on-screen ledger cast** → parser cast →
  sweep. The ledger tier now applies in every mode, not just ledger mode.
  Caps trim from the bottom, so the characters you are actually addressing
  can never be squeezed out by inference.

Proven by `test/proof.js` (297 assertions: scrub semantics, ticker
immunity, tier ordering) + `test/sim.mjs` (69, including end-to-end: a
ticker-only character stays out, zero parser round trips, real cast
untouched). 2 sim guards negative-verified failing on v0.30.0 —
reproducing the reported bug exactly.

## Changelog — v0.30.0 (token resolution can no longer summon the off-screen)

v0.29's token pass regressed injection: it was over-broad on two axes.
Token SOURCE — aliases ("Bee Commander") and suffixed cache keys
("… (bleach)") are full of generic words, so an epithet word in ordinary
prose resolved to a character nowhere near the scene. Token MATCHING —
case-blind, so lowercase prose sharing a word with someone's name swept
them in, displacing the on-screen cast under the caps.

- Token source is the character's NAME only, both in `cacheEntryFor` pass 2
  and the sweep index. Aliases stay exact-match (pass 1) — that is what
  aliases are for.
- The sweep now requires PROPER-NOUN usage: the token must appear in the
  scene with its name casing ("Rukia"), matched case-sensitively on the
  original messages. A character can only be swept in if their name is
  actually written as a name in the window.
- Cross-cache uniqueness guard unchanged: shared tokens ("Kotetsu") still
  resolve to nothing.

Proven by `test/proof.js` (289 assertions) + `test/sim.mjs` (66). 4 guards
negative-verified failing on v0.29.0 — each reproduces the regression
(alias-word summon, key-token summon, lowercase-prose sweep) before the
fix; "Rukia"-style first-name resolution verified intact after it.

## Changelog — v0.29.0 (first names find their character)

"You talked to Rukia" injected the previous scene's cast — and no Rukia.
She was cached, but every non-parser resolver was exact-match blind:
`cacheEntryFor("rukia")` ≠ "Rukia Kuchiki", the smart sweep only matched
full names/aliases against the scene, and the parser gate stayed shut
because the word was already in `parsedWords`. Priority (pins → setting →
cast → sweep) then filled the note from the stale cast.

- **Unambiguous whole-token resolution** in `cacheEntryFor`: a query that is
  a whole token (≥3 chars, non-noise) of exactly ONE character's name/alias
  set resolves to that character. "Rukia" → Rukia Kuchiki. A token two
  characters share — "Kotetsu" with both sisters cached — resolves to
  nothing: no guessing, the parser can disambiguate that one. Heals the
  user-typed prepend (which already rides FIRST, ahead of the cast), the
  parser gate (no wasteful re-parse, no duplicate short-form cache keys),
  and cast pruning — one choke point.
- **First-name smart sweep**: the same uniqueness rule applied scene-wide
  via a token→owner index, so "you talked to Rukia" pulls her in even in
  sweep-only situations.

Proven by `test/proof.js` (284 assertions) + `test/sim.mjs` (66, including
the exact end-to-end scenario: stale cast + first-name user mention →
addressed character injected FIRST, zero parser round trips). 8 guards
negative-verified failing on v0.28.0; ambiguity guards prove the token pass
never over-matches.

## Changelog — v0.28.0 (a "not found" binds only the wikis it searched)

The Bleach-crossover bug: characters missed BEFORE the right wiki was in the
list stayed "✕ not found" for 24h even after adding it — while fresh
suffixed queries ("Kenpachi Zaraki (bleach)") grounded fine, leaving a found
entry AND a corpse ✕ row for the same character. Four legs, one class: the
negative verdict never recorded WHAT it searched, `ensureGrounded` honored
it blindly, the parser gate suppressed re-asking, and `parsedWords` vetoed
the name for the rest of the session.

- Misses now carry a `searched` stamp (normalized wiki set). A negative only
  speaks while it covers the CURRENT list — add a wiki and every affected
  name re-searches on next mention. Legacy stampless misses are always
  stale, so existing dead rows revive once, immediately.
- `cacheEntryFor` buries a stale ✕ shadowing an entity found under another
  key (suffixed/canonical query) — one choke point, every path heals, the
  duplicate panel row deletes itself.
- `isUnhandledName` and both parser-trigger sites apply the same coverage
  test; the `parsedWords` veto is void exactly for wiki-stale negatives
  (verdicts about non-names rightly survive wiki changes).

Proven by `test/proof.js` (276 assertions) + `test/sim.mjs` (60, including
end-to-end: miss on wiki A → add wiki B → same name grounds and injects
same turn; suffix-keyed entry buries its bare-name corpse). 5 sim guards
negative-verified failing on v0.27.1.

## Changelog — v0.27.1 (table peel completes at any depth)

Post-crash audit release. Stress-tested the v0.26 containment pass with
pathological input (340KB, table nesting depth 14, unclosed constructs, 5k
image lines): terminates in 4ms — nothing in this extension can hang or
crash the platform. The audit did catch one leak: the table peel loop's
arbitrary 8-pass cap abandoned *balanced* table syntax at nesting depth >8.
The loop now terminates on progress (each productive pass strictly shrinks
the string; the raised failsafe only guards a hypothetical zero-width regex
edit), and a post-loop sweep makes every exit path junk-free — matching
MediaWiki itself, which swallows an unclosed `{|` to end of page.

Proven by `test/proof.js` (265 assertions: depth-12 guard negative-verified
failing on v0.27.0, unclosed-table guard preserving drop-to-end behavior) +
`test/sim.mjs` (51) + the standalone stress harness, all passing.

## Changelog — v0.27.0 (poisoned caches heal themselves)

Proven by `test/proof.js` (263 assertions) + `test/sim.mjs` (51, including a
live poison→heal→clean-injection scenario), all passing; the 4 heal guards
negative-verified failing on pre-heal code.

v0.26.0 fixed the extractor — but the cache is chat-scoped and permanent, so
every entity grounded BEFORE the fix still carried gallery filenames as its
"look" and injected them forever. The extractor fix alone could never reach an
existing chat. Now:

- **`entryPoisoned`** detects the junk signature (image syntax, `{|` table
  syntax, magic words, comment shrapnel, `|-|` tab plumbing) in any cached
  section.
- **Self-heal in the interceptor**: one poisoned entry per turn is rebuilt in
  the background from a fresh fetch — once per entity ever (`healTs`
  persists), same pattern as the dossier self-upgrade, but scanning the whole
  chat cache so single-character scenes heal too. No manual ✕-resets.
- **One builder, both paths**: section building is extracted from
  `ensureGrounded` into `buildEntrySections`, used verbatim by fresh grounding
  AND the heal — one definition, no drift.

## Changelog — v0.26.0 (markup containment + living-person baseline)

Proven by `test/proof.js` (257 assertions) + `test/sim.mjs` (46, including live
gallery-containment and personality-tail scenarios), all passing. Every new
guard was negative-tested: run against the pre-fix code, 21 proof assertions
and 5 sim assertions fail; on the fix, all pass.

**1) The Tsunade bug — gallery filenames injected as "Appearance".**
Reported symptom: `Appearance: Kid Tsunade.png|Tsunade as a child. Tsunade
full.png|…`. Root cause was a whole defect CLASS in `cleanWikitext`, not a
gallery special case: the generic `<tag>` stripper removes only the tags, so
any block construct whose *content* is markup flowed through as fake prose.
Reproducing it surfaced two more leaks of the same class that simply hadn't
been hit yet: HTML comments containing `>` bled their tails into Identity, and
wikitables bled whole (`{| class="wikitable" ! Arc |- …`) into any section.
One containment pass at the top of `cleanWikitext` now heals every consumer at
once (look, identity, personality, relationships, biography, dossier digest,
arc summary):

- comments stripped first (they may contain `>` or anything else);
- `<gallery>/<imagemap>/<timeline>/<slideshow>/<score>` blocks vanish whole —
  their bodies are image syntax by definition; an unclosed opener drops to
  end-of-input (better no text than raw markup, same philosophy as
  `stripTemplates`);
- `<tabber>` bodies are *unwrapped*, not deleted — tab labels and `|-|`
  plumbing die, prose between them survives;
- wikitables `{| … |}` peel innermost-first (nesting-safe); unclosed drops to
  end;
- residual bare image-entry LINES (`Foo bar.png|caption` from exotic dialects)
  die as lines — prose that merely *mentions* a filename mid-sentence
  survives;
- `__NOTOC__`-style magic words and orphaned `-->` stripped.

Tsunade's Appearance now injects as the wiki's own sentence: *"A fair-skinned
woman with brown eyes and straight blonde hair…"*

**2) The robot-NPC bug — canon making every personality rigid.**
Diagnosis: the note opens with maximum compliance pressure ("authoritative…
do not second-guess"), wiki personality prose is written in timeless absolutes
("never backs down"), and the old behavior paragraph only granted modulation
by company/mood/privacy — it said nothing about *duress*. Under threat of
torture the model played the absolute: identical defiance every beat.
Fixed at all three sources, model-agnostically:

- **Header:** behavior material is now declared DESCRIPTIVE — "how this person
  has tended to act — never a rule for what they do next"; characters "react
  to what JUST happened"; a new under-pressure clause (danger, pain,
  temptation, grief, exhaustion → fear leaks, tactics shift, voices crack,
  they stall/bargain/deflect/rage/adapt — sometimes break, sometimes hold at
  visible, mounting cost); the exact failure is named ("a stubborn character
  threatened with torture is not a wall replaying one refusal"); and
  "an identical reaction repeated while circumstances escalate is a portrayal
  error". Hard-fact authority is explicitly scoped to appearance/relations/
  history/events so it can't bleed onto behavior.
- **Dossier brief:** temperament is written "as living tendency, not law" —
  what softens them, what pressures them, strained vs at ease, the source's
  own contradictions kept, absolutist wording banned unless the source itself
  insists.
- **Regex baseline:** personality sections open with the absolutist thesis and
  record the humanizing exceptions near the bottom; the old 500-char top-slice
  injected only the robot half. Now head+tail sampled (the dossier digest's
  trick), so the injected baseline carries the contradictions too.

## Changelog — v0.25.0 (writes stay in the chat that asked for them)

Proven by `test/proof.js` (236 assertions) + `test/sim.mjs` (38, including a
live two-chat dossier-isolation scenario), all passing.

Three background flows could write into the WRONG chat if you switched mid-work
— the same contamination class fixed across the sibling extensions:

1. **Dossiers are entry-bound, not key-bound.** The dossier builder is seconds
   of LLM time; it used to re-look-up its cache slot by name when it finished.
   Two chats with a same-named character (one per universe) meant chat A's
   dossier could land on chat B's character — and A's in-flight stamp silently
   blocked B's own dossier for a day. The build now holds the entry OBJECT:
   the dossier lands on the character that asked, or nowhere.
2. **Story-position pinning drops on a chat switch.** `groundArc` fetches for
   seconds; finishing after a switch used to stamp the OLD story's arc onto the
   NEW chat. It now captures the chat epoch at entry and refuses a stale pin.
3. **Ask-Canon commands are sovereign IN their chat only.** The router call and
   `pin`'s own grounding are awaits; a switch during either used to land pins,
   blocks, notes, or arcs on whatever chat you arrived in. Every write path now
   re-checks the epoch and reports an honest drop ("aimed at the previous
   chat") instead of a false miss.

## Changelog — v0.24.1 (smart = whole content, zero waste)

Proven by `test/proof.js` (236 assertions) + `test/sim.mjs` (23), all passing.

The block header already names the character — prose re-paying for the name is
waste. Ground-time tightening (deterministic, zero per-turn cost):

1. Leading subject stripped: "Kiyotaka is a tall and lean young man…" →
   "A tall and lean young man…"; "Gamma has a beauty mark…" → "Has a beauty
   mark…". Every fact intact.
2. Scaffolding compressed: "He is usually seen wearing" → "Usually wears";
   "also seen wearing" → "Also wears".
3. The dossier brief prompt now forbids opening with or repeating the name —
   the header pays for it once, nothing else does.

## Changelog — v0.24.0 (Appearance as the wiki wrote it — not a database row)

Proven by `test/proof.js` (232 assertions) + `test/sim.mjs` (23), all passing.

"hair: brown; eyes: brown" was fragment-mining over prose that already said it
better: "a tall and lean young man with brown hair, brown eyes, and a fair
complexion. He is usually seen wearing a standard school uniform." Build,
complexion, clothing, even "considered very handsome" all live in the
Appearance section's OPENING sentences — so now they're kept AS PROSE:

1. **Look prose**: the Appearance section's opening description (≤300 chars,
   sentence-boundary cut) leads the Appearance line, exactly as the wiki wrote
   it. The Ayanokōji paragraph is a verbatim test fixture.
2. **Exact facts as a deduped bracket**: infobox colors ride behind the prose
   as `[height: 176 cm]` — anti-drift stays — but any fact whose value the
   prose already states stays home (no "brown hair… [haircolor: Brown]").
3. **One emitter for every branch** (dossier and non-dossier both) — the old
   split-rendering meant fixes could land in one path and miss the other.
4. `notably:` distinguishing details now scan only BEYOND the look window
   (Gamma's sentence-four mole still surfaces; duplicates don't).
5. Fallbacks intact: no Appearance prose → the exact-facts line as before.
   Existing entries pick up their look on re-ground (✕ once or new chat).

## Changelog — v0.23.0 (⏱🤝 first meetings wait — introductions are never wrong)

Proven by `test/proof.js` (228 assertions) + `test/sim.mjs` (23), all passing.

v0.20's immersion ceiling had one blind spot: "you meet rose oriana" opened the
gate, discovery needed ~3–5s, the 2s ceiling fired, and the introduction went
out UNGROUNDED — black hair invented, canon arriving one turn too late. Stale-
for-one-turn is fine for returning cast; for someone YOU just summoned there is
no stale state — only nothing.

1. **First-meeting wait.** When YOUR message references an entity with zero
   cache presence, the ceiling extends (default 12s, its own setting) so the
   canon is present in the very first reply about them. A wrong-haired
   introduction costs more immersion than a short pause.
2. **Precise detection, conversation-aware.** Partial references to known
   people ("Oriana" when Rose Oriana is cached) never wait; alias tokens
   count; ordinary words already used in the conversation ("you meet …")
   never gate; learned words converge — each new name waits exactly once.
3. Routine turns keep the tight ceiling; nothing else changes.

## Changelog — v0.22.0 (short names resolve to YOUR canon, not a guess)

Proven by `test/proof.js` (222 assertions) + `test/sim.mjs` (23), all passing.

Typing bare "Kakeru" injected Akito Miyake as "Miyake Kakeru" — a three-layer
failure, each layer fixed at the root:

1. **Known-canon resolution.** The parser expanding a short reference to a
   canonical is a GUESS — it welded two classmates into "Miyake Kakeru". Now:
   a cast element whose evidence is a single token matching exactly ONE cached
   entity's name/alias token SNAPS to that established canonical — a human GM
   reading "Kakeru" mid-story thinks of the Kakeru already on stage. Two
   matches = genuinely ambiguous → left alone for the auditor.
2. **Self-certifying anchors closed.** The hybrid name contained the evidence
   token, so it anchored itself as strong. The snap runs BEFORE strength
   split, so the anchor now certifies the true canonical.
3. **Query-coverage guard on grounding.** Fuzzy search landed "Miyake Kakeru"
   on Akito Miyake's real page. A chosen page must now account for EVERY
   meaningful query token via its title or aliases — "Rose"→"Rose Oriana"
   and "Alya"→alias both pass; cross-welded hybrids are a miss.

Note: the wrong "miyake kakeru" cache entry in that chat should be ✕'d once.

## Changelog — v0.21.2 (Hiyori's hair, verbatim-tested)

Proven by `test/proof.js` (216 assertions) + `test/sim.mjs` (23), all passing.

The user supplied the actual wiki prose — "mid-back length silver hair … light
purple eyes" — confirming the completion path fires on re-ground. The prose
extractor is now COLOR-AWARE so it extracts what a human would: "hair: silver"
(not "length silver"), "eyes: light purple" (modifier kept). Those two
sentences are test fixtures verbatim.

## Changelog — v0.21.1 (hair, guaranteed: core-attribute completion)

Proven by `test/proof.js` (214 assertions) + `test/sim.mjs` (23), all passing.

Hair was still vanishing on some wikis after the {{Color}} fix — some infobox
dialect this side can't inspect eats it. So the guarantee moves up a level:
**core-attribute completion**. After infobox extraction, if the Appearance line
lacks "hair" or "eye" but the page's Appearance PROSE mentions it, the prose
phrase is mined and appended. Whatever exotic template, field name, or layout
the infobox uses, hair can no longer go missing as long as the page describes
it anywhere — dialect-proof by construction, not by whack-a-mole.

## Changelog — v0.21.0 (the whole body: builds, marks, and Gamma's mole)

Proven by `test/proof.js` (213 assertions) + `test/sim.mjs` (23), all passing.

Appearance grows beyond hair and eyes, in both lanes:

1. **Infobox**: the default field list now also matches height, build, body,
   skin, complexion, and distinguishing feature/mark fields (one-time
   migration upgrades untouched defaults only).
2. **Prose**: distinguishing details live in the Appearance SECTION, not the
   infobox — "a beauty mark under her left eye", "a scar across his brow",
   "slender but deceptively strong". Up to two such sentences are mined and
   ALWAYS appended (`…; notably: …`) — previously prose only ran when the
   infobox was empty, which is exactly how Gamma's mole never made it in.
3. **The dossier curator now reads the Appearance section too**, so prose
   briefs can weave physicality naturally instead of leaving it to the
   verbatim line alone.

## Changelog — v0.20.1 (hair restored + no more mid-fact amputation)

Proven by `test/proof.js` (208 assertions) + `test/sim.mjs` (23), all passing.

Two root causes behind "Appearance suddenly missing / Facts cut mid-sentence":

1. **Inline text templates were deleted whole.** Wikis wrap colors as
   `{{Color|#4169e1|Royal Blue}}` — the depth walker (correctly nuking layout
   templates) also ate these, so a templated `haircolor` vanished while a plain
   `eyecolor` survived — exactly the observed pattern. Text-carrying inline
   templates ({{Color}}, {{nowrap}}, {{small}}, {{tt}}, {{abbr}}, {{tooltip}})
   now yield their display text.
2. **Whole-line block budgeting.** v0.19's prose briefs grew every block past
   the 700-char vessel, and clip() amputated mid-fact ("…; Engineered.") —
   half a fact is worse than none. Blocks now budget by WHOLE lines: name +
   brief always ride, each further line rides only if it fits, and caps grow
   to match the brief era (per-character 700→1100, total 4500→6000; one-time
   migration touching untouched values only).

## Changelog — v0.20.0 (⏱ the immersion ceiling: your storyteller never waits)

Proven by `test/proof.js` (203 assertions) + `test/sim.mjs` (23), all passing.

Latency audit: steady-state turns were already ~0ms; GATED turns could block
generation on parser (30s budget) + auditor (12s) + first-encounter fetches,
sequentially. Fixed with stale-while-revalidate:

1. The entire discovery chain (parse → verify → audit → ground → pins → pair
   dynamics → expansion → self-heal) now runs as ONE background-capable task
   raced against a hard ceiling — **Max turn wait, default 2s**. Beat the
   deadline → the turn is fully fresh. Miss it → the task CONTINUES in the
   background (every mutation is epoch/serial-guarded or cache-safe) and this
   turn injects the last known state; the next turn is fresh. Stale for one
   turn beats a frozen storyteller every turn.
2. Parser budget is now explicitly the BACKGROUND ceiling; the immersion
   ceiling is what your reply time feels. Both live in 🧠 Character detection.
3. Already-fast paths unchanged: cached entities, sweep, pins, setting, and
   prose briefs cost string math; the dossier curator was always background.

## Changelog — v0.19.0 (📝 prose briefs: written, not pasted)

Proven by `test/proof.js` (203 assertions) + `test/sim.mjs` (23), all passing.

The injection's FORM catches up with its content: the dossier curator now also
WRITES each character — one flowing 60–100-word paragraph (who they are, their
manner, what defines them) that opens the block as prose instead of
"Identity: … Facts: a; b; c" fragments. Better flow, fewer label/separator
tokens. Deliberately still verbatim: Appearance (exact hair/eye facts) and
Voice quotes (verbatim is their function). Scene-conditional lines — Now,
scored Facts, With-X, Context, Secrets — stay atomic beneath the brief,
because atoms are what per-turn selection needs. Toggleable (📝, on by
default); brief-less dossiers fall back to the labeled Identity line and
self-heal in the background like everything else.

## Changelog — v0.18.0 (curation once, selection free — no more top-of-the-wiki bias)

Proven by `test/proof.js` (199 assertions) + `test/sim.mjs` (23), all passing.

The verbatim-from-the-top problem, root-caused twice over:

1. **The curator now reads the WHOLE character.** Wiki sections are
   chronological — late-story development lives at the BOTTOM, which the old
   top-slice amputated before the dossier model ever read it. Digest sections
   are now head+tail sampled (60/40 with a seam) under much larger caps
   (personality 900→2500, history 1200→2500, relationships →3000): once-per-
   entity background work, so generosity costs nothing per turn.
2. **Facts are scene-selected, not dumped.** The dossier stores up to 8 fact
   atoms; each turn they're scored against what is IN PLAY (Now-focus +
   freshest scene text) — the duel surfaces the sword fact first (up to 5),
   an idle scene shows only 3 anchors. Same free mechanism as Now/Context:
   curation happens ONCE in the slow background lane, selection happens every
   turn in string math. Zero added latency, zero added calls.

Where a dossier exists, verbatim wiki sections were already suppressed
(v0.6); this release fixes the bias in what the curator READ and makes its
output breathe with the scene.

## Changelog — v0.17.0 (smart autonomous: the story moves, the extension follows)

Proven by `test/proof.js` (196 assertions) + `test/sim.mjs` (23), all passing.

1. **📖 Auto-advancing story position.** When the parser sees a canon ARC or
   EVENT enter the scene ("the Bushin Festival begins"), the story position
   advances itself — grounded with the full plot summary and spoiler guard,
   superseding the previous pin, with a toast so you always know where the
   extension thinks you are. Events are recognized before places, so a
   festival moves the story instead of becoming a room. Manual pinning and
   Ask Canon still override; toggleable (on by default).
2. **Self-healing dossiers.** Entities dossier'd before the current shape
   (no background-context data) rebuild themselves in the background — one per
   turn, one attempt per entity — so old caches upgrade to full Smarter-AI
   capability without anyone pressing ✕.

## Changelog — v0.16.1 (glass-box completeness: Ask Canon's prompt joins 🧾)

The rule is total: EVERY instruction any model receives is visible, editable,
and individually resettable. The Ask Canon router prompt was the one straggler
— now the fifth box in 🧾 System instructions, same semantics as the rest
(unchanged/empty = default so updates propagate; customized = yours forever;
↺ per box; ♻ resets all five with everything else).

## Changelog — v0.16.0 (🗣 Ask Canon + wiki.gg)

Proven by `test/proof.js` (194 assertions) + `test/sim.mjs` (23), all passing.

1. **🗣 Ask Canon** — say what you want in plain words, the extension does it.
   One box, one tiny router call mapping your request onto the primitives that
   already exist: "pin Rose Oriana" → always-present; "inject X" → same;
   "set arc to Lawless City" → story position; "never show Ryōko" → blocklist;
   "remember: the engagement is broken" → chat pinned canon; "what do you know
   about Beatrix" → grounds her and reports identity/facts/secret-count.
   Your explicit commands are sovereign — no evidence gate applies to them.
   Enter key works; results land in the status line and a toast.
2. **wiki.gg and any MediaWiki host.** A wiki entry containing a dot is treated
   as a full host: `terraria.wiki.gg` works alongside Fandom subdomains
   (pasted URLs are stripped to the host). Many large fandoms migrated off
   Fandom — this covers them with the same free, structured API, no paid
   search needed.

## Changelog — v0.15.1 (factory reset: behavior resets, connections and content survive)

The ♻ reset returns EVERYTHING tunable to the best-tested defaults — all eight
keyword lists, every toggle, cap, budget, and all four system instructions.
Newly preserved through it (they are plumbing/content, not tuning): the parser
Connection Profile (wiping it silently killed parser/dossier/auditor until
re-picked) and the global pinned canon (your authored words). Also kept, as
before: saved wiki library, active wiki, and all per-chat state.

## Changelog — v0.15.0 (chat-scoped canon: each chat is its own universe)

Proven by `test/proof.js` (188 assertions) + `test/sim.mjs` (23), all passing.

The grounded cache — entities, dossiers ✦, pair dynamics, negatives — now lives
in CHAT METADATA (like Summaryception), not global settings:

1. **No cross-universe bleed, ever.** A CotE chat cannot sweep-match, inject,
   or Context-expand entities grounded in an Eminence chat. Switching stories
   is a clean universe automatically — no more "Clear all" between fandoms.
2. **Branches inherit everything.** ST copies chat metadata on branch, so a
   branched chat carries its full grounded cache, dossiers, pins, blocklist,
   arc, and current setting — exactly like Summaryception state.
3. All access flows through one `cache()` accessor (legacy global store remains
   only as a fallback for contexts without chat metadata), and cache writes
   persist via debounced `saveMetadata` instead of rewriting settings.
4. Honest trade-off, chosen deliberately: the same fandom re-grounds per chat
   (wiki fetches are cheap and once-per-chat; dossiers are one call per entity
   per chat). Story isolation is worth it.

## Changelog — v0.14.0 (Smarter AI tier 2: scene-conditional context)

Proven by `test/proof.js` (188 assertions) + `test/sim.mjs` (23), all passing.

Smarter no longer means MORE — it means the RIGHT lines for THIS moment:

1. **Background entities now carry WHY** ("Oriana Kingdom — her homeland and
   throne", "Oriana Sword Style — her school of swordsmanship"); bare-string
   dossiers remain compatible.
2. **Scene-conditional selection**: each character's Context candidates are
   scored against what is IN PLAY — the parser's "Now" focus plus the freshest
   scene text. A duel surfaces the sword school; a succession scene surfaces
   the kingdom. Matches inject (top 2); with no match anywhere, only the single
   anchor entry rides — fewer, better-chosen lines is the whole point.
3. **No duplicates**: a background entity already present as its own block
   (e.g. the current setting) never gets a redundant Context line.
4. Parser lore clause widened: named techniques, magic/power systems, events,
   and significant items count as lore — evidence discipline unchanged.

## Changelog — v0.13.0 (no capitals needed + Smarter AI 🧠)

Proven by `test/proof.js` (183 assertions) + `test/sim.mjs` (23), all passing.

1. **Lowercase names open the gate.** "rose oriana walks in" now triggers
   detection with zero capitals: a pair of adjacent never-seen words (not
   noise, not stopwords, not learned, not cached) opens the parser gate — the
   parser, evidence check, and Cast Auditor still decide who is real, so this
   adds discovery, not junk. Every parsed message's words are learned, so a
   novel pair gates exactly once and the extension converges back to silence.
   (Already-cached names always worked lowercase via the sweep — this fixes
   FIRST mentions.) Toggleable.
2. **Smarter AI 🧠 (context expansion).** The user's own words: "should I just
   inject rose Oriana? No — I should include Oriana Kingdom too, because her
   kingdom background is important." Exactly that: the dossier curator now
   also extracts up to 3 essential BACKGROUND entities (kingdom, order, house,
   organization); they ground once like everything else and ride inside the
   character's block as one-line `Context:` entries. OFF = strict — only what
   the scene itself earns. Blocklist wins as always. Entities dossier'd before
   v0.13 learn their Context on re-ground (✕ them once in the cache).

## Changelog — v0.12.0 (glass box: every instruction visible, editable, resettable)

Proven by `test/proof.js` (179 assertions) + `test/sim.mjs` (23), all passing.

1. **🧾 System instructions.** Every prompt this extension sends — the injection
   header, the cast parser, the dossier curator, the Cast Auditor — is now
   visible AND editable in its own group. A box left unchanged (or empty) uses
   the built-in default, so prompt improvements in updates still reach you;
   a customized box keeps your text through updates. ↺ restores any one box.
2. **♻ Reset ALL settings & instructions to defaults** — one button, one
   confirm. Everything returns to the best-default state; your grounded cache,
   saved wiki library, and per-chat pins/arc are kept.
3. **Best defaults, finalized**: identity always-on; physical, personality,
   relationships, per-pair dynamics, dossiers ✦, Cast Auditor 🛡, trivia, voice,
   and now BIOGRAPHY on (infobox bio + history — identity covers the lead
   separately); abilities off (verbose, and models half-know them); parser
   gated (not every-turn), 30s budget; story-position injection on; caps
   700/4500. The reset button lands anyone on exactly this state.

## Changelog — v0.11.1 (the last door closes: no evidence, no grandfathering)

The evidence-LESS compat fallback (element without an evidence field → admit if
the name appears anywhere in the window) was a dodge route: the model omits
what it cannot quote, and a name sitting in a greeting roster / class list —
text the storyteller never wrote — grandfathered in, unaudited and unexplained
(the missing evidence suffix in "Why these" was the fingerprint). Closed:

1. Evidence-less elements are UNPROVEN → routed to the Cast Auditor as weak,
   with the name itself as the claim under judgment. Admitted ones now show
   `evidence: "<their name>"` in Why-these — the receipt says exactly why.
2. The auditor's mandate now explicitly rules that a name appearing only in a
   roster, class list, cast enumeration, or opening summary is NOT presence.
3. Latency, engineered and honest: the auditor fires ONLY when unproven items
   exist (fully-anchored turns add ZERO time), and its budget is capped at
   min(parser budget, 12s) — it is a tiny verdict call, typically ~1–3s on a
   fast backend, and only on the turns that need judging. Toggle: 🛡 in
   Character detection.

Proven by `test/proof.js` (176 assertions) + `test/sim.mjs` (23), all passing.

## Changelog — v0.11.0 (the Cast Auditor — your referee — and settings that persist)

Proven by `test/proof.js` (175 assertions) + `test/sim.mjs` (23), all passing.

1. **Cast Auditor 🛡 (user-requested: "a dedicated AI that checks who is injected
   and why").** v0.10's evidence check verifies a quote is IN the scene — it
   cannot judge whether the quote is ABOUT the entity. "Her classmates gathered"
   is real prose that refers to no one; a fabricated classmate rode it in.
   Evidence is now split by STRENGTH: anchored (contains a token of the entity's
   name, or place↔place pair) passes mechanically; weak evidence goes to a tiny
   referee call with one narrow job — "does this quote refer to THIS entity in
   THIS scene?" Unconfirmed = dropped; if the auditor itself fails, weak claims
   never pass. Fires only when weak items exist.
2. **Settings persist without prose.** "ANS should be there even if it's not in
   the prose" — correct, that's what a setting IS. Entities now carry a
   kind (character/place) at ground time; when a place enters the cast it
   becomes the chat's CURRENT SETTING and injects every turn with zero mentions
   required, until a new place supersedes it (blocklist still wins). Reason
   line: `current setting (persists without mention)`.
3. **"Why these" now shows the evidence** that put each cast entity in —
   `— evidence: "Nanase bowed"` — so a wrong injection carries its own
   explanation instead of demanding another debugging round.
4. Cache panel now states plainly: an entry in the cache does NOT mean it
   injects — "Why each was injected" is the truth of the note.

## Changelog — v0.10.0 (knowledge leak, root-caused: the parser must prove its cast)

The phantom classmates (Ryōko, Hōsen) were a KNOWLEDGE LEAK, and the old prompt
invited it: "use your own knowledge of the series…" licensed the model to
pattern-complete plausible characters into scenes that never referred to them.
Knowledge-leak failures are reasoning failures — fixed at the mechanism, the
Arbiter way: don't trust, verify.

1. **Strict extraction prompt**: series knowledge may only CANONICALIZE a
   reference to its wiki name — never add anyone the text does not refer to.
   "A famous character who is not referred to in the text is NOT in the scene,
   no matter how likely their presence feels."
2. **Mandatory evidence, mechanically checked**: every parsed entity must carry
   `"evidence": the exact scene words that refer to it` — verified as a real
   substring of the scene (case/whitespace-insensitive) before the entity may
   enter the cast. Fabrications cannot quote the scene, so they drop, with a
   debug line naming the leak. Indirect references pass — "the school" is a
   quotable substring, so ANHS survives exactly as it should. Evidence-less
   elements (old outputs, truncation salvage) fall back to name-in-text.
3. The v0.9.2 blocklist remains as a user-sovereignty control — but it is no
   longer load-bearing: fabrications now die at the source.

Proven by `test/proof.js` (167 assertions) + `test/sim.mjs` (23), all passing.

## Changelog — v0.9.2 (v0.9.1 reverted — force-OUT joins force-IN)

v0.9.1's literal-mention filter was a mistake and is REVERTED: it destroyed the
parser's core value — catching entities the prose references indirectly ("the
school" → Advanced Nurturing High School). The parser's judgment stands again;
stale entries decay via the grace window as before.

The right primitive for wrong entries is now explicit: **"Never inject (this
chat)"** — a per-chat blocklist mirroring the always-present pins. Names (or
aliases) on it never appear in the canon note, whatever brought them in:
parser, sweep, even a conflicting pin (the block is the later, sharper
instruction). The cache entry survives; only injection is forbidden. One field,
deterministic, no heuristics — "stop injecting Ryōko" is now one comma-name,
forever, for that chat.

Proven by `test/proof.js` (160 assertions, incl. a revert-lock: parser-cast
entities inject WITHOUT a literal mention) + `test/sim.mjs` (23), all passing.

## Changelog — v0.9.1 (mention precision: the grace window stops carrying stragglers)

The cast persists between gated parses (grace window) so pronoun-only scenes
keep their people. The cost was stale stragglers: an entity parsed turns ago —
e.g. from a since-fixed OOC question — kept injecting despite ZERO mentions
anywhere in the visible window. New rule: **if the window names ANY cast
member, every injected cast member must be named somewhere in it** (name or
alias). A window that names no one (pure pronoun continuation) still carries
the whole cast — that ambiguity is exactly what grace is for. Pins are exempt;
the sweep is unaffected (it's mention-defined). 4 new assertions.

Proven by `test/proof.js` (159 assertions) + `test/sim.mjs` (23), all passing.

## Changelog — v0.9.0 (big-cast wikis: Classroom of the Elite stress pass)

Proven by `test/proof.js` (155 assertions) + `test/sim.mjs` (23), all passing.

1. **Raw infobox soup in Identity — killed at the root.** Template dialects like
   `{{Character/Y3 |LNImageY1=…}}` contain `{{{param|}}}` triple-braces that left
   a stray brace inside, so the old regex loop could never remove the outer box —
   its naked body flowed into "Identity" as `|LNImageY1 = |…` junk. Templates are
   now removed by a real depth walker (stray-brace immune; an unclosed template
   drops to end-of-input — better nothing than raw markup). A junk-guard also
   rejects any identity that still looks like param soup, and dangling LIST
   openers (`{{Plainlist|` beheaded by an infobox value terminator) keep their
   content.
2. **The series' own page is meta, not canon** — "…is a Japanese light novel
   series written by…" pages are now detected and skipped like disambiguations,
   and the parser prompt forbids listing the franchise title.
3. **OOC ≠ scene**: the parser now ignores names appearing only in author
   questions, choice menus, and out-of-character notes — the source of phantom
   "present in scene" characters no one wrote into the prose.
4. **No meta-apologies as facts**: "No information about her personality is
   provided in the source material" is filtered at the prompt AND at parse time.
5. **Year-versioned infobox keys normalized**: `Y1occupation/Y2occupation/
   status/status2` collapse to one clean `occupation:` / `status:` each.

## Changelog — v0.8.3 (the model was right — the token ceiling wasn't)

The v0.8.2 toast did its job on the very first try: the model's reply was a
PERFECT JSON array — cut off mid-string by the extension's own `maxTokens: 300`
cap, which stopped fitting once every element carried a "now" phrase. The
extractor then (correctly) found no complete array and reported a shape error.
Not a model problem, not a reasoning problem — a ceiling problem.

1. Cast parse ceiling 300 → 800 tokens; dossier 600 → 1000.
2. **Truncation salvage**: a reply cut by ANY token limit now walks back to the
   last complete element, closes the array, and keeps everything that survived —
   partial cast beats no cast, and surviving elements are byte-exact as the
   model wrote them. Locked by 6 assertions.

Proven by `test/proof.js` (148 assertions) + `test/sim.mjs` (23), all passing.

## Changelog — v0.8.2 (reasoning models: the parser was never broken — the extractor was)

Root cause of "Parser: failed" with a green self-test: `glm-5.2-fast` is a
REASONING model. It wraps every answer in `<think>…</think>`, and the old
extractor sliced from the FIRST `[` to the LAST `]` — when the thinking prose
contained any bracket, the slice spanned reasoning + answer and JSON.parse died.
Every scan, every background parse, silently. The self-test passed because it
never needed JSON.

1. Reasoning blocks (`<think>/<thinking>/<reasoning>`, closed, unclosed, or
   stray-close) are stripped before extraction.
2. Extraction now scans for BALANCED JSON candidates (string-aware, so brackets
   inside quoted values don't break it) and tries them LAST-first — the final
   answer sits at the end. Applies to the cast parser AND the dossier curator.
3. When the model replies but not with a JSON array, the toast now shows what it
   actually said — this exact bug would have self-reported in one glance.

Proven by `test/proof.js` (142 assertions) + `test/sim.mjs` (23), all passing.

## Changelog — v0.8.1 (diagnosis kit: nothing fails silently, nothing hides its version)

1. **Version everywhere.** The drawer header, the load line, and a one-time
   console line when the interceptor first runs (`v0.8.1 interceptor active`).
   If that interceptor line never appears in the console, ST is not calling the
   extension at all (update didn't land / needs a full reload) — decisive in
   one glance.
2. **🔬 Parser self-test** (🧠 Character detection): a 3-word test call through
   your backend; reports backend, elapsed ms, and the reply or the exact
   failure. Separates "transport is broken" from "scene/prompt problem".
3. **👁 Preview injection** (🩺 Cache & diagnostics): builds the note for the
   current scene RIGHT NOW — sweep, pins, arc, cast — without a generation
   turn, and shows it in "Last injection".
4. **Background parser deaths are loud**: a throttled toast (max 1 / 5 min)
   with the exact reason. Silent death was the original sin.
5. **Legacy `generateRaw` compat**: old ST builds take positional args; the
   object call silently produced garbage there. Auto-retries the legacy
   convention.
6. `sendRequest` sync throws now carry their message ("re-pick the Connection
   Profile") instead of a generic failure.

## Changelog — v0.8.0 (the parser can lag or die — the injection can't)

Proven by `test/proof.js` (135 assertions) + `test/sim.mjs` (23), all passing.

1. **Smart sweep.** Cast mode now also injects any CACHED entity named in the
   recent scene — including by the AI's own output — with zero parser round
   trips and zero fetches. The AI writing "Alpha" is all the evidence needed:
   she's cached, she injects. You never again have to say a name yourself just
   to make the extension notice. "Why these" marks these as
   `named in scene — no parser needed`.
2. **Parser budget is a setting (default 30s, was a hardcoded 15s).** Slow
   backends (GLM on mobile) regularly blew 15s, and a blown budget silently
   killed the cast — which made everything downstream look dumb. Set it in
   🧠 Character detection; the dossier curator gets 2×.
3. **Honest failure toasts.** "Scan current scene now" no longer says a generic
   "failed or timed out": it tells you WHICH — `timed out after 30s (raise the
   budget)` vs `no parser backend — pick a Connection Profile` vs the actual
   error. Diagnosis in one glance.

## Changelog — v0.7.0 (fandom-master pass: scene focus, accuracy, clean UI)

Proven by `test/proof.js` (131 assertions) + `test/sim.mjs` (21), all passing.

1. **Scene focus — "Now:" lines.** The cast parser already reads every scene; its
   output now carries, per entity, *what about them is in play RIGHT NOW* ("her
   engagement is being challenged", "his secret identity is at risk") — injected
   directly under Identity. Zero extra LLM calls: same parse, richer contract
   (objects or plain strings both accepted; snapshot replaced per parse, reset on
   chat switch). This is what turns a static dossier into a story that tracks.
2. **Disambiguation pages are wrong-info and are now skipped** — "{{Disambig}}" /
   "may refer to:" pages fall through to the next wiki instead of injecting a
   link-list as canon.
3. **Dossier grounding clause**: the curator may use ONLY facts stated in the
   provided material — no gap-filling from model memory.
4. **Identity cuts at a sentence boundary** (≤300) — "…of the Oriana Kingdom."
   never "…of the Ori…".
5. **Bloat trim**: dossier facts that merely repeat the identity line are dropped.
6. **UI rebuilt** into six collapsible groups — 🌐 Wiki source and 🧭 Story &
   pinned canon open on top (the two you touch mid-story), 📚 What to inject,
   🧠 Character detection, 🔧 Keywords & limits, 🩺 Cache & diagnostics folded
   below. Every control id preserved; styled, mobile-friendly summaries.

## Changelog — v0.6.0 (curation: the model writes the injection)

Proven by `test/proof.js` (118 assertions) + `test/sim.mjs` (21), all passing.

1. **Identity is ALWAYS injected.** The "X is the second princess of …" lead
   sentence was gated behind the off-by-default biography category — the model
   knew Rose Oriana's hair color but not WHO SHE IS. Identity is now its own
   always-on category (≤260 chars), first line of every block; biography keeps
   only infobox bio + history (no duplication).
2. **LLM-curated dossiers ✦.** Your parser model reads each grounded page ONCE
   (background — the grounding turn ships regex sections instantly, the dossier
   upgrades every turn after; cached forever, retry after TTL on failure) and
   writes the injection itself: identity, up to 6 load-bearing facts, secrets
   stated AS secrets (rendered with the KNOWLEDGE SCOPE guard label), voice
   quotes, and per-person dynamics. Junk dies at the source: regex fragments
   are replaced by judgment wherever a dossier exists, and remain the fallback
   wherever it doesn't. Wiki-sliced pair dynamics still outrank dossier
   dynamics (exact beats summarized). Curated entities show ✦ in "Why these".
3. **Pinned canon.** Three persistent user-authored controls: a GLOBAL pin
   (your words, injected in every chat, forever), a THIS-CHAT pin, and
   ALWAYS-PRESENT characters (comma list, per chat) that are grounded and
   injected every turn regardless of what the parser thinks is on screen —
   the hammer for "the AI doesn't know X". Pinned text rides above the arc and
   all entity blocks as "PINNED CANON (user-authored — absolute)".
4. `clip()` could exceed its max by one on boundary-free strings — every hard
   cap in the extension is now actually hard.
5. Parser transport factored into one `llmCall` helper (Connection Manager
   profile → generateRaw fallback, abort + race, rejection-safe) shared by the
   cast parser and the dossier builder.

## Changelog — v0.5.0 (deep audit II: 9 fixes, hidden-identity guard, per-chat story position)

Proven by `test/proof.js` (98 assertions) + `test/sim.mjs` (21), all passing.

1. **KNOWLEDGE SCOPE — the hidden-identity guard.** Grounded biography/trivia can
   contain the exact reveal an asymmetric-information RP depends on ("X is
   secretly Y"), and the old header ordered the model to treat facts as absolute.
   New header clause: the reference is for the NARRATOR's accuracy only — a
   character may only know, reveal, or react to what they could know in-story
   right now; hidden identities and unrevealed connections are guarded actively.
2. **Story position is now PER-CHAT** (chat metadata, legacy global pin as
   fallback; clear wipes both). A pinned Eminence arc can no longer bleed into a
   Roshidere chat. Status line re-renders on chat switch.
3. **First bullet was silently dropped** in Trivia AND Quotes whenever the section
   body started directly with `*` (shipped in v0.3, masked by duplicate-bullet
   test fixtures — fixtures de-masked too).
4. **relationFor paragraph fallback returned the wrong paragraph**: it split after
   markup cleaning, which collapses newlines, so any mention returned the
   section's opening lines. Now splits raw paragraphs first, cleans each.
5. **`[[File:x.png|thumb|Caption]]` leaked "thumb|Caption" into cleaned text** —
   media links are now removed whole before generic link conversion.
6. **Quote extraction**: `{{Quote|quote=…}}` named-param prefixes stripped; the
   attribution tail cut no longer amputates dashes INSIDE quotation marks
   ("Half - broken - but alive." survives).
7. **groundArc**: an exact-title hit that isn't a story unit ("Alpha" → her
   character page) now yields to a structural search result ("Alpha Arc").
8. **Voice subpage probe gated on character signal** — places/organizations no
   longer burn a dead `X/Quotes` round trip.
9. **extractSectionRaw** anchors its subtree walk by position, not `indexOf`, so
   duplicate section text can't misanchor it.

## Changelog — v0.4.0 (voice)

Proven by `test/proof.js` (85 assertions) + `test/sim.mjs` (21), all passing.

1. **Voice samples.** Up to 3 short verbatim quotes from the wiki's `== Quotes ==`
   section — or the dedicated `X/Quotes` subpage, fetched once ever when the main
   page has none — inject as `Voice: "…" / "…"` right after Personality/dynamics.
   A personality line *describes* the voice; real lines *show* cadence, diction,
   and attitude — few-shot voice anchoring, the strongest cheap counter to
   cross-character voice convergence. `{{Quote|…}}` templates are lifted before
   markup cleaning (which would otherwise delete them), attribution tails
   ("— to Cid, ch. 12") are cut, monologues (>160 chars) and fragments are
   filtered, samples dedupe case-insensitively, 420-char budget.
2. **Anti-parroting framing.** The note header marks them as STYLE SAMPLES: match
   the cadence and vocabulary in fresh dialogue; never repeat the sample lines
   themselves unless the moment canonically calls for it.
3. On by default (`voice`), with its own keyword list (`quoteKeywords`) in settings.

## Changelog — v0.3.0 (lore depth without rigidity)

Proven by `test/proof.js` (75 assertions, all passing).

1. **Story position (arc/chapter grounding).** Type an arc or chapter into the new
   "Story position" box and 🔎 grounds its wiki page (exact title, then a search that
   *prefers* Arc/Chapter/Episode titles — the opposite of character lookup, which
   rejects them). Its summary is pinned on top of the canon note with a spoiler
   guard: *only events up to this point have occurred; later canon is unknown to
   every character.* The model knows exactly where in the story you are.
2. **Trivia.** `== Trivia ==` bullets now ground and inject per entity (on by
   default). This is where wikis keep the humanizing canon — quirks, habits, hidden
   facts — that never makes the formal sections.
3. **Per-pair dynamics — the "stoic Alpha" fix.** A wiki personality line is a
   *public baseline*, but models were playing it as a script: Alpha is "stoic
   commander" everywhere, even alone with Cid. Now, when two grounded characters
   share a scene, the extension slices *how A acts around B specifically* from A's
   Relationships subsections (or the `A/Relationships` subpage — fetched at most
   once per character, ever) and injects it as `With Cid: …` directly under A's
   Personality. The rewritten note header makes the contract explicit: **facts are
   authoritative; behavior is a baseline that the per-pair dynamic overrides when
   that person is present** — never flatten a character to their trait words.
   Resolved pairs (including "no documented dynamic") cache forever; settled casts
   cost zero extra calls.
4. **Lore-on defaults + room to breathe.** Personality and Relationships now default
   ON (one-time `migrated_v3`) — the rigidity that justified hiding them is fixed at
   the source by 3, not by starving the model of lore. Per-category extraction caps
   raised (personality/relationships 260→500), per-character cap 400→700, total cap
   3000→4500. Grounding still costs one fetch per entity, ever; the injection stays
   hard-capped and scene-scoped.

## Changelog — v0.2.0 (deep audit: 15 root-cause fixes)

Proven by `test/proof.js` (47 assertions, all passing — `node test/proof.js`).

**Correctness / state safety**
1. Settings migration loop — caps (6→8, 2400→3000) re-applied on every load, silently overwriting user values. Now a one-time `migrated_v2` stamp.
2. Cross-chat contamination — an in-flight parse could write the previous chat's cast/groundings after switching chats. Every await is now epoch-guarded; stale results are discarded.
3. Concurrent parse clobber — a slow stale parse finishing last overwrote a fresher cast. Parses are serial-numbered; only the newest may write.
4. Ghost cast — `lastCast` persisted forever between gated parser runs. Cast now decays: past a `contextWindow` grace since the last parse, entities not named in the scene (directly or via alias) are pruned and the pruned list written back.
5. Parser failure vs empty conflated — timeout/garbage now returns `null` (keep previous cast) vs an explicit `[]` (clear it). Rescan toasts distinguish the two.
6. Duplicate fetch + duplicate injection — grounding now alias-resolves against the cache before fetching (a nickname key is reused for the canonical name), and the note builder dedupes blocks per canonical entity.
7. Post-gen gate starvation — the post-gen scan no longer holds the in-flight flag through a 15s parse, which could starve the *next* turn's interceptor into injecting stale canon. Both gates now share one alias-aware, TTL-aware `isUnhandledName`.

**Extraction quality**
8. Cyrillic `mentioned()` was always false (Roshidere Russian names) — non-Latin names now match via case-folded containment.
9. Infobox value over-run — values are cut at section headers / template opens, with an inline-close brace walk so `|hair = Silver}}Body…` can't swallow the page body, and a hard 3000-char slice.
10. Name extraction — token regex widened (McGonagall, DxD), possessives/contractions and CJK honorifics (`-chan`, `-sama`, …) stripped *before* stopword filtering, leading/trailing connective capitals stripped ("Then Rose Oriana" → "Rose Oriana"), lowercase salvage now runs only on fully-lowercase queries so capitalized prose can't manufacture junk pairs.
11. Exact-title lookup title-cases the query first, so lowercase input hits on the first round trip.

**Performance / hygiene**
12. Physical description is derived from the wikitext already fetched (Appearance section → lead) before falling back to a second network call.
13. Raced-out parser promises get rejection handlers — no more unhandled-rejection noise.
14. Injection source label (`LLM parser cast` / `ledger cast` / `scene scan`) now reports what actually produced the injection; ledger casts are grounded as trusted; duplicate UI binding and double scene reads removed; `CHAT_CHANGED` resets all module state.
15. `manifest.json` homePage pointed at the wrong repo (Chat Assistant copy-paste) — fixed.

## Roadmap

- LLM-based entity extraction + alias linking (fixes limitation 1 & 4).
- Optional server-plugin fetch path (SillyTavern-Fandom-Scraper) for wikis where
  the client API is insufficient.
- Per-chat wiki binding instead of a global setting.
- Confidence-scored distillation so only genuinely-corrective facts are injected.

## v0.2.0 — deep audit: 14 root-cause fixes + performance

**Correctness / safety**
- Settings migration loop: cap migrations (6→8, 2400→3000) re-applied on *every* settings read, making those values impossible to keep — now one-time, gated by `migrated_v2`.
- Cross-chat contamination: a parse still in flight when you switch chats no longer writes the old chat's cast or grounds old-chat names (epoch guard on every await, same failure class fixed in Summaryception).
- Stale-parse clobber: concurrent parses (interceptor / post-gen scan / rescan) are serial-guarded — only the latest may write the cast.
- Interceptor starvation: the post-gen scan no longer holds `cgInFlight` for up to 15s, which silently sent your *next* turn out with a stale canon note.
- Parser failure ≠ "nobody here": timeouts/garbled output now return null (keep previous cast); an explicit `[]` from the model is real information and clears a stale cast.
- Cast decay: entities off-screen for more than the scene window drop out of the parser cast instead of injecting forever (grace window preserves pronoun-proofing right after a parse).
- Duplicate entities: grounding a canonical name now reuses the entry cached under its nickname (zero refetch), and the note dedupes by character — the same character can no longer inject twice.
- Cyrillic names: `mentioned()` now lowercases non-Latin names — Russian names never matched the lowercased scene before.
- Post-gen gate unified with pre-gen (`isUnhandledName`): alias-known names no longer re-fire the parser; *expired* negatives are retried instead of being treated as handled forever.
- Unhandled promise rejections from timed-out parser calls suppressed (Android webviews surface these as visible errors).

**Extraction quality**
- Infobox: the last field of an inline-closed infobox (`|eyes = Blue}}`) was silently invisible; values are now bounded by a brace-depth scan (inner `{{ubl|…}}` survives, the box close cuts), section-header over-runs cut, dangling `{{Plainlist|` openers unwrapped, no raw braces ever reach the model.
- Section headers with trailing comments (`== Appearance == <!--x-->`) are now readable.
- Names: `McGonagall`/`DxD` extracted whole; honorifics (`Alya-chan`), possessives (`Cid's`) and contractions stripped before stopword checks; sentence adverbs (`Suddenly Rose Oriana`) stripped from phrase edges; the lowercase fallback only fires for question-like messages and no longer manufactures junk (`screamed STOP`, `took Cid`, bare `hello`); single lowercase names (`whats alpha hair`) now reachable.
- Aliases split on `/` and `・` too.

**Performance**
- Prose appearance is extracted from the wikitext already in hand (Appearance section → lead) — the unconditional second network round trip per new entity (full plain-text article extract) is now a last resort only.
- Exact-title lookup is title-cased, so lowercase-typed names hit on the first request instead of always falling through to search.
- Ledger cast grounded as trusted (it's LLM-curated); injection-source label now reports how the cast was actually chosen.

**Proof**: `node test/proof.js` (52 assertions on the pure extraction/matching/caching logic) and `node test/sim.mjs` (19 assertions driving the real interceptor through gate, decay, clobber, and alias scenarios against a fake wiki). Both must pass, plus `node --check`, before any push.
