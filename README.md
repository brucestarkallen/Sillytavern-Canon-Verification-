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
