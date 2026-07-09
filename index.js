/*
 * Canon Grounding — SillyTavern extension
 * ---------------------------------------
 * Keeps source-material entities (characters, and optionally places/lore) accurate
 * during roleplay by pulling facts from a Fandom wiki and injecting them BEFORE
 * generation — no manual per-character entry, streaming-safe.
 *
 * Pipeline (in the generate_interceptor, which runs before generation):
 *   1. Decide WHO/WHAT is in the current scene. Priority:
 *        a. LLM parser (recommended): a fast model reads the scene and returns the
 *           canon entities to look up (Arbiter-style, via ConnectionManagerRequestService
 *           or generateRaw). Gated so it only runs when a new name appears.
 *        b. Summaryception ledger (if present): its LLM-built cast list.
 *        c. Regex candidates (fallback): capitalized names, sentence-initial words filtered.
 *   2. Ground each NEW entity once via the MediaWiki API (client-side, origin=* → no
 *      CORS, no server plugin). Facts are cached FOREVER in settings, keyed by name,
 *      with aliases so a nickname matches its full-name page. Cached entities never
 *      re-hit the wiki.
 *   3. Inject a compact, capped canon note for the entities present in the current
 *      visible scene, via setExtensionPrompt (reliable) — not a chat splice.
 *   4. A post-generation scan grounds entities the MODEL introduced (fallback mode only;
 *      the parser/ledger already cover the AI's output).
 *
 * Safety/robustness: interceptor runs only on real generations (normal/swipe/regenerate/
 * continue) to avoid injecting into background calls and to stop the parser's own
 * generateRaw from re-entering; a re-entry flag guards overlaps; all wiki/LLM work is
 * time-boxed and wrapped so it can never block or break a turn. Injection size is hard-
 * capped (per-entity + total) so a big cast can't balloon the prompt.
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, chat_metadata } from "../../../../script.js";

const MODULE_NAME = "canon_grounding";

// What the extension injected on the most recent turn (for the settings display).
let lastInjection = "";
let lastInjectionAt = 0;
let lastMatchReasons = [];  // why each injected character was considered "present"
let parsedWords = new Set(); // lowercased candidate words already shown to the LLM parser
let cgInFlight = false;      // guard: don't re-enter the interceptor during our own sub-generation
let lastCast = [];          // entities the parser last judged present (reused between gated runs)
const INJECT_KEY = "CANON_GROUNDING";

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
    // LLM parser (Arbiter-style): before generation, a fast model reads the current
    // scene and decides which CHARACTER names to search — replacing the dumb regex that
    // grabbed words like "Current". Off by default (needs a model/adds a call); when on,
    // it only fires when a potentially-new name appears, so a settled cast costs nothing.
    llmParser: false,
    llmProfileId: "",   // Connection Manager profile for the fast model ("" = main model)
    // When on, run the parser EVERY turn (needed if you write character names in
    // lowercase, since the cheap "new capitalized word" gate can't see those). When
    // off, the gate only calls the model when a genuinely new name appears.
    parserEveryTurn: false,
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
        const words = phrase.split(/\s+/);
        if (words.length === 1) {
            if (STOPWORDS.has(words[0])) continue;
            // A lone capitalized word that merely STARTS a sentence is not a name
            // signal ("Current scene…", "Steam drifted…", "Water pooled…"). Only keep
            // single capitals that appear MID-sentence (a real proper-noun signal).
            // Multi-word phrases (Rose Oriana) are always kept.
            const before = clean.slice(0, m.index).replace(/\s+$/, "");
            if (before === "" || /[.!?:;\n"”)]$/.test(before)) continue;
        }
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
    // NOTE: "(Character)" is intentionally NOT here — some wikis disambiguate a real
    // character page that way, and rejecting it would drop the character.
    return /\((light novel|novel|anime|manga|manhwa|manhua|film|movie|ova|ona|web series|series|video game|soundtrack|album|song|volume|vol\.?|chapter|episode|arc|season|disambiguation|franchise)\)/i.test(t)
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

async function ensureGrounded(name, trusted = false) {
    const s = settings();
    const key = name.toLowerCase();
    const existing = s.cache[key];
    if (existing && existing.sections) {
        if (existing.found) return existing;                       // already grounded
        if (Date.now() - existing.ts < NEGATIVE_TTL) {
            // A page rejected ONLY because it didn't look like a character can still be
            // valid lore (a place/org). If the caller now trusts it (LLM parser), re-fetch
            // instead of reusing the untrusted miss; otherwise honor the recent miss.
            if (!(existing.reason === "not-character" && trusted)) return existing;
        }
    }

    const wikis = s.wikis.split(",").map(w => w.trim()).filter(Boolean);
    let hadError = false;          // network / HTTP / parse failure (transient — retry later)
    let missReason = "no-page";    // upgraded to "not-character" / "no-facts" as we learn more

    for (const wiki of wikis) {
        try {
            const title = await findPageTitle(wiki, name);
            if (!title) continue; // no such page on this wiki — a real miss, not an error

            const wikitext = await fetchWikitext(wiki, title);

            // Gate: reject media/series pages (Light Novel, Anime) that aren't real entities.
            // When the LLM chose this entity (trusted), that's all we check — it may be a
            // place or organization (Mitsugoshi, Shadow Garden), which is valid lore. When
            // untrusted (regex/ledger names), also require it to look like a CHARACTER page
            // so stray words don't ground onto some unrelated article.
            const charSignal = extractInfoboxFields(wikitext,
                ["gender", "age", "hair", "eye", "relatives", "species", "race", "affiliation",
                 "occupation", "height", "birthday", "birthdate", "status", "spouse", "family",
                 "blood", "voiced", "voice actor", "seiyu", "alias", "nickname"]);
            const charSection = extractSection(wikitext, ["personality", "relationships", "appearance"], 40);
            if (!trusted && !charSignal && !charSection) {
                missReason = "not-character";
                debug(`⚠ "${title}" isn't a character page (no character fields) — skipped`);
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
            missReason = "no-facts";
            debug(`⚠ found page "${title}" on ${wiki} but no usable sections`);
        } catch (err) {
            hadError = true;
            debug(`✕ fetch error for "${name}" on ${wiki}: ${err.message}`);
        }
    }

    // Persist a "not found" when we searched cleanly, whether the wiki had no page at
    // all OR the page wasn't usable (media page, no character fields, no sections). This
    // prevents re-fetching the same dead end every turn. Transient network errors are NOT
    // locked in (hadError skips this), and the 24h TTL lets it retry later.
    if (!hadError) {
        s.cache[key] = { name, sections: {}, wiki: null, found: false, reason: missReason, ts: Date.now() };
        saveSettingsDebounced();
        debug(`✕ no usable wiki page for "${name}" on: ${s.wikis}`);
    }
    return s.cache[key] || { name, sections: {}, found: false };
}

async function groundNames(names, trusted = false) {
    // Resolve all new entities concurrently (each is cache-checked inside, so this only
    // hits the wiki for ones we don't already have). One failing lookup can't sink the rest.
    await Promise.all(
        names.map(n => ensureGrounded(n, trusted).catch(e => debug(`ground "${n}" failed: ${e.message}`)))
    );
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

/** Find the cached, grounded entry for a name (by key, then title/alias). */
function cacheEntryFor(nameLc) {
    const s = settings();
    if (s.cache[nameLc] && s.cache[nameLc].found && s.cache[nameLc].sections) {
        return { key: nameLc, entry: s.cache[nameLc] };
    }
    for (const [k, e] of Object.entries(s.cache)) {
        if (!e.found || !e.sections) continue;
        const names = [e.name && e.name.toLowerCase(), k, ...(e.aliases || []).map(a => a.toLowerCase())].filter(Boolean);
        if (names.includes(nameLc)) return { key: k, entry: e };
    }
    return null;
}

