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
    // Comma-separated Fandom subdomains to search, e.g. "eminence-in-shadow,dc".
    wikis: "eminence-in-shadow",
    // Which infobox fields count as "physical/canonical" facts worth grounding.
    fields: "hair,haircolor,hair color,eyes,eye color,eyecolor,height,age,race,species,gender",
    // How many recent messages to consider when deciding which cached entities
    // are currently relevant enough to inject.
    contextWindow: 6,
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

/** Pull candidate proper-noun phrases (sequences of Capitalized words). */
function extractCandidateNames(text) {
    if (!text) return [];
    const out = new Set();
    // Strip common RP action asterisks/quotes to avoid gluing tokens.
    const clean = text.replace(/[*_`~"']/g, " ");
    const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
        const phrase = m[1].trim();
        const first = phrase.split(/\s+/)[0];
        // Skip single stopword tokens (sentence starts etc.).
        if (phrase.split(/\s+/).length === 1 && STOPWORDS.has(first)) continue;
        out.add(phrase);
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
    const url = `${apiBase(wiki)}?action=query&list=search&srlimit=1&format=json&origin=*&srsearch=${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    const data = await res.json();
    const hit = data?.query?.search?.[0];
    return hit ? hit.title : null;
}

async function fetchWikitext(wiki, title) {
    const url = `${apiBase(wiki)}?action=parse&prop=wikitext&format=json&origin=*&page=${encodeURIComponent(title)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`parse HTTP ${res.status}`);
    const data = await res.json();
    return data?.parse?.wikitext?.["*"] || "";
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
        seen.add(key);
        // Normalize key for display (collapse the hair/haircolor variants).
        const label = key.replace(/colou?r/, "").trim() || key;
        found.push(`${label}: ${val}`);
    }
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
        // Already resolved, or recently failed — skip.
        if (existing.found) return existing;
        if (Date.now() - existing.ts < NEGATIVE_TTL) return existing;
    }

    const wikis = s.wikis.split(",").map(w => w.trim()).filter(Boolean);
    for (const wiki of wikis) {
        try {
            const title = await findPageTitle(wiki, name);
            if (!title) continue;
            const wikitext = await fetchWikitext(wiki, title);
            const facts = extractFacts(wikitext, s.fields);
            if (facts) {
                s.cache[key] = { name: title, facts, aliases: [], wiki, found: true, ts: Date.now() };
                saveSettingsDebounced();
                return s.cache[key];
            }
        } catch (err) {
            console.warn(`[CanonGrounding] lookup failed for "${name}" on ${wiki}:`, err.message);
        }
    }
    // Record the miss so we don't hammer the API every turn.
    s.cache[key] = { name, facts: "", aliases: [], wiki: null, found: false, ts: Date.now() };
    saveSettingsDebounced();
    return s.cache[key];
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
    return `[Canonical reference — keep these accurate; do not contradict]\n${lines.join("\n")}`;
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
    if (!s.enabled) return;
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
