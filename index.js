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
import { saveSettingsDebounced, eventSource, event_types, chat_metadata } from "../../../../script.js";

const MODULE_NAME = "canon_grounding";

// What the extension injected on the most recent turn (for the settings display).
let lastInjection = "";
let lastInjectionAt = 0;
let lastMatchReasons = [];  // why each injected character was considered "present"

const defaultSettings = {
    enabled: true,
    // Comma-separated Fandom subdomains to search, e.g. "the-eminence-in-shadow,dc".
    wikis: "the-eminence-in-shadow",
    // Saved library of subdomains you switch between, shown as one-tap chips.
    savedWikis: [],
    // Which infobox fields count as "physical" facts. Kept to hair/eyes on purpose:
    // other fields (height, age) collide with infobox image-sizing params and add noise.
    fields: "hair,haircolor,hair color,eyes,eye color,eyecolor",
    // Keyword lists that say WHERE each category lives — matched (as substrings) against
    // BOTH infobox field names AND prose section headers. Defaults cover Fandom's common
    // templates (Marvel/DC/anime), so most wikis work with no editing. Editable below.
    relationshipKeywords: "relative,relations,family,parent,mother,father,sibling,brother,sister,spouse,wife,husband,child,marital,partner,ancestor,grandparent,descendant,love interest",
    biographyKeywords: "history,background,biography,backstory,origin,occupation,affiliation,alignment,status,alias,identity,citizenship,nationality,residence,base,birthplace,birthday,born,education,universe,reality,first appearance,rank,position,species,race",
    personalityKeywords: "personality,temperament,disposition,demeanor",
    abilitiesKeywords: "power,abilities,ability,skill,technique,weapon,equipment,arsenal,strength,weakness,magic,quirk,devil fruit,semblance,jutsu,nen,stand",
    // Infobox fields that list a character's other names, so nicknames (e.g. "Alya"
    // for "Alisa Mikhailovna Kujou") match the same grounded entry automatically.
    aliasKeywords: "alias,nickname,also known,other name,epithet,codename,aka,known as",
    // What KIND of canon to ground and inject. Physical is on by default; the others
    // are opt-in because they inject prose and can make the model more rigid.
    physical: true,       // appearance: hair, eyes, look
    personality: false,   // temperament / how they behave
    relationship: false,  // family and key connections (helps correct invented parents)
    biography: false,     // role, affiliation, background
    abilities: false,     // powers, skills, weapons
    // How many recent VISIBLE messages count as "the current scene" for deciding who
    // to inject. ~10 matches a setup that summarizes everything older. Higher = a
    // character stays grounded longer after they stop being mentioned.
    contextWindow: 10,
    // Hard limits so a big cast (e.g. High School DxD) can't balloon the prompt.
    maxCharacters: 6,       // inject at most this many characters (the most recent)
    maxCharsPerChar: 400,   // cap per character across all its categories
    maxTotalChars: 2400,    // hard cap on the whole canon block; stop once reached
    // When on, shows a toast for each grounding attempt (found facts / miss / error).
    debug: false,
    // When on, use Summaryception's LLM-built ledger (if present) as the authoritative
    // list of REAL characters — so only genuine cast get grounded/injected, not regex
    // junk. Falls back to name detection when no ledger is available.
    useLedger: true,
    // When on, grounds names found in the AI's replies too (not just yours), so
    // characters the AI introduces into a scene get grounded. On by default.
    groundFromReplies: true,
    // cache: { "lower name": { name, sections:{physical,personality,relationship,biography}, wiki, found, ts } }
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
    // One-time migration: early versions defaulted physical fields to a broad list
    // (height/age/race/gender) that pulled noise. If the saved value is exactly that
    // old default (i.e. never customized), quietly move it to the new hair/eyes-only.
    const OLD_FIELDS = "hair,haircolor,hair color,eyes,eye color,eyecolor,height,age,race,species,gender";
    if (extension_settings[MODULE_NAME].fields === OLD_FIELDS) {
        extension_settings[MODULE_NAME].fields = defaultSettings.fields;
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

/** Non-character / media / meta pages we should never ground as a character. */
function isMediaTitle(t) {
    if (!t) return true;
    return /\((light novel|novel|anime|manga|manhwa|manhua|film|movie|ova|ona|web series|series|video game|game|soundtrack|album|song|volume|vol\.?|chapter|episode|arc|season|character|disambiguation|franchise)\)/i.test(t)
        || /\b(disambiguation|list of|volume \d|episode \d|chapter \d)\b/i.test(t)
        || String(t).includes("/"); // subpages
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
            if (p && p.pageid && !("missing" in p) && !isMediaTitle(p.title)) {
                return p.title;
            }
        }
    } catch (e) { /* fall through to search */ }

    // 2) Fall back to full-text search, skipping media/meta/subpage results so a
    //    character name resolves to the CHARACTER page, not the "(Light Novel)" or
    //    "(Anime)" series pages that also match the query.
    const url = `${apiBase(wiki)}?action=query&list=search&srlimit=8&format=json&origin=*&srsearch=${encodeURIComponent(name)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    const hits = (await res.json())?.query?.search || [];
    const good = hits.find(h => !isMediaTitle(h.title));
    return good ? good.title : null; // if only media pages matched, treat as "not found"
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
// Wikitext section extraction (for personality / relationships / biography)
// ---------------------------------------------------------------------------

/** Strip common wiki markup down to readable prose. */
function cleanWikitext(wt) {
    if (!wt) return "";
    let s = wt;
    // Convert links to their text BEFORE removing templates, so names inside list
    // templates (e.g. a Relatives field) survive.
    s = s.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1");
    s = s.replace(/<br\s*\/?>/gi, ", ");
    // Keep the content of common list templates instead of deleting them.
    s = s.replace(/\{\{\s*(?:plainlist|unbulleted list|ubl|flatlist|hlist|bulleted list|cslist)\s*\|([\s\S]*?)\}\}/gi, "$1");
    for (let i = 0; i < 4; i++) s = s.replace(/\{\{[^{}]*\}\}/g, ""); // remaining templates (nested)
    return s
        .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
        .replace(/<ref[^>]*\/>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/'''?/g, "")
        .replace(/^[\s*#:;]+/gm, "")
        .replace(/\[\d+\]/g, "")
        .replace(/={2,}[^=]+={2,}/g, "")             // stray sub-headers
        .replace(/\s*,\s*,\s*/g, ", ")               // collapse empty list items
        .replace(/\s+/g, " ")
        .replace(/^[,;\s]+|[,;\s]+$/g, "")
        .trim();
}

/** Extract infobox fields whose NAME contains any of the given keywords. */
function extractInfoboxFields(wikitext, keywords, maxLen = 240) {
    if (!wikitext) return "";
    const kw = keywords.map(k => k.trim().toLowerCase()).filter(Boolean);
    const out = [];
    const seen = new Set();
    // |Field = value, where value runs until the next "\n|" param or the "\n}}" close.
    const re = /\n\|\s*([A-Za-z][A-Za-z0-9 _()'-]*?)\s*=\s*([\s\S]*?)(?=\n\s*\||\n\s*\}\})/g;
    let m;
    const src = "\n" + wikitext;
    while ((m = re.exec(src)) !== null) {
        const rawKey = m[1].trim();
        const key = rawKey.toLowerCase();
        if (!kw.some(k => key.includes(k))) continue;
        // Guard: on inline infoboxes the value regex can over-run into the next
        // "| NextField =" on the same line — cut it off there.
        let raw = m[2].split(/(?:^|[\s\n])\|\s*[A-Za-z][A-Za-z0-9 _()'-]*\s*=/)[0];
        const val = cleanWikitext(raw);
        if (!val || seen.has(key)) continue;
        if (/^\d+\s*px$/i.test(val) || /\.(png|jpe?g|gif|webp|svg)$/i.test(val) || /^\d+$/.test(val)) continue;
        seen.add(key);
        out.push(`${rawKey}: ${val}`);
    }
    return out.join("; ").slice(0, maxLen);
}

/** Return the body of the first section whose title matches one of `titles`. */
function extractSection(wikitext, titles, maxLen = 260) {
    if (!wikitext) return "";
    // Split before any line that starts a header (== ... ==).
    const chunks = wikitext.split(/\n(?==={1,4}[^=])/);
    const want = titles.map(t => t.toLowerCase());
    for (const chunk of chunks) {
        const m = chunk.match(/^=+\s*(.+?)\s*=+\s*\n([\s\S]*)$/);
        if (!m) continue;
        const title = m[1].trim().toLowerCase();
        if (want.some(w => title === w || title.includes(w))) {
            const body = cleanWikitext(m[2]);
            if (body) return body.length > maxLen ? body.slice(0, maxLen).replace(/\s+\S*$/, "") + "…" : body;
        }
    }
    return "";
}

/** Lead (intro) paragraph of the article, before the first section header. */
function extractLead(wikitext, maxLen = 220) {
    if (!wikitext) return "";
    const lead = wikitext.split(/\n=={1,4}[^=]/)[0] || "";
    const body = cleanWikitext(lead);
    return body.length > maxLen ? body.slice(0, maxLen).replace(/\s+\S*$/, "") + "…" : body;
}

/** Individual other-names for a character, from infobox nickname/alias fields. */
function extractAliases(wikitext, keywords) {
    const raw = extractInfoboxFields(wikitext, keywords, 500);
    if (!raw) return [];
    // "Nicknames: Alya, Alya-chan; Aliases: Solitary Princess" -> ["Alya","Solitary Princess",...]
    const values = raw.split(";").map(part => part.replace(/^[^:]+:\s*/, "")).join(",");
    const out = [];
    for (let a of values.split(/[,、]/)) {
        a = a.replace(/\([^)]*\)/g, "").replace(/["'“”]/g, "").trim(); // drop "(by X)" notes, quotes
        if (a.length >= 2 && a.length <= 40 && /[A-Za-z]/.test(a)) out.push(a);
    }
    return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Grounding: fetch + cache a single entity (once, ever)
// ---------------------------------------------------------------------------

const NEGATIVE_TTL = 1000 * 60 * 60 * 24; // don't re-search a "not found" for 24h

async function ensureGrounded(name) {
    const s = settings();
    const key = name.toLowerCase();
    const existing = s.cache[key];
    if (existing && existing.sections) {
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

            const wikitext = await fetchWikitext(wiki, title);

            // Gate: is this actually a CHARACTER page? Series/media pages (Light Novel,
            // Anime, franchise) have infobox fields like Author/Studio/Volumes, not
            // Gender/Hair/Relatives — and no Personality/Relationships/Appearance section.
            // Reject them so they never get grounded as a character.
            const charSignal = extractInfoboxFields(wikitext,
                ["gender", "age", "hair", "eye", "relatives", "species", "race", "affiliation",
                 "occupation", "height", "birthday", "birthdate", "status", "spouse", "family",
                 "blood", "voiced", "voice actor", "seiyu", "alias", "nickname"]);
            const charSection = extractSection(wikitext, ["personality", "relationships", "appearance"], 40);
            if (!charSignal && !charSection) {
                debug(`⚠ "${title}" isn't a character page (no character fields) — skipped`);
                pageFoundNoFacts = true;
                continue;
            }

            // Physical: infobox hair/eyes (robust extractor handles piped links and
            // <br> lists), else prose appearance with the "pink hair and eyes" handling.
            let physical = extractInfoboxFields(wikitext, s.fields.split(","));
            if (!physical) physical = extractFromProse(await fetchExtract(wiki, title));

            // For the other categories, look in BOTH infobox fields and prose sections,
            // using the keyword lists — so family in an infobox "Relatives" field is found.
            const relKw = s.relationshipKeywords.split(",");
            const bioKw = s.biographyKeywords.split(",");
            const perKw = s.personalityKeywords.split(",");
            const abiKw = s.abilitiesKeywords.split(",");

            const join = (...parts) => [...new Set(parts.filter(Boolean))].join(" — ");

            const sections = {
                physical,
                personality: join(
                    extractInfoboxFields(wikitext, perKw),
                    extractSection(wikitext, perKw)
                ),
                relationship: join(
                    extractInfoboxFields(wikitext, relKw),
                    extractSection(wikitext, relKw)
                ),
                // Biography always leads with the intro paragraph (the "X is a …" line
                // that has no header), then adds infobox bio fields and a history section.
                biography: join(
                    extractLead(wikitext),
                    extractInfoboxFields(wikitext, bioKw),
                    extractSection(wikitext, bioKw)
                ),
                abilities: join(
                    extractInfoboxFields(wikitext, abiKw),
                    extractSection(wikitext, abiKw)
                ),
            };

            const anything = Object.values(sections).some(Boolean);
            if (anything) {
                // Remember the character's other names (nickname/alias fields) plus the
                // term we searched with, so any of them match this entry later.
                const aliases = extractAliases(wikitext, s.aliasKeywords.split(","));
                if (name && name.toLowerCase() !== title.toLowerCase()) aliases.push(name);
                s.cache[key] = { name: title, sections, aliases, wiki, found: true, ts: Date.now() };
                saveSettingsDebounced();
                const got = Object.entries(sections).filter(([, v]) => v).map(([k]) => k).join(", ");
                debug(`✓ ${title}${aliases.length ? " (aka " + aliases.slice(0, 4).join(", ") + ")" : ""} → ${physical || "(no appearance)"} [have: ${got}]`);
                return s.cache[key];
            }
            pageFoundNoFacts = true;
            debug(`⚠ found page "${title}" on ${wiki} but no usable sections`);
        } catch (err) {
            hadError = true;
            debug(`✕ fetch error for "${name}" on ${wiki}: ${err.message}`);
        }
    }

    // Only persist a "not found" when we actually searched cleanly and the wiki
    // has no page. Transient errors and extraction gaps are NOT locked in.
    if (!hadError && !pageFoundNoFacts) {
        s.cache[key] = { name, sections: {}, wiki: null, found: false, ts: Date.now() };
        saveSettingsDebounced();
        debug(`✕ no wiki page found for "${name}" on: ${s.wikis}`);
    }
    return s.cache[key] || { name, sections: {}, found: false };
}

