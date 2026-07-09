/*
 * Canon Grounding — SillyTavern extension (v0.1)
 * -------------------------------------------------
 * Goal: keep source-material characters physically/factually accurate WITHOUT
 * breaking immersion and WITHOUT manual per-character entry.
 *
 * How it works (streaming-safe):
 *   1. Before each generation, a `generate_interceptor` scans the latest user
 *      message for proper-noun candidates.
 *   2. Any NEW candidate is looked up once against your configured wiki(s) via
 *      the MediaWiki API (client-side, no server plugin, no CORS issue).
 *   3. The distilled canonical facts are cached FOREVER (persisted in settings)
 *      keyed by name, and injected as a compact system note BEFORE the last
 *      user message — so the model writes them correctly from the first token.
 *      Streaming can stay ON; nothing is ever rewritten mid-stream.
 *   4. A silent post-generation scan grounds any character the MODEL introduced
 *      on its own (Rose-at-turn-50 case). The visible text is NOT edited; the
 *      fact is cached so the next mention / a swipe comes out correct.
 *
 * KNOWN v0.1 LIMITATIONS (documented, not hidden):
 *   - Entity detection is a capitalization heuristic. It will miss lowercase
 *     aliases and occasionally flag non-characters. This is the #1 thing to
 *     improve next (LLM-based extraction or NER).
 *   - Infobox field extraction is regex over wikitext; field names vary by wiki.
 *   - Which wiki(s) to search is a per-story SETTING (set once, out of scene).
 *     Auto-detecting the franchise from freeform RP is unreliable, so it is
 *     intentionally a one-time config rather than a guess.
 *   - Real-world people (Wikipedia) and alias resolution are deferred.
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const MODULE_NAME = "canon_grounding";

const defaultSettings = {
    enabled: true,
    // Comma-separated Fandom subdomains to search, e.g. "the-eminence-in-shadow,dc".
    wikis: "the-eminence-in-shadow",
    // Which infobox fields count as "physical" facts. Kept to hair/eyes on purpose:
    // other fields (height, age) collide with infobox image-sizing params and add noise.
    fields: "hair,haircolor,hair color,eyes,eye color,eyecolor",
    // How many recent messages to consider when deciding which cached entities
    // are currently relevant enough to inject.
    contextWindow: 6,
    // When on, shows a toast for each grounding attempt (found facts / miss / error).
    debug: false,
    // When on, also grounds names found in the AI's OWN replies. Default OFF so the
    // extension never chases the model's hallucinated/invented names — it only grounds
    // characters YOU name. Turn on if you want model-introduced characters grounded too.
    groundFromReplies: false,
    // cache: { "lower name": { name, facts, aliases:[], wiki, found:bool, ts } }
    cache: {},
};

function settings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    // Backfill any missing keys after upgrades.
    for (const k of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][k] === undefined) {
            extension_settings[MODULE_NAME][k] = structuredClone(defaultSettings[k]);
        }
    }
    return extension_settings[MODULE_NAME];
}

// Emit a diagnostic line (console always; toast when debug is on) so we can SEE
// what grounding actually did for each character instead of guessing.
function debug(msg) {
    console.log(`[CanonGrounding] ${msg}`);
    try {
        if (settings().debug && typeof toastr !== "undefined") {
            toastr.info(msg, "Canon Grounding", { timeOut: 8000, extendedTimeOut: 4000 });
        }
    } catch (e) { /* toast is best-effort */ }
}

// ---------------------------------------------------------------------------
// Entity detection (v0.1 heuristic)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
    "The", "A", "An", "I", "You", "He", "She", "It", "We", "They", "My", "Your",
    "His", "Her", "Its", "Our", "Their", "This", "That", "These", "Those",
    "And", "But", "Or", "So", "If", "As", "At", "In", "On", "Of", "To", "For",
    "With", "Without", "Then", "There", "Here", "When", "Where", "What", "Who",
    "Why", "How", "OK", "Okay", "Yes", "No", "Mr", "Mrs", "Ms", "Dr",
]);

