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
- Eminence in Shadow → `eminence-in-shadow`
- DC / Superman → `dc`
- Multiple at once → `eminence-in-shadow,dc`

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

## Roadmap

- LLM-based entity extraction + alias linking (fixes limitation 1 & 4).
- Optional server-plugin fetch path (SillyTavern-Fandom-Scraper) for wikis where
  the client API is insufficient.
- Per-chat wiki binding instead of a global setting.
- Confidence-scored distillation so only genuinely-corrective facts are injected.