async function groundNames(names) {
    for (const n of names) {
        await ensureGrounded(n);
    }
}

// ---------------------------------------------------------------------------
// Which cached entities are relevant to the current moment?
// ---------------------------------------------------------------------------

/**
 * Text of the CURRENT scene only — used to decide who to inject. Deliberately
 * excludes anything that would keep an off-screen character "present" forever:
 *  - hidden/summarized turns (Summaryception /hide's them; they stay in chat as
 *    is_system, so we skip is_system messages)
 *  - the permanent memory/summary block and our own canon block (by marker)
 * Summaryception's summary is a setExtensionPrompt injection (not a chat message),
 * so it isn't in ctx.chat anyway — but we also guard by marker in case a summary
 * is ever written as a visible message. Result: a name that merely lingers in the
 * running summary does NOT trigger injection; only a character actually in the last
 * few visible messages does. Leaves the scene → stops injecting; returns → instant
 * re-inject from cache.
 */
function sceneMessages(ctx, windowSize) {
    const chat = ctx.chat || [];
    const markers = ["[Story memory", "[AUTHORITATIVE SOURCE CANON", "[Canonical reference", "[Plot essential"];
    const visible = chat.filter(m =>
        !m.is_system && !markers.some(mk => (m.mes || "").includes(mk))
    );
    return visible.slice(-Math.max(1, windowSize)).map(m => m.mes || "");
}

