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
