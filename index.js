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
 *
 * v0.2: every async result is epoch-guarded (CHAT_CHANGED bumps an epoch; stale
 * parses/groundings from a previous chat are discarded) and serial-guarded (only the
 * newest parse may write the cast). The cast itself DECAYS: past a grace window of
 * `contextWindow` messages since the last parse, entities no longer named in the scene
 * (directly or via alias) are pruned, so ghosts can't ride the injection forever.
 * Parser failure (timeout/garbage → null) is distinguished from an explicit empty
 * answer ([]) — failure keeps the previous cast, empty clears it.
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, chat_metadata } from "../../../../script.js";

const MODULE_NAME = "canon_grounding";

// What the extension injected on the most recent turn (for the settings display).
let lastInjection = "";
let lastInjectionAt = 0;
let lastMatchReasons = [];  // why each injected character was considered "present"
let parsedWords = new Set(); // lowercased candidate words already shown to the LLM parser
let cgInFlight = false;      // guard: don't run two interceptor passes at once
let lastCast = [];          // entities the parser last judged present (reused between gated runs)
let lastCastLen = 0;        // visible-chat length when lastCast was last confirmed (drives decay)
let lastSource = "";        // how the last injection's cast was chosen (for the settings display)
let chatEpoch = 0;          // bumped on CHAT_CHANGED — async work from an older epoch is discarded
let parseSerial = 0;        // monotonically increasing parse id — only the LATEST parse may apply
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
    // Hard limits so a big cast (e.g. High School DxD) can't balloon the prompt. Set a
    // bit generously because the LLM parser only returns real, relevant entities (no
    // regex junk), so there's room for present + referenced characters.
    maxCharacters: 8,       // inject at most this many entities (most central first)
    maxCharsPerChar: 400,   // cap per entity across all its categories
    maxTotalChars: 3000,    // hard cap on the whole canon block; stop once reached
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
    // One-time migrations, GATED by a stamp. The old code re-applied these on every
    // settings() call, which made it impossible to keep maxCharacters=6 or
    // maxTotalChars=2400 on purpose — they silently reverted mid-session.
    const st = extension_settings[MODULE_NAME];
    if (!st.migrated_v2) {
        // Early versions defaulted physical fields to a broad list (height/age/race/
        // gender) that pulled noise. If never customized, move to hair/eyes-only.
        const OLD_FIELDS = "hair,haircolor,hair color,eyes,eye color,eyecolor,height,age,race,species,gender";
        if (st.fields === OLD_FIELDS) st.fields = defaultSettings.fields;
        // Bump the old default caps (6 / 2400) so referenced characters have room.
        if (st.maxCharacters === 6) st.maxCharacters = 8;
        if (st.maxTotalChars === 2400) st.maxTotalChars = 3000;
        st.migrated_v2 = true;
        saveSettingsDebounced();
    }
    return st;
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
    // Narration sentence-starters and glue that routinely weld onto names in RP
    // prose ("Suddenly Rose Oriana…", "Meanwhile Cid…") — stripped from phrase
    // edges so the bare name is what gets gated and searched.
    "Suddenly", "Meanwhile", "Later", "Finally", "Eventually", "Slowly", "Quietly",
    "Instead", "Perhaps", "Maybe", "Almost", "Across", "Inside", "Outside",
    "Behind", "Beyond", "Beneath", "Above", "Below", "Nearby", "Once", "Still",
    "Even", "Just", "Only", "Now", "Soon", "Today", "Tonight", "Tomorrow",
    "Yesterday", "Again", "Around", "Along", "Toward", "Towards", "Under", "Over",
    "After", "Before", "During", "Between", "Both", "Each", "Every", "Some",
    "Any", "Another", "Other", "Several", "Many", "Few", "More", "Most",
    "Everyone", "Someone", "Anyone", "Nobody", "Something", "Nothing",
    "Everything", "Somewhere", "Please", "Well", "Also", "Though", "Although",
    "Because", "Since", "While", "Until", "Unless", "However", "Whatever",
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
    "canon", "character", "physical", "personality", "today", "tonight",
    "tomorrow", "yesterday", "now", "right", "just", "really", "still", "again",
]);