/**
 * Summaryception's ledger — an LLM-maintained, curated list of the REAL characters
 * in this story (keyed by name, with whereabouts in each entry). Reading it lets us
 * ground/inject only genuine cast instead of trusting regex, at zero extra LLM cost
 * because Summaryception already computed it. Returns a lowercase Set of names, or
 * null when Summaryception isn't running / has no ledger.
 */
function ledgerNames() {
    try {
        if (!settings().useLedger) return null;
        // Try the context's metadata, then the imported global — either can be the
        // live object Summaryception writes its ledger into, depending on ST version.
        const sources = [getContext() && getContext().chatMetadata, chat_metadata];
        for (const md of sources) {
            const ledger = md && md.summaryception && md.summaryception.ledger;
            if (ledger && typeof ledger === "object" && !Array.isArray(ledger)) {
                const keys = Object.keys(ledger);
                if (keys.length) return keys;
            }
        }
    } catch (e) { /* Summaryception not present — fall back */ }
    return null;
}

function clip(str, max) {
    if (str.length <= max) return str;
    return str.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/**
 * Whole-word-ish match: "Cid" matches "Cid drew his sword" and "Cid's" but NOT
 * "Cidolfus"; "Lucy" won't fire inside "reclusively". Hyphens/apostrophes/spaces
 * count as boundaries so "Alya" still matches "Alya-chan". Falls back to substring
 * for non-Latin names where boundaries are unreliable.
 */
function mentioned(name, lowerText) {
    if (!name || !lowerText) return false;
    if (/[^\x00-\x7F]/.test(name)) return lowerText.includes(name);
    try {
        return new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}([^a-z0-9]|$)`, "i").test(lowerText);
    } catch (e) {
        return lowerText.includes(name);
    }
}

function relevantCanonNote(sceneMsgs) {
    const s = settings();
    const msgs = sceneMsgs || [];
    const lowerMsgs = msgs.map(m => m.toLowerCase());
    // If the ledger is available, restrict injection to its real characters — this
    // removes regex false-positives ("Shadow Garden", "Anime", stray words) that
    // would otherwise sit in the cache and match loosely.
    const lgNames = ledgerNames();
    const ledger = lgNames ? new Set(lgNames.map(n => n.toLowerCase())) : null;
    const labels = {
        physical: "Appearance",
        relationship: "Relationships",
        personality: "Personality",
        biography: "Background",
        abilities: "Powers & Abilities",
    };
    // Order matters: lean, high-value facts first so they survive the per-character cap;
    // verbose biography/abilities are trimmed first when space runs out.
    const order = ["physical", "relationship", "personality", "biography", "abilities"];

    // Find every cached character present in the scene and WHERE they were last mentioned.
    const present = [];
    for (const key of Object.keys(s.cache)) {
        const entry = s.cache[key];
        if (!entry.found || !entry.sections) continue;
        // All the names this character goes by: page title, search key, and aliases.
        const names = [entry.name.toLowerCase(), key, ...(entry.aliases || []).map(a => a.toLowerCase())]
            .filter(Boolean);
        // Ledger filter: keep only real cast — but a nickname counts, so check aliases too.
        if (ledger && !names.some(n => ledger.has(n))) continue;
        // All the names this character goes by: page title, search key, and aliases.
        const names = [entry.name.toLowerCase(), key, ...(entry.aliases || []).map(a => a.toLowerCase())]
            .filter(Boolean);
        // Ledger filter: keep only real cast — but a nickname counts, so check aliases too.
        if (ledger && !names.some(n => ledger.has(n))) continue;
        let lastIdx = -1, matchedName = "";
        for (let i = lowerMsgs.length - 1; i >= 0; i--) {
            const hit = names.find(n => mentioned(n, lowerMsgs[i]));
            if (hit) { lastIdx = i; matchedName = hit; break; }
        }
        if (lastIdx >= 0) present.push({ entry, lastIdx, matchedName });
    }
    // Most recently mentioned first — those are the characters actually in play now.
    present.sort((a, b) => b.lastIdx - a.lastIdx);

    const blocks = [];
    const reasons = [];
    let total = 0;
    for (const { entry, matchedName, lastIdx } of present) {
        if (blocks.length >= s.maxCharacters) break;
        const lines = [];
        for (const cat of order) {
            if (s[cat] && entry.sections[cat]) lines.push(`  - ${labels[cat]}: ${entry.sections[cat]}`);
        }
        if (!lines.length) continue;
        let block = clip(`${entry.name}:\n${lines.join("\n")}`, s.maxCharsPerChar);
        if (total + block.length > s.maxTotalChars) {
            if (blocks.length === 0) block = clip(block, s.maxTotalChars); // always fit at least one
            else break;
        }
        blocks.push(block);
        total += block.length;
        const snippet = (msgs[lastIdx] || "").replace(/\s+/g, " ").trim();
        const at = snippet.toLowerCase().indexOf(matchedName);
        const around = at >= 0 ? snippet.slice(Math.max(0, at - 25), at + matchedName.length + 25) : snippet.slice(0, 60);
        reasons.push(`${entry.name} ← matched "${matchedName}" in: …${around}…`);
    }
    lastMatchReasons = reasons;
    if (!blocks.length) return "";
    return (
        "[AUTHORITATIVE SOURCE CANON — retrieved from the official wiki for this " +
        "series. These facts are CORRECT and take priority over your own memory, your " +
        "assumptions, and any other description in this prompt. If something else here " +
        "disagrees, it is wrong — use THESE and do not second-guess, 'correct', or " +
        "invent alternatives.]\n" + blocks.join("\n")
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

        // If Summaryception's ledger is available, also ground its real characters that
        // are in the current scene — a clean, LLM-verified cast (handles pronoun-only
        // introductions and aliases the regex would miss), at no extra LLM cost.
        const scene = sceneMessages(getContext(), s.contextWindow);
        const lgNames = ledgerNames();
        if (lgNames) {
            const sceneLower = scene.join("\n").toLowerCase();
            const onScreen = lgNames.filter(n => mentioned(n.toLowerCase(), sceneLower));
            if (onScreen.length) await groundNames(onScreen);
        }

        // Inject only for characters ACTUALLY in the current visible scene — not for
        // every name that lingers in the permanent summary (that would pile up forever
        // and overwhelm the model). Recency-prioritized and hard-capped by size.
        const ctx = getContext();
        const note = relevantCanonNote(sceneMessages(ctx, s.contextWindow));

        // Record exactly what we injected this turn so it can be shown in settings.
        lastInjection = note || "";
        lastInjectionAt = Date.now();
        renderLastInjection();

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
                <hr>
                <small><b>What to ground:</b></small>
                <label class="checkbox_label">
                    <input id="cg_physical" type="checkbox">
                    <span>Physical (hair, eyes, appearance)</span>
                </label>
                <label class="checkbox_label">
                    <input id="cg_personality" type="checkbox">
                    <span>Personality</span>
                </label>
                <label class="checkbox_label">
                    <input id="cg_relationship" type="checkbox">
                    <span>Relationships / family</span>
                </label>
                <label class="checkbox_label">
                    <input id="cg_biography" type="checkbox">
                    <span>Biography (role, background)</span>
                </label>
                <label class="checkbox_label">
                    <input id="cg_abilities" type="checkbox">
                    <span>Powers &amp; Abilities</span>
                </label>
                <hr>
                <label class="checkbox_label">
                    <input id="cg_debug" type="checkbox">
                    <span>Debug (show a toast for each lookup)</span>
                </label>
                <label class="checkbox_label">
                    <input id="cg_replies" type="checkbox">
                    <span>Also ground names from AI replies</span>
                </label>
                <label class="checkbox_label">
                    <input id="cg_ledger" type="checkbox">
                    <span>Use Summaryception ledger for the real cast (recommended)</span>
                </label>
                <label>Wiki subdomains (comma-separated) — active for this story</label>
                <input id="cg_wikis" class="text_pole" type="text" placeholder="the-eminence-in-shadow">
                <div style="margin-top:4px;">
                    <input id="cg_save_wiki" class="menu_button" type="button" value="+ Save active to library">
                </div>
                <small>Saved wikis (tap to toggle in active, × to remove):</small>
                <div id="cg_saved_wikis" class="cg-chips"></div>
                <label>Physical fields (infobox)</label>
                <input id="cg_fields" class="text_pole" type="text">
                <label>Relationship keywords (infobox fields + sections)</label>
                <input id="cg_relkw" class="text_pole" type="text">
                <label>Biography keywords</label>
                <input id="cg_biokw" class="text_pole" type="text">
                <label>Personality keywords</label>
                <input id="cg_perkw" class="text_pole" type="text">
                <label>Powers &amp; abilities keywords</label>
                <input id="cg_abikw" class="text_pole" type="text">
                <label>Alias / nickname keywords (so "Alya" finds "Alisa")</label>
                <input id="cg_aliaskw" class="text_pole" type="text">
                <label>Scene window (visible messages that count as "now")</label>
                <input id="cg_window" class="text_pole" type="number" min="1" max="100">
                <small><b>Size limits</b> (stop the prompt ballooning with a big cast):</small>
                <label>Max characters injected at once</label>
                <input id="cg_maxchars" class="text_pole" type="number" min="1" max="30">
                <label>Max characters (text length) per character</label>
                <input id="cg_maxper" class="text_pole" type="number" min="80" max="2000" step="50">
                <label>Max total length for the whole canon block</label>
                <input id="cg_maxtotal" class="text_pole" type="number" min="200" max="20000" step="100">
                <div style="margin-top:4px;">
                    <input id="cg_reset_kw" class="menu_button" type="button" value="Reset fields &amp; keywords to defaults">
                </div>
                <hr>
                <small><b>Cache</b> — what's grounded (× removes one, so it re-fetches):</small>
                <div id="cg_cache_list" class="cg-cache"></div>
                <div style="margin-top:6px;">
                    <input id="cg_refresh" class="menu_button" type="button" value="Refresh">
                    <input id="cg_clear" class="menu_button" type="button" value="Clear all">
                </div>
                <hr>
                <small><b>Last injection</b> <span id="cg_inject_time" class="cg-empty"></span> — exactly what was added to the prompt:</small>
                <pre id="cg_last_inject" class="cg-inject"></pre>
                <small>Why each was injected (which name matched, and where):</small>
                <div id="cg_why" class="cg-why"></div>
                <small>Facts are fetched once per character and cached across sessions.</small>
            </div>
        </div>
    </div>`;
    $("#extensions_settings2").append(html);

    const s = settings();
    $("#cg_enabled").prop("checked", s.enabled).on("input", function () {
        s.enabled = $(this).prop("checked"); saveSettingsDebounced();
    });
    for (const cat of ["physical", "personality", "relationship", "biography", "abilities"]) {
        $(`#cg_${cat}`).prop("checked", s[cat]).on("input", function () {
            s[cat] = $(this).prop("checked"); saveSettingsDebounced();
        });
    }
    $("#cg_debug").prop("checked", s.debug).on("input", function () {
        s.debug = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_replies").prop("checked", s.groundFromReplies).on("input", function () {
        s.groundFromReplies = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_ledger").prop("checked", s.useLedger).on("input", function () {
        s.useLedger = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_wikis").val(s.wikis).on("input", function () {
        s.wikis = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_fields").val(s.fields).on("input", function () {
        s.fields = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_relkw").val(s.relationshipKeywords).on("input", function () {
        s.relationshipKeywords = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_biokw").val(s.biographyKeywords).on("input", function () {
        s.biographyKeywords = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_perkw").val(s.personalityKeywords).on("input", function () {
        s.personalityKeywords = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_abikw").val(s.abilitiesKeywords).on("input", function () {
        s.abilitiesKeywords = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_aliaskw").val(s.aliasKeywords).on("input", function () {
        s.aliasKeywords = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_window").val(s.contextWindow).on("input", function () {
        const n = parseInt($(this).val(), 10);
        s.contextWindow = Number.isFinite(n) && n > 0 ? n : 10;
        saveSettingsDebounced();
    });
    const numHandler = (id, key, min, def) => {
        $(id).val(s[key]).on("input", function () {
            const n = parseInt($(this).val(), 10);
            s[key] = Number.isFinite(n) && n >= min ? n : def;
            saveSettingsDebounced();
        });
    };
    numHandler("#cg_maxchars", "maxCharacters", 1, 6);
    numHandler("#cg_maxper", "maxCharsPerChar", 80, 400);
    numHandler("#cg_maxtotal", "maxTotalChars", 200, 2400);

    $("#cg_reset_kw").on("click", function () {
        for (const k of ["fields", "relationshipKeywords", "biographyKeywords", "personalityKeywords", "abilitiesKeywords", "aliasKeywords"]) {
            s[k] = defaultSettings[k];
        }
        $("#cg_fields").val(s.fields);
        $("#cg_relkw").val(s.relationshipKeywords);
        $("#cg_biokw").val(s.biographyKeywords);
        $("#cg_perkw").val(s.personalityKeywords);
        $("#cg_abikw").val(s.abilitiesKeywords);
        $("#cg_aliaskw").val(s.aliasKeywords);
        saveSettingsDebounced();
        toastr?.info?.("Fields & keywords reset. Clear the cache to re-fetch with the new fields.");
    });

    // Keep the active field and the saved-wiki highlights in sync.
    $("#cg_wikis").off("input").on("input", function () {
        s.wikis = String($(this).val()); saveSettingsDebounced();
        renderSavedWikis();
    });

    $("#cg_save_wiki").on("click", function () {
        const active = String($("#cg_wikis").val()).split(",").map(x => x.trim()).filter(Boolean);
        s.savedWikis = s.savedWikis || [];
        for (const w of active) if (!s.savedWikis.includes(w)) s.savedWikis.push(w);
        saveSettingsDebounced();
        renderSavedWikis();
    });

    $("#cg_refresh").on("click", function () {
        renderCacheList();
        renderLastInjection();
    });
    $("#cg_clear").on("click", function () {
        s.cache = {}; saveSettingsDebounced();
        renderCacheList();
        toastr?.info?.("Canon cache cleared.");
    });

    renderSavedWikis();
    renderCacheList();
    renderLastInjection();
}

function renderLastInjection() {
    const $el = $("#cg_last_inject");
    if (!$el.length) return;
    if (!lastInjection) {
        $el.text("Nothing injected last turn (no grounded character was in the visible scene).");
        $("#cg_inject_time").text("");
        return;
    }
    $el.text(lastInjection);
    const approxTokens = Math.round(lastInjection.length / 4);
    const when = lastInjectionAt ? new Date(lastInjectionAt).toLocaleTimeString() : "";
    const lg = ledgerNames();
    const src = lg ? `ledger cast (${lg.length})` : "name-matching";
    $("#cg_inject_time").text(`~${approxTokens} tokens · ${src}${when ? " · " + when : ""}`);
    // Show WHY each character was injected — reveals a wrong match at a glance.
    const $why = $("#cg_why");
    if ($why.length) {
        $why.empty();
        if (lastMatchReasons.length) {
            for (const r of lastMatchReasons) $("<div class='cg-why-row'></div>").text(r).appendTo($why);
        } else {
            $why.append('<span class="cg-empty">—</span>');
        }
    }
}

// Toggle a saved subdomain in/out of the active field.
function toggleActiveWiki(w) {
    const s = settings();
    const cur = String($("#cg_wikis").val()).split(",").map(x => x.trim()).filter(Boolean);
    const i = cur.indexOf(w);
    if (i >= 0) cur.splice(i, 1); else cur.push(w);
    const val = cur.join(",");
    $("#cg_wikis").val(val);
    s.wikis = val; saveSettingsDebounced();
    renderSavedWikis();
}

function renderSavedWikis() {
    const s = settings();
    const active = String(s.wikis || "").split(",").map(x => x.trim()).filter(Boolean);
    const $box = $("#cg_saved_wikis").empty();
    if (!s.savedWikis || !s.savedWikis.length) {
        $box.append('<span class="cg-empty">Nothing saved yet — tap "+ Save active to library".</span>');
        return;
    }
    for (const w of s.savedWikis) {
        const on = active.includes(w);
        const $chip = $('<span class="cg-chip"></span>').toggleClass("cg-chip-on", on);
        $('<span class="cg-chip-name"></span>').text(w).on("click", () => toggleActiveWiki(w)).appendTo($chip);
        $('<span class="cg-chip-x">×</span>').on("click", (e) => {
            e.stopPropagation();
            s.savedWikis = s.savedWikis.filter(x => x !== w);
            saveSettingsDebounced();
            renderSavedWikis();
        }).appendTo($chip);
        $box.append($chip);
    }
}

function renderCacheList() {
    const s = settings();
    const $box = $("#cg_cache_list").empty();
    const keys = Object.keys(s.cache || {});
    if (!keys.length) { $box.append('<span class="cg-empty">Cache is empty.</span>'); return; }
    for (const key of keys) {
        const e = s.cache[key];
        let label;
        if (e && e.found) {
            const cats = e.sections
                ? Object.entries(e.sections).filter(([, v]) => v).map(([k]) => k).join(", ")
                : "";
            label = `✓ ${e.name} (${e.wiki}) — ${cats || "no data"}`;
        } else {
            label = `✕ ${(e && e.name) || key} — not found`;
        }
        const $row = $('<div class="cg-cache-row"></div>');
        $('<span class="cg-cache-label"></span>').text(label).appendTo($row);
        $('<span class="cg-cache-x">×</span>').on("click", () => {
            delete s.cache[key]; saveSettingsDebounced(); renderCacheList();
        }).appendTo($row);
        $box.append($row);
    }
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
