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