// Words that mark a lowercase message as a QUESTION/COMMAND about someone — the only
// situation where the lowercase-run fallback should fire (see extractCandidateNames).
const LOWER_TRIGGERS = new Set([
    "what", "whats", "who", "whos", "tell", "about", "describe", "show", "name",
    "named", "called", "how", "which", "know", "knows", "remember", "seen", "heard",
    "met", "meet", "find", "search", "lookup", "look", "wiki", "canon", "info",
]);

function isNameToken(tok) {
    return /^[A-Za-z][A-Za-z'’-]+$/.test(tok) && tok.length >= 2;
}

// Suffixes that glue onto names in RP prose — honorifics ("Alya-chan", "Rias-senpai"),
// possessives ("Cid's"), and contractions ("He'll") — stripped so the bare name is what
// gets gated, searched, and cached. Without this, every honorific variant would be a
// separate "new name" (parser re-fires) and a separate dead wiki lookup.
const HONORIFIC_RE = /-(?:chan|san|sama|kun|senpai|sensei|dono|tan|chi|nee(?:chan|san)?|nii(?:chan|san)?|kouhai|shi|han)$/i;
function normalizeNameWord(w) {
    return w
        .replace(/['’](?:s|ll|re|ve|d|m)$/i, "")
        .replace(HONORIFIC_RE, "")
        .replace(/^[-'’]+|[-'’]+$/g, "");
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

    // (1) Capitalized phrases. Token = Upper + lower + any word-ish tail, so
    // McGonagall and DxD match in full (ALLCAPS shouting still doesn't — the second
    // character must be lowercase). Honorifics/possessives are stripped BEFORE the
    // stopword check so "He'll" → "He" is filtered, "Alya-chan" → "Alya" is kept.
    // Sentence-start stopwords are stripped from phrase EDGES ("Then Rose Oriana" →
    // "Rose Oriana", "Later He" → nothing) — the old code kept whole phrases verbatim,
    // so sentence-glue words became part of the searched name.
    const capRe = /\b([A-Z][a-z][A-Za-z'’-]*(?:\s+[A-Z][a-z][A-Za-z'’-]*){0,3})\b/g;
    let m;
    while ((m = capRe.exec(clean)) !== null) {
        let words = m[1].trim().split(/\s+/).map(normalizeNameWord).filter(w => w.length >= 2);
        const hadLeading = words.length > 0 && STOPWORDS.has(words[0]);
        while (words.length && STOPWORDS.has(words[0])) words.shift();
        while (words.length && STOPWORDS.has(words[words.length - 1])) words.pop();
        if (!words.length) continue;
        if (words.length === 1) {
            if (STOPWORDS.has(words[0])) continue;
            // A lone capitalized word that merely STARTS a sentence is not a name
            // signal ("Current scene…", "Steam drifted…"). Only keep single capitals
            // that sit MID-sentence — which a stripped leading stopword also proves
            // ("Then Cid" ⇒ "Cid" was mid-phrase even though the MATCH starts the line).
            if (!hadLeading) {
                const before = clean.slice(0, m.index).replace(/\s+$/, "");
                if (before === "" || /[.!?:;\n"”)]$/.test(before)) continue;
            }
        }
        out.add(words.join(" "));
    }

    // (2) Lowercase runs — a FALLBACK for names typed without capitals, and only when
    // the message reads like a short question/command about someone ("whats rose oriana
    // hair", "have you seen mary", or a bare 1–4 token name). The old version also ran
    // on ordinary short narration and manufactured junk candidates out of verbs and
    // shouting ("screamed STOP", "took Cid", "Then Rose") — every one a dead wiki
    // lookup plus a pointless parser-gate re-fire.
    if (out.size === 0) {
        const tokens = clean.split(/\s+/).filter(Boolean);
        const bare = (t) => t.toLowerCase().replace(/[.,;:!?]+$/, "");
        // askStrong = the message is explicitly asking about someone (question word or
        // "?"); askish additionally allows a bare short name ("cid kagenou"). Single-
        // token candidates need askStrong — with only the short-message freebie, "hello"
        // and trailing verbs ("…nods") became wiki lookups AND parser-gate re-fires.
        const askStrong = /\?/.test(clean) || tokens.some(t => LOWER_TRIGGERS.has(bare(t)));
        const askish = askStrong || tokens.length <= 4;
        if (tokens.length <= 20 && askish) {
            const lowerCandidates = [];
            let run = [];
            const flush = () => {
                // Most character names are 1-2 words; take the first two tokens of a
                // run so trailing verbs ("cid kagenou before speaking") don't glue on.
                // Single-token runs count too when the token is substantial (≥3 chars) —
                // otherwise one-word names typed lowercase ("whats alpha hair") were
                // unreachable, the exact case this fallback exists for.
                if (run.length >= 2) lowerCandidates.push(run.slice(0, 2).join(" "));
                else if (askStrong && run.length === 1 && run[0].length >= 3) lowerCandidates.push(run[0]);
                run = [];
            };
            for (const raw of tokens) {
                const tok = normalizeNameWord(raw.replace(/[.,;:!?]+$/, ""));
                // A lowercase RUN must actually be lowercase — a token with any capital
                // belongs to path (1)'s world (or is ALLCAPS shouting) and breaks the run.
                if (tok === tok.toLowerCase() && isNameToken(tok) && !NOISE_WORDS.has(tok)) {
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
    //    or an unrelated page ("Shadow Garden", "Anime"). MediaWiki only auto-
    //    capitalizes the FIRST letter, so "rose oriana" would always miss here and
    //    burn a second request — title-case each word (preserving internal caps
    //    like McGonagall) so lowercase-typed names hit on the first round trip.
    try {
        const exactName = name.replace(/\S+/g, w => w[0].toUpperCase() + w.slice(1));
        const u = `${apiBase(wiki)}?action=query&titles=${encodeURIComponent(exactName)}&redirects=1&format=json&origin=*`;
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
    // A multi-line list template whose close was cut off upstream (value ends at the
    // "\n}}" terminator) leaves a dangling "{{Plainlist|" opener — unwrap it, then
    // purge any stray brace runs so raw markup can never reach the model.
    s = s.replace(/\{\{[^{}|\n]*\|/g, "").replace(/[{}]{2,}/g, " ");
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
    // |Field = value, where value runs until the next "\n|" param, the "\n}}" close,
    // or end-of-input. Without the $ alternative, the LAST field of an infobox whose
    // "}}" sits inline (|eyes = Blue}}) was silently invisible — the lazy value could
    // never satisfy a terminator, so the whole field match failed.
    const re = /\n\|\s*([A-Za-z][A-Za-z0-9 _()'-]*?)\s*=\s*([\s\S]*?)(?=\n\s*\||\n\s*\}\}|$)/g;
    let m;
    const src = "\n" + wikitext;
    while ((m = re.exec(src)) !== null) {
        const rawKey = m[1].trim();
        const key = rawKey.toLowerCase();
        if (!kw.some(k => key.includes(k))) continue;
        // Guard: on inline infoboxes the value regex can over-run into the next
        // "| NextField =" on the same line — cut it off there. A value can also never
        // legitimately contain a section header, so cut at "\n==" too; the hard length
        // cap keeps cleanWikitext cheap on pathological runs.
        let raw = m[2].split(/(?:^|[\s\n])\|\s*[A-Za-z][A-Za-z0-9 _()'-]*\s*=/)[0];
        raw = raw.split(/\n==/)[0].slice(0, 3000);
        // Cut at the infobox's OWN closing "}}" when it sits inline (|eyes = Blue}}Body…):
        // walk brace depth so closers of templates INSIDE the value ({{ubl|…}}) don't
        // truncate it, but an unbalanced close (depth 0 = the box itself) does.
        let depth = 0;
        for (let i = 0; i < raw.length - 1; i++) {
            if (raw[i] === "{" && raw[i + 1] === "{") { depth++; i++; }
            else if (raw[i] === "}" && raw[i + 1] === "}") {
                if (depth === 0) { raw = raw.slice(0, i); break; }
                depth--; i++;
            }
        }
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
        // [^\n]* after the closing "==" tolerates trailing comments/whitespace
        // ("== Appearance == <!--note-->"), which previously made the whole
        // section invisible.
        const m = chunk.match(/^=+\s*(.+?)\s*=+[^\n]*\n([\s\S]*)$/);
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
    for (let a of values.split(/[,、\/・]/)) {
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

    // The same character may already be grounded under a DIFFERENT key — e.g. "alya"
    // resolved to the page "Alisa Mikhailovna Kujou", and now the parser asks for the
    // canonical name. Reuse that entry instead of re-hitting the wiki and creating a
    // second cache entry for the same character (which also injected them twice).
    const aliasHit = cacheEntryFor(key);
    if (aliasHit) return aliasHit.entry;

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
            // Prose is read from the WIKITEXT WE ALREADY HAVE (Appearance section, then
            // the lead) — the old code always made a second network round trip for the
            // full plain-text extract, which on mobile added 100-500ms per new entity
            // and pulled entire articles. The extract fetch remains only as a last resort.
            let physical = extractInfoboxFields(wikitext, s.fields.split(","));
            if (!physical) {
                physical = extractFromProse(
                    extractSection(wikitext, ["appearance", "physical appearance", "physical description", "looks"], 1500)
                    || extractLead(wikitext, 1200)
                );
                if (!physical) physical = extractFromProse(await fetchExtract(wiki, title));
            }

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
    // Non-Latin fallback: the text is already lowercased, so the name must be too —
    // Cyrillic HAS case ("Мария" never matched "мария" before this fix, which broke
    // mention detection for Russian names entirely).
    if (/[^\x00-\x7F]/.test(name)) return lowerText.includes(name.toLowerCase());
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
 * Cast decay (parser mode). lastCast is reused between gated parser runs so injection
 * stays pronoun-proof — but without decay, a character who LEFT the scene kept
 * injecting forever if no new capitalized word ever re-fired the gate. Rule:
 *  - within `contextWindow` visible messages of the last confirmed parse → keep the
 *    full cast (grace period; pronoun-only stretches right after a parse stay covered);
 *  - past that → keep only entities still mentioned (by any name/alias) in the visible
 *    scene window, and write the pruned list back so ghosts stay gone. Entities that
 *    keep being named renew naturally; staleness is bounded by ~2× the window. A char
 *    dropped here but still named in-scene is caught by the scene-scan fallback anyway.
 */
function pruneStaleCast(visibleLen, sceneMsgs) {
    if (!lastCast || !lastCast.length) return [];
    const s = settings();
    if (visibleLen - lastCastLen <= s.contextWindow) return [...lastCast];
    const lower = (sceneMsgs || []).map(m => m.toLowerCase());
    const kept = lastCast.filter(cn => {
        const hit = cacheEntryFor(cn.toLowerCase());
        const names = hit
            ? [hit.entry.name.toLowerCase(), ...(hit.entry.aliases || []).map(a => a.toLowerCase())]
            : [cn.toLowerCase()];
        return lower.some(msg => names.some(n => mentioned(n, msg)));
    });
    if (kept.length !== lastCast.length) {
        debug(`cast decay: ${lastCast.length} → ${kept.length} (off-screen > ${s.contextWindow} msgs dropped)`);
    }
    lastCast = kept;
    lastCastLen = visibleLen;
    return [...kept];
}

/**
 * Gate check shared by the pre-generation interceptor AND the post-generation scan —
 * they previously disagreed: the post-gen gate used a raw cache-key check, so a name
 * already grounded under an alias re-fired the parser, and an EXPIRED negative was
 * treated as handled forever. One definition, both sides.
 */
function isUnhandledName(n) {
    const lc = n.toLowerCase();
    if (cacheEntryFor(lc)) return false;                                        // grounded (any name/alias)
    const neg = settings().cache[lc];
    if (neg && !neg.found && (Date.now() - neg.ts < NEGATIVE_TTL)) return false; // fresh miss
    return true;
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
    const seenEntities = new Set();  // one block per CHARACTER, even if cached under two keys
    let total = 0;
    for (const { entry, matchedName } of present) {
        if (blocks.length >= s.maxCharacters) break;
        const nameKey = (entry.name || "").toLowerCase();
        if (seenEntities.has(nameKey)) continue;
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
        seenEntities.add(nameKey);
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

/**
 * Pull a JSON array of strings out of model output (may include reasoning/fences).
 * Returns the (possibly EMPTY) array when the model actually answered with one —
 * an explicit [] means "I looked; nobody canon is here" and may clear a stale cast.
 * Returns NULL when no array could be recovered (garbled/refused output), so the
 * caller keeps the previous cast instead of treating failure as "nobody present".
 */
function parseNameArray(text) {
    if (!text) return null;
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
    return null;
}

/**
 * Arbiter-style pre-generation parse: a fast model reads the scene and returns the
 * character names actually present. Time-boxed so it can never block a turn.
 * Returns: string[] when the model answered ([] = it says no canon entities are
 * present, which may legitimately clear a stale cast); NULL on timeout/failure
 * (caller keeps the previous cast — failure must never be read as "nobody here").
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
            // The raced-out promise must not surface as an unhandled rejection when
            // the timeout wins and the abort later rejects it (console noise, and
            // Android webviews can surface those as visible errors).
            const req = svc.sendRequest(s.llmProfileId, messages, maxTokens, { signal: controller.signal, extractData: true });
            if (req && typeof req.catch === "function") req.catch(() => {});
            const res = await Promise.race([req, sleep(budgetMs + 250).then(() => null)]);
            out = extract(res);
        } else if (typeof c.generateRaw === "function") {
            const req = c.generateRaw({ prompt: userText, systemPrompt: systemText, responseLength: maxTokens });
            if (req && typeof req.catch === "function") req.catch(() => {});
            const res = await Promise.race([req, sleep(budgetMs).then(() => null)]);
            out = extract(res);
        }
        if (!out) return null;        // timeout / no backend / empty output → FAILURE, not "nobody here"
        return parseNameArray(out);   // [] only when the model explicitly answered []
    } catch (e) {
        debug(`LLM parser failed: ${e.message}`);
        return null;
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
    const myEpoch = chatEpoch;   // if the chat switches during any await below, drop everything
    try {
        const s = settings();
        setInjection("");            // start each generation clean; re-set below if needed
        if (!s.enabled) return;

        const ctx = getContext();
        const scene = sceneMessages(ctx, s.contextWindow);
        const sceneText = scene.join("\n");
        const visibleLen = (ctx.chat || []).filter(m => !m.is_system).length;
        const lastUserMsg = ([...chat].reverse().find(m => m.is_user) || {}).mes || "";
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
                // A capitalized word we've never shown the model and never grounded.
                shouldParse = quick.some(n => isUnhandledName(n) && !parsedWords.has(n.toLowerCase()));
            }
            if (!shouldParse) {
                // Always (re)parse when the CURRENT user message names someone we haven't
                // grounded — the player is bringing them up (e.g. "have you seen Mary?"), so
                // fetch their canon even if that name was seen before.
                shouldParse = extractCandidateNames(lastUserMsg).some(isUnhandledName);
            }
            if (shouldParse) {
                const mySerial = ++parseSerial;
                const parsed = await parseSceneCharacters(sceneText);
                if (myEpoch !== chatEpoch) return;   // chat switched mid-parse: old-chat results must not apply
                if (mySerial === parseSerial) {      // a newer parse hasn't superseded this one
                    for (const n of quick) parsedWords.add(n.toLowerCase()); // shown to the model now
                    if (parsed) {                    // null = call failed → keep the previous cast
                        debug(parsed.length ? `LLM parser → ${parsed.join(", ")}` : "LLM parser → (no canon entities present)");
                        lastCast = parsed;           // [] here is REAL info: clears a stale cast
                        lastCastLen = visibleLen;
                        if (parsed.length) {
                            await groundNames(parsed, true);   // trusted: model chose these (may be lore)
                            if (myEpoch !== chatEpoch) return;
                        }
                    }
                }
            }
            // Inject the present-cast (pronoun-proof), reused between gated runs but
            // DECAYED: entities off-screen for more than the scene window drop out.
            cast = pruneStaleCast(visibleLen, scene);
        } else if (lgNames) {
            // Ledger present → its real characters that are on-screen (named in the window).
            const sceneLower = sceneText.toLowerCase();
            cast = lgNames.filter(n => mentioned(n.toLowerCase(), sceneLower));
            if (cast.length) {
                // Ledger names are LLM-curated (the story's REAL cast) — trusted, same as
                // parser picks. The untrusted character-page gate was wrongly dropping
                // valid ledger entities whose pages lack standard infobox fields.
                await groundNames(cast, true);
                if (myEpoch !== chatEpoch) return;
            }
        } else {
            // No parser, no ledger → regex fallback. Grounding of the user's names happens
            // in the shared block below; injection then uses the scene-scan (cast stays null).
        }

        // A name the PLAYER typed always gets looked up, in any mode — the parser's
        // judgment (or the ledger) can miss someone you ask about ("have you seen Mary?").
        // Search those names directly; if they resolve and we're injecting by cast, put
        // them FIRST so they aren't capped out. (Character-gated: only real character pages
        // ground, so a stray capitalized word can't pollute anything.)
        {
            const userNames = extractCandidateNames(lastUserMsg);
            if (userNames.length) {
                await groundNames(userNames);
                if (myEpoch !== chatEpoch) return;
                if (cast) {
                    const groundedUser = [];
                    for (const n of userNames) {
                        const hit = cacheEntryFor(n.toLowerCase());
                        if (hit) groundedUser.push(hit.entry.name);
                    }
                    if (groundedUser.length) cast = [...new Set([...groundedUser, ...cast])];
                }
            }
        }

        // Build the note. Cast-driven when we have one (parser/ledger); scene-scan otherwise.
        // Scene text hasn't changed since the top of the run — reuse it (the old code
        // recomputed sceneMessages a second time for nothing).
        const note = relevantCanonNote(scene, cast);
        lastSource = (cast && cast.length)
            ? (s.llmParser ? `LLM parser cast (${cast.length})` : `ledger cast (${cast.length})`)
            : "scene scan";

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
        // present-cast is up to date for the next turn's injection. Same gate as pre-gen
        // (isUnhandledName — the old raw-key check re-fired on alias-known names and
        // treated EXPIRED negatives as handled forever).
        const sceneText = sceneMessages(ctx, s.contextWindow).join("\n");
        const quick = extractCandidateNames(sceneText);
        const hasNew = s.parserEveryTurn ||
            quick.some(n => isUnhandledName(n) && !parsedWords.has(n.toLowerCase()));
        if (!hasNew) return;
        // NOT guarded by cgInFlight: the old code held that flag for up to 15s here,
        // which made the NEXT user turn's interceptor bail out entirely — a whole
        // generation went out with a stale (previous turn's) canon note. The parser
        // call doesn't route through Generate(), so it can't re-enter the interceptor;
        // stale-result safety is handled by the epoch + serial guards instead.
        const myEpoch = chatEpoch;
        const mySerial = ++parseSerial;
        const visibleLen = chat.filter(m => !m.is_system).length;
        const parsed = await parseSceneCharacters(sceneText);
        if (myEpoch !== chatEpoch) return;      // chat switched while parsing: results belong to the OLD chat
        if (mySerial !== parseSerial) return;   // a newer parse (interceptor/rescan) already superseded us
        for (const n of quick) parsedWords.add(n.toLowerCase());
        if (parsed) {                            // null = failure → keep previous cast
            lastCast = parsed;
            lastCastLen = visibleLen;
            if (parsed.length) await groundNames(parsed, true);
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
    $("#cg_wikis").val(s.wikis); // input handler bound once, further below (keeps chips in sync)
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
    numHandler("#cg_maxchars", "maxCharacters", 1, 8);
    numHandler("#cg_maxper", "maxCharsPerChar", 80, 400);
    numHandler("#cg_maxtotal", "maxTotalChars", 200, 3000);

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

    // Keep the active field and the saved-wiki highlights in sync (single binding).
    $("#cg_wikis").on("input", function () {
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
        lastCastLen = 0;
        renderCacheList();
        toastr?.info?.("Canon cache cleared. Send a message (or 'Scan current scene now') to re-ground.");
    });
    $("#cg_rescan").on("click", async function () {
        const st = settings();
        if (!st.enabled) { toastr?.warning?.("Canon Grounding is disabled."); return; }
        const ctx = getContext();
        const sceneText = sceneMessages(ctx, st.contextWindow).join("\n");
        if (!sceneText.trim()) { toastr?.info?.("No visible scene to scan yet."); return; }
        const myEpoch = chatEpoch;   // switching chats mid-scan must not apply old-chat results
        try {
            if (st.llmParser) {
                toastr?.info?.("Scanning the current scene…");
                const mySerial = ++parseSerial;
                const parsed = await parseSceneCharacters(sceneText);
                if (myEpoch !== chatEpoch) return;
                for (const n of extractCandidateNames(sceneText)) parsedWords.add(n.toLowerCase());
                if (parsed === null) {
                    toastr?.warning?.("Parser call failed or timed out — nothing changed.");
                } else if (mySerial === parseSerial) {
                    lastCast = parsed;
                    lastCastLen = (ctx.chat || []).filter(m => !m.is_system).length;
                    if (parsed.length) {
                        await groundNames(parsed, true);
                        if (myEpoch !== chatEpoch) return;
                        toastr?.success?.(`Grounded: ${parsed.join(", ")}`);
                    } else {
                        toastr?.info?.("Parser says no canon entities are in this scene.");
                    }
                }
            } else {
                const names = extractCandidateNames(sceneText);
                await groundNames(names);
                if (myEpoch !== chatEpoch) return;
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
    // Report how the cast was ACTUALLY chosen last turn — the old code sniffed the
    // ledger live, so it said "ledger cast" even when the parser or scene scan did it.
    const src = lastSource || "name-matching";
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
    // canon injection so it can't bleed into the new chat's first generation. The epoch
    // bump also invalidates any parse/grounding still awaiting for the OLD chat — its
    // results are discarded instead of contaminating the new chat's cast (same failure
    // class as Summaryception's cross-chat contamination bug).
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            chatEpoch++;
            parsedWords = new Set();
            lastCast = [];
            lastCastLen = 0;
            lastInjection = "";
            lastInjectionAt = 0;
            lastMatchReasons = [];
            lastSource = "";
            try { setInjection(""); } catch (e) { /* not critical */ }
            renderLastInjection();
        });
    }
    console.log("[CanonGrounding] loaded.");
});