/**
 * Build the canon note.
 *  - If `castNames` is given (from the LLM parser or ledger — the entities judged to be
 *    present THIS turn), inject exactly those, in that order. This is pronoun-proof: a
 *    character the parser says is here gets injected even if only "she" appears in the text.
 *  - Otherwise fall back to scanning the visible scene for grounded names (regex mode).
 * Hard-capped by count / per-entity / total length either way.
 */
function relevantCanonNote(sceneMsgs, castNames) {
    const s = settings();
    const msgs = sceneMsgs || [];
    const lowerMsgs = msgs.map(m => m.toLowerCase());
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

    const present = [];  // { entry, matchedName }
    if (castNames && castNames.length) {
        // Cast-driven: inject the entities identified as present, in centrality order.
        const usedKeys = new Set();
        for (const cn of castNames) {
            const found = cacheEntryFor(cn.toLowerCase());
            if (found && !usedKeys.has(found.key)) {
                usedKeys.add(found.key);
                present.push({ entry: found.entry, matchedName: cn });
            }
        }
    } else {
        // Scene-scan fallback (regex mode): grounded names actually in the recent window.
        const lgNames = (!s.llmParser) ? ledgerNames() : null;
        const ledger = lgNames ? new Set(lgNames.map(n => n.toLowerCase())) : null;
        const scored = [];
        for (const key of Object.keys(s.cache)) {
            const entry = s.cache[key];
            if (!entry.found || !entry.sections) continue;
            const names = [entry.name.toLowerCase(), key, ...(entry.aliases || []).map(a => a.toLowerCase())]
                .filter(Boolean);
            if (ledger && !names.some(n => ledger.has(n))) continue;
            let lastIdx = -1, matchedName = "";
            for (let i = lowerMsgs.length - 1; i >= 0; i--) {
                const hit = names.find(n => mentioned(n, lowerMsgs[i]));
                if (hit) { lastIdx = i; matchedName = hit; break; }
            }
            if (lastIdx >= 0) scored.push({ entry, lastIdx, matchedName });
        }
        scored.sort((a, b) => b.lastIdx - a.lastIdx);  // most recently mentioned first
        for (const sc of scored) present.push({ entry: sc.entry, matchedName: sc.matchedName });
    }

    const blocks = [];
    const reasons = [];
    let total = 0;
    for (const { entry, matchedName } of present) {
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
        reasons.push(`${entry.name} ← ${matchedName && matchedName.toLowerCase() !== entry.name.toLowerCase() ? `present (as "${matchedName}")` : "present in scene"}`);
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

/** Connection Manager profiles (for the fast parser model dropdown). */
function getProfiles() {
    try {
        const list = getContext().extensionSettings?.connectionManager?.profiles;
        return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
}

/** Pull a JSON array of strings out of model output (may include reasoning/fences). */
function parseNameArray(text) {
    if (!text) return [];
    const cleaned = String(text).replace(/```(?:json)?/gi, "");
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start >= 0 && end > start) {
        try {
            const arr = JSON.parse(cleaned.slice(start, end + 1));
            if (Array.isArray(arr)) {
                return [...new Set(arr
                    .filter(x => typeof x === "string")
                    .map(x => x.trim())
                    .filter(x => x.length >= 2 && x.length <= 50 && /[A-Za-z]/.test(x)))];
            }
        } catch (e) { /* fall through */ }
    }
    return [];
}

/**
 * Arbiter-style pre-generation parse: a fast model reads the scene and returns the
 * character names actually present. Time-boxed; returns [] on any failure so it can
 * never block or break a turn.
 */
async function parseSceneCharacters(sceneText) {
    const c = getContext();
    const s = settings();
    const systemText =
        "This is a scene from a work of fiction that has published source material with a " +
        "wiki. List the canon entities worth looking up in that wiki so the writer can portray " +
        "them accurately. INCLUDE: (a) characters who are present or acting in the scene; " +
        "(b) characters who are NAMED, referred to, remembered, or asked about even if NOT " +
        "physically present — the writer still needs to know who they are to mention them " +
        "correctly (e.g. someone the player asks 'have you seen X?'); (c) places, organizations, " +
        "groups, or notable lore that are central to what is happening. Use your own knowledge " +
        "of the series to tell a real canon entity from ordinary description. Give each entity's " +
        "canonical name (the one the wiki would use). Leave out generic words, everyday objects, " +
        "and anything invented just for this scene. Respond with ONLY a JSON array of names as " +
        "strings, most central first, or [] if none. No other text.";
    const userText = `<scene>\n${sceneText}\n</scene>\n\nJSON array of canon entities to look up:`;
    const budgetMs = 15000, maxTokens = 200;
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, budgetMs);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const extract = (res) =>
        typeof res === "string" ? res.trim()
        : (res && typeof res === "object" ? String(res.content ?? res.text ?? "").trim() : "");
    try {
        let out = "";
        const svc = c.ConnectionManagerRequestService;
        if (s.llmProfileId && svc && typeof svc.sendRequest === "function") {
            const messages = [{ role: "system", content: systemText }, { role: "user", content: userText }];
            const res = await Promise.race([
                svc.sendRequest(s.llmProfileId, messages, maxTokens, { signal: controller.signal, extractData: true }),
                sleep(budgetMs + 250).then(() => null),
            ]);
            out = extract(res);
        } else if (typeof c.generateRaw === "function") {
            const res = await Promise.race([
                c.generateRaw({ prompt: userText, systemPrompt: systemText, responseLength: maxTokens }),
                sleep(budgetMs).then(() => null),
            ]);
            out = extract(res);
        }
        return parseNameArray(out);
    } catch (e) {
        debug(`LLM parser failed: ${e.message}`);
        return [];
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Inject the canon note reliably via setExtensionPrompt (the documented API, same as
 * Summaryception/Arbiter) — an is_system chat-splice can be silently dropped from the
 * prompt on some builds. Empty text clears the injection. Returns false if the API is
 * unavailable (caller then falls back to a chat splice).
 */
function setInjection(text) {
    try {
        const c = getContext();
        if (typeof c.setExtensionPrompt !== "function") return false;
        const types = c.extension_prompt_types || {};
        const roles = c.extension_prompt_roles || {};
        const pos = types.IN_CHAT !== undefined ? types.IN_CHAT : 1;   // in-chat @ depth
        const role = roles.SYSTEM !== undefined ? roles.SYSTEM : 0;    // system role
        c.setExtensionPrompt(INJECT_KEY, text || "", pos, 1, false, role); // depth 1 = just above the latest message
        return true;
    } catch (e) {
        return false;
    }
}

globalThis.CanonGrounding_intercept = async function (chat, contextSize, abort, type) {
    // Only real user-facing generations. Skipping quiet/impersonate also prevents our
    // own parser generateRaw call (a quiet generation) from re-entering this interceptor.
    const genType = type || "normal";
    if (!["normal", "swipe", "regenerate", "continue"].includes(genType)) return;
    if (cgInFlight) return;
    cgInFlight = true;
    try {
        const s = settings();
        setInjection("");            // start each generation clean; re-set below if needed
        if (!s.enabled) return;

        const scene = sceneMessages(getContext(), s.contextWindow);
        const sceneText = scene.join("\n");
        const lgNames = ledgerNames();
        let cast = null;  // entities present this turn; drives injection when known

        if (s.llmParser) {
            // Primary path: a fast model reads THIS scene and names the characters present.
            //  - "every turn" mode: always (needed if you write names in lowercase).
            //  - default gate: only when a capitalized word appears that we have NOT already
            //    shown the model. We remember every word parsed (not just grounded ones), so
            //    recurring non-characters (Mitsugoshi) don't re-fire — it settles when stable.
            let shouldParse = s.parserEveryTurn;
            const quick = extractCandidateNames(sceneText);
            if (!shouldParse) {
                shouldParse = quick.some(n => {
                    const lc = n.toLowerCase();
                    return !parsedWords.has(lc) && !s.cache[lc];
                });
            }
            if (shouldParse) {
                const parsed = await parseSceneCharacters(sceneText);
                for (const n of quick) parsedWords.add(n.toLowerCase()); // shown to the model now
                if (parsed.length) {
                    debug(`LLM parser → ${parsed.join(", ")}`);
                    lastCast = parsed;                       // remember for turns the gate skips
                    await groundNames(parsed, true);         // trusted: model chose these (may be lore)
                }
            }
            // Inject the parser's present-cast (pronoun-proof), reused between gated runs.
            cast = lastCast;
        } else if (lgNames) {
            // Ledger present → its real characters that are on-screen (named in the window).
            const sceneLower = sceneText.toLowerCase();
            cast = lgNames.filter(n => mentioned(n.toLowerCase(), sceneLower));
            if (cast.length) await groundNames(cast);
        } else {
            // No parser, no ledger → regex fallback; injection uses the scene-scan (cast=null).
            const lastUser = [...chat].reverse().find(m => m.is_user);
            if (lastUser) {
                const names = extractCandidateNames(lastUser.mes);
                if (names.length) await groundNames(names);
            }
        }

        // Build the note. Cast-driven when we have one (parser/ledger); scene-scan otherwise.
        const note = relevantCanonNote(sceneMessages(getContext(), s.contextWindow), cast);

        // Record exactly what we injected this turn so it can be shown in settings.
        lastInjection = note || "";
        lastInjectionAt = Date.now();
        renderLastInjection();

        if (note) {
            const ok = setInjection(note);
            if (!ok) {
                // Fallback for very old ST without setExtensionPrompt.
                const injected = { is_user: false, is_system: true, name: "Canon", send_date: Date.now(), mes: note };
                chat.splice(Math.max(chat.length - 1, 0), 0, injected);
            }
        }
    } catch (err) {
        console.error("[CanonGrounding] interceptor error:", err);
        // Never block generation on our account.
    } finally {
        cgInFlight = false;
    }
};

// ---------------------------------------------------------------------------
// Silent post-generation grounding (catch model-introduced characters)
// ---------------------------------------------------------------------------

async function onMessageReceived() {
    const s = settings();
    if (!s.enabled || cgInFlight) return;
    const ctx = getContext();
    const chat = ctx.chat || [];
    const last = chat[chat.length - 1];
    if (!last || last.is_user) return; // only after an AI reply

    if (s.llmParser) {
        // Scan the AI's fresh output so characters IT introduced are grounded now and the
        // present-cast is up to date for the next turn's injection. Same gate as pre-gen.
        const sceneText = sceneMessages(getContext(), s.contextWindow).join("\n");
        const quick = extractCandidateNames(sceneText);
        const hasNew = s.parserEveryTurn ||
            quick.some(n => !parsedWords.has(n.toLowerCase()) && !s.cache[n.toLowerCase()]);
        if (!hasNew) return;
        cgInFlight = true; // block the interceptor from re-entering during our generateRaw
        try {
            const parsed = await parseSceneCharacters(sceneText);
            for (const n of quick) parsedWords.add(n.toLowerCase());
            if (parsed.length) { lastCast = parsed; await groundNames(parsed, true); }
        } finally {
            cgInFlight = false;
        }
        return;
    }
    if (ledgerNames()) return;        // ledger already tracks the cast
    if (!s.groundFromReplies) return; // regex fallback is opt-in
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
                <small class="cg-hint">Master switch. Off = no grounding and nothing injected.</small>
                <hr>
                <small><b>What to ground</b> — which kinds of canon facts to inject:</small>
                <label class="checkbox_label">
                    <input id="cg_physical" type="checkbox">
                    <span>Physical (hair, eyes, appearance)</span>
                </label>
                <small class="cg-hint">Hair and eye color. Leanest and most useful — fixes wrong looks. Leave this on.</small>
                <label class="checkbox_label">
                    <input id="cg_personality" type="checkbox">
                    <span>Personality</span>
                </label>
                <small class="cg-hint">How they behave. Adds a short paragraph of tokens.</small>
                <label class="checkbox_label">
                    <input id="cg_relationship" type="checkbox">
                    <span>Relationships / family</span>
                </label>
                <small class="cg-hint">Parents, siblings, key ties. Good for stopping invented family.</small>
                <label class="checkbox_label">
                    <input id="cg_biography" type="checkbox">
                    <span>Biography (role, background)</span>
                </label>
                <small class="cg-hint">Role, affiliation, backstory. Verbose — use only if needed.</small>
                <label class="checkbox_label">
                    <input id="cg_abilities" type="checkbox">
                    <span>Powers &amp; Abilities</span>
                </label>
                <small class="cg-hint">Powers, skills, weapons. Verbose, and the model often half-knows these.</small>
                <hr>
                <small><b>How characters are found</b>:</small>
                <label class="checkbox_label">
                    <input id="cg_llm" type="checkbox">
                    <span>Use a fast LLM to pick names (recommended)</span>
                </label>
                <small class="cg-hint">Best accuracy. A model reads the current scene and decides what to look up — no false matches like "Current". Costs one small call, and only when a new name appears.</small>
                <label>Parser model</label>
                <small class="cg-hint">Which model the parser uses. Blank = your main chat model (simplest). For speed, pick a fast/cheap Connection Manager profile. ↻ refreshes the list.</small>
                <div style="display:flex; gap:4px; align-items:center;">
                    <select id="cg_profile" class="text_pole" style="flex:1;"></select>
                    <div id="cg_profile_refresh" class="menu_button fa-solid fa-rotate" title="Refresh profiles"></div>
                </div>
                <label class="checkbox_label">
                    <input id="cg_llm_every" type="checkbox">
                    <span>Run the parser every turn</span>
                </label>
                <small class="cg-hint">Off = only when a new capitalized name shows up (efficient). On = every turn — needed only if you write character names in lowercase. Pair with a fast model.</small>
                <label class="checkbox_label">
                    <input id="cg_ledger" type="checkbox">
                    <span>Use Summaryception ledger (fallback if no parser)</span>
                </label>
                <small class="cg-hint">If you run Summaryception, use its character list. Only knows characters from earlier turns (its list builds after each reply), so it can't see brand-new ones — the LLM parser is better. Ignored when the parser is on.</small>
                <label class="checkbox_label">
                    <input id="cg_replies" type="checkbox">
                    <span>Also ground names from AI replies</span>
                </label>
                <small class="cg-hint">Learn characters the AI introduces on its own. Only used in plain regex mode — the parser and ledger already cover this.</small>
                <label class="checkbox_label">
                    <input id="cg_debug" type="checkbox">
                    <span>Debug toasts</span>
                </label>
                <small class="cg-hint">Pop-up for every lookup (found / miss / error) and the parser's picks. Turn on to see what's happening; off for normal play.</small>
                <hr>
                <small><b>Wiki</b> — where facts come from:</small>
                <label>Wiki subdomains (comma-separated) — active for this story</label>
                <small class="cg-hint">The part before .fandom.com for your story's wiki (e.g. the-eminence-in-shadow). Add several, comma-separated, for a crossover.</small>
                <input id="cg_wikis" class="text_pole" type="text" placeholder="the-eminence-in-shadow">
                <div style="margin-top:4px;">
                    <input id="cg_save_wiki" class="menu_button" type="button" value="+ Save active to library">
                </div>
                <small class="cg-hint">Saves the current subdomain(s) as tap-to-use chips so you never retype them.</small>
                <small>Saved wikis (tap to toggle in active, × to remove):</small>
                <div id="cg_saved_wikis" class="cg-chips"></div>
                <hr>
                <small><b>Advanced</b> — where each category lives in the wiki. Defaults cover most wikis; edit only if a category comes up empty.</small>
                <label>Physical fields (infobox)</label>
                <input id="cg_fields" class="text_pole" type="text">
                <small class="cg-hint">Infobox field names that hold appearance (matched loosely). Default: hair/eyes only.</small>
                <label>Relationship keywords (infobox fields + sections)</label>
                <input id="cg_relkw" class="text_pole" type="text">
                <label>Biography keywords</label>
                <input id="cg_biokw" class="text_pole" type="text">
                <label>Personality keywords</label>
                <input id="cg_perkw" class="text_pole" type="text">
                <label>Powers &amp; abilities keywords</label>
                <input id="cg_abikw" class="text_pole" type="text">
                <small class="cg-hint">Words that tell the extension which infobox fields and section titles feed each category above.</small>
                <label>Alias / nickname keywords (so "Alya" finds "Alisa")</label>
                <input id="cg_aliaskw" class="text_pole" type="text">
                <small class="cg-hint">Infobox fields that list a character's other names, so any nickname matches their full-name page.</small>
                <label>Scene window (visible messages that count as "now")</label>
                <input id="cg_window" class="text_pole" type="number" min="1" max="100">
                <small class="cg-hint">How many recent visible messages count as the current scene. A character stops injecting once their name scrolls past this many messages. Lower = drops off-screen characters faster.</small>
                <hr>
                <small><b>Size limits</b> — hard caps so a big cast can't balloon the prompt:</small>
                <label>Max characters injected at once</label>
                <input id="cg_maxchars" class="text_pole" type="number" min="1" max="30">
                <small class="cg-hint">Never inject more than this many at once (most recently mentioned win).</small>
                <label>Max characters (text length) per character</label>
                <input id="cg_maxper" class="text_pole" type="number" min="80" max="2000" step="50">
                <small class="cg-hint">Length cap on each character's block. Lower = leaner, trims the wordy categories first.</small>
                <label>Max total length for the whole canon block</label>
                <input id="cg_maxtotal" class="text_pole" type="number" min="200" max="20000" step="100">
                <small class="cg-hint">Overall cap on the whole note. Roughly 4 characters ≈ 1 token (so 2400 ≈ 600 tokens).</small>
                <div style="margin-top:4px;">
                    <input id="cg_reset_kw" class="menu_button" type="button" value="Reset fields &amp; keywords to defaults">
                </div>
                <small class="cg-hint">Restores the field/keyword boxes above to defaults. Clear the cache afterwards so entries re-fetch.</small>
                <hr>
                <small><b>Cache</b> — everything grounded so far:</small>
                <div id="cg_cache_list" class="cg-cache"></div>
                <small class="cg-hint">Facts are fetched from the wiki once per entity, then reused forever (no repeat calls). × removes one entry so it re-fetches next time; "Clear all" wipes everything — do this after changing fields/keywords or fixing a wrong entry.</small>
                <div style="margin-top:6px;">
                    <input id="cg_rescan" class="menu_button" type="button" value="Scan current scene now">
                    <input id="cg_refresh" class="menu_button" type="button" value="Refresh">
                    <input id="cg_clear" class="menu_button" type="button" value="Clear all">
                </div>
                <small class="cg-hint">"Scan current scene now" grounds whoever is in the scene right away — use it after clearing the cache mid-story, so you don't have to wait for a character to be named again.</small>
                <hr>
                <small><b>Last injection</b> <span id="cg_inject_time" class="cg-empty"></span></small>
                <pre id="cg_last_inject" class="cg-inject"></pre>
                <small class="cg-hint">The exact text sent to the model last turn. The line above shows its rough token size and whether the cast was chosen by the ledger or by name-matching. Tap Refresh to update after a message.</small>
                <small><b>Why each was injected</b>:</small>
                <div id="cg_why" class="cg-why"></div>
                <small class="cg-hint">For each injected character, which of their names matched and where — if something wrong shows up, this tells you why.</small>
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
    $("#cg_llm").prop("checked", s.llmParser).on("input", function () {
        s.llmParser = $(this).prop("checked"); saveSettingsDebounced();
    });
    const fillProfiles = () => {
        const $sel = $("#cg_profile").empty();
        $sel.append('<option value="">(main model)</option>');
        for (const p of getProfiles()) {
            if (p && p.id) $sel.append($("<option></option>").val(p.id).text(p.name || p.id));
        }
        $sel.val(s.llmProfileId || "");
    };
    fillProfiles();
    $("#cg_profile").on("change", function () {
        s.llmProfileId = String($(this).val()); saveSettingsDebounced();
    });
    $("#cg_profile_refresh").on("click", fillProfiles);
    $("#cg_llm_every").prop("checked", s.parserEveryTurn).on("input", function () {
        s.parserEveryTurn = $(this).prop("checked"); saveSettingsDebounced();
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
        parsedWords = new Set();   // let the parser re-evaluate every name again
        lastCast = [];
        renderCacheList();
        toastr?.info?.("Canon cache cleared. Send a message (or 'Scan current scene now') to re-ground.");
    });
    $("#cg_rescan").on("click", async function () {
        const st = settings();
        if (!st.enabled) { toastr?.warning?.("Canon Grounding is disabled."); return; }
        const sceneText = sceneMessages(getContext(), st.contextWindow).join("\n");
        if (!sceneText.trim()) { toastr?.info?.("No visible scene to scan yet."); return; }
        try {
            if (st.llmParser) {
                toastr?.info?.("Scanning the current scene…");
                cgInFlight = true;
                let parsed = [];
                try { parsed = await parseSceneCharacters(sceneText); }
                finally { cgInFlight = false; }
                for (const n of extractCandidateNames(sceneText)) parsedWords.add(n.toLowerCase());
                if (parsed.length) {
                    lastCast = parsed;
                    await groundNames(parsed, true);
                    toastr?.success?.(`Grounded: ${parsed.join(", ")}`);
                } else {
                    toastr?.info?.("Parser returned no entities.");
                }
            } else {
                const names = extractCandidateNames(sceneText);
                await groundNames(names);
                toastr?.info?.(`Scanned ${names.length} name(s) from the scene.`);
            }
        } catch (e) {
            toastr?.error?.("Scan failed: " + e.message);
        }
        renderCacheList();
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
    // Switching chats: forget the previous story's parsed words and drop any lingering
    // canon injection so it can't bleed into the new chat's first generation.
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            parsedWords = new Set();
            lastCast = [];
            try { setInjection(""); } catch (e) { /* not critical */ }
        });
    }
    console.log("[CanonGrounding] loaded.");
});
