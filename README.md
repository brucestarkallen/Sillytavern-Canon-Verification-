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
