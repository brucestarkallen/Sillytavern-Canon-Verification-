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
 *
 * v0.3 — lore depth without rigidity:
 *   - Trivia: "== Trivia ==" bullets (fan-level canon) ground and inject per entity.
 *   - Per-pair DYNAMICS: when A and B share the scene, "With B: …" is sliced from A's
 *     Relationships subsections (or the A/Relationships subpage, fetched once ever) and
 *     injected under A's Personality — the wiki's own record of how A acts around B.
 *   - The note header frames Personality as a public BASELINE that per-pair dynamics
 *     override: facts are authoritative, DELIVERY is situational. This is the fix for
 *     "the wiki says stoic → stoic with everyone" flattening.
 *   - Story position: an arc/chapter page can be grounded and pinned with a spoiler
 *     guard, so the model knows what has happened and never uses what hasn't.
 *   - v0.4 Voice: up to 3 short verbatim quotes (Quotes section, or the X/Quotes
 *     subpage fetched once ever) injected as style samples with anti-parroting
 *     framing — the model hears HOW they talk, not just a description of it.
 *   - v0.5 KNOWLEDGE SCOPE: canon facts are narrator knowledge, not character
 *     knowledge — hidden identities stay hidden. Story position is per-chat
 *     (chat metadata); characters/arcs from one story can't bleed into another.
 *   - v0.6: Identity always injects (the "who she IS" line); LLM-curated
 *     dossiers ✦ replace regex fragments with model judgment (built once, in
 *     the background, cached forever; secrets rendered under the KNOWLEDGE
 *     SCOPE guard); pinned canon — global text, per-chat text, and
 *     always-present characters — is user-authored law above everything.
 *   - v0.7: the parser's same call now returns per-entity "now" focus (what's in
 *     play THIS scene) injected under Identity; disambiguation pages skipped;
 *     dossier restricted to provided material; identity sentence-clipped;
 *     settings drawer regrouped into collapsible sections.
 *   - v0.8: SMART SWEEP — any cached entity named in the recent scene (by the
 *     user OR the AI) injects with no parser round trip; parser budget is a
 *     setting (30s default; 15s starved slow backends and silently killed the
 *     cast); llmCall failures carry a reason and the rescan toast reports it.
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
let castFocus = {};          // name-lc → "what about them is in play NOW" (latest parse)
let castEvidence = {};       // name-lc → the scene words that put them in the cast
let lastCastLen = 0;        // visible-chat length when lastCast was last confirmed (drives decay)
let lastSource = "";        // how the last injection's cast was chosen (for the settings display)
let renderArcStatus = null;  // set by the settings UI; called on CHAT_CHANGED
let renderChatScoped = null; // refreshes per-chat pin fields on CHAT_CHANGED
let chatEpoch = 0;          // bumped on CHAT_CHANGED — async work from an older epoch is discarded
let parseSerial = 0;        // monotonically increasing parse id — only the LATEST parse may apply
const INJECT_KEY = "CANON_GROUNDING";
const CG_VERSION = "0.13.0";

// ---------------------------------------------------------------------------
// DEFAULT SYSTEM INSTRUCTIONS — every prompt this extension sends to a model.
// Visible and editable in the "🧾 System instructions" group; an EMPTY override
// means these defaults apply, so prompt improvements in updates still reach
// everyone who hasn't customized.
const DEFAULT_PROMPT_HEADER =
            "[CANON REFERENCE — retrieved from the official wiki for this series.\n" +
        "FACTS (appearance, relations, history, events) are authoritative: they override " +
        "your own memory and anything else in this prompt that disagrees — use them, do " +
        "not second-guess, 'correct', or invent alternatives.\n" +
        "KNOWLEDGE SCOPE: these facts are for YOUR accuracy as the narrator — they are " +
        "NOT public knowledge inside the story. A character may only know, reveal, or " +
        "react to what THEY could know in-story right now. Hidden identities, secret " +
        "affiliations, and unrevealed connections stay hidden: guard them actively, and " +
        "never let a character's dialogue, thoughts, or behavior betray information " +
        "sourced from this reference.\n" +
        "BEHAVIOR is different: each Personality line is that character's public BASELINE, " +
        "not a script. Real people modulate with company, mood, privacy, and stakes — a " +
        "commander who is stoic on duty can be warm, petty, or openly devoted in private. " +
        "When a 'With <name>' line exists and that person is in the scene, THAT dynamic " +
        "overrides the baseline. Voice lines are STYLE SAMPLES — match their cadence, " +
        "vocabulary, and attitude in fresh dialogue; never repeat the sample lines " +
        "themselves unless the moment canonically calls for it. Never flatten a " +
        "character to their trait words; show the traits through fresh, " +
        "situation-specific behavior, contradictions included.]\n";
const DEFAULT_PROMPT_PARSER =
        "This is a scene from a work of fiction that has published source material with a " +
        "wiki. List the canon entities worth looking up in that wiki so the writer can portray " +
        "them accurately. INCLUDE: (a) characters who are present or acting in the scene; " +
        "(b) characters who are NAMED, referred to, remembered, or asked about even if NOT " +
        "physically present — the writer still needs to know who they are to mention them " +
        "correctly (e.g. someone the player asks 'have you seen X?'); (c) places, organizations, " +
        "groups, or notable lore that are central to what is happening. STRICT EXTRACTION RULE: " +
        "list ONLY entities the scene text itself refers to — by name, alias, title, or a clear " +
        "description ('the school', 'her older sister'). Your series knowledge is ONLY for " +
        "canonicalizing a reference to its proper wiki name — NEVER for adding characters the " +
        "text does not refer to. A famous character who is not referred to in the text is NOT " +
        "in the scene, no matter how likely their presence feels. Leave out generic words, " +
        "everyday objects, and anything invented just for this scene. Never list the " +
        "series/franchise title itself. Ignore names that appear ONLY in out-of-character notes, " +
        "author questions to the player, choice menus, or meta commentary. " +
        "Respond with ONLY a JSON array, most central " +
        "first, or [] if none. Each element is {\"name\": \"Canonical Name\", \"now\": \"under 12 " +
        "words: what about them is in play in THIS scene\", \"evidence\": \"the EXACT words " +
        "from the scene that refer to this entity, copied verbatim\"}. Evidence is mandatory — " +
        "an entity you cannot quote the scene for must not be listed. No other text.";
const DEFAULT_PROMPT_DOSSIER =
        "You curate a compact canon dossier for a roleplay NARRATOR from wiki material. " +
        "Extract only what matters for portraying this character accurately in scenes. " +
        "Return JSON with exactly these keys: " +
        '{"identity": one sentence — who they are (title, role, affiliation); ' +
        '"facts": up to 6 short story-relevant facts a narrator must not get wrong; ' +
        '"secrets": up to 4 things HIDDEN in-story (secret identities, covert affiliations, unrevealed twists) stated plainly; ' +
        '"voice": up to 3 short verbatim quotes if any appear; ' +
        '"dynamics": object mapping up to 5 specific other characters to one line on how this character behaves around THEM; ' +
        '"related": up to 3 canon BACKGROUND entities (their kingdom, order, house, school, organization) essential to understanding them — proper names only}. ' +
        "Use ONLY facts stated in the provided material — if it is not in the text, it does not go in the dossier; never fill gaps from memory. " +
        "Never write meta-statements about the wiki or missing information ('no information is provided', 'the source does not mention…') — omit absent things silently. " +
        "Prefer concrete, unusual, load-bearing detail over generic praise. Empty string/array/object for anything absent. " +
        "Respond with ONLY the JSON object, no other text.";
const DEFAULT_PROMPT_AUDITOR =
        "You are a strict referee for scene-reference claims in fiction. For each entity below, " +
        "decide whether the quoted evidence genuinely REFERS TO that specific entity AND the entity " +
        "is part of, or directly relevant to, the CURRENT scene's events — " +
        "not merely appears near them, and not because the entity plausibly exists in this world. " +
        "Generic phrases ('her classmates', 'the students', 'everyone') refer to no specific entity. " +
        "A name appearing only in a roster, class list, cast enumeration, opening summary, or " +
        "similar catalogue is NOT presence in the scene — answer false for those. " +
        'Respond with ONLY a JSON object mapping each entity name to true or false. No other text.';

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
    // What KIND of canon to ground and inject. v0.3 turns the lore categories ON by
    // default: the old rigidity fear ("personality prose makes the model robotic") is
    // fixed at the source by the baseline-not-script framing + per-pair dynamics below,
    // so knowing the lore no longer costs natural behavior.
    physical: true,       // appearance: hair, eyes, look
    personality: true,    // temperament — injected as a BASELINE, not a script
    relationship: true,   // family and key connections (helps correct invented parents)
    biography: true,      // infobox bio + history — identity covers the lead separately
    abilities: false,     // powers, skills, weapons
    trivia: true,         // "== Trivia ==" bullets — dense fan-level canon facts
    triviaKeywords: "trivia",
    // Voice samples: short verbatim quotes from the wiki's Quotes section (or the
    // X/Quotes subpage). A personality line DESCRIBES the voice; three real lines
    // SHOW cadence, diction, and attitude — the strongest cheap anchor against
    // cross-character voice convergence. Injected with anti-parroting framing.
    voice: true,
    quoteKeywords: "quotes,notable quotes,memorable quotes",
    // Per-PAIR relationship dynamics: when two grounded characters share the scene,
    // inject how A acts around B specifically ("With Cid: …"), from the Relationships
    // subsections of A's page (or the "A/Relationships" subpage). This is the fix for
    // "the wiki says stoic, so she's stoic with everyone" — the wiki itself documents
    // the exceptions, per person; we surface exactly the pair that's on screen.
    relationDynamics: true,
    // Story position: a grounded arc/chapter page pinned into the note, with a spoiler
    // guard so later canon events stay unknown to every character.
    arcTitle: "",
    arcNote: null,        // { query, title, wiki, summary, ts }
    arcInject: true,
    // Parser/dossier time budget. 15s was too tight for slower backends (GLM on
    // mobile): a blown budget silently kills the cast, and everything downstream
    // looks "not smart". Raise further if you still see timeouts.
    parserBudgetMs: 30000,
    // The Cast Auditor: a dedicated referee call that judges weak evidence — does
    // this quote actually REFER to this entity? Fires only when weak items exist.
    castAuditor: true,
    // Names typed in lowercase ("rose oriana walks in") still open the parser gate:
    // a pair of adjacent never-seen tokens is treated as a possible name and the
    // parser + evidence + auditor decide the truth. Learned tokens gate only once.
    lowercaseNames: true,
    // Smarter AI 🧠: injecting a character also injects their essential BACKGROUND
    // entities (kingdom, order, house, organization) as one-line Context entries —
    // Rose Oriana without the Oriana Kingdom is half a character. OFF = strict:
    // only what the scene itself earns.
    smartExpansion: true,
    // System-instruction overrides — empty means the built-in default applies
    // (shown in the 🧾 group), so prompt improvements in updates still land.
    promptParser: "",
    promptDossier: "",
    promptAuditor: "",
    promptHeader: "",
    // LLM-curated dossiers: the model reads each grounded page once (background,
    // cached forever) and writes the injection itself — identity, load-bearing
    // facts, secrets-as-secrets, voice, per-person dynamics. Regex sections stay
    // as the immediate/fallback path.
    llmDossier: true,
    // Pinned canon: user-authored text injected in EVERY chat, always.
    pinnedGlobal: "",
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
    if (!st.migrated_v3) {
        // v0.3 is the "make the AI actually know the lore" release: personality and
        // relationships go ON (the rigidity they used to cause is solved by framing +
        // per-pair dynamics, not by hiding the lore), and the caps grow so the richer
        // note isn't truncated mid-category. Numeric bumps only touch untouched defaults.
        st.personality = true;
        st.relationship = true;
        if (st.maxCharsPerChar === 400) st.maxCharsPerChar = 700;
        if (st.maxTotalChars === 3000) st.maxTotalChars = 4500;
        st.migrated_v3 = true;
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
/** Drop everything inside {{ … }} at any nesting, stray braces included. */
function stripTemplates(text) {
    let out = "";
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "{" && text[i + 1] === "{") { depth++; i++; continue; }
        if (text[i] === "}" && text[i + 1] === "}") { if (depth > 0) { depth--; i++; continue; } i++; continue; }
        if (depth === 0) out += text[i];
    }
    return out;
}