// Filler/question/appearance words that should never be part of a name. Used to
// carve names out of casual lowercase questions like "what's rose oriana hair".
const NOISE_WORDS = new Set([
    "what", "whats", "what's", "who", "whos", "who's", "is", "are", "was", "were",
    "the", "a", "an", "and", "or", "of", "to", "for", "with", "in", "on", "at",
    "by", "tell", "me", "about", "does", "do", "did", "has", "have", "hair",
    "eye", "eyes", "haircolor", "color", "colour", "colored", "coloured", "look",
    "looks", "looking", "like", "appearance", "describe", "description", "this",
    "that", "her", "his", "their", "its", "he", "she", "they", "it", "you",
    "your", "my", "our", "how", "why", "when", "where", "which", "please",
    "give", "show", "name", "named", "called", "from", "source", "material",
    "canon", "character", "physical", "personality",
]);

function isNameToken(tok) {
    return /^[A-Za-z][A-Za-z'’-]+$/.test(tok) && tok.length >= 2;
}

/**
 * Pull candidate character names from text.
 *  (1) Capitalized phrases (Rose Oriana) — high confidence, always scanned. This
 *      is how names appear in RP prose, so it covers normal play.
 *  (2) Lowercase multi-word runs — only for SHORT messages (casual questions),
 *      with filler words stripped. Fixes first-mention grounding when a name is
 *      typed lowercase, without flooding lookups on long narration.
 * False positives are cheap: an unknown phrase fails the wiki search and gets
 * negative-cached; only real, found characters are ever injected.
 */
function extractCandidateNames(text) {
    if (!text) return [];
    const out = new Set();
    const clean = text.replace(/[*_`~"“”()]/g, " ");

    // (1) Capitalized phrases.
    const capRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;
    let m;
    while ((m = capRe.exec(clean)) !== null) {
        const phrase = m[1].trim();
        const first = phrase.split(/\s+/)[0];
        if (phrase.split(/\s+/).length === 1 && STOPWORDS.has(first)) continue;
        out.add(phrase);
    }

    // (2) Lowercase runs — short messages only.
    const tokens = clean.split(/\s+/).filter(Boolean);
    if (tokens.length <= 20) {
        const lowerCandidates = [];
        let run = [];
        const flush = () => {
            // Most character names are 1-2 words; take the first two tokens of a
            // run so trailing verbs ("cid kagenou before speaking") don't glue on.
            if (run.length >= 2) lowerCandidates.push(run.slice(0, 2).join(" "));
            run = [];
        };
        for (const raw of tokens) {
            const tok = raw.replace(/[.,;:!?]+$/, "");
            if (isNameToken(tok) && !NOISE_WORDS.has(tok.toLowerCase())) {
                run.push(tok);
            } else {
                flush();
            }
        }
        flush();
        for (const c of lowerCandidates.slice(0, 6)) {
            if (![...out].some(o => o.toLowerCase() === c.toLowerCase())) out.add(c);
        }
    }

    return [...out];
}

// ---------------------------------------------------------------------------
// MediaWiki fetch (client-side, origin=* → CORS-safe, no server plugin)
// ---------------------------------------------------------------------------

function apiBase(wiki) {
    // Fandom wikis: https://<sub>.fandom.com/api.php
    return `https://${wiki.trim()}.fandom.com/api.php`;
}

async function findPageTitle(wiki, name) {
    // 1) Exact-title lookup first. A character's page is almost always titled with
    //    their name, so this avoids search returning a subpage ("X/Relationships")
    //    or an unrelated page ("Shadow Garden", "Anime").
    try {
        const u = `${apiBase(wiki)}?action=query&titles=${encodeURIComponent(name)}&redirects=1&format=json&origin=*`;
        const r = await fetch(u);
        if (r.ok) {
            const d = await r.json();
            const p = Object.values(d?.query?.pages || {})[0];
            if (p && p.pageid && !("missing" in p) && !String(p.title).includes("/")) {
                return p.title;
            }
        }
    } catch (e) { /* fall through to search */ }

    // 2) Fall back to full-text search, preferring a non-subpage result.
    const url = `${apiBase(wiki)}?action=query&list=search&srlimit=5&format=json&origin=*&srsearch=${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    const hits = (await res.json())?.query?.search || [];
    const main = hits.find(h => !String(h.title).includes("/"));
    return main ? main.title : (hits[0] ? hits[0].title : null);
}

async function fetchWikitext(wiki, title) {
    const url = `${apiBase(wiki)}?action=parse&prop=wikitext&format=json&origin=*&page=${encodeURIComponent(title)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`parse HTTP ${res.status}`);
    const data = await res.json();
    return data?.parse?.wikitext?.["*"] || "";
}

async function fetchExtract(wiki, title) {
    // Plain-text article extract — used to recover facts that live in prose
    // (e.g. an "Appearance" paragraph) rather than in infobox fields.
    const url = `${apiBase(wiki)}?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`extract HTTP ${res.status}`);
    const data = await res.json();
    const pages = data?.query?.pages || {};
    const first = Object.values(pages)[0];
    return first?.extract || "";
}

/** Extract the configured physical fields from an infobox block in wikitext. */
function extractFacts(wikitext, fieldList) {
    if (!wikitext) return "";
    const wanted = fieldList.split(",").map(f => f.trim().toLowerCase()).filter(Boolean);
    const found = [];
    const seen = new Set();
    // Match |field = value lines (infobox params).
    const re = /\|\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*=\s*([^\n|]+)/g;
    let m;
    while ((m = re.exec(wikitext)) !== null) {
        const key = m[1].trim().toLowerCase();
        if (!wanted.includes(key)) continue;
        let val = m[2].trim();
        // Clean common wiki markup.
        val = val.replace(/\[\[([^\]|]*\|)?([^\]]+)\]\]/g, "$2") // [[link|text]] -> text
                 .replace(/'''?/g, "")
                 .replace(/<[^>]+>/g, "")
                 .replace(/\{\{[^}]*\}\}/g, "")
                 .replace(/\s+/g, " ")
                 .trim();
        if (!val || seen.has(key)) continue;
        // Reject infobox image-sizing / file / bare-number values (e.g. "250px",
        // "Sherry.png", "3") that are not real appearance descriptors.
        if (/^\d+\s*px$/i.test(val) || /\.(png|jpe?g|gif|webp|svg)$/i.test(val) || /^\d+$/.test(val)) continue;
        seen.add(key);
        // Normalize key for display (collapse the hair/haircolor variants).
        const label = key.replace(/colou?r/, "").trim() || key;
        found.push(`${label}: ${val}`);
    }
    return found.join("; ");
}

// Words to strip when reading a descriptor out of prose.
const PROSE_STOP = new Set([
    "with", "and", "a", "an", "the", "her", "his", "long", "short", "girl",
    "boy", "young", "has", "have", "is", "are", "of", "to", "very", "quite",
    "she", "he", "who", "beautiful", "gorgeous", "stunning", "captivating",
]);

/** Fallback: recover "hair"/"eyes" descriptors from prose when the infobox lacks them. */
function extractFromProse(text) {
    if (!text) return "";
    const snippet = text.slice(0, 4000);

    const clean = (words) => {
        let w = words.trim().split(/\s+/);
        while (w.length && PROSE_STOP.has(w[0].toLowerCase())) w.shift();
        if (w.length > 2) w = w.slice(-2);
        return w.length ? w.join(" ") : null;
    };

    // Compound case first: "pastel pink hair and eyes" — one color covers both.
    const compound = snippet.match(
        /((?:[A-Za-z][A-Za-z-]+\s+){1,4})hair\s+and\s+eyes\b/i
    );
    if (compound) {
        const c = clean(compound[1]);
        if (c) return `hair: ${c}; eyes: ${c}`;
    }

    const grab = (noun) => {
        const re = new RegExp(`((?:[A-Za-z][A-Za-z-]+\\s+){1,4})${noun}\\b`, "i");
        const m = snippet.match(re);
        return m ? clean(m[1]) : null;
    };
    const found = [];
    const hair = grab("hair");
    const eyes = grab("eyes");
    if (hair) found.push(`hair: ${hair}`);
    if (eyes) found.push(`eyes: ${eyes}`);
    return found.join("; ");
}

// ---------------------------------------------------------------------------
// Grounding: fetch + cache a single entity (once, ever)
// ---------------------------------------------------------------------------

const NEGATIVE_TTL = 1000 * 60 * 60 * 24; // don't re-search a "not found" for 24h

async function ensureGrounded(name) {
    const s = settings();
    const key = name.toLowerCase();
    const existing = s.cache[key];
    if (existing) {
        if (existing.found) return existing;                       // already grounded
        if (Date.now() - existing.ts < NEGATIVE_TTL) return existing; // genuine recent miss
    }

    const wikis = s.wikis.split(",").map(w => w.trim()).filter(Boolean);
    let hadError = false;      // network / HTTP / parse failure (transient — retry later)
    let pageFoundNoFacts = false;

    for (const wiki of wikis) {
        try {
            const title = await findPageTitle(wiki, name);
            if (!title) continue; // no such page on this wiki — a real miss, not an error
            let facts = extractFacts(await fetchWikitext(wiki, title), s.fields);
            if (!facts) facts = extractFromProse(await fetchExtract(wiki, title));
            if (facts) {
                s.cache[key] = { name: title, facts, aliases: [], wiki, found: true, ts: Date.now() };
                saveSettingsDebounced();
                debug(`✓ ${title} → ${facts}`);
                return s.cache[key];
            }
            pageFoundNoFacts = true;
            debug(`⚠ found page "${title}" on ${wiki} but no hair/eye facts in infobox or prose`);
        } catch (err) {
            hadError = true;
            debug(`✕ fetch error for "${name}" on ${wiki}: ${err.message}`);
        }
    }

    // Only persist a "not found" when we actually searched cleanly and the wiki
    // has no page. Transient errors and extraction gaps are NOT locked in, so the
    // next mention retries instead of being stuck for 24h.
    if (!hadError && !pageFoundNoFacts) {
        s.cache[key] = { name, facts: "", aliases: [], wiki: null, found: false, ts: Date.now() };
        saveSettingsDebounced();
        debug(`✕ no wiki page found for "${name}" on: ${s.wikis}`);
    }
    return s.cache[key] || { name, facts: "", found: false };
}

async function groundNames(names) {
    for (const n of names) {
        await ensureGrounded(n);
    }
}

// ---------------------------------------------------------------------------
// Which cached entities are relevant to the current moment?
// ---------------------------------------------------------------------------

function recentText(ctx, windowSize) {
    const chat = ctx.chat || [];
    return chat.slice(-windowSize).map(m => m.mes || "").join("\n");
}

function relevantCanonNote(ctx) {
    const s = settings();
    const text = recentText(ctx, s.contextWindow).toLowerCase();
    const lines = [];
    for (const key of Object.keys(s.cache)) {
        const entry = s.cache[key];
        if (!entry.found || !entry.facts) continue;
        const names = [entry.name.toLowerCase(), key, ...(entry.aliases || []).map(a => a.toLowerCase())];
        if (names.some(n => n && text.includes(n))) {
            lines.push(`- ${entry.name} — ${entry.facts}`);
        }
    }
    if (!lines.length) return "";
    return (
        "[AUTHORITATIVE SOURCE CANON — retrieved from the official wiki for this " +
        "series. These appearance facts are CORRECT and take priority over your own " +
        "memory, your assumptions, and any other character description in this prompt. " +
        "If something else here disagrees, it is wrong — use THESE values and do not " +
        "second-guess, 'correct', or explain them away.]\n" + lines.join("\n")
    );
}

// ---------------------------------------------------------------------------
// The pre-generation interceptor (streaming-safe injection)
// ---------------------------------------------------------------------------

globalThis.CanonGrounding_intercept = async function (chat, contextSize, abort, type) {
    try {
        const s = settings();
        if (!s.enabled) return;

        // Ground names appearing in the latest USER message before we generate.
        const lastUser = [...chat].reverse().find(m => m.is_user);
        if (lastUser) {
            const names = extractCandidateNames(lastUser.mes);
            if (names.length) await groundNames(names);
        }

        // Inject a compact note for every cached entity relevant right now.
        const ctx = getContext();
        const note = relevantCanonNote(ctx);
        if (note) {
            const injected = {
                is_user: false,
                is_system: true,
                name: "Canon",
                send_date: Date.now(),
                mes: note,
                // Not a reference to an existing message object, so this stays
                // in the prompt only and does not persist to saved chat history.
            };
            const at = Math.max(chat.length - 1, 0);
            chat.splice(at, 0, injected);
        }
    } catch (err) {
        console.error("[CanonGrounding] interceptor error:", err);
        // Never block generation on our account.
    }
};

// ---------------------------------------------------------------------------
// Silent post-generation grounding (catch model-introduced characters)
// ---------------------------------------------------------------------------

async function onMessageReceived() {
    const s = settings();
    if (!s.enabled || !s.groundFromReplies) return; // don't chase the model's own output by default
    const ctx = getContext();
    const chat = ctx.chat || [];
    const last = chat[chat.length - 1];
    if (!last || last.is_user) return;
    const names = extractCandidateNames(last.mes);
    if (names.length) await groundNames(names); // fills cache; does NOT edit text
}

// ---------------------------------------------------------------------------
// Minimal settings UI
// ---------------------------------------------------------------------------

async function addSettingsUI() {
    const html = `
    <div class="canon-grounding-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Canon Grounding</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="cg_enabled" type="checkbox">
                    <span>Enabled</span>
                </label>
                <label class="checkbox_label">
                    <input id="cg_debug" type="checkbox">
                    <span>Debug (show a toast for each lookup)</span>
                </label>
                <label class="checkbox_label">
                    <input id="cg_replies" type="checkbox">
                    <span>Also ground names from AI replies (off = only names you type)</span>
                </label>
                <label>Wiki subdomains (comma-separated)</label>
                <input id="cg_wikis" class="text_pole" type="text" placeholder="eminence-in-shadow,dc">
                <label>Physical fields to ground</label>
                <input id="cg_fields" class="text_pole" type="text">
                <div style="margin-top:6px;">
                    <input id="cg_clear" class="menu_button" type="button" value="Clear cached canon">
                </div>
                <small>Facts are fetched once per character and cached. Set the wiki(s) for your current story here.</small>
            </div>
        </div>
    </div>`;
    $("#extensions_settings2").append(html);

    const s = settings();
    $("#cg_enabled").prop("checked", s.enabled).on("input", function () {
        s.enabled = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_debug").prop("checked", s.debug).on("input", function () {
        s.debug = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_replies").prop("checked", s.groundFromReplies).on("input", function () {
        s.groundFromReplies = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_wikis").val(s.wikis).on("input", function () {
        s.wikis = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_fields").val(s.fields).on("input", function () {
        s.fields = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_clear").on("click", function () {
        s.cache = {}; saveSettingsDebounced();
        toastr?.info?.("Canon cache cleared.");
    });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

jQuery(async () => {
    settings();
    await addSettingsUI();
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    console.log("[CanonGrounding] loaded.");
});