function cleanWikitext(wt) {
    if (!wt) return "";
    let s = wt;
    // Media links FIRST — [[File:x.png|thumb|Caption]] must vanish whole, or the
    // generic link rule below leaks its parameters ("thumb|Caption") into the text.
    s = s.replace(/\[\[(?:File|Image|Media):[^\]]*\]\]/gi, "");
    // Convert links to their text BEFORE removing templates, so names inside list
    // templates (e.g. a Relatives field) survive.
    s = s.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1");
    s = s.replace(/<br\s*\/?>/gi, ", ");
    // Keep the content of common list templates instead of deleting them.
    s = s.replace(/\{\{\s*(?:plainlist|unbulleted list|ubl|flatlist|hlist|bulleted list|cslist)\s*\|([\s\S]*?)\}\}/gi, "$1");
    // An infobox VALUE often ends at the "\n}}" terminator, beheading its list
    // template's close — the opener then dangles and the depth walker below would
    // drop the names inside to end-of-input. Strip dangling LIST openers so their
    // content survives; any other unclosed template is junk and SHOULD drop.
    s = s.replace(/\{\{\s*(?:plainlist|unbulleted list|ubl|flatlist|hlist|bulleted list|cslist)\s*\|/gi, "");
    // Remove remaining templates with a real DEPTH WALKER. The old regex loop
    // could never match an outer template whose body held a stray brace (the
    // {{{param|}}} triple-brace pattern in big infoboxes like Classroom of the
    // Elite's {{Character/Y3 …}}) — the naked infobox body then flowed straight
    // into "Identity" as |LNImageY1 = |… junk. Depth counting is immune: while
    // inside any {{ … }}, characters are dropped; a template left unclosed drops
    // to end-of-input (better no text than raw markup).
    s = stripTemplates(s);
    s = s.replace(/[{}]{2,}/g, " ");
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
        // Big wikis version their fields per school year / season: Y1occupation,
        // Y2affiliation, status2… Normalize the LABEL (strip year prefixes and
        // trailing counters) and dedupe on it — one clean "occupation: Student"
        // instead of a Y1/Y2/Y3 parade of the same value.
        const label = rawKey.replace(/^[YySs]\d+\s*/, "").replace(/\d+$/, "").trim() || rawKey;
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
        if (!val || seen.has(label.toLowerCase())) continue;
        if (/^\d+\s*px$/i.test(val) || /\.(png|jpe?g|gif|webp|svg)$/i.test(val) || /^\d+$/.test(val)) continue;
        seen.add(label.toLowerCase());
        out.push(`${label}: ${val}`);
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

/**
 * RAW (uncleaned) body of a section — keeps ===Subsection=== headers and paragraph
 * breaks intact, so per-pair relationship slicing can find "=== Cid Kagenou ===".
 */
function extractSectionRaw(wikitext, titles, maxLen = 4000) {
    if (!wikitext) return "";
    const chunks = wikitext.split(/\n(?==={1,4}[^=])/);
    const want = titles.map(t => t.toLowerCase());
    for (let ci = 0; ci < chunks.length; ci++) {
        const m = chunks[ci].match(/^(=+)\s*(.+?)\s*=+[^\n]*\n([\s\S]*)$/);
        if (!m) continue;
        const title = m[2].trim().toLowerCase();
        if (!want.some(w => title === w || title.includes(w))) continue;
        // The split cuts at EVERY header, so deeper subsections (=== X ===) landed in
        // LATER chunks — re-attach every following chunk whose header is DEEPER than
        // this one, so the returned body contains the whole subtree. Positional index
        // (not indexOf) so a duplicate chunk text elsewhere can't misanchor the walk.
        const depth = m[1].length;
        let body = m[3];
        for (let i = ci + 1; i < chunks.length; i++) {
            const hm = chunks[i].match(/^(=+)\s*.+?\s*=+[^\n]*\n/);
            if (!hm || hm[1].length <= depth) break;
            body += "\n" + chunks[i];
            if (body.length >= maxLen) break;
        }
        return body.slice(0, maxLen);
    }
    return "";
}

/**
 * "== Trivia ==" bullets: dense fan-level canon (habits, quirks, hidden facts) that
 * humanizes a character beyond the formal sections. First N usable bullets, cleaned.
 */
function extractTrivia(wikitext, titles, maxBullets = 6, maxLen = 700) {
    const raw = extractSectionRaw(wikitext, titles, 6000);
    if (!raw) return "";
    const out = [];
    let total = 0;
    // "\n" prefix: a body that STARTS with "*" must not lose its first bullet to
    // slice(1) — slice only drops the pre-bullet intro text.
    for (const line of ("\n" + raw).split(/\n\*+\s*/).slice(1)) {
        const item = cleanWikitext(line.split("\n")[0]).trim();
        if (item.length < 10 || out.includes(item)) continue;
        if (total + item.length > maxLen) break;
        out.push(item);
        total += item.length;
        if (out.length >= maxBullets) break;
    }
    return out.join("; ");
}

/**
 * Voice samples from a Quotes section (or a whole /Quotes subpage body).
 * Handles both Fandom layouts:
 *   * "Line." — context bullets
 *   {{Quote|Line.|speaker|context}} templates (first param is the line — lifted
 *   BEFORE cleaning, because cleanWikitext deletes unknown templates wholesale).
 * Short lines only: voice anchoring saturates fast, and a monologue teaches less
 * per token than three punchy lines. Attribution tails ("— to Cid, ch. 12") are cut.
 */
function extractQuotes(sectionRaw, maxQuotes = 3, maxLen = 420) {
    if (!sectionRaw) return "";
    const found = [];  // { text, cutTail } — tails ("— to Cid, ch. 12") only exist on UNQUOTED lines
    const tpl = /\{\{\s*(?:c?quote[dh]?|quotation|dialogue)\s*\|([^|{}]+)/gi;
    let m;
    while ((m = tpl.exec(sectionRaw)) !== null) {
        // Named first params ({{Quote|quote=…}}, {{Quote|1=…}}) carry a key= prefix.
        found.push({ text: m[1].replace(/^\s*[a-zA-Z0-9 _]+=\s*/, ""), cutTail: false });
    }
    for (const line of ("\n" + sectionRaw).split(/\n\*+\s*/).slice(1)) {
        const first = line.split("\n")[0];
        const q = first.match(/["“]([^"”]{4,})["”]/);
        // Inside quotation marks the attribution tail is already excluded; a dash in
        // there is CONTENT ("Half - broken - but alive.") and must survive. Only the
        // unquoted fallback gets the "— context" tail cut.
        found.push(q ? { text: q[1], cutTail: false } : { text: first, cutTail: true });
    }
    const out = [];
    let total = 0;
    for (const { text, cutTail } of found) {
        let q = cleanWikitext(text).replace(/^["“'\s]+|["”'\s]+$/g, "");
        if (cutTail) q = q.split(/\s+[—–-]\s+/)[0].trim();
        if (q.length < 4 || q.length > 160) continue;  // voice samples, not monologues
        if (out.some(o => o.toLowerCase() === q.toLowerCase())) continue;
        if (total + q.length > maxLen) break;
        out.push(q);
        total += q.length;
        if (out.length >= maxQuotes) break;
    }
    return out.map(q => `"${q}"`).join(" / ");
}

/** Lead (intro) paragraph of the article, before the first section header. */
/**
 * The identity line: the lead, cut at a SENTENCE boundary (≤300) instead of
 * mid-clause — "…is the second princess of the Oriana Kingdom." not "…of the Ori…".
 */
function identityLine(wikitext) {
    const lead = extractLead(wikitext, 340);
    if (!lead) return "";
    // If markup still leaked (exotic template dialects), an identity that looks
    // like "Name/ |Param = |Param2 =" is worse than none — the dossier identity
    // or the model's own knowledge covers better than raw junk.
    if (/\|\s*[A-Za-z0-9_]+\s*=/.test(lead) || /^[\w/'-]+\s*\|/.test(lead)) return "";
    if (lead.length <= 300) return lead;
    const cut = lead.slice(0, 300);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "),
                          cut.endsWith(".") ? cut.length - 1 : -1);
    return stop >= 80 ? cut.slice(0, stop + 1) : clip(lead, 300);
}

/**
 * The series' own page ("…is a light novel series written by…") is meta, not
 * canon — injecting it tells the model about the FRANCHISE, not the world.
 */
function isMetaSeriesPage(wikitext) {
    const lead = extractLead(wikitext, 500);
    return /\bis an?\s+(?:japanese\s+)?(?:light novel|web novel|manga|anime|novel|visual novel|video game|television|tv)\s+(?:series|franchise)\b/i.test(lead);
}

/** A disambiguation page injected as canon is pure wrong-info — detect and skip. */
function isDisambiguation(wikitext) {
    if (!wikitext) return false;
    if (/\{\{\s*(?:disambig|disambiguation|dab|hndis|geodis)[^}]*\}\}/i.test(wikitext.slice(0, 2000))) return true;
    return /\bmay (?:also )?refer to\s*:/i.test(extractLead(wikitext, 200));
}

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
                // Identity is the single highest-value string on any wiki page — the
                // "X is the second princess of …" lead sentence. It was gated behind
                // the off-by-default biography category, which is exactly how a model
                // ends up knowing a character's hair color but not WHO SHE IS.
                // Always extracted, always injected (≤260 chars).
                identity: identityLine(wikitext),
                physical,
                personality: join(
                    extractInfoboxFields(wikitext, perKw),
                    extractSection(wikitext, perKw, 500)
                ),
                relationship: join(
                    extractInfoboxFields(wikitext, relKw),
                    extractSection(wikitext, relKw, 500)
                ),
                // Biography = infobox bio fields + history section. The lead moved to
                // the always-on identity category above (no duplication when both show).
                biography: join(
                    extractInfoboxFields(wikitext, bioKw),
                    extractSection(wikitext, bioKw, 400)
                ),
                abilities: join(
                    extractInfoboxFields(wikitext, abiKw),
                    extractSection(wikitext, abiKw, 300)
                ),
                // Fan-level canon: quirks, habits, hidden facts. Often the ONLY place the
                // wiki records the humanizing detail ("secretly practices X", "only smiles
                // around Y") that keeps a character from reading as their job title.
                trivia: extractTrivia(wikitext, s.triviaKeywords.split(",").map(t => t.trim()).filter(Boolean)),
                // Voice: verbatim lines from the Quotes section — how they actually talk.
                voice: extractQuotes(extractSectionRaw(wikitext, s.quoteKeywords.split(",").map(t => t.trim()).filter(Boolean), 6000)),
            };

            // Many wikis keep quotes on a dedicated "X/Quotes" subpage instead of a
            // section. One extra fetch, at ground time, only when the main page had
            // none — cached forever on the entry like everything else. Gated on the
            // CHARACTER signal: places/organizations (trusted lore) don't get quote
            // subpages, so probing them is a guaranteed dead round trip.
            if (s.voice && !sections.voice && (charSignal || charSection)) {
                try {
                    const qp = await fetchWikitext(wiki, `${title}/Quotes`);
                    if (qp) sections.voice = extractQuotes(qp);
                } catch (e) { /* best-effort */ }
            }

            const anything = Object.values(sections).some(Boolean);
            if (anything) {
                // Remember the character's other names (nickname/alias fields) plus the
                // term we searched with, so any of them match this entry later.
                const aliases = extractAliases(wikitext, s.aliasKeywords.split(","));
                if (name && name.toLowerCase() !== title.toLowerCase()) aliases.push(name);
                // Raw material for per-pair dynamics: the whole Relationships subtree,
                // subsection headers intact, so relationFor can slice "how A is with B"
                // at note time for exactly the pair that's on screen.
                const relRaw = extractSectionRaw(wikitext, ["relationships", "relationship"], 4000);
                const kind = (charSignal || charSection) ? "character" : "place";
                s.cache[key] = { name: title, sections, aliases, relRaw, rel: {}, wiki, kind, found: true, ts: Date.now() };
                // LLM curation runs in the BACKGROUND — this turn ships the regex
                // sections immediately, the dossier upgrades every turn after.
                if (s.llmDossier && (charSignal || charSection)) scheduleDossier(key, title, wikitext, relRaw);
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

/**
 * Per-PAIR dynamics: for every ordered pair (A, B) of grounded characters on screen,
 * resolve "how A is around B" once and cache it forever at A.rel[bKey].
 * Sources, in order: the Relationships subtree already on A's page (free), then the
 * "A/Relationships" subpage (one fetch per character, ever — capped per turn).
 * An empty string is a real, cached answer ("no documented dynamic"), so settled
 * pairs cost nothing on later turns.
 */
async function resolveRelations(entries) {
    const s = settings();
    if (!s.relationDynamics) return;
    const found = (entries || []).filter(e => e && e.found);
    let fetchBudget = 3; // first-time subpage fetches per turn; the cache absorbs the rest
    for (const a of found) {
        if (!a.rel) a.rel = {};
        for (const b of found) {
            if (a === b || (a.name || "").toLowerCase() === (b.name || "").toLowerCase()) continue;
            const bKey = (b.name || "").toLowerCase();
            if (!bKey || a.rel[bKey] !== undefined) continue;      // already resolved (even to "")
            const bNames = [b.name, ...(b.aliases || [])].filter(Boolean);
            let snip = relationFor(a.relRaw, bNames);
            if (!snip && a.wiki) {
                // Many wikis keep dynamics on a dedicated subpage. Fetch it AT MOST once
                // per character, ever; a missing page parses to "" and is remembered.
                if (a.relPageRaw === undefined && fetchBudget > 0) {
                    fetchBudget--;
                    try {
                        a.relPageRaw = (await fetchWikitext(a.wiki, `${a.name}/Relationships`)).slice(0, 8000);
                    } catch (e) {
                        a.relPageRaw = "";
                        debug(`rel subpage fetch failed for ${a.name}: ${e.message}`);
                    }
                }
                if (a.relPageRaw) snip = relationFor(a.relPageRaw, bNames);
            }
            if (snip) { a.rel[bKey] = snip; continue; }
            // "" (no documented dynamic) is only FINAL once the subpage has actually been
            // consulted — or there's no wiki to consult. If the per-turn fetch budget ran
            // out first, leave the pair unresolved so a later turn can still try it.
            if (!a.wiki || a.relPageRaw !== undefined) a.rel[bKey] = "";
        }
    }
    saveSettingsDebounced();
}

/**
 * Ground a story ARC / CHAPTER / EPISODE page and pin its summary as the current
 * story position. Character lookups reject these titles on purpose (isMediaTitle);
 * here they are the point, so this path does its own exact-then-search resolution.
 */
/**
 * Smarter AI 🧠: ground each present character's essential background entities
 * (from their dossier's "related") so the note can carry one-line Context —
 * cached once like everything else; capped per turn so a big cast can't stampede.
 */
async function resolveRelated(entries) {
    const s = settings();
    if (!s.smartExpansion) return;
    const wanted = [];
    for (const e of entries || []) {
        for (const r of (e && e.dossier && e.dossier.related) || []) {
            if (wanted.length >= 4) break;
            if (!cacheEntryFor(String(r).toLowerCase())) wanted.push(r);
        }
    }
    if (wanted.length) await groundNames(wanted, true);
}

async function groundArc(query) {
    const s = settings();
    const wikis = s.wikis.split(",").map(w => w.trim()).filter(Boolean);
    const structural = /\b(arc|saga|chapter|episode|season|volume|part)\b/i;
    for (const wiki of wikis) {
        try {
            let exact = null;
            try {
                const cap = query.replace(/\S+/g, w => w[0].toUpperCase() + w.slice(1));
                const r = await fetch(`${apiBase(wiki)}?action=query&titles=${encodeURIComponent(cap)}&redirects=1&format=json&origin=*`);
                if (r.ok) {
                    const p = Object.values((await r.json())?.query?.pages || {})[0];
                    if (p && p.pageid && !("missing" in p)) exact = p.title;
                }
            } catch (e) { /* fall through to search */ }
            let title = exact;
            // An exact hit that doesn't LOOK like a story unit ("Alpha" → her character
            // page) must yield to a structural search result ("Alpha Arc") — otherwise a
            // character page becomes the pinned "story position". A structural exact hit
            // skips the search entirely.
            if (!exact || !structural.test(exact)) {
                const res = await fetch(`${apiBase(wiki)}?action=query&list=search&srlimit=8&format=json&origin=*&srsearch=${encodeURIComponent(query)}`);
                if (res.ok) {
                    const hits = ((await res.json())?.query?.search || []).map(h => h.title);
                    const best = pickArcHit(hits, query);
                    if (best && structural.test(best)) title = best;
                    else if (!title) title = best;
                }
            }
            if (!title) continue;
            const wikitext = await fetchWikitext(wiki, title);
            const summary = extractSection(wikitext, ["summary", "plot", "synopsis", "overview", "story", "events"], 900)
                || extractLead(wikitext, 900);
            if (!summary) continue;
            const note = { query, title, wiki, summary, ts: Date.now() };
            setChatArc(note);
            s.arcTitle = query;               // remembered globally as input convenience only
            saveSettingsDebounced();
            debug(`✓ story position → ${title} (${wiki})`);
            return note;
        } catch (e) {
            debug(`arc ground error on ${wiki}: ${e.message}`);
        }
    }
    return null;
}

/** Prefer story-structure titles (Arc/Chapter/Episode/…) over character/subpage hits. */
function pickArcHit(titles, query) {
    const q = String(query || "").toLowerCase();
    const structural = /\b(arc|saga|chapter|episode|season|volume|part)\b/i;
    return titles.find(t => t.toLowerCase() === q)
        || titles.find(t => structural.test(t) && !t.includes("/"))
        || titles.find(t => !t.includes("/"))
        || null;
}

/**
 * Story position is PER-CHAT state (a pinned Eminence arc must not bleed into a
 * Roshidere chat), stored in chat metadata. settings().arcNote remains as a legacy
 * fallback for pre-v0.5 pins and for very old ST builds without chat metadata.
 */
function chatArc() {
    try {
        const md = getContext().chatMetadata;
        if (md && md.canon_grounding_arc !== undefined) return md.canon_grounding_arc;
    } catch (e) { /* no context yet */ }
    return settings().arcNote;
}
function chatPin() {
    try { return getContext().chatMetadata?.canon_grounding_pin || ""; } catch (e) { return ""; }
}
function chatSettingKey() {
    try { return getContext().chatMetadata?.canon_grounding_setting || ""; } catch (e) { return ""; }
}
function chatBlockNames() {
    try {
        const raw = getContext().chatMetadata?.canon_grounding_block || "";
        return String(raw).split(",").map(n => n.trim()).filter(Boolean);
    } catch (e) { return []; }
}
function chatPinNames() {
    try {
        const raw = getContext().chatMetadata?.canon_grounding_pin_names || "";
        return String(raw).split(",").map(n => n.trim()).filter(Boolean);
    } catch (e) { return []; }
}
function setChatPin(field, value) {
    try {
        const ctx = getContext();
        if (!ctx.chatMetadata) return;
        ctx.chatMetadata[field] = value;
        if (typeof ctx.saveMetadata === "function") ctx.saveMetadata();
    } catch (e) { /* no chat loaded */ }
}

function setChatArc(note) {
    try {
        const ctx = getContext();
        if (ctx.chatMetadata) {
            ctx.chatMetadata.canon_grounding_arc = note;
            if (typeof ctx.saveMetadata === "function") ctx.saveMetadata();
            if (note === null) settings().arcNote = null; // clear wipes the legacy pin too
            return;
        }
    } catch (e) { /* fall back to global */ }
    settings().arcNote = note;
    saveSettingsDebounced();
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
    const markers = ["[Story memory", "[AUTHORITATIVE SOURCE CANON", "[CANON REFERENCE", "[Canonical reference", "[Plot essential"];
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
    let base = str.slice(0, max).replace(/\s+\S*$/, "");
    // A single boundary-free token trims nothing — make room for the ellipsis so the
    // contract holds: output length NEVER exceeds max.
    if (base.length >= max) base = base.slice(0, max - 1);
    return base + "…";
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

/**
 * How this character relates to ONE specific other character, sliced from a
 * Relationships section body (raw wikitext, subsection headers intact).
 * Priority: a "=== Other Name ===" subsection matching any of the other's
 * names/aliases; else the first paragraph that mentions them. Returns "" on miss.
 */
function relationFor(relWikitext, otherNames, maxLen = 350) {
    if (!relWikitext || !otherNames || !otherNames.length) return "";
    const wants = otherNames.map(n => String(n).toLowerCase()).filter(Boolean);
    // 1) Subsection headed with the other character's name (the common Fandom layout).
    for (const chunk of relWikitext.split(/\n(?==={1,4}[^=])/)) {
        const m = chunk.match(/^=+\s*(.+?)\s*=+[^\n]*\n([\s\S]*)$/);
        if (!m) continue;
        const title = m[1].trim().toLowerCase();
        if (wants.some(w => title === w || title.includes(w) || w.includes(title))) {
            const body = cleanWikitext(m[2].split(/\n=={1,4}[^=]/)[0]);
            if (body) return clip(body, maxLen);
        }
    }
    // 2) No subsection — the first PARAGRAPH that names them. Split the RAW text
    //    (cleanWikitext collapses all whitespace, so splitting after cleaning made
    //    the whole section one "paragraph" and always returned its opening lines
    //    regardless of where the mention actually sat).
    for (const rawPara of relWikitext.split(/\n{2,}/)) {
        const para = cleanWikitext(rawPara);
        if (!para) continue;
        const lower = para.toLowerCase();
        if (wants.some(w => mentioned(w, lower))) return clip(para.trim(), maxLen);
    }
    return "";
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
function relevantCanonNote(sceneMsgs, castNames, arc = undefined, extras = {}) {
    const s = settings();
    const msgs = sceneMsgs || [];
    const lowerMsgs = msgs.map(m => m.toLowerCase());
    const pinNames = (extras.pinNames || []).filter(Boolean);
    // Force-OUT by decree: any entity whose name/alias matches the blocklist never
    // injects — whatever brought it in (parser, sweep, even a conflicting pin; the
    // block is the later, sharper instruction). The cache keeps the entry; only
    // injection is forbidden.
    const blockSet = new Set((extras.blockNames || []).map(n => String(n).trim().toLowerCase()).filter(Boolean));
    const isBlocked = (entry, matched) => {
        if (!blockSet.size) return false;
        const names = [entry.name, matched, ...(entry.aliases || [])].filter(Boolean).map(n => String(n).toLowerCase());
        return names.some(n => blockSet.has(n));
    };
    const labels = {
        physical: "Appearance",
        relationship: "Relationships",
        personality: "Personality",
        voice: "Voice",
        biography: "Background",
        abilities: "Powers & Abilities",
        trivia: "Trivia",
    };
    // Order matters: lean, high-value facts first so they survive the per-character cap;
    // verbose biography/abilities are trimmed first when space runs out. Trivia rides
    // last — flavor, not identity — but per-pair dynamics are spliced in right after
    // Personality (they're the anti-flattening payload, worth protecting), and Voice
    // samples follow them: baseline → dynamic → how it actually sounds.
    const order = ["physical", "relationship", "personality", "voice", "biography", "abilities", "trivia"];

    const present = [];  // { entry, matchedName }
    const usedKeysGlobal = new Set();
    // Pinned entities ride FIRST, always — no cast, no mention, no scene required.
    for (const pn of pinNames) {
        const found = cacheEntryFor(pn.toLowerCase());
        if (found && !usedKeysGlobal.has(found.key)) {
            usedKeysGlobal.add(found.key);
            present.push({ entry: found.entry, matchedName: pn, pinned: true });
        }
    }
    // CURRENT SETTING: the location the story is in persists WITHOUT mention — it
    // is where the scene happens, not something the prose must keep naming. Set by
    // the parser whenever a place enters the cast; superseded by the next place;
    // removable via the blocklist.
    if (extras.settingKey && s.cache[extras.settingKey] && !usedKeysGlobal.has(extras.settingKey)) {
        usedKeysGlobal.add(extras.settingKey);
        present.push({ entry: s.cache[extras.settingKey], matchedName: s.cache[extras.settingKey].name, setting: true });
    }

    if (castNames && castNames.length) {
        // Cast-driven: inject the entities identified as present, in centrality order.
        // The parser's judgment STANDS — it exists to catch entities the prose
        // references indirectly ("the school" → Advanced Nurturing High School), so
        // no literal-mention filter is applied here (v0.9.1 tried; it destroyed
        // exactly that value). Wrong entries are removed by decree via the
        // "Never inject" blocklist, not by string heuristics.
        for (const cn of castNames) {
            const found = cacheEntryFor(cn.toLowerCase());
            if (found && !usedKeysGlobal.has(found.key)) {
                usedKeysGlobal.add(found.key);
                present.push({ entry: found.entry, matchedName: cn });
            }
        }
        // SMART SWEEP: the parser's cast is pronoun-proof but gated — it can lag the
        // story (or be down entirely). Any entity we ALREADY KNOW (cached) that is
        // named in the recent scene — including by the AI's own output — injects
        // immediately, no parser round trip required. The AI saying "Alpha" is all
        // the evidence needed: she's cached.
        for (const key of Object.keys(s.cache)) {
            const entry = s.cache[key];
            if (!entry.found || !entry.sections || usedKeysGlobal.has(key)) continue;
            if (usedKeysGlobal.has((entry.name || "").toLowerCase())) continue;
            const names = [entry.name.toLowerCase(), key, ...(entry.aliases || []).map(a => a.toLowerCase())].filter(Boolean);
            let hit = "";
            for (let i = lowerMsgs.length - 1; i >= 0 && !hit; i--) hit = names.find(n => mentioned(n, lowerMsgs[i])) || "";
            if (hit) {
                usedKeysGlobal.add(key);
                present.push({ entry, matchedName: hit, swept: true });
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
            if (lastIdx >= 0) scored.push({ entry, lastIdx, matchedName, key });
        }
        scored.sort((a, b) => b.lastIdx - a.lastIdx);  // most recently mentioned first
        for (const sc of scored) {
            if (usedKeysGlobal.has(sc.key)) continue;
            usedKeysGlobal.add(sc.key);
            present.push({ entry: sc.entry, matchedName: sc.matchedName });
        }
    }

    const blocks = [];
    const reasons = [];
    const seenEntities = new Set();  // one block per CHARACTER, even if cached under two keys
    let total = 0;
    for (const { entry, matchedName, pinned, swept, setting } of present) {
        if (blocks.length >= s.maxCharacters) break;
        if (isBlocked(entry, matchedName)) continue;
        const nameKey = (entry.name || "").toLowerCase();
        if (seenEntities.has(nameKey)) continue;
        const lines = [];
        const dynLines = () => {
            // Per-pair dynamics: "the baseline says stoic, but with THIS person on
            // screen, canon says she is like THIS." Wiki-sliced pairs first (exact),
            // then dossier dynamics for co-present others the slicer had nothing on.
            const out = [];
            if (!s.relationDynamics) return out;
            const covered = new Set();
            for (const { entry: other } of present) {
                if (out.length >= 3 || other === entry) continue;
                const okey = (other.name || "").toLowerCase();
                const snip = entry.rel && entry.rel[okey];
                if (snip) { out.push(`  - With ${other.name}: ${snip}`); covered.add(okey); }
            }
            if (entry.dossier && entry.dossier.dynamics) {
                for (const { entry: other } of present) {
                    if (out.length >= 3 || other === entry) continue;
                    const okey = (other.name || "").toLowerCase();
                    if (covered.has(okey)) continue;
                    const hit = Object.entries(entry.dossier.dynamics)
                        .find(([who]) => {
                            const w = who.toLowerCase();
                            return w === okey || okey.includes(w) || w.includes(okey)
                                || (other.aliases || []).some(a => a.toLowerCase() === w);
                        });
                    if (hit) out.push(`  - With ${other.name}: ${hit[1]}`);
                }
            }
            return out;
        };
        const focusLine = () => {
            const keys = [nameKey, (matchedName || "").toLowerCase(), ...(entry.aliases || []).map(a => a.toLowerCase())];
            for (const k of keys) if (k && castFocus[k]) return `  - Now: ${castFocus[k]}`;
            return "";
        };
        if (entry.dossier) {
            // LLM-curated path: the model read the page and chose what matters.
            const d = entry.dossier;
            const identity = d.identity || entry.sections.identity;
            if (identity) lines.push(`  - Identity: ${identity}`);
            const nf = focusLine(); if (nf) lines.push(nf);
            if (s.physical && entry.sections.physical) lines.push(`  - Appearance: ${entry.sections.physical}`);
            const idLc = (identity || "").toLowerCase();
            const facts = d.facts.filter(f => !idLc.includes(f.toLowerCase().replace(/[.?!]$/, "")));
            if (facts.length) lines.push(`  - Facts: ${facts.join("; ")}`);
            lines.push(...dynLines());
            const voice = (s.voice && (d.voice.length ? d.voice.map(q => `"${q}"`).join(" / ") : entry.sections.voice)) || "";
            if (voice) lines.push(`  - Voice: ${voice}`);
            if (s.smartExpansion && d.related && d.related.length) {
                let ctx = 0;
                for (const rn of d.related) {
                    if (ctx >= 2) break;
                    const rHit = cacheEntryFor(String(rn).toLowerCase());
                    if (!rHit || isBlocked(rHit.entry, rn)) continue;
                    const rid = (rHit.entry.dossier && rHit.entry.dossier.identity) || rHit.entry.sections.identity;
                    if (rid) { lines.push(`  - Context: ${rHit.entry.name} — ${clip(rid, 150)}`); ctx++; }
                }
            }
            if (d.secrets.length) lines.push(`  - Secret (unrevealed in-story — guard per KNOWLEDGE SCOPE): ${d.secrets.join("; ")}`);
        } else {
            // Regex-section fallback. Identity is ALWAYS on — a model that knows the
            // hair color but not WHO SHE IS was the original sin here.
            if (entry.sections.identity) lines.push(`  - Identity: ${entry.sections.identity}`);
            const nf = focusLine(); if (nf) lines.push(nf);
            for (const cat of order) {
                if (s[cat] && entry.sections[cat]) lines.push(`  - ${labels[cat]}: ${entry.sections[cat]}`);
                if (cat === "personality") lines.push(...dynLines());
            }
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
        const ev = castEvidence[(entry.name || "").toLowerCase()] || castEvidence[(matchedName || "").toLowerCase()];
        reasons.push(`${entry.name} ← ${setting ? "current setting (persists without mention)" : pinned ? "pinned" : swept ? `named in scene (as "${matchedName}") — no parser needed` : (matchedName && matchedName.toLowerCase() !== entry.name.toLowerCase() ? `present (as "${matchedName}")` : "present in scene")}${ev ? ` — evidence: "${clip(ev, 60)}"` : ""}${entry.dossier ? " ✦" : ""}`);
    }
    lastMatchReasons = reasons;

    // Story position rides on top of the note: what has ALREADY happened (continuity
    // anchor) plus a spoiler guard so later canon can't leak into anyone's head.
    let arcBlock = "";
    const arcNote = (arc !== undefined) ? arc : s.arcNote;
    if (s.arcInject && arcNote && arcNote.summary) {
        arcBlock =
            `STORY POSITION — ${arcNote.title}: ${arcNote.summary}\n` +
            `(Only events up to this point have occurred. Later canon events, reveals, and ` +
            `identities are unknown to every character — never foreshadow or use them.)\n`;
        reasons.push(`story position ← ${arcNote.title}`);
    }

    let pinBlock = "";
    const pinTexts = [extras.globalPin, extras.chatPin].map(t => (t || "").trim()).filter(Boolean);
    if (pinTexts.length) {
        pinBlock = `PINNED CANON (user-authored — absolute, always in effect):\n${pinTexts.join("\n")}\n`;
        reasons.push("pinned canon text");
    }

    if (!blocks.length && !arcBlock && !pinBlock) return "";
    return (
        ((settings().promptHeader || "").trim() || DEFAULT_PROMPT_HEADER) +
        pinBlock + arcBlock + blocks.join("\n")
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
/**
 * Defensive parse of the dossier JSON. Strips code fences, tolerates chatter around
 * the object, clips every field to budget, coerces near-miss shapes. Returns null
 * when nothing usable came back (transport failure, refusal, garbage) — the regex
 * sections stay in charge, same null-vs-empty discipline as the cast parser.
 */
function parseDossier(text) {
    if (!text) return null;
    const obj = parseJsonCandidates(text, "{", "}", v => v && typeof v === "object" && !Array.isArray(v));
    if (!obj) return null;
    const str = (v, n) => (typeof v === "string" ? clip(v.trim(), n) : "");
    const arr = (v, count, n) => (Array.isArray(v) ? v : (typeof v === "string" && v ? [v] : []))
        .map(x => str(x, n)).filter(Boolean).slice(0, count);
    const META_FACT = /source material|\bno (?:further |other )?(?:information|details?)\b|not (?:specified|provided|mentioned|stated|given)\b/i;
    const d = {
        identity: str(obj.identity, 300),
        facts: arr(obj.facts, 6, 200).filter(f => !META_FACT.test(f)),
        secrets: arr(obj.secrets, 4, 200).filter(f => !META_FACT.test(f)),
        voice: arr(obj.voice, 3, 160),
        related: arr(obj.related, 3, 60),
        dynamics: {},
    };
    if (obj.dynamics && typeof obj.dynamics === "object" && !Array.isArray(obj.dynamics)) {
        for (const [k, v] of Object.entries(obj.dynamics).slice(0, 6)) {
            const line = str(v, 300);
            if (k && line) d.dynamics[String(k).trim()] = line;
        }
    }
    if (!d.identity && !d.facts.length && !d.secrets.length && !d.voice.length && !Object.keys(d.dynamics).length) return null;
    return d;
}

/**
 * LLM-curated dossier: instead of injecting regex-extracted section fragments, the
 * model READS the page and writes the injection — identity, load-bearing facts,
 * secrets stated as secrets (paired with the KNOWLEDGE SCOPE guard), voice, and
 * per-person dynamics. Built once per entity, in the background, cached forever.
 * The turn that grounds the entity ships regex sections immediately; the dossier
 * upgrades the entry for every turn after. Failure leaves regex sections in charge
 * and retries after the negative TTL.
 */
async function buildDossier(name, wikitext, relRaw) {
    const digest = [
        `PAGE: ${name}`,
        `LEAD: ${extractLead(wikitext, 700)}`,
        `PERSONALITY: ${extractSection(wikitext, ["personality"], 900)}`,
        `RELATIONSHIPS: ${clip(cleanWikitext(relRaw || extractSectionRaw(wikitext, ["relationships", "relationship"], 3500)), 1600)}`,
        `HISTORY: ${extractSection(wikitext, ["history", "biography", "background", "plot", "synopsis"], 1200)}`,
        `TRIVIA: ${extractTrivia(wikitext, ["trivia"], 8, 900)}`,
        `QUOTES: ${extractQuotes(extractSectionRaw(wikitext, ["quotes", "notable quotes"], 4000), 5, 700)}`,
    ].filter(l => !/^[A-Z]+: ?$/.test(l)).join("\n");
    const systemText = (settings().promptDossier || "").trim() || DEFAULT_PROMPT_DOSSIER;
    const out = await llmCall(systemText, digest, { maxTokens: 1000, budgetMs: (Number(settings().parserBudgetMs) || 30000) * 2 });
    return parseDossier(out);
}

/** Fire-and-forget dossier build with an in-flight/retry guard on the cache entry. */
function scheduleDossier(key, name, wikitext, relRaw) {
    const s = settings();
    const entry = s.cache[key];
    if (!entry || entry.dossier) return;
    if (entry.dossierTs && Date.now() - entry.dossierTs < NEGATIVE_TTL) return;  // in flight / recent failure
    entry.dossierTs = Date.now();
    buildDossier(name, wikitext, relRaw).then(d => {
        const e = settings().cache[key];
        if (!e) return;
        if (d) {
            e.dossier = d;
            debug(`✦ dossier ready: ${name}`);
        }
        saveSettingsDebounced();
    }).catch(() => { /* retry after TTL */ });
}

/**
 * Reasoning models (GLM, DeepSeek-R1, o-series…) wrap answers in <think>…</think>
 * blocks whose prose can contain brackets/braces — a naive first-[ … last-] slice
 * spans reasoning + answer and JSON.parse dies on it EVERY time. Strip the
 * reasoning, then scan for BALANCED candidates and try them last-first (the final
 * answer is at the end).
 */
function stripReasoning(text) {
    let t = String(text);
    t = t.replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi, "");
    // Unclosed-open or stray-close variants: keep only what follows the LAST close tag.
    const lastClose = Math.max(t.lastIndexOf("</think>"), t.lastIndexOf("</thinking>"), t.lastIndexOf("</reasoning>"));
    if (lastClose !== -1) t = t.slice(t.indexOf(">", lastClose) + 1);
    return t.trim();
}

/** All top-level balanced `open…close` substrings, in order of appearance. */
function balancedSlices(text, open, close) {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === "\\") esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { if (depth > 0) inStr = true; continue; }
        if (ch === open) { if (depth === 0) start = i; depth++; }
        else if (ch === close && depth > 0) { depth--; if (depth === 0 && start !== -1) { out.push(text.slice(start, i + 1)); start = -1; } }
    }
    return out;
}

/**
 * A reply cut off by a token ceiling has a perfect array that simply never
 * closes. Walk back to the last COMPLETE element boundary, close the array,
 * and keep everything that survived — partial cast beats no cast, and the
 * elements that made it through are exactly as the model wrote them.
 */
function salvageTruncatedArray(text) {
    const t = stripReasoning(String(text).replace(/```(?:json)?/gi, ""));
    const start = t.indexOf("[");
    if (start === -1) return null;
    const body = t.slice(start);
    let end = body.length;
    while (end > 1) {
        const cut = body.slice(0, end).replace(/,\s*$/, "");
        const boundary = Math.max(cut.lastIndexOf("}"), cut.lastIndexOf('"'));
        if (boundary <= 0) return null;
        try {
            const v = JSON.parse(cut.slice(0, boundary + 1) + "]");
            if (Array.isArray(v) && v.length) return v;
        } catch (e) { /* trim further back */ }
        end = boundary;
    }
    return null;
}

/** Try candidates LAST-first (final answer sits at the end of the output). */
function parseJsonCandidates(text, open, close, want) {
    const t = stripReasoning(String(text).replace(/```(?:json)?/gi, ""));
    const cands = balancedSlices(t, open, close);
    for (let i = cands.length - 1; i >= 0; i--) {
        try {
            const v = JSON.parse(cands[i]);
            if (want(v)) return v;
        } catch (e) { /* try earlier candidate */ }
    }
    return null;
}

/**
 * Parse the cast parser's output: a JSON array whose elements are either name
 * strings or {"name": …, "now": "≤12 words on what about them is in play in THIS
 * scene"}. Returns [{name, now}] (deduped by name), [] for an explicit empty
 * answer, null for garbage/failure — the null-vs-empty discipline everything
 * downstream depends on.
 */
function parseCast(text) {
    if (!text) return null;
    const arr = parseJsonCandidates(text, "[", "]", Array.isArray) || salvageTruncatedArray(text);
    if (!arr) return null;
    const out = [];
    const seen = new Set();
    for (const x of arr) {
        let name = "", now = "";
        let evidence = "";
        if (typeof x === "string") name = x.trim();
        else if (x && typeof x === "object" && typeof x.name === "string") {
            name = x.name.trim();
            if (typeof x.now === "string") now = clip(x.now.trim(), 110);
            if (typeof x.evidence === "string") evidence = x.evidence.trim();
        }
        if (name.length < 2 || name.length > 50 || !/[A-Za-z]/.test(name)) continue;
        const k = name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ name, now, evidence });
    }
    return out;
}

/**
 * The Arbiter move: don't trust the parser — VERIFY it. Every element must carry
 * evidence that is actually findable in the scene text (case- and
 * whitespace-insensitive). A model that "knows" a famous classmate belongs in
 * this school cannot quote the scene for them, so the fabrication drops here,
 * mechanically. Indirect references pass fine — "the school" is a quotable
 * substring. Elements WITHOUT an evidence field (older outputs, truncation
 * salvage) fall back to the strictest check available: the name itself must
 * appear in the text.
 */
const PLACE_WORDS = /\b(school|academy|institute|institution|university|college|city|town|village|kingdom|empire|nation|guild|organization|organisation|company|agency|island|castle|palace|temple|church|dungeon|tower|district|region|world|realm|garden)\b/i;

/**
 * Split verified cast by evidence STRENGTH. Strong = the evidence (or name-in-text
 * fallback) is anchored to the entity itself: it contains a token of the entity's
 * name, or entity and evidence are both place-flavored ("…High School" ↔ "the
 * school grounds"). Weak = the evidence is real scene text but nothing ties it to
 * THIS entity — "her classmates gathered" is in the prose and refers to no one in
 * particular. Weak items are exactly what the Cast Auditor exists to judge.
 */
function splitEvidenceStrength(cast, sceneText) {
    const strong = [], weak = [];
    for (const c of cast) {
        if (!c.evidence) {
            // No evidence supplied = UNPROVEN, not grandfathered. The name does sit
            // somewhere in the window (that's how it passed verify) — but "somewhere"
            // includes greeting rosters and cast lists the storyteller never wrote.
            // The auditor rules; the name itself becomes the claim under judgment.
            weak.push({ ...c, evidence: c.name });
            continue;
        }
        const ev = c.evidence.toLowerCase();
        const tokens = String(c.name).toLowerCase().split(/\s+/).filter(t => t.length >= 3);
        const anchored = tokens.some(t => ev.includes(t))
            || (PLACE_WORDS.test(c.name) && PLACE_WORDS.test(ev));
        (anchored ? strong : weak).push(c);
    }
    return { strong, weak };
}

function verifyCastEvidence(cast, sceneText) {
    if (!Array.isArray(cast)) return cast;
    const hay = String(sceneText).toLowerCase().replace(/\s+/g, " ");
    const inScene = (frag) => {
        const needle = String(frag || "").toLowerCase().replace(/\s+/g, " ").trim();
        return needle.length >= 2 && hay.includes(needle);
    };
    const kept = [];
    for (const c of cast) {
        if (c.evidence ? inScene(c.evidence) : inScene(c.name)) kept.push(c);
        else debug(`parser listed "${c.name}" with no textual evidence — dropped (knowledge leak)`);
    }
    return kept;
}

/** Names-only view of parseCast — same null / [] / list semantics. */
function parseNameArray(text) {
    const cast = parseCast(text);
    return cast === null ? null : cast.map(c => c.name);
}

/**
 * Arbiter-style pre-generation parse: a fast model reads the scene and returns the
 * character names actually present. Time-boxed so it can never block a turn.
 * Returns: string[] when the model answered ([] = it says no canon entities are
 * present, which may legitimately clear a stale cast); NULL on timeout/failure
 * (caller keeps the previous cast — failure must never be read as "nobody here").
 */
/**
 * One LLM call over whatever backend is configured: the Connection Manager profile
 * when set, else generateRaw. Returns the raw text, or null on timeout/failure/empty —
 * callers keep the parser's null-vs-empty discipline. Raced-out promises are always
 * given a rejection handler (Android webviews surface unhandled rejections).
 */
let lastLlmError = "";       // why the last llmCall returned null — surfaced by rescan
let lastParseFailToastAt = 0; // throttle for background-failure toasts (silence was the bug)

async function llmCall(systemText, userText, { maxTokens = 200, budgetMs = 0 } = {}) {
    const c = getContext();
    const s = settings();
    if (!budgetMs) budgetMs = Number(s.parserBudgetMs) || 30000;
    lastLlmError = "";
    const controller = new AbortController();
    const timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, budgetMs);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const extract = (res) =>
        typeof res === "string" ? res.trim()
        : (res && typeof res === "object" ? String(res.content ?? res.text ?? "").trim() : "");
    try {
        let out = "";
        let usedBackend = false;
        const svc = c.ConnectionManagerRequestService;
        if (s.llmProfileId && svc && typeof svc.sendRequest === "function") {
            usedBackend = true;
            const messages = [{ role: "system", content: systemText }, { role: "user", content: userText }];
            let req;
            try {
                req = svc.sendRequest(s.llmProfileId, messages, maxTokens, { signal: controller.signal, extractData: true });
            } catch (e) {
                lastLlmError = `profile request threw immediately: ${e.message} — re-pick the Connection Profile`;
                return null;
            }
            if (req && typeof req.catch === "function") req.catch(() => {});
            const res = await Promise.race([req, sleep(budgetMs + 250).then(() => null)]);
            out = extract(res);
        } else if (typeof c.generateRaw === "function") {
            usedBackend = true;
            const req = c.generateRaw({ prompt: userText, systemPrompt: systemText, responseLength: maxTokens });
            if (req && typeof req.catch === "function") req.catch(() => {});
            const res = await Promise.race([req, sleep(budgetMs).then(() => null)]);
            out = extract(res);
            if (!out && c.generateRaw.length >= 2) {
                // Older ST builds take positional args (prompt, api, instructOverride,
                // quietToLoud, systemPrompt, responseLength) — the object call above
                // silently produced garbage there. Try the legacy convention once.
                const req2 = c.generateRaw(userText, null, false, false, systemText, maxTokens);
                if (req2 && typeof req2.catch === "function") req2.catch(() => {});
                const res2 = await Promise.race([req2, sleep(budgetMs).then(() => null)]);
                out = extract(res2);
            }
        }
        if (!out) {
            lastLlmError = usedBackend
                ? `timed out after ${Math.round(budgetMs / 1000)}s — raise "Parser budget" in 🧠 Character detection, or the model returned nothing`
                : 'no parser backend — pick a Connection Profile in 🧠 Character detection (or update ST so generateRaw exists)';
            return null;
        }
        return out;
    } catch (e) {
        lastLlmError = `error: ${e.message}`;
        debug(`LLM call failed: ${e.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * THE CAST AUDITOR — a dedicated referee with one narrow, verifiable job: for each
 * entity whose evidence is real scene text but not anchored to them, decide whether
 * that evidence actually REFERS to that entity in this scene. Substring checks
 * cannot judge reference; a model can, and it only ever sees the weak cases, so the
 * call is tiny and rare. Anything it cannot confirm is dropped — strictness is the
 * point. Fails safe: if the auditor itself fails, weak items are dropped, never
 * waved through.
 */
async function auditCastEvidence(sceneText, weak) {
    if (!weak.length) return [];
    const items = weak.map(c => `- ${c.name} :: evidence: "${c.evidence}"`).join("\n");
    const systemText = (settings().promptAuditor || "").trim() || DEFAULT_PROMPT_AUDITOR;
    const userText = `<scene>\n${sceneText}\n</scene>\n\n${items}\n\nJSON verdict:`;
    const out = await llmCall(systemText, userText, { maxTokens: 200, budgetMs: Math.min(Number(settings().parserBudgetMs) || 30000, 12000) });
    if (!out) return [];   // auditor unavailable → weak claims do not pass
    const verdict = parseJsonCandidates(out, "{", "}", v => v && typeof v === "object" && !Array.isArray(v));
    if (!verdict) return [];
    const norm = {};
    for (const [k, v] of Object.entries(verdict)) norm[String(k).trim().toLowerCase()] = v === true;
    const kept = weak.filter(c => norm[c.name.toLowerCase()] === true);
    for (const c of weak) if (!kept.includes(c)) debug(`auditor rejected "${c.name}" — evidence doesn't refer to them`);
    return kept;
}

/**
 * Lowercase first-mention detector: two ADJACENT tokens the pipeline has never
 * seen (not noise, not stopwords, not learned, not cached) look like a typed-in
 * name ("rose oriana") regardless of capitals. It only opens the GATE — the
 * parser, evidence check, and auditor still decide who actually exists. Every
 * parsed message's tokens are learned afterwards, so a novel pair gates once.
 */
function hasNovelLowercasePair(text) {
    if (!text) return false;
    const toks = String(text).toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(t => t.length >= 3);
    const known = (t) =>
        NOISE_WORDS.has(t) || STOPWORDS.has(t[0].toUpperCase() + t.slice(1)) ||
        parsedWords.has(t) || !!cacheEntryFor(t);
    for (let i = 0; i < toks.length - 1; i++) {
        if (!known(toks[i]) && !known(toks[i + 1])) return true;
    }
    return false;
}

async function parseSceneCharacters(sceneText) {
    const c = getContext();
    const s = settings();
    const systemText = (settings().promptParser || "").trim() || DEFAULT_PROMPT_PARSER;
    const userText = `<scene>\n${sceneText}\n</scene>\n\nJSON array of canon entities to look up:`;
    const out = await llmCall(systemText, userText, { maxTokens: 800 });
    if (!out) return null;        // timeout / no backend / empty output → FAILURE, not "nobody here"
    const cast = parseCast(out);  // [] only when the model explicitly answered []
    if (cast === null) {
        lastLlmError = `model replied but not with a JSON array — it said: "${clip(stripReasoning(out), 90)}"`;
        return null;
    }
    // Every listed entity must be provable against the scene it was parsed from —
    // and evidence that proves nothing in particular goes to the Cast Auditor.
    const verified = verifyCastEvidence(cast, sceneText);
    const { strong, weak } = splitEvidenceStrength(verified, sceneText);
    if (!weak.length || !settings().castAuditor) return settings().castAuditor ? strong : verified;
    const confirmed = await auditCastEvidence(sceneText, weak);
    return [...strong, ...confirmed];
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

let interceptAnnounced = false;
globalThis.CanonGrounding_intercept = async function (chat, contextSize, abort, type) {
    if (!interceptAnnounced) {
        interceptAnnounced = true;
        console.log(`[CanonGrounding] v${CG_VERSION} interceptor active — if you never see this line, ST is not calling the interceptor at all.`);
    }
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
            if (!shouldParse && s.lowercaseNames) {
                // No capitals required: "rose oriana walks in" opens the gate too.
                shouldParse = hasNovelLowercasePair(lastUserMsg);
            }
            if (shouldParse) {
                const mySerial = ++parseSerial;
                const parsed = await parseSceneCharacters(sceneText);
                if (myEpoch !== chatEpoch) return;   // chat switched mid-parse: old-chat results must not apply
                if (parsed === null && Date.now() - lastParseFailToastAt > 300000) {
                    lastParseFailToastAt = Date.now();
                    try { toastr?.warning?.(`Canon parser failing in background: ${lastLlmError || "unknown"}. Sweep/pins still inject.`); } catch (e) {}
                }
                if (mySerial === parseSerial) {      // a newer parse hasn't superseded this one
                    for (const n of quick) parsedWords.add(n.toLowerCase()); // shown to the model now
                    for (const t of String(lastUserMsg).toLowerCase().split(/[^\p{L}\p{N}'-]+/u)) {
                        if (t.length >= 3) parsedWords.add(t);               // novel words gate once
                    }
                    if (parsed) {                    // null = call failed → keep the previous cast
                        const names = parsed.map(p => p.name);
                        debug(names.length ? `LLM parser → ${names.join(", ")}` : "LLM parser → (no canon entities present)");
                        lastCast = names;            // [] here is REAL info: clears a stale cast
                        lastCastLen = visibleLen;
                        castFocus = {};              // focus is a snapshot of THIS parse
                        castEvidence = {};
                        for (const p of parsed) {
                            if (p.now) castFocus[p.name.toLowerCase()] = p.now;
                            if (p.evidence) castEvidence[p.name.toLowerCase()] = p.evidence;
                        }
                        if (names.length) {
                            await groundNames(names, true);   // trusted: model chose these (may be lore)
                            if (myEpoch !== chatEpoch) return;
                            // A PLACE in the cast becomes the CURRENT SETTING — settings
                            // persist without prose ("ANS should be there even if it's not
                            // in the prose"). A later place supersedes it.
                            for (const n of names) {
                                const hit = cacheEntryFor(n.toLowerCase());
                                if (hit && (hit.entry.kind === "place" || PLACE_WORDS.test(hit.entry.name))) {
                                    setChatPin("canon_grounding_setting", hit.key);
                                }
                            }
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

        // Pinned entities: user-decreed always-present. Ground them (cache absorbs
        // repeats), and let them participate in pair dynamics with the live cast.
        const pinNames = chatPinNames();
        if (pinNames.length) {
            await groundNames(pinNames, true);
            if (myEpoch !== chatEpoch) return;
        }

        // Per-pair dynamics: with the cast settled, resolve "how A is around B" for every
        // grounded pair on screen (cached forever per pair; subpage fetches budgeted).
        const pairPool = [...(cast || []), ...pinNames];
        if (pairPool.length > 1) {
            const uniq = new Map();
            for (const n of pairPool) {
                const hit = cacheEntryFor(n.toLowerCase());
                if (hit) uniq.set(hit.key, hit.entry);
            }
            if (uniq.size > 1) {
                await resolveRelations([...uniq.values()]);
                if (myEpoch !== chatEpoch) return;
            }
            await resolveRelated([...uniq.values()]);
            if (myEpoch !== chatEpoch) return;
        }

        // Build the note. Cast-driven when we have one (parser/ledger); scene-scan otherwise.
        // Scene text hasn't changed since the top of the run — reuse it (the old code
        // recomputed sceneMessages a second time for nothing).
        const note = relevantCanonNote(scene, cast, chatArc(), {
            pinNames,
            blockNames: chatBlockNames(),
            settingKey: chatSettingKey(),
            chatPin: chatPin(),
            globalPin: settings().pinnedGlobal,
        });
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
            const names = parsed.map(p => p.name);
            lastCast = names;
            lastCastLen = visibleLen;
            castFocus = {};
            castEvidence = {};
            for (const p of parsed) {
                if (p.now) castFocus[p.name.toLowerCase()] = p.now;
                if (p.evidence) castEvidence[p.name.toLowerCase()] = p.evidence;
            }
            if (names.length) await groundNames(names, true);
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
                <b>Canon Grounding <span style="opacity:.6">v${CG_VERSION}</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input id="cg_enabled" type="checkbox">
                    <span>Enabled</span>
                </label>
                <small class="cg-hint">Master switch. Off = no grounding and nothing injected.</small>
                <details class="cg-group" open>
                <summary>🌐 Wiki source</summary>
                <div class="cg-group-body">
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
                </div>
                </details>
                <details class="cg-group" open>
                <summary>🧭 Story position &amp; pinned canon</summary>
                <div class="cg-group-body">
                <small><b>Story position</b> — pin an arc/chapter so the model knows exactly where in canon you are (and never spoils past it):</small>
                <div style="display:flex; gap:4px; align-items:center;">
                    <input id="cg_arc" class="text_pole" type="text" placeholder="e.g. Lawless City Arc, Chapter 45" style="flex:1;">
                    <div id="cg_arc_go" class="menu_button" title="Search the wiki and ground this arc/chapter">🔎</div>
                    <div id="cg_arc_clear" class="menu_button" title="Clear story position">✕</div>
                </div>
                <small id="cg_arc_status" class="cg-hint">—</small>
                <label class="checkbox_label">
                    <input id="cg_arc_inject" type="checkbox">
                    <span>Inject story position</span>
                </label>
                <small class="cg-hint">Adds the arc summary + a spoiler guard ("later events are unknown to every character") on top of the canon note.</small>
                <hr>
                <small><b>Pinned canon</b> — your words, always injected, above everything:</small>
                <label>Every chat (global)</label>
                <textarea id="cg_pin_global" class="text_pole" rows="2" placeholder="Facts/rules you want in every story, forever."></textarea>
                <label>This chat only</label>
                <textarea id="cg_pin_chat" class="text_pole" rows="2" placeholder="Facts/rules for this story only."></textarea>
                <label>Always-present characters (this chat)</label>
                <input id="cg_pin_names" class="text_pole" type="text" placeholder="e.g. Rose Oriana, Alpha">
                <small class="cg-hint">Comma-separated names, grounded and injected EVERY turn regardless of who the parser thinks is on screen. The hammer for "the AI doesn't know X".</small>
                <label>Never inject (this chat)</label>
                <input id="cg_block_names" class="text_pole" type="text" placeholder="e.g. Ryōko Nishikawa">
                <small class="cg-hint">Comma-separated names (aliases count) that must NEVER appear in the canon note — whatever the parser, sweep, or even a pin says. The hammer for "stop injecting X". The cache entry stays; only injection is forbidden.</small>
                </div>
                </details>
                <details class="cg-group">
                <summary>📚 What to inject</summary>
                <div class="cg-group-body">
                <small><b>What to ground</b> — which kinds of canon facts to inject:</small>
                <label class="checkbox_label">
                    <input id="cg_physical" type="checkbox">
                    <span>Physical (hair, eyes, appearance)</span>
                </label>
                <small class="cg-hint">Hair and eye color. Leanest and most useful — fixes wrong looks. Leave this on.</small>
                <label class="checkbox_label">
                    <input id="cg_personality" type="checkbox">
                    <span>Personality (baseline)</span>
                </label>
                <small class="cg-hint">Temperament, injected as a public BASELINE with framing that tells the model to modulate it — not a script. On by default in v0.3.</small>
                <label class="checkbox_label">
                    <input id="cg_relationship" type="checkbox">
                    <span>Relationships / family</span>
                </label>
                <small class="cg-hint">Parents, siblings, key ties. Good for stopping invented family.</small>
                <label class="checkbox_label">
                    <input id="cg_dynamics" type="checkbox">
                    <span>Per-pair dynamics ("With Cid: …")</span>
                </label>
                <small class="cg-hint">When two grounded characters share a scene, inject how THIS one acts around THAT one, from the wiki's Relationships subsections (or the X/Relationships subpage). The fix for "stoic on the wiki → stoic with everyone".</small>
                <label class="checkbox_label">
                    <input id="cg_smart" type="checkbox">
                    <span>Smarter AI 🧠 (context expansion)</span>
                </label>
                <small class="cg-hint">Injecting a character also injects their essential background as one-line Context — "rose oriana" brings the Oriana Kingdom with her, because her kingdom IS her story. OFF = strict: only what the scene itself earns. (Entities dossier'd before this feature learn their Context on re-ground — ✕ them once.)</small>
                <label class="checkbox_label">
                    <input id="cg_lowercase" type="checkbox">
                    <span>Lowercase names open the gate</span>
                </label>
                <small class="cg-hint">"rose oriana walks in" triggers detection with no capitals needed — a pair of never-seen words opens the gate; the parser, evidence check, and Auditor still decide who's real. Learned words gate only once.</small>
                <label class="checkbox_label">
                    <input id="cg_auditor" type="checkbox">
                    <span>Cast Auditor 🛡</span>
                </label>
                <small class="cg-hint">A dedicated AI check on who gets injected and why: when the parser's evidence for an entity is real scene text but not clearly ABOUT them ("her classmates gathered"), a tiny referee call rules whether it truly refers to them. Unconfirmed = dropped. Fires only on weak cases.</small>
                <label class="checkbox_label">
                    <input id="cg_dossier" type="checkbox">
                    <span>LLM-curated dossiers ✦</span>
                </label>
                <small class="cg-hint">Your parser model reads each grounded page ONCE (in the background) and writes the injection itself: identity, load-bearing facts, secrets marked as secrets, voice, per-person dynamics. Replaces regex-extracted fragments with judgment. Entities upgraded get a ✦ in "Why these".</small>
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
                <label class="checkbox_label">
                    <input id="cg_trivia" type="checkbox">
                    <span>Trivia</span>
                </label>
                <small class="cg-hint">"== Trivia ==" bullets — dense fan-level canon (quirks, habits, hidden facts) that humanizes characters beyond the formal sections.</small>
                <label class="checkbox_label">
                    <input id="cg_voice" type="checkbox">
                    <span>Voice (canon quotes)</span>
                </label>
                <small class="cg-hint">Up to 3 short verbatim lines from the wiki's Quotes section (or X/Quotes subpage) — the model hears HOW they talk, not just a description of it. Framed as style samples so it matches the cadence instead of parroting the lines.</small>
                </div>
                </details>
                <details class="cg-group">
                <summary>🧠 Character detection</summary>
                <div class="cg-group-body">
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
                <div class="cg-row" style="display:flex; gap:4px;">
                    <input id="cg_selftest" class="menu_button" type="button" value="🔬 Parser self-test">
                </div>
                <small class="cg-hint">Sends a 3-word test call through your parser backend and reports backend, elapsed time, and the reply (or the exact failure). Diagnoses transport problems without touching your scene.</small>
                <label>Parser budget (seconds)</label>
                <input id="cg_budget" class="text_pole" type="number" min="10" max="180" step="5">
                <small class="cg-hint">How long the cast parser / dossier curator may take. Slow backends (GLM on mobile) need 30–60s — a blown budget silently kills the cast and everything looks dumb.</small>
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
                </div>
                </details>
                <details class="cg-group">
                <summary>🔧 Keywords &amp; limits</summary>
                <div class="cg-group-body">
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
                <label>Quote section keywords</label>
                <input id="cg_quotekw" class="text_pole" type="text">
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
                </div>
                </details>
                <details class="cg-group">
                <summary>🧾 System instructions</summary>
                <div class="cg-group-body">
                <small class="cg-hint">Every prompt this extension sends, visible and editable. Leave a box UNCHANGED (or empty) to use the built-in default — customized boxes keep your text through updates; ↺ restores one box to default.</small>
                <label>Injection header (framing above every canon note)</label>
                <textarea id="cg_prompt_header" class="text_pole" rows="5"></textarea>
                <div id="cg_prompt_header_reset" class="menu_button" title="Restore default">↺ default</div>
                <label>Cast parser (who is in the scene)</label>
                <textarea id="cg_prompt_parser" class="text_pole" rows="5"></textarea>
                <div id="cg_prompt_parser_reset" class="menu_button" title="Restore default">↺ default</div>
                <label>Dossier curator (reads each wiki page once)</label>
                <textarea id="cg_prompt_dossier" class="text_pole" rows="5"></textarea>
                <div id="cg_prompt_dossier_reset" class="menu_button" title="Restore default">↺ default</div>
                <label>Cast Auditor 🛡 (judges weak evidence)</label>
                <textarea id="cg_prompt_auditor" class="text_pole" rows="5"></textarea>
                <div id="cg_prompt_auditor_reset" class="menu_button" title="Restore default">↺ default</div>
                <hr>
                <div id="cg_factory_reset" class="menu_button" title="Reset every setting and instruction to defaults">♻ Reset ALL settings &amp; instructions to defaults</div>
                <small class="cg-hint">Restores every setting and every instruction to the best-default state. Your grounded cache, saved wiki library, and per-chat pins/arc are KEPT.</small>
                </div>
                </details>
                <details class="cg-group">
                <summary>🩺 Cache &amp; diagnostics</summary>
                <div class="cg-group-body">
                <small><b>Cache</b> — everything grounded so far:</small>
                <div id="cg_cache_list" class="cg-cache"></div>
                <small class="cg-hint">Facts are fetched from the wiki once per entity, then reused forever (no repeat calls). × removes one entry so it re-fetches next time; "Clear all" wipes everything — do this after changing fields/keywords or fixing a wrong entry. An entry HERE does not mean it injects — "Why each was injected" below is the truth of what entered the note.</small>
                <div style="margin-top:6px;">
                    <input id="cg_rescan" class="menu_button" type="button" value="Scan current scene now">
                    <input id="cg_preview" class="menu_button" type="button" value="👁 Preview injection">
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
                </details>
            </div>
        </div>
    </div>`;
    $("#extensions_settings2").append(html);

    const s = settings();
    $("#cg_enabled").prop("checked", s.enabled).on("input", function () {
        s.enabled = $(this).prop("checked"); saveSettingsDebounced();
    });
    for (const cat of ["physical", "personality", "relationship", "biography", "abilities", "trivia", "voice"]) {
        $(`#cg_${cat}`).prop("checked", s[cat]).on("input", function () {
            s[cat] = $(this).prop("checked"); saveSettingsDebounced();
        });
    }
    $("#cg_dynamics").prop("checked", s.relationDynamics).on("input", function () {
        s.relationDynamics = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_dossier").prop("checked", s.llmDossier).on("input", function () {
        s.llmDossier = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_auditor").prop("checked", s.castAuditor).on("input", function () {
        s.castAuditor = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_smart").prop("checked", s.smartExpansion).on("input", function () {
        s.smartExpansion = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_lowercase").prop("checked", s.lowercaseNames).on("input", function () {
        s.lowercaseNames = $(this).prop("checked"); saveSettingsDebounced();
    });
    // 🧾 System instructions: box shows the EFFECTIVE text; saving text identical to
    // the default stores "" so future default improvements still reach this user.
    const PROMPTS = [
        ["#cg_prompt_header",  "promptHeader",  DEFAULT_PROMPT_HEADER],
        ["#cg_prompt_parser",  "promptParser",  DEFAULT_PROMPT_PARSER],
        ["#cg_prompt_dossier", "promptDossier", DEFAULT_PROMPT_DOSSIER],
        ["#cg_prompt_auditor", "promptAuditor", DEFAULT_PROMPT_AUDITOR],
    ];
    for (const [sel, key, def] of PROMPTS) {
        $(sel).val((s[key] || "").trim() || def).on("input", function () {
            const v = String($(this).val());
            s[key] = (v.trim() === def.trim()) ? "" : v;
            saveSettingsDebounced();
        });
        $(sel + "_reset").on("click", function () {
            s[key] = ""; $(sel).val(def); saveSettingsDebounced();
            toastr?.info?.("Restored default instruction.");
        });
    }
    $("#cg_factory_reset").on("click", function () {
        if (!confirm("Reset EVERY Canon Grounding setting and instruction to defaults?\nKept: grounded cache, saved wiki library, per-chat pins/arc.")) return;
        const keep = { cache: s.cache, savedWikis: s.savedWikis, wikis: s.wikis };
        for (const k of Object.keys(s)) delete s[k];
        Object.assign(s, structuredClone(defaultSettings), keep, { migrated_v2: true, migrated_v3: true });
        saveSettingsDebounced();
        toastr?.success?.("Defaults restored. Reloading UI…");
        setTimeout(() => location.reload(), 800);
    });
    $("#cg_pin_global").val(s.pinnedGlobal).on("input", function () {
        s.pinnedGlobal = $(this).val(); saveSettingsDebounced();
    });
    const renderChatPins = () => {
        $("#cg_pin_chat").val(chatPin());
        try { $("#cg_pin_names").val(getContext().chatMetadata?.canon_grounding_pin_names || ""); } catch (e) {}
        try { $("#cg_block_names").val(getContext().chatMetadata?.canon_grounding_block || ""); } catch (e) {}
    };
    renderChatPins();
    renderChatScoped = () => { renderChatPins(); };
    $("#cg_pin_chat").on("input", function () { setChatPin("canon_grounding_pin", $(this).val()); });
    $("#cg_pin_names").on("input", function () { setChatPin("canon_grounding_pin_names", $(this).val()); });
    $("#cg_block_names").on("input", function () { setChatPin("canon_grounding_block", $(this).val()); });
    // Story position (arc/chapter grounding).
    const renderArc = () => {
        const a = chatArc();
        $("#cg_arc_status").text(a ? `✓ ${a.title} (${a.wiki}) — this chat` : "—");
    };
    renderArcStatus = renderArc;
    $("#cg_arc").val(s.arcTitle || "");
    renderArc();
    $("#cg_arc_go").on("click", async function () {
        const q = String($("#cg_arc").val() || "").trim();
        if (!q) return;
        $("#cg_arc_status").text("searching…");
        const got = await groundArc(q);
        if (got) renderArc();
        else $("#cg_arc_status").text("✕ no arc/chapter page found on: " + s.wikis);
    });
    $("#cg_arc_clear").on("click", function () {
        s.arcTitle = ""; setChatArc(null); $("#cg_arc").val("");
        saveSettingsDebounced(); renderArc();
    });
    $("#cg_arc_inject").prop("checked", s.arcInject).on("input", function () {
        s.arcInject = $(this).prop("checked"); saveSettingsDebounced();
    });
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
    $("#cg_quotekw").val(s.quoteKeywords).on("input", function () {
        s.quoteKeywords = $(this).val(); saveSettingsDebounced();
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
    // budget stored in ms, edited in seconds
    $("#cg_budget").val(Math.round((s.parserBudgetMs || 30000) / 1000)).on("input", function () {
        const v = parseInt($(this).val(), 10);
        if (!isNaN(v) && v >= 10) { s.parserBudgetMs = v * 1000; saveSettingsDebounced(); }
    });
    $("#cg_selftest").on("click", async function () {
        toastr?.info?.("Parser self-test running…");
        const t0 = Date.now();
        const out = await llmCall("You are a connectivity test. Reply with exactly: ok", "Reply with exactly: ok", { maxTokens: 8 });
        const ms = Date.now() - t0;
        if (out) toastr?.success?.(`Parser backend OK in ${ms}ms — replied: "${clip(out, 40)}"`);
        else toastr?.error?.(`Parser backend FAILED in ${ms}ms — ${lastLlmError || "unknown"}`);
    });
    $("#cg_preview").on("click", function () {
        try {
            const ctx = getContext();
            const scene = sceneMessages(ctx, s.contextWindow);
            const cast = pruneStaleCast((ctx.chat || []).filter(m => !m.is_system).length, scene);
            const note = relevantCanonNote(scene, cast, chatArc(), {
                pinNames: chatPinNames(), blockNames: chatBlockNames(),
                settingKey: chatSettingKey(),
                chatPin: chatPin(), globalPin: s.pinnedGlobal,
            });
            lastInjection = note;
            lastInjectionAt = Date.now();
            renderLastInjection();
            toastr?.[note ? "success" : "warning"]?.(note
                ? `Preview built: ${lastMatchReasons.length} entr${lastMatchReasons.length === 1 ? "y" : "ies"} — see "Last injection" below.`
                : "Preview is EMPTY: nothing cached is named in the scene window, cast is empty, and no pins/arc are set.");
        } catch (e) {
            toastr?.error?.(`Preview failed: ${e.message}`);
        }
    });
    const numHandler = (id, key, min, def) => {
        $(id).val(s[key]).on("input", function () {
            const n = parseInt($(this).val(), 10);
            s[key] = Number.isFinite(n) && n >= min ? n : def;
            saveSettingsDebounced();
        });
    };
    numHandler("#cg_maxchars", "maxCharacters", 1, 8);
    numHandler("#cg_maxper", "maxCharsPerChar", 80, 700);
    numHandler("#cg_maxtotal", "maxTotalChars", 200, 4500);

    $("#cg_reset_kw").on("click", function () {
        for (const k of ["fields", "relationshipKeywords", "biographyKeywords", "personalityKeywords", "abilitiesKeywords", "aliasKeywords", "quoteKeywords"]) {
            s[k] = defaultSettings[k];
        }
        $("#cg_fields").val(s.fields);
        $("#cg_relkw").val(s.relationshipKeywords);
        $("#cg_biokw").val(s.biographyKeywords);
        $("#cg_perkw").val(s.personalityKeywords);
        $("#cg_abikw").val(s.abilitiesKeywords);
        $("#cg_aliaskw").val(s.aliasKeywords);
        $("#cg_quotekw").val(s.quoteKeywords);
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
                    toastr?.warning?.(`Parser: ${lastLlmError || "failed"} — nothing changed.`);
                } else if (mySerial === parseSerial) {
                    const names = parsed.map(p => p.name);
                    lastCast = names;
                    lastCastLen = (ctx.chat || []).filter(m => !m.is_system).length;
                    castFocus = {};
                    castEvidence = {};
                    for (const p of parsed) {
                        if (p.now) castFocus[p.name.toLowerCase()] = p.now;
                        if (p.evidence) castEvidence[p.name.toLowerCase()] = p.evidence;
                    }
                    if (names.length) {
                        await groundNames(names, true);
                        if (myEpoch !== chatEpoch) return;
                        toastr?.success?.(`Grounded: ${names.join(", ")}`);
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
            castFocus = {};
            castEvidence = {};
            lastCastLen = 0;
            lastInjection = "";
            lastInjectionAt = 0;
            lastMatchReasons = [];
            lastSource = "";
            try { setInjection(""); } catch (e) { /* not critical */ }
            renderLastInjection();
            try { if (renderArcStatus) renderArcStatus(); } catch (e) { /* UI optional */ }
            try { if (renderChatScoped) renderChatScoped(); } catch (e) { /* UI optional */ }
        });
    }
    console.log(`[CanonGrounding] v${CG_VERSION} loaded.`);
});
