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
let refreshWikiUi = null;    // set by the settings UI; syncs the wiki field after \ud83d\udd2d discovery
let renderChatScoped = null; // refreshes per-chat pin fields on CHAT_CHANGED
let renderCacheHook = null;  // refreshes the per-chat cache list on CHAT_CHANGED
let renderPromptDefaults = null; // re-resolves persona-dependent instruction defaults on CHAT_CHANGED
let chatEpoch = 0;          // bumped on CHAT_CHANGED — async work from an older epoch is discarded
let parseSerial = 0;        // monotonically increasing parse id — only the LATEST parse may apply
const INJECT_KEY = "CANON_GROUNDING";
const CG_VERSION = "0.44.0";
// Tag set on the legacy chat-spliced canon note (old-ST fallback when
// setExtensionPrompt is unavailable) so every later pass can find and remove it.
const FALLBACK_TAG = "canon_grounding_fallback";

// ---------------------------------------------------------------------------
// DEFAULT SYSTEM INSTRUCTIONS — every prompt this extension sends to a model.
// Visible and editable in the "🧾 System instructions" group; an EMPTY override
// means these defaults apply, so prompt improvements in updates still reach
// everyone who hasn't customized.
// The injection voice: the canon note speaks with the player's own persona
// name, whoever that is. ST's unset persona defaults ("User"/"Player") are
// role-words that read as corpo to a defensive storyteller persona, so those
// fall back to the universal fiction convention: the author's note.
function noteLabel() {
    try {
        const n = String(getContext().name1 || "").trim();
        if (n && n.toLowerCase() !== "user" && n.toLowerCase() !== "player") return n + "'s note";
    } catch (_) {}
    return "Author's note";
}

const DEFAULT_PROMPT_HEADER_BODY =
        "canon from this series' wiki, to keep our story accurate.\n" +
        "You know this world; what's below is the sharp version of details that go " +
        "fuzzy. Where something here differs from what you recall — a face, a " +
        "relationship, a past event — go with the note, that's the accurate one. Don't " +
        "argue with it, correct it, or invent an alternative; just know it.\n" +
        "These facts are for you as the storyteller — not public knowledge inside the " +
        "story. A character can only know, reveal, or react to what they could know " +
        "in-story right now. Hidden identities, secret affiliations, and unrevealed " +
        "connections stay hidden: never let a character's dialogue, thoughts, or " +
        "behavior betray what the note tells you.\n" +
        "How someone is described here is how they've tended to be — never a script. " +
        "They're a person first: traits shape how they respond, not whether they " +
        "respond like a person. Mood, company, privacy, and stakes bend them — stoic " +
        "on duty can be warm or petty in private. Pressure shows through a trait, not " +
        "instead of it — defiance strains, fear leaks, people bargain, beg, break, or " +
        "hold at visible cost — and the same reaction repeated while things escalate " +
        "reads as a portrayal error. When a 'With <name>' line matches someone in the " +
        "scene, that dynamic overrides the baseline. Quoted lines are style samples so " +
        "you can hear their cadence — write fresh dialogue in it, never recite the " +
        "quotes. Show traits through fresh, situation-specific behavior, " +
        "contradictions included.\n";
// The effective default header: the player's name resolved at injection time,
// so the same shipped default reads as "<their name>'s note" for anyone.
function defaultPromptHeader() { return noteLabel() + " \u2014 " + DEFAULT_PROMPT_HEADER_BODY; }
const DEFAULT_PROMPT_ASK =
    "You route a user's request about a roleplay canon-injection tool to ONE action. Actions: " +
    '"ground" (fetch canon for an entity so it can appear), ' +
    '"pin" (make a character ALWAYS injected in this chat), ' +
    '"block" (NEVER inject this entity in this chat), ' +
    '"arc" (set the story position to an arc/chapter), ' +
    '"note" (remember a user-authored fact/rule for this chat — target is the full text), ' +
    '"info" (report what is known about an entity). ' +
    'Respond ONLY with JSON: {"action": "...", "target": "..."}. ' +
    '"inject X" or "add X" means pin. If the request is a fact or rule rather than a name, use note.';
const DEFAULT_PROMPT_PARSER =
        "This is a scene from a work of fiction that has published source material with a " +
        "wiki. List the canon entities worth looking up in that wiki so the writer can portray " +
        "them accurately. INCLUDE: (a) characters who are present or acting in the scene; " +
        "(b) characters who are NAMED, referred to, remembered, or asked about even if NOT " +
        "physically present — the writer still needs to know who they are to mention them " +
        "correctly (e.g. someone the player asks 'have you seen X?'); (c) places, organizations, " +
        "groups, or notable lore that are central to what is happening — named techniques, magic or " +
        "power systems, events, and significant items are lore too. STRICT EXTRACTION RULE: " +
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
        '"brief": one flowing paragraph, 60–100 words, third person present tense, weaving who they are, their manner, and what defines them — write temperament as living tendency, not law: where the material shows it, include what softens them, what pressures them, and how they differ strained versus at ease; keep the source\'s own contradictions; avoid absolutist wording ("always", "never", "nothing can") unless the source itself insists; natural prose a narrator absorbs in one read; no lists, no headers; do NOT begin with or repeat the character\'s name (the block header already names them); ' +
        '"facts": up to 8 short story-relevant facts a narrator must not get wrong; ' +
        '"secrets": up to 4 things HIDDEN in-story (secret identities, covert affiliations, unrevealed twists) stated plainly; ' +
        '"abilities": up to 4 short entries — named techniques, powers, weapons, and their stated LIMITS or costs; the proper name first ("I Am Atomic: wide-area annihilation spell"); empty array for a character with none; ' +
        '"voice": up to 3 short verbatim quotes if any appear; ' +
        '"dynamics": object mapping up to 5 specific other characters to one line on how this character behaves around THEM; ' +
        '"related": up to 3 canon BACKGROUND entities essential to understanding them, each as {\"name\": proper name, \"why\": under 8 words on what it is to them — e.g. their kingdom, their sword school, their order}}. ' +
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
const DEFAULT_PROMPT_ARCJUDGE =
        "You referee STORY PROGRESSION for a roleplay. You are given a scene and ONE candidate canon event/arc. " +
        "Decide whether the story itself has MOVED INTO that event: it is beginning, starting, or actively underway " +
        "in the scene's present moment. Characters merely remembering, discussing, comparing to, planning for, " +
        "dreading, or being warned about the event does NOT count, and a flashback to it does NOT count — " +
        "only the present scene entering the event counts. " +
        'Respond with ONLY {"advance": true} or {"advance": false}. No other text.';

const DEFAULT_PROMPT_DISCOVER = `You identify which MediaWiki fan wiki covers a story. Given a protagonist and the story's own text, output STRICT JSON only:
{"franchise":"<franchise name>","evidence":"<verbatim phrase copied from the text>","slugs":["slug1","slug2"],"names":["Full Name","Full Name"]}
evidence: a phrase COPIED WORD-FOR-WORD from the text above that identifies the franchise — a canon character, place, organization, technique or title. Copy it exactly; do not paraphrase or invent one.
slugs: 3-6 lowercase hyphenated wiki-subdomain candidates for this franchise, most likely FIRST. Include romaji/alternate titles (e.g. Demon Slayer -> "kimetsu-no-yaiba") and common short forms.
names: 3-5 full names of this franchise's most famous CANON characters (the protagonist may be an original character who appears in no wiki — never rely on them alone).
If the text names no recognizable franchise, answer {"franchise":"","evidence":"","slugs":[],"names":[]} — guessing is worse than nothing.
No prose, no markdown, JSON only.`;

const defaultSettings = {
    enabled: true,
    // Comma-separated Fandom subdomains to search, e.g. "the-eminence-in-shadow,dc".
    wikis: "the-eminence-in-shadow",
    // \ud83d\udd2d Find the wiki automatically: on a new chat, verify the active wiki actually
    // knows the protagonist; if not, LLM proposes candidate slugs and the REAL wiki
    // API verifies them structurally. The wikis field above stays the manual override.
    autoDiscoverWiki: true,
    promptDiscover: "",
    // Saved library of subdomains you switch between, shown as one-tap chips.
    savedWikis: [],
    // Which infobox fields count as "physical" facts. Kept to hair/eyes on purpose:
    // other fields (height, age) collide with infobox image-sizing params and add noise.
    fields: "hair,haircolor,hair color,eyes,eye color,eyecolor,height,build,body,skin,complexion,feature,features,mark,birthmark",
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
    abilities: true,      // powers, skills, weapons — curated + scene-conditional (see abilityLine)
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
    // ⏱ IMMERSION CEILING: the storyteller never waits longer than this for canon.
    // Discovery that misses the window keeps running in the background and lands
    // next turn — stale for one turn beats a frozen storyteller every turn.
    maxBlockMs: 2000,
    // ⏱🤝 FIRST-MEETING WAIT: when YOUR message names someone with zero cache
    // presence, there is no "last known state" to inject — blocking briefly is
    // correct, because a wrong-haired introduction costs more immersion than a
    // short pause. Routine turns still use maxBlockMs.
    firstMeetWaitMs: 12000,
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
    // Autonomous story tracking: when the parser sees a canon ARC/EVENT enter the
    // scene ("the Bushin Festival begins"), the story position advances itself —
    // grounded with the full plot summary + spoiler guard, superseding the old one.
    autoArc: true,
    // 📝 Prose briefs: the character's block opens with the curator's WRITTEN
    // paragraph instead of labeled fragments — a narrator's briefing, not a
    // database row. Scene-conditional lines (Now, Facts, With, Voice, Secrets)
    // stay atomic below it, because atoms are what per-turn selection needs.
    proseBriefs: true,
    // System-instruction overrides — empty means the built-in default applies
    // (shown in the 🧾 group), so prompt improvements in updates still land.
    promptParser: "",
    promptDossier: "",
    promptAuditor: "",
    promptHeader: "",
    promptAsk: "",
    promptArcJudge: "",
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
    injectDepth: 9999,      // in-chat injection depth; huge = clamps to TOP of chat (right after the system prompt)
    // Hard limits so a big cast (e.g. High School DxD) can't balloon the prompt. Set a
    // bit generously because the LLM parser only returns real, relevant entities (no
    // regex junk), so there's room for present + referenced characters.
    maxCharacters: 8,       // inject at most this many entities (most central first)
    // THESE LITERALS ARE THE CURRENT DEFAULTS — the migrations below only exist to
    // move OLD installs forward, and the factory reset re-clones this object. When a
    // migration raises a cap, raise it HERE too, or the reset button silently
    // restores the stale pre-migration value (the 400/3000 vs 1100/6000 bug).
    maxCharsPerChar: 1100,  // cap per entity across all its categories
    maxTotalChars: 6000,    // budget for the CHARACTER BLOCKS; stop once reached. The
                            // header, pinned canon, and story position ride on top and
                            // are deliberately never trimmed (see relevantCanonNote).
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
    if (!st.migrated_v5) {
        // v0.19 prose briefs grew every block; v0.20.1 grows the vessel to match —
        // untouched caps only, user-set values are respected.
        if (st.maxCharsPerChar === 700) st.maxCharsPerChar = 1100;
        if (st.maxTotalChars === 4500) st.maxTotalChars = 6000;
        st.migrated_v5 = true;
        saveSettingsDebounced();
    }
    if (!st.migrated_v7) {
        // Abilities defaulted OFF because the raw wiki section was 400 characters of
        // noise on every turn. It is now a curated, limits-aware line that appears
        // only when the scene is about capability — the reason to hide it is gone,
        // and a model that doesn't know a character's techniques invents them.
        st.abilities = true;
        st.migrated_v7 = true;
        saveSettingsDebounced();
    }
    if (!st.migrated_v6) {
        // Appearance grows beyond hair/eyes — build, height, skin, distinguishing
        // features. Only upgrades the untouched default keyword list.
        if (st.fields === "hair,haircolor,hair color,eyes,eye color,eyecolor") {
            st.fields = "hair,haircolor,hair color,eyes,eye color,eyecolor,height,build,body,skin,complexion,feature,features,mark,birthmark";
        }
        st.migrated_v6 = true;
        saveSettingsDebounced();
    }
    return st;
}

/** HTML-escape a string before it goes anywhere near innerHTML-land. */
function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * THE ONLY way this extension toasts. Toast payloads routinely contain model
 * output (lastLlmError embeds the parser's raw reply), wiki-derived text, and
 * entity names — and toastr renders HTML by default. We escape EXPLICITLY here
 * rather than relying on toastr.options.escapeHtml: that global is shared
 * state another extension can flip, and a hostile/compromised LLM endpoint
 * would otherwise have script execution inside the ST page.
 */
function cgToast(kind, msg, opts) {
    try {
        if (typeof toastr !== "undefined") toastr?.[kind]?.(escapeHtml(msg), "Canon Grounding", opts);
    } catch (e) { /* toast is best-effort */ }
}

// Emit a diagnostic line (console always; toast when debug is on) so we can SEE
// what grounding actually did for each character instead of guessing.
function debug(msg) {
    console.log(`[CanonGrounding] ${msg}`);
    try {
        if (settings().debug) cgToast("info", msg, { timeOut: 8000, extendedTimeOut: 4000 });
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

// High-frequency English words that are never the distinguishing half of a typed
// name. The first-meeting wait (needsFirstMeetWait) used to fire on ANY pair of
// novel lowercase tokens — "the fire burns low" bought a 12-second stall once,
// exactly like a real first meeting. A pair/candidate whose tokens are ALL in
// this lexicon is prose, not a person. Deliberately EXCLUDES words the docs and
// tests use as real names (rose, shadow, alpha…) so "rose oriana walks in"
// still extends the wait: one uncommon token is enough to keep the signal.
const COMMON_LOWERCASE = new Set([
    // motion & action verbs (3rd-person and base forms as they appear in prose)
    "walks", "walked", "walking", "runs", "running", "sits", "sitting", "stands",
    "stood", "standing", "nods", "nodded", "nodding", "smiles", "smiled", "laughs",
    "laughed", "sighs", "sighed", "whispers", "whispered", "shouts", "shouted",
    "screams", "screamed", "cries", "cried", "looks", "looked", "looking", "turns",
    "turned", "says", "said", "asks", "asked", "answers", "answered", "speaks",
    "spoke", "talks", "talked", "tells", "told", "hears", "heard", "listens",
    "listened", "watches", "watched", "sees", "saw", "moves", "moved", "stays",
    "stayed", "waits", "waited", "opens", "opened", "closes", "closed", "falls",
    "fell", "falling", "rises", "risen", "breaks", "broke", "takes", "took",
    "gives", "gave", "makes", "made", "comes", "came", "coming", "goes", "went",
    "gone", "knows", "knew", "thinks", "thought", "feels", "felt", "seems",
    "seemed", "wants", "wanted", "needs", "needed", "likes", "liked", "loves",
    "loved", "hates", "hated", "tries", "tried", "starts", "started", "stops",
    "stopped", "keeps", "kept", "leaves", "left", "finds", "found", "loses",
    "lost", "wins", "won", "dies", "died", "kills", "killed", "fights", "fought",
    "sleeps", "slept", "wakes", "woke", "eats", "ate", "drinks", "drank",
    "works", "worked", "plays", "played", "reads", "writes", "wrote", "calls",
    "called", "follows", "followed", "leads", "led", "holds", "held", "pulls",
    "pulled", "pushes", "pushed", "catches", "caught", "throws", "threw", "cuts",
    "draws", "drew", "wears", "wore", "carries", "carried", "builds", "built",
    "burns", "burned", "burning", "flies", "flew", "enters", "entered",
    "approaches", "approached", "returns", "returned", "remains", "remained",
    "continues", "continued", "begins", "began", "pauses", "paused", "steps",
    "stepped", "crosses", "crossed", "reaches", "reached", "touches", "touched",
    "grabs", "grabbed", "glances", "glanced", "stares", "stared", "blinks",
    "blinked", "frowns", "frowned", "shrugs", "shrugged", "leans", "leaned",
    "kneels", "knelt", "bows", "bowed", "gestures", "gestured", "replies",
    "replied", "responds", "responded", "mutters", "muttered", "mumbles",
    "grins", "grinned", "smirks", "smirked", "chuckles", "chuckled", "growls",
    "snarls", "yawns", "stretches", "settles", "settled", "drifts", "drifted",
    "flickers", "flickered", "glows", "glowed", "shines", "shone", "hangs",
    "hung", "lies", "lay", "lain", "rests", "rested", "passes", "passed",
    // scene nouns
    "fire", "fires", "flame", "flames", "smoke", "ashes", "dust", "door",
    "doors", "window", "windows", "room", "rooms", "table", "tables", "chair",
    "chairs", "floor", "floors", "wall", "walls", "ceiling", "hall", "hallway",
    "corridor", "stairs", "gate", "gates", "night", "morning", "evening",
    "afternoon", "dusk", "dawn", "rain", "snow", "wind", "storm", "thunder",
    "lightning", "water", "river", "ocean", "lake", "forest", "trees", "tree",
    "road", "roads", "path", "street", "bridge", "mountain", "hill", "field",
    "fields", "sky", "skies", "sun", "moon", "light", "lights", "darkness",
    "ground", "stone", "stones", "rock", "rocks", "wood", "wooden", "metal",
    "iron", "glass", "paper", "papers", "book", "books", "candle", "candles",
    "lantern", "hand", "hands", "head", "face", "voice", "sound", "sounds",
    "silence", "music", "song", "songs", "bell", "bells", "clock", "hour",
    "hours", "minute", "minutes", "moment", "moments", "second", "seconds",
    "day", "days", "week", "weeks", "month", "year", "years", "time", "times",
    "home", "house", "houses", "bed", "beds", "roof", "floorboards", "embers",
    "campfire", "courtyard", "garden", "tower", "castle",
    // qualities & manner
    "low", "high", "soft", "softly", "quiet", "loud", "loudly", "slow", "fast",
    "hard", "cold", "warm", "hot", "cool", "bright", "dim", "dark", "pale",
    "heavy", "empty", "full", "small", "large", "big", "little", "long", "tall",
    "wide", "narrow", "deep", "shallow", "calm", "gentle", "gently", "rough",
    "smooth", "sharp", "dull", "faint", "faintly", "distant", "nearby", "close",
    "closer", "far", "away", "ahead", "behind", "beside", "beyond", "around",
    "above", "below", "inside", "outside", "tonight", "together", "alone",
    "quietly", "slowly", "softly", "suddenly", "finally", "patiently", "warmly",
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
    // Unicode letters throughout — "Ayanokōji" and "Tōshirō" are ONE token, not
    // ASCII fragments. \b is ASCII-blind (it fails after a trailing ō), so explicit
    // letter lookarounds mark the word edges instead.
    const capRe = /(?<![\p{L}\p{M}])(\p{Lu}[\p{Ll}\p{M}][\p{L}\p{M}'’-]*(?:\s+\p{Lu}[\p{Ll}\p{M}][\p{L}\p{M}'’-]*){0,3})(?![\p{L}\p{M}])/gu;
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
    // Bare subdomain → Fandom. Anything WITH a dot is a full MediaWiki host —
    // wiki.gg (where many big fandoms migrated), miraheze, self-hosted wikis:
    //   "the-eminence-in-shadow"  → https://the-eminence-in-shadow.fandom.com/api.php
    //   "terraria.wiki.gg"        → https://terraria.wiki.gg/api.php
    const w = wiki.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return w.includes(".") ? `https://${w}/api.php` : `https://${w}.fandom.com/api.php`;
}

/** Non-character / media / meta pages we should never ground as a character. */
function isMediaTitle(t) {
    if (!t) return true;
    // NOTE: "(Character)" is intentionally NOT here — some wikis disambiguate a real
    // character page that way, and rejecting it would drop the character.
    return /\((light novel|novel|anime|manga|manhwa|manhua|film|movie|ova|ona|web series|series|video game|soundtrack|album|song|volume|vol\.?|chapter|episode|arc|season|disambiguation|franchise)\)/i.test(t)
        || /\b(disambiguation|list of|volume \d|episode \d|chapter \d)\b/i.test(t)
        // FIGHT pages. Wikis with heavy battle coverage (Bleach: "Rukia Kuchiki &
        // Yasutora Sado vs. Shrieker") title them after their participants, so they
        // rank high on a character search AND pass the coverage guard — the query's
        // every token really is in the title. They carry no character infobox, so
        // the character gate would catch them... except a TRUSTED name skips that
        // gate. Result: a battle page grounds as the character, yields nothing, and
        // negative-caches her. A page naming two combatants is an event, not a who.
        || /\s(?:vs\.?|versus)\s/i.test(t)
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
    const usable = hits.filter(h => !isMediaTitle(h.title));
    // Search rank is relevance, not identity: a query for "Rukia" can rank a page
    // that mentions her a hundred times above her own article. A character's OWN
    // page is the TIGHTEST title that still accounts for the query — "Rukia
    // Kuchiki" beats "Rukia Kuchiki & Renji Abarai vs. Szayelaporro Granz". Prefer
    // covering titles shortest-first; fall back to plain relevance when none cover.
    const covering = usable.filter(h => titleCoversQuery(name, h.title, []));
    const pick = covering.length
        ? covering.reduce((a, b) => (b.title.length < a.title.length ? b : a))
        : usable[0];
    return pick ? pick.title : null; // if only media pages matched, treat as "not found"
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

    const COLORS = new Set(["silver","black","blonde","blond","blue","violet","purple","pink","white","grey","gray","red","green","brown","crimson","azure","golden","gold","platinum","auburn","chestnut","teal","turquoise","lavender","scarlet","amber","hazel","magenta","indigo","cyan","emerald","ruby","sapphire","raven","snow-white","silver-white"]);
    const MODIFIERS = new Set(["light","dark","pale","deep","bright","ash","platinum","midnight","dusty","soft","vivid","pastel"]);
    // Nearest COLOR to the noun, scanning back from it; keeps a leading modifier
    // ("light purple") but never a length word ("mid-back length silver").
    const pickColor = (w) => {
        for (let i = w.length - 1; i >= 0; i--) {
            if (COLORS.has(w[i].toLowerCase().replace(/[.,;]$/, ""))) {
                const mod = i > 0 && MODIFIERS.has(w[i - 1].toLowerCase()) ? w[i - 1] + " " : "";
                return (mod + w[i]).replace(/[.,;]$/, "");
            }
        }
        return null;
    };
    const clean = (words) => {
        let w = words.trim().split(/\s+/);
        while (w.length && PROSE_STOP.has(w[0].toLowerCase())) w.shift();
        const col = pickColor(w);
        if (col) return col;
        if (w.length > 2) w = w.slice(-2);
        return w.length ? w.join(" ") : null;
    };
    // CLAUSE ISOLATION. The old extractor searched the whole snippet for "the words
    // before <noun>", so a colour belonging to a DIFFERENT clause was read as this
    // attribute: "Her hair is a deep crimson and her eyes are pale gold" reported
    // eyes: deep crimson — a confidently wrong canon fact, injected silently.
    // Each attribute is now resolved inside the clause that names it.
    const clauses = snippet.split(/[.;:!?]+|\s+and\s+/i).filter(Boolean);

    // Compound case first: "pastel pink hair and eyes" — one color covers both.
    const compound = snippet.match(
        /((?:[A-Za-z][A-Za-z-]+\s+){1,4})hair\s+and\s+eyes\b/i
    );
    if (compound) {
        const c = clean(compound[1]);
        if (c) return `hair: ${c}; eyes: ${c}`;
    }

    const grab = (noun) => {
        const nounRe = new RegExp(`\\b${noun}\\b`, "i");
        const preRe = new RegExp(`((?:[A-Za-z][A-Za-z-]+\\s+){1,4})${noun}\\b`, "i");
        // PREDICATE form: "her hair is a deep crimson", "his hair, once black, is now
        // white", "hair as black as night". The pre-modifier pattern alone returned
        // nothing for these — the commonest way English wikis actually write it —
        // so hair/eye colour vanished on any page that phrased it as a sentence.
        const postRe = new RegExp(`${noun}\\b((?:[\\s,]+[A-Za-z][A-Za-z-]*){1,6})`, "i");
        for (const clause of clauses) {
            if (!nounRe.test(clause)) continue;
            const pre = clause.match(preRe);
            const preVal = pre ? clean(pre[1]) : null;
            if (preVal) return preVal;
            const post = clause.match(postRe);
            // A trailing run is only trusted when it names a real colour; arbitrary
            // following words ("hair fell across her face") are not a descriptor.
            const postVal = post ? pickColor(post[1].trim().split(/[\s,]+/).filter(Boolean)) : null;
            if (postVal) return postVal;
        }
        return null;
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

/** Strip common wiki markup down to readable prose. */
function cleanWikitext(wt) {
    if (!wt) return "";
    let s = wt;
    // BLOCK CONSTRUCTS FIRST — containers whose CONTENT is markup, not prose. The
    // generic <tag> stripper below removes only the tags, so their bodies used to
    // flow into the text as fake sentences: a <gallery> in an Appearance section
    // injected "Kid Tsunade.png|Tsunade as a child. Tsunade full.png|…" as the
    // character's look. One containment pass here heals every consumer at once
    // (look, identity, personality, relationships, biography, dossier, arc).
    // 1) Comments — may contain ">" (which breaks the generic stripper) or anything else.
    s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
    // 2) Image containers: bodies are image syntax by definition — the whole block
    //    vanishes. An unclosed opener runs to end-of-input (same philosophy as
    //    stripTemplates: better no text than raw markup).
    s = s.replace(/<(gallery|imagemap|timeline|slideshow|score)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
    // 3) Tabber bodies DO carry content between the tab plumbing — unwrap: drop the
    //    |-| separators and line-leading "Label=" heads, keep the rest (File links
    //    inside die in the media-link pass below).
    s = s.replace(/<tabber\b[^>]*>([\s\S]*?)(?:<\/tabber\s*>|$)/gi,
        (m, tbody) => tbody.replace(/\|-\|/g, "\n").replace(/^[ \t]*[^=\n]{1,40}=[ \t]*/gm, ""));
    // 4) Wikitables: {| … |} — headers, row pipes, style attrs; none of it is prose.
    //    Tempered innermost-first loop peels one nesting LEVEL per pass. The match
    //    can never be empty, so every productive pass strictly shrinks the string —
    //    termination is guaranteed by progress, not by the count failsafe (which
    //    only protects against a future edit making the regex zero-width).
    for (let guard = 0; guard < 64 && s.includes("{|"); guard++) {
        const next = s.replace(/\{\|(?:(?!\{\||\|\})[\s\S])*\|\}/g, "");
        if (next === s) break;
        s = next;
    }
    // Anything still open — unclosed opener, or nesting past the failsafe — can
    // only be table markup from here down; MediaWiki itself swallows an unclosed
    // {| to end of page. Every exit path lands junk-free.
    if (s.includes("{|")) s = s.replace(/\{\|[\s\S]*$/, "");
    // Media links — [[File:x.png|thumb|Caption]] must vanish whole, or the
    // generic link rule below leaks its parameters ("thumb|Caption") into the text.
    s = s.replace(/\[\[(?:File|Image|Media):[^\]]*\]\]/gi, "");
    // 5) Residual bare image-entry LINES ("Foo bar.png|caption", "File:Foo.jpg") —
    //    exotic gallery dialects, unclosed containers. A line that IS an image
    //    reference dies whole; prose that merely mentions a filename mid-sentence
    //    (text continuing after the extension without a pipe) survives.
    s = s.replace(/^[ \t]*(?:File:|Image:)?[^|=\n]{1,120}\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?)\s*(?:\|[^\n]*)?$/gim, "");
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
    // Inline TEXT-CARRYING templates — {{Color|#hex|Royal Blue}}, {{nowrap|X}},
    // {{small|X}}, {{tooltip|term|text}} — must yield their text, not vanish: the
    // depth walker deleting them whole is exactly how "haircolor" disappears while
    // a plain "eyecolor" survives. Keep the LAST parameter (the display text).
    s = s.replace(/\{\{\s*(?:colou?r|font ?colou?r|nowrap|small|big|tt|abbr|tooltip)\s*\|(?:[^{}]*\|)?([^{}|]*)\}\}/gi, "$1");
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
        .replace(/__[A-Z]+__/g, "")                  // magic words (__NOTOC__, __TOC__…)
        .replace(/-->/g, "")                         // orphaned comment closer (opener was malformed)
        .replace(/^[\s*#:;]+/gm, "")
        .replace(/\[\d+\]/g, "")
        .replace(/={2,}[^=]+={2,}/g, "")             // stray sub-headers
        .replace(/\s*,\s*,\s*/g, ", ")               // collapse empty list items
        .replace(/\s+/g, " ")
        .replace(/^[,;\s]+|[,;\s]+$/g, "")
        .trim();
}

/** Every balanced top-level {{ … }} block on the page, with its offset. */
function templateBlocks(wikitext) {
    const out = [];
    let depth = 0, start = -1;
    for (let i = 0; i < wikitext.length - 1; i++) {
        if (wikitext[i] === "{" && wikitext[i + 1] === "{") {
            if (depth === 0) start = i;
            depth++; i++;
        } else if (wikitext[i] === "}" && wikitext[i + 1] === "}") {
            if (depth > 0) {
                depth--; i++;
                if (depth === 0 && start !== -1) { out.push({ start, text: wikitext.slice(start, i + 1) }); start = -1; }
            }
        }
    }
    return out;
}

const INFOBOX_NAME = /^\{\{\s*[A-Za-z0-9_ -]*\b(?:infobox|character|charbox|profile|person|persona|hero|villain|creature|species|weapon|location|organi[sz]ation)\b[A-Za-z0-9_ -]*\s*(?:\||\}\})/i;
const PARAM_LINE = /\n\s*\|\s*[A-Za-z][A-Za-z0-9 _()'-]*\s*=/g;
/**
 * WHERE the fields live. The extractor was named for the infobox but had no
 * notion of one — it scanned the ENTIRE page, so any template anywhere could
 * donate a field. A scroll box, navbox, or layout wrapper carrying its own
 * "|height = 2.3" outranked the character's real "|height = 187 cm" purely by
 * sitting earlier in the source, and did it identically on every page of that
 * wiki. Scope to the infobox; fall back to the whole page only when no infobox
 * can be identified, so nothing that worked before stops working.
 */
function infoboxScope(wikitext) {
    if (!wikitext) return "";
    const blocks = templateBlocks(wikitext);
    if (!blocks.length) return wikitext;
    const named = blocks.filter(b => INFOBOX_NAME.test(b.text));
    const pick = named.length ? named
        : blocks.filter(b => b.start < 3000 && (b.text.match(PARAM_LINE) || []).length >= 4).slice(0, 1);
    return pick.length ? pick.map(b => b.text).join("\n") : wikitext;
}

// Layout numbers masquerading as facts. A human height is "187 cm", never
// "2.3" — a bare number is a row height, an image ratio, or a stat weight. The
// old filter rejected bare INTEGERS only, so every decimal walked straight in.
const LAYOUT_VALUE = /^\d+(?:\.\d+)?\s*(?:px|em|rem|pt|%)?$/i;
const MEASURE_LABEL = /\b(height|weight|width|length|depth|size|mass|bust|waist|hips?)\b/i;
const MEASURE_UNIT = /\d\s*(?:cm|mm|kms?|ms?\b|ft|in\b|kgs?|lbs?|g\b|meters?|metres?|feet|foot|inch(?:es)?|stone|['’"″′])/i;
/**
 * Is this value a FACT, or is it markup that happened to sit under a matching
 * field name? A measurement that carries digits must carry a unit with them;
 * prose ("Tall", "Average") is fine, a naked number is not. Rejected values do
 * NOT claim the label, so a real "height" later in the box still wins.
 */
function plausibleFieldValue(label, val) {
    if (LAYOUT_VALUE.test(val)) return false;
    if (MEASURE_LABEL.test(label) && /\d/.test(val) && !MEASURE_UNIT.test(val)) return false;
    return true;
}

/** Extract infobox fields whose NAME contains any of the given keywords. */
function extractInfoboxFields(wikitextRaw, keywords, maxLen = 240) {
    const wikitext = infoboxScope(wikitextRaw);
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
        if (/\.(png|jpe?g|gif|webp|svg)$/i.test(val)) continue;
        if (!plausibleFieldValue(label, val)) {
            debug(`infobox "${rawKey}" = "${clip(val, 40)}" rejected as layout/implausible for ${label}`);
            continue;   // does not claim the label: a real value later still wins
        }
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

/**
 * The wiki already wrote the physical description better than fragment-mining
 * recombines it: "a tall and lean young man with brown hair, brown eyes, and a
 * fair complexion. He is usually seen wearing…" — build, complexion, clothing,
 * even "considered very handsome" all live in the Appearance section's OPENING
 * sentences. Take them as prose, sentence-boundary cut.
 */
function extractLookProse(prose, maxChars = 300) {
    if (!prose) return "";
    let out = "";
    for (const sRaw of String(prose).split(/(?<=[.!?])\s+/)) {
        const sent = sRaw.trim();
        if (!sent || sent.length < 10) continue;
        if (out && (out.length + 1 + sent.length) > maxChars) break;
        if (!out && sent.length > maxChars) { out = sent.slice(0, maxChars); break; }
        out = out ? out + " " + sent : sent;
    }
    return out;
}

/**
 * SMART = whole content, zero waste. The block header already names the
 * character — the look prose repeating "Kiyotaka is a tall…" pays for the name
 * twice. Strip the leading subject, compress scaffolding phrases ("He is
 * usually seen wearing" → "Usually wears"), keep every fact intact.
 */
function tightenLook(look, entityName) {
    if (!look) return "";
    let t = String(look).trim();
    const toks = String(entityName || "").split(/\s+/).filter(w => w.length >= 2)
        .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (toks.length) {
        const namePat = `(?:${toks.join("|")})(?:\\s+(?:${toks.join("|")}))*`;
        t = t.replace(new RegExp(`^${namePat}\\s+(?:is|was)\\s+(a|an|the)\\s+`, "i"),
            (m, art) => art.charAt(0).toUpperCase() + art.slice(1) + " ");
        t = t.replace(new RegExp(`^${namePat}\\s+(?:is|was)\\s+`, "i"), "");
        t = t.replace(new RegExp(`^${namePat}\\s+has\\s+`, "i"), "Has ");
    }
    t = t.replace(/\b(?:He|She|They)\s+(?:is|are)\s+(?:usually|often|typically)\s+seen\s+wearing\b/gi, "Usually wears");
    t = t.replace(/\b(?:He|She|They)\s+(?:is|are)\s+also\s+seen\s+wearing\b/gi, "Also wears");
    t = t.replace(/\b(?:He|She|They)\s+(?:is|are)\s+seen\s+wearing\b/gi, "Wears");
    if (t && /^[a-z]/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);
    return t;
}

const DISTINGUISH_RE = /\b(mole|beauty mark|beauty spot|scar|scars|tattoo|birthmark|freckle|freckles|heterochrom\w*|eyepatch|fang|fangs|pointed ears|slender|petite|muscular|voluptuous|curvaceous|lithe|stocky|towering|diminutive|androgynous|ample|well[- ]built|delicate features)\b/i;
/**
 * Distinguishing physical details live in the Appearance PROSE, not the infobox —
 * "a beauty mark under her left eye", "a scar across his brow", "slender but
 * deceptively strong". Pull up to 2 short sentences containing distinctive
 * markers, so Gamma's mole makes it into Appearance alongside hair and eyes.
 */
function extractDistinguishing(prose, maxSentences = 2) {
    if (!prose) return "";
    const out = [];
    for (const sRaw of String(prose).split(/(?<=[.!?])\s+/)) {
        const sent = sRaw.trim();
        if (sent.length < 15 || sent.length > 180) continue;
        if (!DISTINGUISH_RE.test(sent)) continue;
        out.push(sent);
        if (out.length >= maxSentences) break;
    }
    return out.join(" ");
}

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
        // Drop "(by X)" notes and the quote marks that WRAP a value — but an
        // apostrophe INSIDE a name belongs to it. Blanket-stripping ' turned
        // "White Room's Masterpiece" into "White Rooms Masterpiece", an alias that
        // can never match the scene text that names her.
        a = a.replace(/\([^)]*\)/g, "")
             .replace(/^[\s"“”'‘’]+|[\s"“”'‘’]+$/g, "")
             .trim();
        if (a.length >= 2 && a.length <= 40 && /[A-Za-z]/.test(a)) out.push(a);
    }
    return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Grounding: fetch + cache a single entity (once, ever)
// ---------------------------------------------------------------------------

const NEGATIVE_TTL = 1000 * 60 * 60 * 24; // don't re-search a "not found" for 24h
// A SOFT miss heals in minutes, not a day. The distinction is whose failure it was:
// "no-page" means the wiki genuinely has no such article — durable knowledge, and
// the right answer for an original character or a stray capitalised word. Every
// other reason means we FOUND a page and our own resolution or extraction failed
// (landed on a battle page, an infobox we could not read, a router page). That is a
// failure of our heuristics, not evidence of absence, and locking it in for 24h is
// what makes a character the story is actively addressing stay silently ungrounded
// while the note fills with whoever happens to still be cached.
const SOFT_NEGATIVE_TTL = 1000 * 60 * 20;
function negativeTtl(entry) {
    return (entry && entry.reason && entry.reason !== "no-page") ? SOFT_NEGATIVE_TTL : NEGATIVE_TTL;
}

// Markup that has no business inside an injected section: image syntax, table
// syntax, magic words, comment shrapnel, tab plumbing. Presence means the entry
// was built by a pre-containment extractor (or an unknown dialect leaked) — the
// self-heal below rebuilds it from a fresh fetch with the current extractor.
const SECTION_JUNK = /\.(?:png|jpe?g|gif|webp|svg|bmp|tiff?)\b|\{\||__[A-Z]+__|-->|<gallery|\|-\|/i;
/**
 * An already-cached "height: 2.3" is a lie that the extractor fix alone can
 * never reach — the cache is permanent. A rendered physical line whose values
 * fail the same validity test the extractor now applies IS poison, so the
 * existing self-heal rebuilds it from a fresh fetch. One definition, both ends.
 */
function physicalImplausible(physical) {
    if (!physical) return false;
    return String(physical).split(/;\s*/).some(part => {
        const i = part.indexOf(":");
        if (i < 0) return false;
        const val = part.slice(i + 1).trim();
        return !!val && !plausibleFieldValue(part.slice(0, i).trim(), val);
    });
}
function entryPoisoned(entry) {
    const sec = entry && entry.sections;
    if (!sec) return false;
    if (physicalImplausible(sec.physical)) return true;
    return ["look", "physical", "identity", "personality", "relationship", "biography", "abilities", "trivia", "voice"]
        .some(k => sec[k] && SECTION_JUNK.test(sec[k]));
}

function normWikiSet(csv) {
    return [...new Set(String(csv || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean))].sort();
}

/** Does this negative verdict still speak for the CURRENT wiki list?
 *  A miss is a fact about the wikis that were searched, nothing more. When the
 *  user adds a wiki (the usual reason: crossover characters kept missing), every
 *  old "not found" is silent about the new wiki and must not block a re-search.
 *  Removing a wiki changes nothing (still covered). Legacy negatives carry no
 *  `searched` stamp — always stale, so pre-existing dead rows revive once. */
function missCoversCurrentWikis(entry, wikisCsv) {
    if (!entry || !Array.isArray(entry.searched)) return false;
    return normWikiSet(wikisCsv).every(w => entry.searched.includes(w));
}

/**
 * Build every injected section from a page's wikitext. Extracted from
 * ensureGrounded so the poisoned-cache self-heal can rebuild an existing
 * entry with the exact same logic a fresh grounding uses — one definition,
 * both paths, no drift.
 */
async function buildEntrySections(wiki, title, wikitext, s, isCharacter) {
    // Physical: infobox hair/eyes (robust extractor handles piped links and
    // <br> lists), else prose appearance with the "pink hair and eyes" handling.
    // Prose is read from the wikitext we already have; the extract fetch remains
    // only as a last resort.
    const appearanceProse = cleanWikitext(
        extractSectionRaw(wikitext, ["appearance", "physical appearance", "physical description", "looks"], 4000)
    );
    let physical = extractInfoboxFields(wikitext, s.fields.split(","));
    if (!physical) {
        physical = extractFromProse(appearanceProse || extractLead(wikitext, 1200));
        if (!physical) physical = extractFromProse(await fetchExtract(wiki, title));
    }
    // The LOOK: the Appearance section's opening description, kept as the
    // wiki wrote it — build, complexion, clothing, all of it.
    const look = tightenLook(extractLookProse(appearanceProse), title);
    // CORE-ATTRIBUTE COMPLETION — dialect-proof: if neither the infobox line
    // nor the look prose carries hair/eyes but the page mentions them, mine
    // the phrase. Hair can never vanish to an infobox quirk.
    const proseBits = extractFromProse(appearanceProse) || "";
    for (const attr of ["hair", "eye"]) {
        if (new RegExp(attr, "i").test(physical + " " + look)) continue;
        const bit = proseBits.split(/;\s*/).find(p => new RegExp(attr, "i").test(p));
        if (bit) physical = physical ? `${physical}; ${bit.trim()}` : bit.trim();
    }
    // Distinguishing details BEYOND the look window still append — Gamma's
    // mole may be sentence four; inside the window it's already in the look.
    const notable = extractDistinguishing(appearanceProse.slice(look.length));
    if (notable) physical = physical ? `${physical}; notably: ${notable}` : notable;

    const relKw = s.relationshipKeywords.split(",");
    const bioKw = s.biographyKeywords.split(",");
    const perKw = s.personalityKeywords.split(",");
    const abiKw = s.abilitiesKeywords.split(",");
    const join = (...parts) => [...new Set(parts.filter(Boolean))].join(" — ");

    const sections = {
        // Identity is the single highest-value string on any wiki page —
        // always extracted, always injected (≤260 chars).
        identity: identityLine(wikitext),
        physical,
        // Personality sections open with the absolutist thesis ("stern and
        // unyielding") and record the humanizing exceptions and growth near
        // the BOTTOM. A 500-char top-slice injected only the robot half —
        // sample head + tail (the dossier digest's trick) so the baseline
        // carries the contradictions too.
        personality: join(
            extractInfoboxFields(wikitext, perKw),
            sampleSection(extractSection(wikitext, perKw, 4000), 500)
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
    // section. One extra fetch, at build time, only when the main page had
    // none. Gated on the CHARACTER signal: places/organizations don't get
    // quote subpages, so probing them is a guaranteed dead round trip.
    if (s.voice && !sections.voice && isCharacter) {
        try {
            const qp = await fetchWikitext(wiki, `${title}/Quotes`);
            if (qp) sections.voice = extractQuotes(qp);
        } catch (e) { /* best-effort */ }
    }
    if (look) sections.look = look;
    return sections;
}

async function ensureGrounded(name, trusted = false) {
    const s = settings();
    const key = name.toLowerCase();
    const c = cache();
    // The same character may already be grounded under a DIFFERENT key — e.g. "alya"
    // resolved to the page "Alisa Mikhailovna Kujou", or "Kenpachi Zaraki" grounded
    // as "Kenpachi Zaraki (bleach)". A found entry beats any stale miss at this key
    // (cacheEntryFor buries the corpse itself), so this check runs FIRST.
    const aliasHit = cacheEntryFor(key);
    if (aliasHit) return aliasHit.entry;

    const existing = c[key];
    if (existing && existing.sections) {
        if (existing.found) return existing;                       // already grounded
        if (Date.now() - existing.ts < negativeTtl(existing)) {
            // A page rejected ONLY because it didn't look like a character can still be
            // valid lore (a place/org). If the caller now trusts it (LLM parser), re-fetch
            // instead of reusing the untrusted miss; otherwise honor the recent miss —
            // but only if it was searched against every wiki now configured. A miss
            // recorded before the user added a wiki says nothing about that wiki.
            if (!missCoversCurrentWikis(existing, activeWikis())) {
                debug(`↻ wiki list grew since "${name}" missed — re-searching`);
            } else if (!(existing.reason === "not-character" && trusted)) return existing;
        }
    }

    const wikis = activeWikis().split(",").map(w => w.trim()).filter(Boolean);
    let hadError = false;          // network / HTTP / parse failure (transient — retry later)
    let missReason = "no-page";    // upgraded to "meta-page" / "not-character" / "no-facts" as we learn more

    for (const wiki of wikis) {
        try {
            const title = await findPageTitle(wiki, name);
            if (!title) continue; // no such page on this wiki — a real miss, not an error

            const wikitext = await fetchWikitext(wiki, title);

            // PAGE VALIDITY, before anything reads this text. A disambiguation page
            // ("Rose may refer to: …") and the franchise's own page ("Bleach is a
            // Japanese manga series…") are not entities in ANY sense — one is a
            // router, the other is about the media product, not the world. Trust
            // cannot overrule this: the caller vouched for the NAME, we chose the
            // PAGE, so a trusted name lands here too. Its own miss reason, because
            // "not-character" is the reason that gets re-fetched for trusted callers
            // (a place/org is still valid lore) — a meta page never becomes valid, so
            // it must settle instead of re-fetching the same dead page every turn.
            if (isDisambiguation(wikitext) || isMetaSeriesPage(wikitext)) {
                missReason = "meta-page";
                debug(`⚠ "${title}" is a disambiguation/series page, not an entity — skipped`);
                continue;
            }

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

            // One builder for fresh grounding AND the poisoned-cache self-heal —
            // same logic, one definition, no drift (see buildEntrySections).
            const sections = await buildEntrySections(wiki, title, wikitext, s, !!(charSignal || charSection));

            const anything = Object.values(sections).some(Boolean);
            if (anything) {
                // Remember the character's other names (nickname/alias fields) plus the
                // term we searched with, so any of them match this entry later.
                const aliases = extractAliases(wikitext, s.aliasKeywords.split(","));
                // COVERAGE GUARD: the page must account for every meaningful token of
                // the query — title or aliases. A fuzzy search landing "Miyake Kakeru"
                // on "Akito Miyake" grounds a hallucinated hybrid onto a real-but-
                // wrong person; that's a MISS, not a match. ("Alya" → alias passes.)
                if (!titleCoversQuery(name, title, aliases)) {
                    debug(`"${title}" does not cover query "${name}" (missing token) — treated as miss`);
                    continue;   // try the next wiki; negative-caches below if none pan out
                }
                if (name && name.toLowerCase() !== title.toLowerCase()) aliases.push(name);
                // Raw material for per-pair dynamics: the whole Relationships subtree,
                // subsection headers intact, so relationFor can slice "how A is with B"
                // at note time for exactly the pair that's on screen.
                const relRaw = extractSectionRaw(wikitext, ["relationships", "relationship"], 4000);
                const kind = (charSignal || charSection) ? "character" : "place";
                c[key] = { name: title, sections, aliases, relRaw, rel: {}, wiki, kind, found: true, ts: Date.now() };
                // LLM curation runs in the BACKGROUND — this turn ships the regex
                // sections immediately, the dossier upgrades every turn after.
                if (s.llmDossier && (charSignal || charSection)) scheduleDossier(c[key], title, wikitext, relRaw);
                saveCache();
                const got = Object.entries(sections).filter(([, v]) => v).map(([k]) => k).join(", ");
                debug(`✓ ${title}${aliases.length ? " (aka " + aliases.slice(0, 4).join(", ") + ")" : ""} → ${sections.physical || "(no appearance)"} [have: ${got}]`);
                return c[key];
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
        c[key] = { name, sections: {}, wiki: null, found: false, reason: missReason, searched: normWikiSet(activeWikis()), ts: Date.now() };
        saveCache();
        debug(`✕ no usable wiki page for "${name}" on: ${activeWikis()}`);
    }
    return c[key] || { name, sections: {}, found: false };
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
    saveCache();
}

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
            const rn = typeof r === "string" ? r : r.name;
            if (rn && !cacheEntryFor(String(rn).toLowerCase())) wanted.push(rn);
        }
    }
    if (wanted.length) await groundNames(wanted, true);
}

const CANON_INTENTS = new Set(["ground", "pin", "block", "arc", "note", "info"]);

/** Parse the Ask-Canon router's JSON verdict into a safe {action, target}. */
function parseCanonIntent(text) {
    const obj = parseJsonCandidates(text, "{", "}", v => v && typeof v === "object" && !Array.isArray(v));
    if (!obj || typeof obj.action !== "string") return null;
    const action = obj.action.trim().toLowerCase();
    const target = typeof obj.target === "string" ? obj.target.trim() : "";
    if (!CANON_INTENTS.has(action) || !target) return null;
    return { action, target: clip(target, 300) };
}

/**
 * 🗣 ASK CANON — say what you want in plain words; a tiny router call maps it to
 * the extension's own primitives and executes. "inject rose oriana" → ground +
 * always-present pin; "set arc to lawless city" → story position; "never show
 * ryoko" → blocklist; "remember: the engagement is broken" → chat pin text;
 * "what do you know about beatrix" → ground + show her dossier. User commands
 * are sovereign — no evidence gate applies to what you explicitly order.
 */
async function askCanon(request) {
    const myEpoch = chatEpoch;   // the command was typed IN a chat; its writes must never follow the user to another one
    const systemText = (settings().promptAsk || "").trim() || DEFAULT_PROMPT_ASK;
    const out = await llmCall(systemText, request, { maxTokens: 120, budgetMs: Math.min(Number(settings().parserBudgetMs) || 30000, 12000) });
    const intent = out && parseCanonIntent(out);
    if (!intent) return { ok: false, msg: lastLlmError || "couldn't understand that — try e.g. \"pin Rose Oriana\" or \"set arc to Lawless City\"" };
    if (myEpoch !== chatEpoch) return { ok: false, msg: "chat changed while the command was being read — dropped (it was aimed at the previous chat)" };
    const t = intent.target;
    const ctx = getContext();
    switch (intent.action) {
        case "ground": {
            await groundNames([t], true);
            const hit = cacheEntryFor(t.toLowerCase());
            return hit && hit.entry.found
                ? { ok: true, msg: `grounded ${hit.entry.name} — ${clip((hit.entry.dossier && hit.entry.dossier.identity) || hit.entry.sections.identity || "no identity on the page", 140)}` }
                : { ok: false, msg: `no usable wiki page found for "${t}"` };
        }
        case "pin": {
            await groundNames([t], true);
            if (myEpoch !== chatEpoch) return { ok: false, msg: "chat changed — pin dropped (it was aimed at the previous chat)" };
            const cur = chatPinNames();
            if (!cur.some(n => n.toLowerCase() === t.toLowerCase())) {
                setChatPin("canon_grounding_pin_names", [...cur, t].join(", "));
            }
            if (renderChatScoped) try { renderChatScoped(); } catch (e) {}
            return { ok: true, msg: `pinned — ${t} now injects every turn in this chat` };
        }
        case "block": {
            const cur = chatBlockNames();
            if (!cur.some(n => n.toLowerCase() === t.toLowerCase())) {
                setChatPin("canon_grounding_block", [...cur, t].join(", "));
            }
            if (renderChatScoped) try { renderChatScoped(); } catch (e) {}
            return { ok: true, msg: `blocked — ${t} will never inject in this chat` };
        }
        case "arc": {
            const got = await groundArc(t);
            if (myEpoch !== chatEpoch) return { ok: false, msg: "chat changed — story position not pinned (the command was aimed at the previous chat)" };
            if (renderArcStatus) try { renderArcStatus(); } catch (e) {}
            return got ? { ok: true, msg: `story position → ${got.title}` }
                       : { ok: false, msg: `no arc/chapter page found for "${t}"` };
        }
        case "note": {
            const cur = chatPin();
            setChatPin("canon_grounding_pin", cur ? cur + "\n" + t : t);
            if (renderChatScoped) try { renderChatScoped(); } catch (e) {}
            return { ok: true, msg: "noted — added to this chat's pinned canon" };
        }
        case "info": {
            await groundNames([t], true);
            const hit = cacheEntryFor(t.toLowerCase());
            if (!hit || !hit.entry.found) return { ok: false, msg: `nothing on the wiki for "${t}"` };
            const e = hit.entry;
            const d = normalizeDossier(e.dossier);
            const bits = [
                (d && d.identity) || e.sections.identity,
                d && d.facts.length ? `Facts: ${d.facts.slice(0, 2).join("; ")}` : "",
                d && d.secrets.length ? `${d.secrets.length} guarded secret(s)` : "",
            ].filter(Boolean).join(" · ");
            return { ok: true, msg: `${e.name}${d ? " ✦" : ""}: ${clip(bits || "grounded, thin page", 260)}` };
        }
    }
    return { ok: false, msg: "unknown action" };
}

/**
 * Ground a story ARC / CHAPTER / EPISODE page and pin its summary as the current
 * story position. Character lookups reject these titles on purpose (isMediaTitle);
 * here they are the point, so this path does its own exact-then-search resolution.
 */
async function groundArc(query, opts = {}) {
    const myEpoch = chatEpoch;   // arc pinning is FOR the chat that asked — a switch during the fetches below must drop it, not re-target it
    const mode = opts.mode === "begun" ? "begun" : "reached";
    const s = settings();
    const wikis = activeWikis().split(",").map(w => w.trim()).filter(Boolean);
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
            // A router page pinned as the story position is the same wrong-info as a
            // router page grounded as a character: extractLead would pin "X may refer
            // to: …" as where the story stands. (isMetaSeriesPage is deliberately NOT
            // applied here — an arc page legitimately describes its own series.)
            if (isDisambiguation(wikitext)) {
                debug(`⚠ arc "${title}" is a disambiguation page — skipped`);
                continue;
            }
            const summary = extractSection(wikitext, ["summary", "plot", "synopsis", "overview", "story", "events"], 900)
                || extractLead(wikitext, 900);
            if (!summary) continue;
            if (myEpoch !== chatEpoch) return null;   // chat switched mid-fetch: pinning now would stamp the OLD story's position onto the NEW chat
            const base = { query, title, wiki, summary, ts: Date.now() };
            if (opts.name) base.name = opts.name;
            // ONE writer for the transition: manual (reached) wipes the tracker's
            // memory — the user redefined the timeline; auto (begun) records the
            // superseded position so the story can never slide back to it.
            const t = arcTransition(chatArc(), chatArcReached(), base, mode);
            setChatArc(t.note);
            setChatPin("canon_grounding_arc_reached", t.reached);
            s.arcTitle = query;               // remembered globally as input convenience only
            saveSettingsDebounced();
            debug(`✓ story position → ${title} (${wiki})${mode === "begun" ? " — just beginning" : ""}`);
            return t.note;
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
 * STORY POSITION is a HIGH-WATER MARK. arcAlreadyReached answers "has this
 * chat's story already been at this event?" — true for the current position
 * (under any of its names: resolved title, original query, triggering entity)
 * and for every position the auto-tracker has superseded. A reached event
 * re-entering the scene is a reference, a memory, or a flashback: the position
 * must not regress to it, and no referee call is spent on it.
 */
function arcAlreadyReached(candidate, curNote, reached) {
    const lc = normName(candidate);
    if (!lc) return false;
    if (curNote && [curNote.title, curNote.query, curNote.name].some(x => x && normName(x) === lc)) return true;
    return (Array.isArray(reached) ? reached : []).some(x => normName(x) === lc);
}

/**
 * ONE writer for a story-position transition. mode "reached" is a USER DECREE
 * (settings box, Ask Canon): the user redefined the timeline, so the tracker's
 * memory of superseded positions is wiped — the story may be replayed forward
 * through them again. mode "begun" is the AUTO-TRACKER advancing: the outgoing
 * position joins the reached list (title, query, and triggering entity name
 * all count) so the story can never slide back to it on a mention.
 */
function arcTransition(prevNote, reached, note, mode) {
    if (mode !== "begun") return { note: { ...note, mode: "reached" }, reached: [] };
    const out = (Array.isArray(reached) ? reached : []).map(x => normName(x)).filter(Boolean);
    for (const x of prevNote ? [prevNote.title, prevNote.query, prevNote.name] : []) {
        const lc = normName(x || "");
        if (lc && !out.includes(lc)) out.push(lc);
    }
    return { note: { ...note, mode: "begun" }, reached: out };
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
/** The auto-tracker's per-chat memory of superseded positions (see arcTransition). */
function chatArcReached() {
    try {
        const r = getContext().chatMetadata?.canon_grounding_arc_reached;
        return Array.isArray(r) ? r : [];
    } catch (e) { return []; }
}
function chatPin() {
    try { return getContext().chatMetadata?.canon_grounding_pin || ""; } catch (e) { return ""; }
}
/**
 * THE CANON CACHE IS CHAT-SCOPED (like Summaryception): each chat is its own
 * universe — grounded entities, dossiers, pair dynamics all live in chat
 * metadata, so switching stories never bleeds canon across universes and
 * BRANCHES INHERIT everything (ST copies chat metadata on branch). Falls back
 * to the legacy global store only when no chat metadata exists (very old ST,
 * or test sandboxes without a context).
 */
function cache() {
    try {
        const md = getContext().chatMetadata;
        if (md) {
            if (!md.canon_grounding_cache) md.canon_grounding_cache = {};
            return md.canon_grounding_cache;
        }
    } catch (e) { /* no context */ }
    const s = settings();
    if (!s.cache) s.cache = {};
    return s.cache;
}
let saveCacheT = null;
function saveCache() {
    try {
        const ctx = getContext();
        if (ctx.chatMetadata && typeof ctx.saveMetadata === "function") {
            clearTimeout(saveCacheT);
            saveCacheT = setTimeout(() => { try { ctx.saveMetadata(); } catch (e) {} }, 400);
            return;
        }
    } catch (e) { /* fall through */ }
    saveSettingsDebounced();
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
    const markers = ["[Story memory", "[AUTHORITATIVE SOURCE CANON", "[CANON NOTES", "[CANON REFERENCE", "[Canonical reference", "[Plot essential"];
    // The natural-voice header begins "<name>'s note — canon" — any persona
    // name, or the Author's-note fallback; history outlives persona renames.
    const noteHeaderRe = /^[^\n]{0,42}'s note — canon/m;
    const visible = chat.filter(m =>
        !m.is_system && !markers.some(mk => (m.mes || "").includes(mk)) && !noteHeaderRe.test(m.mes || "")
    );
    return visible.slice(-Math.max(1, windowSize)).map(m => stripMetaBlocks(m.mes || ""));
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
 * ONE canonical form for a name used as a key or compared against another name.
 * Wikis, models, and human typing disagree about which apostrophe they use
 * ("Room's" vs "Room’s"); without a canonical form the same name is two
 * different strings and every exact-match lookup silently misses.
 */
const APOSTROPHES = /['’‘‛´`]/g;
function normName(n) {
    return String(n || "").toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // fold diacritics: Ayanokōji ≡ Ayanokoji
        .replace(APOSTROPHES, "'");
}
/** Regex source for a name that matches any apostrophe dialect. */
function nameRegexSource(name) { return escapeRegex(String(name)).replace(APOSTROPHES, "['’‘‛´`]"); }

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
    if (/[^\x00-\x7F]/.test(name)) return normName(lowerText).includes(normName(name));
    try {
        return new RegExp(`(^|[^a-z0-9])${nameRegexSource(name)}([^a-z0-9]|$)`, "i").test(lowerText);
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
function cacheEntryFor(nameLcRaw) {
    const c = cache();
    const nameLc = normName(nameLcRaw);
    if (c[nameLc] && c[nameLc].found && c[nameLc].sections) {
        return { key: nameLc, entry: c[nameLc] };
    }
    for (const [k, e] of Object.entries(c)) {
        if (!e.found || !e.sections) continue;
        const names = [e.name && normName(e.name), normName(k), ...(e.aliases || []).map(normName)].filter(Boolean);
        if (names.includes(nameLc)) {
            // The same entity grounded under another key (suffixed/canonical query)
            // while a stale "not found" sits at THIS key — a corpse that shadows the
            // real entry for the parser gate and haunts the panel as a duplicate ✕
            // row. Every resolver path funnels through here: bury it on sight.
            if (c[nameLc] && !c[nameLc].found) { delete c[nameLc]; saveCache(); debug(`⚰ stale miss "${nameLc}" buried — found as "${e.name}"`); }
            return { key: k, entry: e };
        }
    }
    // PASS 2 — a WHOLE TOKEN of exactly one character's NAME: "Rukia" must find
    // "Rukia Kuchiki" without a parser round trip. NAME tokens only — aliases stay
    // exact-match (pass 1): epithet aliases ("Bee Commander") and suffixed cache
    // keys ("… (bleach)") are full of generic words, and token-matching them let
    // ordinary prose resolve to characters who aren't even in play. A token two
    // DIFFERENT characters share ("Kotetsu" with both sisters cached) resolves to
    // nothing — no guessing; the parser can disambiguate that one.
    if (nameLc.length >= 3 && !NOISE_WORDS.has(nameLc)) {
        let hit = null;
        for (const [k, e] of Object.entries(c)) {
            if (!e.found || !e.sections) continue;
            const toks = String(e.name || "").toLowerCase()
                .split(/[^\p{L}\p{N}'-]+/u).filter(t => t.length >= 3 && !NOISE_WORDS.has(t));
            if (toks.includes(nameLc)) {
                if (hit && hit.entry.name !== e.name) return null;   // shared by two characters
                if (!hit) hit = { key: k, entry: e };
            }
        }
        if (hit) {
            if (c[nameLc] && !c[nameLc].found) { delete c[nameLc]; saveCache(); debug(`⚰ stale miss "${nameLc}" buried — found as "${hit.entry.name}"`); }
            return hit;
        }
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
    // A NEGATIVE delta means the chat SHRANK (messages deleted/swiped away) —
    // the anchor is gone, not the grace period. Falling through to the mention
    // check against the window that exists NOW is the only sound move; treating
    // shrinkage as "within grace" froze decay and pinned ghosts forever.
    const delta = visibleLen - lastCastLen;
    if (delta >= 0 && delta <= s.contextWindow) return [...lastCast];
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
    const neg = cache()[lc];
    if (neg && !neg.found && (Date.now() - neg.ts < negativeTtl(neg))
        && missCoversCurrentWikis(neg, activeWikis())) return false;         // fresh miss, list unchanged
    return true;
}

/** parsedWords stops re-showing the parser words it already ruled on — but a
 *  "not found" ruling is a fact about the wiki list that produced it. When the
 *  list has since grown, THAT word's veto is void; verdicts about non-names
 *  (never cached) rightly survive wiki changes. */
function parserMayRevisit(n) {
    const lc = n.toLowerCase();
    if (!isUnhandledName(n)) return false;
    if (!parsedWords.has(lc)) return true;
    const neg = cache()[lc];
    return !!(neg && !neg.found && !missCoversCurrentWikis(neg, activeWikis()));
}

/**
 * How much of `text` is actually IN PLAY right now. Word-boundary matching, not
 * substring — "Wind Read" must not score off "bread", "Star" must not score off
 * "started". Distinct tokens only, so repetition can't inflate a score.
 */
function inPlayScore(text, play) {
    if (!text || !play) return 0;
    const toks = [...new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(t => t.length >= 4))];
    return toks.reduce((a, t) => a + (mentioned(t, play) ? 1 : 0), 0);
}

/**
 * ONE Abilities emitter for every branch — SCENE-CONDITIONAL by design. A
 * character's named techniques and their limits are the difference between a real
 * fight and invented nonsense, and dead weight in a conversation. They ride when
 * the scene touches them (token overlap) or when the moment is about conflict at
 * all; otherwise they cost nothing. Curated dossier entries preferred; the regex
 * section is the fallback so a pre-abilities dossier still answers.
 */
function abilityLine(entry, inPlay) {
    const s = settings();
    if (!s.abilities) return "";
    const d = entry.dossier;
    const list = (d && Array.isArray(d.abilities) && d.abilities.length)
        ? d.abilities
        : ((entry.sections && entry.sections.abilities) ? [entry.sections.abilities] : []);
    if (!list.length) return "";
    const play = String(inPlay || "").toLowerCase();
    const scored = list.map(a => ({ a, score: inPlayScore(a, play) }));
    const hot = scored.filter(x => x.score > 0).sort((x, y) => y.score - x.score).map(x => x.a);
    // The two triggers COMPOSE, they don't compete. A fight needs the arsenal
    // (relevance-ordered); a quiet scene that merely names one technique needs
    // that technique and nothing else. Scoring must never NARROW the answer
    // below what a bare combat scene would have shown.
    const ordered = [...hot, ...list.filter(a => !hot.includes(a))];
    const take = COMBAT_WORDS.test(play) ? ordered.slice(0, 3) : hot.slice(0, 2);
    return take.length ? `  - Abilities: ${take.join("; ")}` : "";
}

/**
 * ONE Appearance emitter for every branch: the wiki's own opening description
 * as prose, with exact infobox facts as a compact deduped bracket — a fact
 * whose value the prose already states stays home.
 */
function appearanceLine(entry) {
    const look = (entry.sections && entry.sections.look) || "";
    let facts = (entry.sections && entry.sections.physical) || "";
    if (!look && !facts) return "";
    if (look && facts) {
        // WORD-BOUNDARY dedupe. Raw substring containment silently deleted true
        // facts whose value happens to sit inside an unrelated word: "hair: red"
        // vanished because the look prose said "shredded", "eyes: tan" because it
        // said "distant". A fact is only redundant when the prose states THAT WORD.
        const lookLc = look.toLowerCase();
        facts = facts.split(/;\s*/).filter(f => {
            const val = (f.split(":")[1] || f).trim().toLowerCase();
            return val && !mentioned(val, lookLc);
        }).join("; ");
    }
    return look ? `  - Appearance: ${look}${facts ? ` [${facts}]` : ""}` : `  - Appearance: ${facts}`;
}

/** Ambient status/meta blocks other extensions weave into messages —
 *  "[ACW: Hiyori Shiina | Library | calm]", "[HUD: …]", "[OOC: …]" — are UI,
 *  not scene. Left in, they hand the parser a roll call of every tracked
 *  character and give the sweep a page of proper-noun names for people who
 *  are nowhere near the scene. ALL-CAPS-tag brackets only, so "[sic]",
 *  "[laughs]", and name-tagged dialogue ("[Kiyotaka: …]") survive. An
 *  unclosed block drops to the end of its LINE. */
function stripMetaBlocks(text) {
    // A block's terminator must be its OWN. The closed-block branch may cross
    // newlines (blocks legitimately wrap) but NOT another block's OPENER: the
    // old rule ([^\]]*) let an unclosed marker borrow the "]" belonging to a
    // LATER, well-formed marker and erase every paragraph in between. With
    // Summaryception running, two markers in one message is the normal case,
    // so one stream-cut "[IST: ..." blanked the entire scene - the matcher saw
    // nothing, the note came out empty, and the diagnosis blamed [META:] for a
    // cast that was sitting in the prose all along.
    // No terminator of its own => unclosed => strip to the end of its LINE (a
    // stream cut IS the end of the message, so that case still strips whole).
    return String(text || "").replace(/\[[A-Z][A-Z0-9 _&-]{1,14}:(?:[^\]\[]*\]|[^\]\n]*)/g, " ");
}

/**
 * Why is the note empty? MEASURED, never asserted. Reports what actually exists
 * (found entries, scene size, cast, pins, whether the setting pin resolves) and
 * hunts for the nearest miss: a cached name visible in the RAW scene but not in
 * the STRIPPED scene means the name lives only inside [META:] blocks — the
 * matcher is meta-blind by design, and this says so instead of shrugging.
 */
function emptyNoteDiagnosis(rawMsgs, castNames, extras = {}) {
    try {
        const store = cache();
        const found = Object.entries(store).filter(([, e]) => e && e.found && e.sections);
        const raw = (rawMsgs || []).join("\n");
        const stripped = (rawMsgs || []).map(stripMetaBlocks).join("\n");
        const rawLc = raw.toLowerCase(), strippedLc = stripped.toLowerCase();
        const bits = [];
        bits.push(`scene: ${(rawMsgs || []).length} msg / ${raw.length} chars`);
        bits.push(`cache: ${found.length} found entr${found.length === 1 ? "y" : "ies"}`);
        bits.push(`cast: ${(castNames || []).length}`);
        const pinCt = (extras.pinNames || []).filter(Boolean).length;
        if (pinCt) bits.push(`pins: ${pinCt}`);
        if (extras.settingKey) {
            const sk = String(extras.settingKey).toLowerCase();
            const ok = (store[sk] && store[sk].found) || cacheEntryFor(sk);
            bits.push(ok ? `setting pin resolves ("${extras.settingKey}")` : `setting pin DANGLES ("${extras.settingKey}" has no cache entry)`);
        }
        const metaOnly = [], nowhere = [];
        for (const [key, e] of found) {
            const names = [e.name, key, ...(e.aliases || [])].filter(Boolean).map(n => String(n).toLowerCase());
            const inRaw = names.some(n => mentioned(n, rawLc));
            const inStripped = names.some(n => mentioned(n, strippedLc));
            if (inRaw && !inStripped) metaOnly.push(e.name);
            else if (!inRaw) nowhere.push(e.name);
        }
        if (metaOnly.length) bits.push(`\u26a0 named ONLY inside [META:] blocks (stripped before matching): ${metaOnly.slice(0, 4).join(", ")}`);
        if (nowhere.length && nowhere.length === found.length) bits.push("no cached name appears anywhere in the window");
        return bits.join(" \u00b7 ");
    } catch (e) { return "diagnosis failed: " + e.message; }
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
    const msgs = (sceneMsgs || []).map(stripMetaBlocks);
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
    const usedKeysGlobal = new Set();   // CACHE-KEY space
    const usedNamesGlobal = new Set();  // ENTITY-NAME space — kept strictly separate:
    // the same person cached under two keys ("ken" + "kenpachi zaraki (bleach)")
    // must admit once, and two different people must never shadow each other.
    /**
     * The ONE door into `present`. Every tier funnels through it, so the blocklist
     * is enforced once, at admission — not at emit time, where a forbidden entity
     * had already been seen by the pair-dynamics builder ("With <blocked>: …"),
     * by the Context de-dup set, and by the reasons panel. Blocked means absent.
     * Name-space dedupe also kills the phantom-PAIR bug: a duplicate entry under
     * a second key is a different OBJECT, so `other === entry` didn't skip it and
     * a character could get a "With <themselves>: …" dynamics line.
     */
    const admit = (entry, matchedName, key, flags = {}) => {
        if (!entry) return false;
        const nk = (entry.name || "").toLowerCase();
        if (usedKeysGlobal.has(key) || (nk && usedNamesGlobal.has(nk))) return false;
        if (isBlocked(entry, matchedName)) return false;
        usedKeysGlobal.add(key);
        if (nk) usedNamesGlobal.add(nk);
        present.push({ entry, matchedName, ...flags });
        return true;
    };
    // Pinned entities ride FIRST, always — no cast, no mention, no scene required.
    for (const pn of pinNames) {
        const found = cacheEntryFor(pn.toLowerCase());
        if (found) admit(found.entry, pn, found.key, { pinned: true });
    }
    // CURRENT SETTING: the location the story is in persists WITHOUT mention — it
    // is where the scene happens, not something the prose must keep naming. Set by
    // the parser whenever a place enters the cast; superseded by the next place;
    // removable via the blocklist.
    const store = cache();
    if (extras.settingKey) {
        const sk = String(extras.settingKey).toLowerCase();
        const direct = store[sk] && store[sk].found ? { key: sk, entry: store[sk] } : cacheEntryFor(sk);
        if (direct) admit(direct.entry, direct.entry.name, direct.key, { setting: true });
    }

    // PRIORITY TIERS (decree over inference): characters the PLAYER just named
    // outrank everything but pins and the setting; the story's own ledger cast
    // comes second; the parser's cast third; the sweep last. Caps always trim
    // from the bottom, so the people you are actually talking to survive.
    for (const un of (extras.userNames || [])) {
        const found = cacheEntryFor(String(un).toLowerCase());
        if (found) admit(found.entry, un, found.key);
    }
    for (const ln of (extras.ledgerNames || [])) {
        const found = cacheEntryFor(String(ln).toLowerCase());
        if (found) admit(found.entry, ln, found.key);
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
            if (found) admit(found.entry, cn, found.key);
        }
        // SMART SWEEP: the parser's cast is pronoun-proof but gated — it can lag the
        // story (or be down entirely). Any entity we ALREADY KNOW (cached) that is
        // named in the recent scene — including by the AI's own output — injects
        // immediately, no parser round trip required. The AI saying "Alpha" is all
        // the evidence needed: she's cached.
        // token → owning character across the cache: a NAME token unique to ONE
        // character ("Rukia") counts as a mention of them; a shared token
        // ("Kuchiki") never does. Name tokens only — alias/key tokens are full of
        // generic words and swept in characters nowhere near the scene.
        const tokenOwner = new Map();
        for (const e2 of Object.values(store)) {
            if (!e2.found || !e2.sections) continue;
            for (const t of String(e2.name || "").toLowerCase().split(/[^\p{L}\p{N}'-]+/u)) {
                if (t.length < 3 || NOISE_WORDS.has(t)) continue;
                const cur = tokenOwner.get(t);
                if (cur !== undefined && cur !== (e2.name || "")) tokenOwner.set(t, "\u0000AMBIG");
                else tokenOwner.set(t, e2.name || "");
            }
        }
        for (const key of Object.keys(store)) {
            const entry = store[key];
            if (!entry.found || !entry.sections || usedKeysGlobal.has(key)) continue;
            // (name-space duplicates are rejected inside admit() — see usedNamesGlobal)
            const names = [entry.name.toLowerCase(), key, ...(entry.aliases || []).map(a => a.toLowerCase())].filter(Boolean);
            let hit = "";
            for (let i = lowerMsgs.length - 1; i >= 0 && !hit; i--) hit = names.find(n => mentioned(n, lowerMsgs[i])) || "";
            if (!hit) {
                // First-name sweep: "you talked to Rukia" must pull Rukia Kuchiki in.
                // PROPER-NOUN usage required: the token must appear in the scene with
                // its name casing ("Rukia"), so ordinary prose ("the ice cracked")
                // can never summon an off-screen character whose name shares a word.
                const toks = [...new Set(String(entry.name || "").split(/[^\p{L}\p{N}'-]+/u)
                    .filter(t => t.length >= 3 && /^\p{Lu}/u.test(t) && !NOISE_WORDS.has(t.toLowerCase())
                        && tokenOwner.get(t.toLowerCase()) === (entry.name || "")))];
                for (let i = msgs.length - 1; i >= 0 && !hit; i--) {
                    const m = msgs[i];
                    hit = toks.find(t => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(t)}(?![\\p{L}\\p{N}])`, "u").test(m)) || "";
                }
                if (hit) hit = hit.toLowerCase();
            }
            if (hit) admit(entry, hit, key, { swept: true });
        }
    } else {
        // Scene-scan fallback (regex mode): grounded names actually in the recent window.
        const lgNames = (!s.llmParser) ? ledgerNames() : null;
        const ledger = lgNames ? new Set(lgNames.map(n => n.toLowerCase())) : null;
        const scored = [];
        for (const key of Object.keys(store)) {
            const entry = store[key];
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
        for (const sc of scored) admit(sc.entry, sc.matchedName, sc.key);
    }

    const blocks = [];
    const reasons = [];
    const seenEntities = new Set();  // one block per CHARACTER, even if cached under two keys
    let total = 0;
    for (const { entry, matchedName, pinned, swept, setting } of present) {
        if (blocks.length >= s.maxCharacters) break;
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
            // normalizeDossier: a legacy-shaped cached dossier must degrade to
            // empty fields, never throw mid-note and kill the whole injection.
            const d = normalizeDossier(entry.dossier);
            const identity = d.identity || entry.sections.identity;
            if (s.proseBriefs && d.brief) {
                // The curator's WRITTEN briefing — prose, not a database row.
                lines.push(`  ${d.brief}`);
            } else if (identity) {
                lines.push(`  - Identity: ${identity}`);
            }
            const nf = focusLine(); if (nf) lines.push(nf);
            if (s.physical) {
                const al = appearanceLine(entry);
                if (al) lines.push(al);
            }
            // In prose-brief mode the identity line is NOT printed — the brief is — so
            // deduping facts against identity alone let every fact the BRIEF already
            // stated ride along a second time, on every character, on every turn.
            const shownLc = ((s.proseBriefs && d.brief ? d.brief + " " : "") + (identity || "")).toLowerCase();
            const pool = d.facts.filter(f => !shownLc.includes(f.toLowerCase().replace(/[.?!]$/, "")));
            // Scene-conditional selection, same trick as Now/Context: score each fact
            // against what is IN PLAY; matched facts surface first (up to 5), and an
            // idle scene shows only the 3 anchors — curation once, selection free.
            const inPlayF = ((castFocus[nameKey] || "") + " " + lowerMsgs.slice(-2).join(" ")).toLowerCase();
            const scoredF = pool.map(f => ({ f, score: inPlayScore(f, inPlayF) }));
            const hot = scoredF.filter(x => x.score > 0).sort((a, b) => b.score - a.score).map(x => x.f);
            const facts = hot.length ? [...hot, ...pool.filter(f => !hot.includes(f))].slice(0, 5) : pool.slice(0, 3);
            if (facts.length) lines.push(`  - Facts: ${facts.join("; ")}`);
            lines.push(...dynLines());
            const al2 = abilityLine(entry, inPlayF); if (al2) lines.push(al2);
            const voice = (s.voice && (d.voice.length ? d.voice.map(q => `"${q}"`).join(" / ") : entry.sections.voice)) || "";
            if (voice) lines.push(`  - Voice: ${voice}`);
            if (s.smartExpansion && d.related && d.related.length) {
                // SCENE-CONDITIONAL selection: score each background entity by token
                // overlap between its name+why and what is IN PLAY (the character's
                // "Now" focus + the freshest scene text). Matches surface, the rest
                // stay home — a duel pulls the sword school, a court scene pulls the
                // kingdom. No match anywhere → only the single anchor entry injects:
                // smarter means FEWER, better-chosen lines, not more.
                const inPlay = ((castFocus[nameKey] || "") + " " + lowerMsgs.slice(-2).join(" ")).toLowerCase();
                const presentNames = new Set(present.map(p => (p.entry.name || "").toLowerCase()));
                const scored = [];
                for (const r of d.related) {
                    const rn = typeof r === "string" ? r : r.name;
                    const why = typeof r === "string" ? "" : (r.why || "");
                    if (!rn) continue;
                    const rHit = cacheEntryFor(String(rn).toLowerCase());
                    if (!rHit || isBlocked(rHit.entry, rn)) continue;
                    if (presentNames.has((rHit.entry.name || "").toLowerCase())) continue; // has its own block
                    scored.push({ rHit, rn, why, score: inPlayScore(rn + " " + why, inPlay) });
                }
                scored.sort((a, b) => b.score - a.score);
                const anyMatch = scored.some(x => x.score > 0);
                const take = anyMatch ? scored.filter(x => x.score > 0).slice(0, 2) : scored.slice(0, 1);
                for (const { rHit, why } of take) {
                    const rid = (rHit.entry.dossier && rHit.entry.dossier.identity) || rHit.entry.sections.identity;
                    if (rid) lines.push(`  - Context: ${rHit.entry.name}${why ? ` (${why})` : ""} — ${clip(rid, 150)}`);
                }
            }
            if (d.secrets.length) lines.push(`  - Secret (unrevealed in-story — keep it hidden): ${d.secrets.join("; ")}`);
        } else {
            // Regex-section fallback. Identity is ALWAYS on — a model that knows the
            // hair color but not WHO SHE IS was the original sin here.
            if (entry.sections.identity) lines.push(`  - Identity: ${entry.sections.identity}`);
            const nf = focusLine(); if (nf) lines.push(nf);
            const inPlayR = ((castFocus[nameKey] || "") + " " + lowerMsgs.slice(-2).join(" ")).toLowerCase();
            for (const cat of order) {
                if (cat === "physical") {
                    if (s.physical) { const al = appearanceLine(entry); if (al) lines.push(al); }
                } else if (cat === "abilities") {
                    const al2 = abilityLine(entry, inPlayR); if (al2) lines.push(al2);
                } else if (s[cat] && entry.sections[cat]) {
                    lines.push(`  - ${labels[cat]}: ${entry.sections[cat]}`);
                }
                if (cat === "personality") lines.push(...dynLines());
            }
        }
        if (!lines.length) continue;
        // Budget by WHOLE LINES: the name + first line always ride; each further
        // line rides only if it fits. Mid-sentence amputation ("…; Engineered.")
        // told the model half a fact — worse than no fact. clip() remains only as
        // the belt for a single monstrous opening line.
        let block = clip(`${entry.name}:\n${lines[0] || ""}`, s.maxCharsPerChar);
        for (let li = 1; li < lines.length; li++) {
            if (block.length + 1 + lines[li].length > s.maxCharsPerChar) continue;
            block += "\n" + lines[li];
        }
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
        // mode "begun" = the auto-tracker just moved here: the arc SUMMARY is the
        // narrator's map of canon that has NOT happened yet — quarantined from
        // character knowledge, never asserted as past. Manual/legacy notes keep
        // the original "everything above has occurred" semantics byte-for-byte.
        arcBlock = (arcNote.mode === "begun")
            ? `Where our story is — ${arcNote.title} (just beginning): ${arcNote.summary}\n` +
              `(The story is at the START of this arc: the summary above is the storyteller's map of canon events that have NOT yet happened — let them unfold naturally, never treat them as past, and no character knows them. Events from earlier arcs have happened. Canon beyond this arc, and every unrevealed identity, is likewise unknown to every character — never foreshadow or use it.)\n`
            : `Where our story is — ${arcNote.title}: ${arcNote.summary}\n` +
              `(Only events up to this point have happened. Later canon events, reveals, and ` +
              `identities are unknown to every character — never foreshadow or use them.)\n`;
        reasons.push(`story position ← ${arcNote.title}${arcNote.mode === "begun" ? " (just begun)" : ""}`);
    }

    let pinBlock = "";
    const pinTexts = [extras.globalPin, extras.chatPin].map(t => (t || "").trim()).filter(Boolean);
    if (pinTexts.length) {
        pinBlock = `My standing notes — I wrote these, they always apply:\n${pinTexts.join("\n")}\n`;
        reasons.push("pinned canon text");
    }

    if (!blocks.length && !arcBlock && !pinBlock) return "";
    return (
        ((settings().promptHeader || "").trim() || defaultPromptHeader()) +
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
        brief: str(obj.brief, 750),
        facts: arr(obj.facts, 8, 200).filter(f => !META_FACT.test(f)),
        secrets: arr(obj.secrets, 4, 200).filter(f => !META_FACT.test(f)),
        voice: arr(obj.voice, 3, 160),
        abilities: arr(obj.abilities, 4, 160).filter(f => !META_FACT.test(f)),
        related: [],
        dynamics: {},
    };
    // related: {name, why} objects preferred; bare strings accepted (older dossiers).
    if (Array.isArray(obj.related)) {
        for (const r of obj.related.slice(0, 3)) {
            if (typeof r === "string" && r.trim()) d.related.push({ name: clip(r.trim(), 60), why: "" });
            else if (r && typeof r === "object" && typeof r.name === "string" && r.name.trim()) {
                d.related.push({ name: clip(r.name.trim(), 60), why: typeof r.why === "string" ? clip(r.why.trim(), 80) : "" });
            }
        }
    }
    if (obj.dynamics && typeof obj.dynamics === "object" && !Array.isArray(obj.dynamics)) {
        for (const [k, v] of Object.entries(obj.dynamics).slice(0, 6)) {
            const line = str(v, 300);
            if (k && line) d.dynamics[String(k).trim()] = line;
        }
    }
    // The BRIEF is the highest-value field in prose-brief mode and the one the
    // block actually opens with — a reply carrying only a brief was being thrown
    // away as "empty" because this test predates it.
    if (!d.identity && !d.brief && !d.facts.length && !d.secrets.length && !d.voice.length
        && !d.abilities.length && !Object.keys(d.dynamics).length) return null;
    return d;
}

/**
 * Coerce a dossier of ANY age/shape to the current contract. Dossiers are cached
 * forever in chat metadata, so a pre-"related"/"brief"/"abilities" (or otherwise
 * damaged) dossier can reach a read site with missing keys — an unguarded
 * `d.facts.length` then threw inside the note builder and silently killed the
 * whole canon note for the turn. Missing pieces become empty, never a crash.
 * Mutates and returns the given object (null/non-object passes through).
 */
function normalizeDossier(d) {
    if (!d || typeof d !== "object") return d == null ? null : d;
    if (typeof d.identity !== "string") d.identity = "";
    if (typeof d.brief !== "string") d.brief = "";
    for (const k of ["facts", "secrets", "voice", "abilities"]) {
        if (!Array.isArray(d[k])) d[k] = [];
    }
    if (!Array.isArray(d.related)) d.related = [];
    if (!d.dynamics || typeof d.dynamics !== "object" || Array.isArray(d.dynamics)) d.dynamics = {};
    return d;
}

/**
 * Long wiki sections are CHRONOLOGICAL — the character's late-story development
 * lives at the BOTTOM, which a naive top-slice amputates before the curator ever
 * reads it. Sample head + tail with a seam so both ends inform the dossier.
 */
function sampleSection(text, cap) {
    const t = String(text || "");
    if (t.length <= cap) return t;
    const head = Math.floor(cap * 0.6), tail = cap - head;
    return t.slice(0, head) + " […] " + t.slice(t.length - tail);
}

function dossierDigest(name, wikitext, relRaw) {
    const s = settings();
    // The INFOBOX is the densest factual element on a wiki page (affiliation, rank,
    // status, relatives, height, birthday) and the curator was never shown it — it
    // wrote every dossier blind to it. Same field vocabulary the extension already
    // trusts elsewhere, collapsed into one line.
    const boxKw = [...new Set([s.fields, s.relationshipKeywords, s.biographyKeywords,
        s.personalityKeywords, s.abilitiesKeywords, s.aliasKeywords]
        .join(",").split(",").map(k => k.trim()).filter(Boolean))];
    // Once-per-entity background work: generous caps + head/tail sampling — the
    // curator should read the WHOLE character, not the top of each section.
    return [
        `PAGE: ${name}`,
        `LEAD: ${extractLead(wikitext, 700)}`,
        `INFOBOX: ${extractInfoboxFields(wikitext, boxKw, 700)}`,
        `APPEARANCE: ${sampleSection(cleanWikitext(extractSectionRaw(wikitext, ["appearance", "physical appearance"], 4000)), 1200)}`,
        `PERSONALITY: ${sampleSection(extractSection(wikitext, ["personality"], 6000), 2500)}`,
        `RELATIONSHIPS: ${sampleSection(cleanWikitext(relRaw || extractSectionRaw(wikitext, ["relationships", "relationship"], 6000)), 3000)}`,
        `ABILITIES: ${sampleSection(cleanWikitext(extractSectionRaw(wikitext, s.abilitiesKeywords.split(",").map(t => t.trim()).filter(Boolean), 8000)), 2000)}`,
        `HISTORY: ${sampleSection(extractSection(wikitext, ["history", "biography", "background", "plot", "synopsis"], 8000), 2500)}`,
        `TRIVIA: ${extractTrivia(wikitext, ["trivia"], 10, 1200)}`,
        `QUOTES: ${extractQuotes(extractSectionRaw(wikitext, ["quotes", "notable quotes"], 5000), 6, 800)}`,
    ].filter(l => !/^[A-Z]+: ?$/.test(l)).join("\n");
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
    const digest = dossierDigest(name, wikitext, relRaw);
    const systemText = (settings().promptDossier || "").trim() || DEFAULT_PROMPT_DOSSIER;
    const out = await llmCall(systemText, digest, { maxTokens: 1000, budgetMs: (Number(settings().parserBudgetMs) || 30000) * 2 });
    return parseDossier(out);
}

/**
 * A multi-token query must be COVERED by the page it lands on: every meaningful
 * query token appears in the title or the page's aliases. "Miyake Kakeru"
 * fuzzy-matching onto "Akito Miyake" (which has no 'kakeru' anywhere) grounded a
 * hallucinated hybrid onto a real-but-wrong person. "Rose" → "Rose Oriana" and
 * "Alya" → alias "Alya" both pass; cross-welded names don't.
 */
function titleCoversQuery(query, title, aliases) {
    // normName folds diacritics on BOTH sides: a typed-ASCII query must cover
    // a macron title ("ayanokoji" ⊂ "Kiyotaka Ayanokōji").
    const hay = normName([title, ...(aliases || [])].join(" "));
    const toks = normName(query).split(/[^\p{L}\p{N}'-]+/u)
        .filter(t => t.length >= 3 && !NOISE_WORDS.has(t));
    return toks.every(t => hay.includes(t));
}

/** Fire-and-forget dossier build with an in-flight/retry guard on the cache entry. */
function scheduleDossier(entry, name, wikitext, relRaw) {
    // ENTRY-bound, not key-bound. The build is seconds of LLM time, and cache()
    // resolves to whatever chat is open at CALL time — so looking the key up
    // again after the build meant a mid-build chat switch could land this
    // universe's dossier on a same-named character in ANOTHER chat's universe,
    // and the in-flight stamp below silently blocked that chat's own dossier
    // for a day. The entry object IS the identity: writes land on the character
    // that asked, or (if its chat was unloaded unsaved) nowhere — never on a
    // stranger.
    if (!entry || entry.dossier) return;
    if (entry.dossierTs && Date.now() - entry.dossierTs < NEGATIVE_TTL) return;  // in flight / recent failure
    entry.dossierTs = Date.now();
    buildDossier(name, wikitext, relRaw).then(d => {
        if (d) {
            entry.dossier = normalizeDossier(d);
            debug(`✦ dossier ready: ${name}`);
        }
        saveCache();
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

// Story-structure/event pages: when one enters the cast, the STORY has moved —
// autonomously advance the pinned story position instead of treating it as a place.
const EVENT_WORDS = /\b(arc|saga|festival|exam|examination|tournament|war|battle|incident|trial|ceremony|raid|expedition|invasion|uprising|rebellion|massacre|banquet|gala|election)\b/i;

/**
 * Is the moment ABOUT capability? Powers, techniques and their limits are the
 * difference between a real fight and invented nonsense, and dead weight in a
 * conversation — so they ride only when the scene earns them.
 */
const COMBAT_WORDS = /\b(fight|fights|fighting|fought|battle|battling|duel|duels|spar|sparring|combat|attack|attacks|attacked|strike|strikes|struck|slash|stab|parry|parries|dodge|dodges|block(?:s|ed)?|clash|clashes|kill|kills|killed|slay|wound|wounded|sword|blade|dagger|spear|bow|gun|fist|magic|mana|spell|spells|cast|casting|technique|techniques|jutsu|quirk|semblance|ability|abilities|power|powers|weapon|weapons|armor|armour|enemy|enemies|ambush|assassin|assassinate|duelist|training|train(?:s|ed)?\s+(?:with|against))\b/i;

/** \ud83d\udd2d Wiki discovery — pure helpers (I/O-free; proven in test/proof.js). */
function slugifyTitle(t) {
    return String(t || "").toLowerCase()
        .replace(/['\u2019\u2018]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
/** Word tokens of a title/name — parentheticals dropped ("Jovan Oda (Soul
 * Reaper)" is Jovan Oda), punctuation split, diacritics folded upstream. */
function nameTokens(s) {
    return normName(s).replace(/\(.*?\)/g, " ").split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2);
}
/**
 * Does this wiki page title actually name this thing? WHOLE WORDS ONLY — the
 * old rule compared raw substrings and shared single words, so "Yokoda" claimed
 * "Oda", "Blade Runner" claimed "Zar Blade", and "Oda Family" claimed "Jovan
 * Oda". Every one of those is a wiki falsely certifying that it knows this
 * chat. The rule now: one side's words must ALL be words of the other, with at
 * least one of them substantial (>=3 chars) — so two-letter glue can never
 * carry a match. Names shorter than that match only exactly.
 */
function titleMatchesName(title, name) {
    const na = normName(title), nb = normName(name);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const a = nameTokens(title), b = nameTokens(name);
    if (!a.length || !b.length) return false;
    const A = new Set(a), B = new Set(b);
    const covered = (list, other) => list.every(t => other.has(t)) && list.some(t => t.length >= 3);
    return covered(b, A) || covered(a, B);
}
/** Stale-fork rule: many big fandoms migrated to wiki.gg, leaving a frozen Fandom
 * copy behind. The wiki with the NEWER last edit is the live one; a host whose
 * recent-changes can't be read loses to one whose can; total silence -> fandom. */
function pickLiveHost(rcFandom, rcGg) {
    if (!rcFandom && !rcGg) return "fandom";
    if (!rcFandom) return "gg";
    if (!rcGg) return "fandom";
    return Date.parse(rcGg) > Date.parse(rcFandom) ? "gg" : "fandom";
}
/**
 * Names that identify NOBODY: SillyTavern's neutral card is literally called
 * "Assistant", groups and blank cards leave equally empty labels behind. Such a
 * name is not a protagonist — it must never head the discovery prompt, never be
 * a probe key ("Assistant" matches an "Assistant Director" page on any wiki in
 * existence), and never count as evidence that this chat has a universe.
 */
const PLACEHOLDER_NAMES = new Set([
    "assistant", "ai", "bot", "chatbot", "robot", "system", "narrator", "storyteller",
    "gm", "dm", "host", "user", "you", "me", "char", "character", "persona", "default",
    "none", "unknown", "unnamed", "untitled", "new", "test", "example", "sample",
    "group", "chat", "sillytavern", "gpt", "claude", "gemini", "llama", "model", "llm",
    "anon", "anonymous", "someone", "somebody", "person", "stranger",
]);
function isPlaceholderName(n) {
    const words = normName(n).replace(/\(.*?\)/g, " ").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!words.length) return true;
    return words.every(w => PLACEHOLDER_NAMES.has(w));
}

/**
 * 🔭 Everything THIS CHAT has actually said about its world: the whole card
 * (description, personality, scenario, greeting, creator notes, tags) plus the
 * opening AND the latest scenes. Discovery used to read a 600-char description
 * and two 300-char messages — so a chat whose world was written in the scenario
 * field or revealed at message forty looked, to the proposer, like a blank page.
 */
function discoveryCorpus(ctx) {
    const parts = [];
    const add = (v, n) => { const t = String(v == null ? "" : v).trim(); if (t) parts.push(t.slice(0, n)); };
    let ch = null;
    try { ch = (ctx && ctx.characters && ctx.characterId != null) ? ctx.characters[ctx.characterId] : null; } catch (e) { /* no card */ }
    if (ch) {
        add(ch.name, 80);
        add(ch.description, 1500);
        add(ch.personality, 400);
        add(ch.scenario, 800);
        add(ch.first_mes, 800);
        add(ch.creatorcomment || ch.creator_notes || (ch.data && ch.data.creator_notes), 400);
        const tags = Array.isArray(ch.tags) ? ch.tags : (ch.data && Array.isArray(ch.data.tags) ? ch.data.tags : null);
        if (tags) add(tags.join(", "), 200);
    }
    const msgs = (ctx && Array.isArray(ctx.chat)) ? ctx.chat : [];
    const window = msgs.length <= 8 ? msgs : msgs.slice(0, 2).concat(msgs.slice(-6));
    for (const m of window) add(m && m.mes, 700);
    return parts.join("\n");
}

function declaredUniverses(corpus) {
    const out = [];
    const re = /(?:^|\n)\s*(?:#|fandom\s*[:=]|universe\s*[:=]|setting\s*[:=]|series\s*[:=])\s*([^\n.,;!?]{3,60})/gi;
    let d;
    while ((d = re.exec(String(corpus || ""))) !== null) {
        const t = d[1].trim().replace(/\s+/g, " ");
        if (t && !out.some(x => normName(x) === normName(t))) out.push(t);
    }
    return out;
}

/** Hyphens are punctuation, not identity: "found-saga" and "foundsaga" and
 * "Found Saga" are one declaration. */
function slugCore(v) { return slugifyTitle(v).replace(/-/g, ""); }

/**
 * 🔭 THE DECLARATION IS A DECREE. "#Found Saga" on line one is the user naming
 * their own universe, so a candidate slug that IS that name needs no canon-name
 * proof — the chat already pointed at it. Everything else must earn its binding
 * by knowing something the chat says. Returns the declaring term, or "".
 */
function declaredCandidate(slug, declarations) {
    const core = slugCore(slug);
    if (!core) return "";
    return (declarations || []).find(t => slugCore(t) === core) || "";
}

/**
 * 🔭 The distinctive proper nouns THIS CHAT contains, ranked: an explicit
 * declaration first (a decree), then multi-word names ("Soul Society"), then
 * substantial single ones ("Seireitei"), longest first. These are the ONLY keys
 * a candidate wiki may be verified with — which is why a hallucinated universe
 * cannot self-certify.
 */
function chatEvidenceTerms(corpus, limit = 8) {
    const text = String(corpus || "");
    const out = [];
    const seen = new Set();
    const push = (v) => {
        const t = String(v || "").trim().replace(/\s+/g, " ");
        if (t.length < 3 || t.length > 60) return;
        if (isPlaceholderName(t)) return;
        const k = normName(t);
        if (!k || seen.has(k)) return;
        seen.add(k); out.push(t);
    };
    for (const t of declaredUniverses(text)) push(t);
    // A universe term is a PROPER NOUN. extractCandidateNames also has a
    // lowercase fallback for names typed without capitals ("whats rose oriana
    // hair") — invaluable there, poison here: it turns "how are you doing
    // today?" into the evidence "am fine" and "doing", which would both lift
    // the no-evidence hold and burn probes on nothing. Capitals only.
    const names = extractCandidateNames(text).filter(n => /^\p{Lu}/u.test(n));
    for (const n of names) if (n.includes(" ")) push(n);
    for (const n of names.filter(x => !x.includes(" ")).sort((a, b) => b.length - a.length)) {
        if (n.length >= 4) push(n);
    }
    return out.slice(0, limit);
}

/**
 * Model-proposed canon names are only usable as PROOF when this chat actually
 * says them: a substantial word of the name must appear in the corpus. Handed
 * "Ichigo" by the scene, the model may expand it to "Ichigo Kurosaki" and that
 * still counts; handed nothing, "Spock" does not.
 */
function groundedNames(names, corpus) {
    const hay = " " + normName(corpus).replace(/[^\p{L}\p{N}]+/gu, " ") + " ";
    const out = [];
    for (const n of names || []) {
        const toks = nameTokens(n).filter(t => t.length >= 4);
        if (toks.some(t => hay.includes(" " + t + " "))) out.push(n);
    }
    return out;
}

/** LLM proposes, the wiki API disposes: assemble candidate slugs from the model's
 * JSON plus deterministic fallbacks, deduped, capped — every one gets probed.
 * Each candidate carries the chat string that GENERATED it (`from`), because a
 * candidate may never be proven by its own source: the card name "Alice" makes
 * the slug "alice", and alice.fandom.com of course knows an "Alice". That is a
 * wiki proving itself, and it is how unrelated domains got bound. */
function discoverCandidates(parsed, franchiseFallback, probeName) {
    const out = [];
    const push = (v, from) => {
        const c = slugifyTitle(v);
        if (!c || c.length < 2 || out.some(x => x.slug === c)) return;
        out.push({ slug: c, from: String(from || "") });
    };
    if (parsed && Array.isArray(parsed.slugs)) for (const x of parsed.slugs) push(x, "");
    if (parsed && parsed.franchise) push(parsed.franchise, "");
    push(franchiseFallback, "");
    push(probeName, probeName);
    return out.slice(0, 6);
}

/** Names to verify a wiki WITH: the franchise's famous canon characters (from
 * the LLM) plus the card name itself — because an ORIGINAL protagonist is, by
 * definition, in no wiki, and must never be the only key we test with. */
function probeNamesFrom(parsed, probeName) {
    const out = [];
    const seen = new Set();
    const push = (v) => {
        const t = String(v || "").trim();
        if (!t || isPlaceholderName(t)) return;   // "Assistant" matches a page on every wiki alive
        const k = normName(t);
        if (!k || seen.has(k)) return;
        seen.add(k); out.push(t);
    };
    if (parsed && Array.isArray(parsed.names)) for (const n of parsed.names.slice(0, 5)) push(n);
    push(probeName);
    return out.slice(0, 6);
}

/** What discovery SAW: card + the chat's OPENING messages + the effective wiki
 * list. Settlement is keyed on this — so a fandom DECLARED in the first
 * message ("#classroom of the elite …") re-opens a settlement made against an
 * empty chat, instead of being ignored forever. Stable after the opening. */
function wikiFingerprint(probeName, msgs, wikisCsv) {
    const head = (msgs || []).slice(0, 2).map(m => String((m && m.mes) || "").slice(0, 200)).join("|");
    return normName(String(probeName || "") + "|" + head + "|" + String(wikisCsv || ""));
}

const PLACE_WORDS = /\b(school|academy|institute|institution|university|college|city|town|village|kingdom|empire|nation|guild|organization|organisation|company|agency|island|castle|palace|temple|church|dungeon|tower|district|region|world|realm|garden)\b/i;

/**
 * 📖 THE STORY REFEREE — the auto-tracker's occurring-vs-mentioned judgment.
 * An event ENTERING THE CAST is not the story entering the event: the parser
 * lists remembered, discussed, and flashback entities by design, and string
 * heuristics cannot tell "the Festival begins" from "she missed the Festival".
 * A model can (the Cast Auditor argument), and this call fires only for a NEW
 * candidate event — reached ones are skipped before it. Fails safe: no
 * verdict = no advancement; the position holds until the story really moves.
 */
async function judgeArcAdvance(sceneText, eventName, curTitle) {
    const systemText = (settings().promptArcJudge || "").trim() || DEFAULT_PROMPT_ARCJUDGE;
    const userText = `<scene>\n${sceneText}\n</scene>\n\nCandidate event: "${eventName}"` +
        (curTitle ? `\nCurrent story position: "${curTitle}"` : "") + `\n\nJSON verdict:`;
    const out = await llmCall(systemText, userText, { maxTokens: 60, budgetMs: Math.min(Number(settings().parserBudgetMs) || 30000, 12000) });
    if (!out) return false;
    const v = parseJsonCandidates(out, "{", "}", x => x && typeof x === "object" && !Array.isArray(x));
    return !!(v && v.advance === true);
}

/**
 * WORLD STATE from the cast — ONE definition for every parse path (interceptor,
 * post-generation scan, manual rescan), so a story the AI moves advances the
 * position exactly like a story the player moves. A PLACE becomes the CURRENT
 * SETTING; an EVENT/ARC is a candidate to ADVANCE THE STORY POSITION — gated by
 * the high-water mark (never regress, never re-pin) and the 📖 story referee
 * (occurring, not merely mentioned). Events are checked first so a "Sports
 * Festival" moves the story instead of becoming a room.
 */
async function applyCastWorldState(names, sceneText, myEpoch) {
    const s = settings();
    for (const n of names || []) {
        const hit = cacheEntryFor(n.toLowerCase());
        if (!hit) continue;
        if (s.autoArc && EVENT_WORDS.test(hit.entry.name)) {
            const cur = chatArc();
            if (arcAlreadyReached(hit.entry.name, cur, chatArcReached())) continue;
            const go = await judgeArcAdvance(sceneText, hit.entry.name, cur && cur.title);
            if (myEpoch !== chatEpoch) return;
            if (!go) continue;
            groundArc(hit.entry.name, { mode: "begun", name: hit.entry.name }).then(got => {
                if (got) {
                    cgToast("info", `📖 story position → ${got.title}`);
                    if (renderArcStatus) try { renderArcStatus(); } catch (e) {}
                }
            }).catch(() => {});
        } else if (hit.entry.kind === "place" || PLACE_WORDS.test(hit.entry.name)) {
            setChatPin("canon_grounding_setting", hit.key);
        }
    }
}

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

let lastLlmError = "";       // why the last llmCall returned null — surfaced by rescan
let lastParseFailToastAt = 0; // throttle for background-failure toasts (silence was the bug)

function chatWikiBinding() {
    try {
        const v = getContext().chatMetadata?.canon_grounding_wiki;
        return typeof v === "string" && v.trim() ? v.trim() : "";
    } catch (e) { return ""; }
}
/** THE universe of the CURRENT chat: its own binding first, the global field
 * only as the default for unbound chats. Every grounding path reads THIS —
 * never settings().wikis directly — so one chat's discovery can never leak
 * canon into another chat. */
function activeWikis() {
    return chatWikiBinding() || String(settings().wikis || "");
}
function purgeForeignEntries(wikisCsv) {
    try {
        const keep = normWikiSet(wikisCsv);
        const st = cache();
        let dropped = 0;
        for (const k of Object.keys(st)) {
            const e = st[k];
            if (!e) continue;
            const w = e.wiki ? (normWikiSet(String(e.wiki))[0] || null) : null;
            if (e.found && w && !keep.includes(w)) { delete st[k]; dropped++; }
            else if (!e.found && !missCoversCurrentWikis(e, wikisCsv)) { delete st[k]; dropped++; }
        }
        if (dropped) { saveCache(); debug(`\ud83d\udd2d universe changed \u2192 purged ${dropped} foreign cache entr${dropped === 1 ? "y" : "ies"}`); }
    } catch (e) { /* purge is best-effort */ }
}
/** ONE writer for a chat's universe: pin the binding, settle the chat, and
 * purge canon that belongs to a DIFFERENT universe. */
function bindChatWiki(stored, verifiedName, manual, via, viaDecl) {
    const effective = String(stored || "") || String(settings().wikis || "");
    let fpNow = "(manual)";
    if (!manual) {
        let msgs = [];
        try { msgs = getContext().chat || []; } catch (e) { /* fp degrades to card+wikis */ }
        fpNow = wikiFingerprint(verifiedName, msgs, effective);
    }
    setChatPin("canon_grounding_wiki", String(stored || ""));
    setChatPin("canon_grounding_wiki_ok", manual
        ? { wikis: String(stored || ""), name: verifiedName, fp: "(manual)", manual: true, ts: Date.now() }
        : { wikis: String(stored || ""), name: verifiedName, via: String(via || verifiedName || ""), viaDecl: !!viaDecl, fp: fpNow, ts: Date.now() });
    purgeForeignEntries(effective);
}
function wikiStateHint() {
    try {
        const ok = chatWikiOk();
        if (ok && !ok.failed) { const b = chatWikiBinding(); return b ? ` \ud83d\udd2d This chat's universe: ${b} (chat-bound).` : ""; }
        if (ok && ok.failed) return " \ud83d\udd2d Discovery found no wiki for this chat YET — it re-evaluates as the opening messages arrive; the wikis field is the manual override.";
        return " \ud83d\udd2d The wiki is NOT verified for this chat yet — discovery runs as soon as the story names something (a character, a place, or a #fandom line).";
    } catch (e) { return ""; }
}
function chatWikiOk() {
    try {
        const v = getContext().chatMetadata?.canon_grounding_wiki_ok;
        return v && typeof v === "object" ? v : null;
    } catch (e) { return null; }
}
async function fetchSearchTitles(wikiSpec, name) {
    try {
        const url = `${apiBase(wikiSpec)}?action=query&list=search&srlimit=3&format=json&origin=*&srsearch=${encodeURIComponent(name)}`;
        const res = await fetch(url);
        if (!res || !res.ok) return null;
        const data = await res.json();
        const arr = data?.query?.search;
        return Array.isArray(arr) ? arr.map(x => String(x?.title || "")) : null;
    } catch (e) { return null; }
}
async function fetchLastEdit(wikiSpec) {
    try {
        const url = `${apiBase(wikiSpec)}?action=query&list=recentchanges&rclimit=1&rcprop=timestamp&format=json&origin=*`;
        const res = await fetch(url);
        if (!res || !res.ok) return null;
        const data = await res.json();
        return data?.query?.recentchanges?.[0]?.timestamp || null;
    } catch (e) { return null; }
}
/** A DECLARED universe only has to be real: does this host return any content
 * at all for the name the user declared? A dead subdomain answers nothing; a
 * live fan wiki always answers something about its own franchise. */
async function hostHasAnything(wikiSpec, term) {
    const hits = await fetchSearchTitles(wikiSpec, term);
    return Array.isArray(hits) && hits.length > 0;
}
async function hostKnowsAny(wikiSpec, names) {
    for (const n of names) {
        const hits = await fetchSearchTitles(wikiSpec, n);
        if ((hits || []).some(t => titleMatchesName(t, n))) return n;
    }
    return "";
}
/** \ud83d\udd2d The wikis FIELD stays the manual override; this makes it optional.
 * Verify the active wiki actually knows the protagonist; if not, discover one:
 * the LLM proposes candidate slugs (it knows romaji titles) and every candidate
 * is verified against the real api.php — but a hallucinated slug does NOT simply
 * fail its probe, and believing it did is what bound memory-alpha to a chat that
 * had never heard of Star Trek. The proposer named both the wiki AND the canon
 * names used to test it, so the test could only ever succeed. Verification keys
 * therefore come from THIS CHAT (see the evidence law below). Fails safe: no
 * evidence -> nothing spent; nothing proven -> one toast, settle, never nag
 * again until the chat, the wikis field, or an explicit scan changes it. */
let discoverInFlight = null;   // the ONE discovery currently running, if any
/**
 * ONE DISCOVERY AT A TIME. There are four entry points (chat change, boot, the
 * interceptor, the Scan button) and an unbound chat answers "not settled" to all
 * of them until a pin is written - so they used to stack: two or three full runs,
 * each spending its own LLM call and its own probe storm, each racing to bind.
 * Concurrent callers now share the run in progress. An explicit force:true scan
 * is a user command, so it never merges - it queues behind and re-evaluates.
 */
function verifyOrDiscoverWiki(opts = {}) {
    if (discoverInFlight && !opts.force) return discoverInFlight;
    const prior = discoverInFlight;
    let self = null;
    self = (async () => {
        if (prior) await prior.catch(() => {});
        // The slot is released in a `finally`, which runs BEFORE this promise
        // resolves. Releasing it from a CHAINED promise instead put the reset a
        // microtask behind the caller's own `await`, so the very next call still
        // saw the finished run and handed back its stale result rather than
        // starting the discovery it asked for.
        try { return await discoverWikiOnce(opts); }
        finally { if (discoverInFlight === self) discoverInFlight = null; }
    })();
    discoverInFlight = self;
    self.catch(() => {});   // a rejection here must never surface as unhandled
    return self;
}
async function discoverWikiOnce(opts = {}) {
    const myEpoch = chatEpoch;
    const s = settings();
    if (!s.enabled || !s.autoDiscoverWiki) return;
    const ctx = getContext();
    const rawName = String(ctx?.name2 || ctx?.characters?.[ctx?.characterId]?.name || "").trim();
    if (!rawName) return;                              // no card at all = context not loaded yet, not "no evidence"
    const ok = chatWikiOk();
    if (ok && ok.manual) return;                       // a manual decree is never second-guessed
    const fp = wikiFingerprint(rawName, ctx?.chat, activeWikis());
    if (!opts.force && ok && ok.fp === fp) return;     // settled — and NOTHING it saw has changed

    // 🔭 THE EVIDENCE LAW. A universe is a claim about THIS chat, so this chat
    // has to be the one making it. Read everything the chat says (card + scenes)
    // and take its distinctive proper nouns; the card name counts only when it
    // is a name at all — SillyTavern's neutral card is called "Assistant", and
    // "Protagonist: Assistant" plus a blank page is an invitation to invent.
    // With NOTHING to go on, discovery does not run: no LLM is spent, no pin is
    // written, and the next turn re-checks for free the moment the story speaks.
    const probeName = (rawName && !isPlaceholderName(rawName)) ? rawName : "";
    const corpus = discoveryCorpus(ctx);
    const terms = chatEvidenceTerms(corpus);
    if (!probeName && !terms.length) {
        debug("\ud83d\udd2d no universe evidence in this chat yet \u2014 discovery holds (nothing spent)");
        return;
    }

    const active = activeWikis().split(",").map(x => x.trim()).filter(Boolean);
    // Re-checks remember what WORKED: the pin's `via` (the term that verified
    // this chat last time) is probed FIRST — a bound chat re-verifies with one
    // fetch and ZERO LLM instead of re-running discovery.
    const quick = (ok && ok.via && !ok.manual)
        ? probeNamesFrom({ names: [ok.via] }, probeName)
        : probeNamesFrom(null, probeName);
    const reDecl = !!(ok && ok.viaDecl && ok.via);
    for (const w of active) {
        if (!quick.length && !reDecl) break;
        const knownAs = reDecl
            ? (await hostHasAnything(w, ok.via) ? ok.via : "")
            : await hostKnowsAny(w, quick);
        if (myEpoch !== chatEpoch) return;
        if (knownAs) {
            bindChatWiki(activeWikis(), rawName, false, knownAs, reDecl);
            debug(`\ud83d\udd2d wiki verified for ${rawName} via "${knownAs}": ${w}`);
            return;
        }
    }
    const out = await llmCall(s.promptDiscover || DEFAULT_PROMPT_DISCOVER,
        `Protagonist: ${probeName || "(unnamed)"}\n<text>\n${clip(corpus, 4000)}\n</text>`,
        { maxTokens: 140, budgetMs: Math.min(Number(s.parserBudgetMs) || 30000, 15000) });
    if (myEpoch !== chatEpoch) return;
    let parsed = null;
    try { parsed = JSON.parse(String(out || "").replace(/```json|```/gi, "").trim()); } catch (e) { /* fails safe */ }
    const probes = probeNamesFrom(parsed, probeName);
    // An ORIGINAL protagonist is in no wiki — so before touching candidates,
    // re-verify the ACTIVE config with the franchise's CANON names: a correct
    // manual setup must settle silently, never be told "not found". The active
    // list is the USER's decree; confirming it needs no evidence gate.
    for (const w of active) {
        if (!probes.length) break;
        const knownAs = await hostKnowsAny(w, probes);
        if (myEpoch !== chatEpoch) return;
        if (knownAs) {
            bindChatWiki(activeWikis(), rawName, false, knownAs);
            debug(`\ud83d\udd2d wiki verified for ${rawName} via canon name "${knownAs}": ${w}`);
            return;
        }
    }

    // 🔭 CHOOSING a universe is where the evidence law bites. The proposer may
    // name any wiki it likes, but the keys that verify one come from the CHAT:
    // the canon names it actually mentions, the phrase the proposer quoted back
    // out of the text, and the chat's own distinctive proper nouns. Probing
    // memory-alpha for "Spock" only ever proved that Star Trek exists — under
    // this law memory-alpha must know something the chat SAYS, or it is not the
    // chat's universe. A candidate can never be proven by the string that
    // generated it, so the card name "Alice" cannot certify alice.fandom.com.
    const quoted = (parsed && typeof parsed.evidence === "string") ? parsed.evidence.trim() : "";
    const quoteOk = quoted && quoted.length >= 3 &&
        normName(corpus).replace(/\s+/g, " ").includes(normName(quoted).replace(/\s+/g, " "));
    const grounded = groundedNames((parsed && Array.isArray(parsed.names)) ? parsed.names : [], corpus);
    const proofPool = [];
    const addProof = (v) => {
        const t = String(v || "").trim();
        if (!t || proofPool.some(x => normName(x) === normName(t))) return;
        proofPool.push(t);
    };
    if (probeName) addProof(probeName);
    for (const n of grounded) addProof(n);
    if (quoteOk) addProof(quoted);
    for (const t of terms) addProof(t);

    const declarations = declaredUniverses(corpus);
    const candidates = discoverCandidates(parsed, parsed?.franchise, probeName);
    let probeBudget = 24;                              // bounded work: a total miss cannot grind the turn
    for (const cand of candidates) {
        const slug = cand.slug;
        const declaredAs = declaredCandidate(slug, declarations);
        const keys = proofPool.filter(t => !cand.from || normName(t) !== normName(cand.from)).slice(0, 4);
        if ((!keys.length && !declaredAs) || probeBudget <= 0) continue;
        probeBudget -= Math.max(keys.length, 1);
        const [fKnown, gKnown] = declaredAs
            ? await Promise.all([
                hostHasAnything(slug, declaredAs).then(v => v ? declaredAs : ""),
                hostHasAnything(`${slug}.wiki.gg`, declaredAs).then(v => v ? declaredAs : ""),
            ])
            : await Promise.all([
                hostKnowsAny(slug, keys),
                hostKnowsAny(`${slug}.wiki.gg`, keys),
            ]);
        if (myEpoch !== chatEpoch) return;
        const fOk = !!fKnown;
        const gOk = !!gKnown;
        if (!fOk && !gOk) continue;
        let stored = fOk ? slug : `${slug}.wiki.gg`;
        if (fOk && gOk) {
            const [fRc, gRc] = await Promise.all([fetchLastEdit(slug), fetchLastEdit(`${slug}.wiki.gg`)]);
            if (myEpoch !== chatEpoch) return;
            stored = pickLiveHost(fRc, gRc) === "gg" ? `${slug}.wiki.gg` : slug;
        }
        s.savedWikis = Array.isArray(s.savedWikis) ? s.savedWikis : [];
        if (!s.savedWikis.includes(stored)) s.savedWikis.push(stored);
        try { saveSettingsDebounced(); } catch (e) { /* library save is best-effort */ }
        const via = (stored.endsWith(".wiki.gg") ? gKnown : fKnown) || probeName;
        bindChatWiki(stored, rawName, false, via, !!declaredAs);   // the CHAT gets the universe — the global field is untouched
        try { if (refreshWikiUi) refreshWikiUi(); } catch (e) { /* UI optional */ }
        cgToast("success", `\ud83d\udd2d Universe found via "${via}": ${stored.includes(".") ? stored : stored + ".fandom.com"}`);
        debug(`\ud83d\udd2d discovery \u2192 ${stored} (candidate "${slug}", proven by "${via}")`);
        return;
    }
    setChatPin("canon_grounding_wiki_ok", { wikis: activeWikis(), name: rawName, fp, failed: true, ts: Date.now() });
    cgToast("warning", `\ud83d\udd2d No wiki matched this story \u2014 set one in Canon Grounding \u2699 (the field is the manual override).`);
}
globalThis.CanonGrounding_verifyWiki = verifyOrDiscoverWiki;

/**
 * One LLM call over whatever backend is configured: the Connection Manager profile
 * when set, else generateRaw. Returns the raw text, or null on timeout/failure/empty —
 * callers keep the parser's null-vs-empty discipline. Raced-out promises are always
 * given a rejection handler (Android webviews surface unhandled rejections).
 */
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
 * KNOWN-CANON RESOLUTION: a short reference ("Kakeru") is ambiguous, and the
 * parser expanding it to a canonical is a GUESS — it invented "Miyake Kakeru"
 * from bare "Kakeru", welding two classmates together. A human GM reading a
 * short name mid-story thinks of the person ALREADY ON STAGE. So: when a cast
 * element's evidence is a single token that matches exactly ONE cached, found
 * entity's name/alias token, the element SNAPS to that known canonical. Two or
 * more matches = genuinely ambiguous → left for the auditor. The chat's own
 * established canon outranks fresh canonicalization.
 */
function resolveAgainstKnown(cast) {
    if (!Array.isArray(cast) || !cast.length) return cast;
    const store = cache();
    const known = Object.values(store).filter(e => e && e.found && e.name);
    if (!known.length) return cast;
    return cast.map(c => {
        const ev = String(c.evidence || "").trim();
        if (!ev || /\s/.test(ev)) return c;                       // multi-word evidence: specific enough
        const tok = ev.toLowerCase();
        if (tok.length < 3) return c;
        const matches = known.filter(e =>
            [e.name, ...(e.aliases || [])].some(n =>
                String(n).toLowerCase().split(/\s+/).includes(tok)));
        if (matches.length !== 1) return c;                        // 0 = new person; 2+ = ambiguous
        const canonical = matches[0].name;
        if (canonical.toLowerCase() === c.name.toLowerCase()) return c;
        debug(`"${c.name}" (from bare "${ev}") snapped to known canon: ${canonical}`);
        return { ...c, name: canonical };
    });
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

/**
 * FIRST-MEETING DETECTION: does the user's CURRENT message reference an entity
 * with zero cache presence? If yes, the immersion ceiling extends — for a brand
 * -new character there is nothing stale to inject, and their canon must be in
 * the very first reply about them. Converges: once parsed/grounded (or learned
 * as a non-name), the same words never trigger the wait again.
 */
function tokenCoveredByCache(tok) {
    if (cacheEntryFor(tok)) return true;
    for (const e of Object.values(cache())) {
        if (!e || !e.found || !e.name) continue;
        for (const n of [e.name, ...(e.aliases || [])]) {
            if (String(n).toLowerCase().split(/\s+/).includes(tok)) return true;
        }
    }
    return false;
}
function needsFirstMeetWait(lastUserMsg, priorMsgs) {
    if (!lastUserMsg) return false;
    const prior = new Set();
    for (const m of priorMsgs || []) {
        for (const t of String(m).toLowerCase().split(/[^\p{L}\p{N}'-]+/u)) {
            if (t.length >= 3) prior.add(t);
        }
    }
    for (const n of extractCandidateNames(lastUserMsg)) {
        const lc = n.toLowerCase();
        if (cacheEntryFor(lc)) continue;
        // "Oriana" alone is covered by cached "Rose Oriana" — partial references
        // to known people are NOT first meetings. Neither is ordinary prose: a
        // candidate built ENTIRELY from high-frequency English words ("fire
        // burns") is a sentence fragment, not a person — waiting 12s for it was
        // the false-positive stall. One uncommon token keeps the signal alive
        // ("rose oriana": "oriana" is not in the lexicon → still a first meet).
        if (lc.split(/\s+/).every(t => parsedWords.has(t) || prior.has(t) || tokenCoveredByCache(t) || COMMON_LOWERCASE.has(t))) continue;
        return true;
    }
    if (settings().lowercaseNames) {
        const toks = String(lastUserMsg).toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(t => t.length >= 3);
        const known = (t) => NOISE_WORDS.has(t) || STOPWORDS.has(t[0].toUpperCase() + t.slice(1))
            || parsedWords.has(t) || prior.has(t) || tokenCoveredByCache(t) || COMMON_LOWERCASE.has(t);
        for (let i = 0; i < toks.length - 1; i++) {
            if (!known(toks[i]) && !known(toks[i + 1])) return true;
        }
    }
    return false;
}

/**
 * Arbiter-style pre-generation parse: a fast model reads the scene and returns the
 * canon entities actually present. Time-boxed so it can never block a turn.
 * Returns: [{name, now, evidence}] when the model answered ([] = it says no canon
 * entities are present, which may legitimately clear a stale cast); NULL on
 * timeout/failure (caller keeps the previous cast — failure must never be read as
 * "nobody here").
 */
async function parseSceneCharacters(sceneText) {
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
    const verified = resolveAgainstKnown(verifyCastEvidence(cast, sceneText));
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
        // USER role: the note reads as the player briefing the storyteller, not
        // as a system injection (system-role reference blocks are exactly what
        // persona defenses reject as "corpo injection").
        const role = roles.USER !== undefined ? roles.USER : 1;        // user role
        // Depth is how many messages up from the bottom the note lands. ST clamps
        // it to the chat, so the huge default parks canon at the VERY TOP — right
        // after the system prompt, above other extensions' injections and the
        // first message: stable reference the model reads before any recency.
        const rawDepth = Number(settings().injectDepth);
        const depth = Number.isFinite(rawDepth) && rawDepth >= 0 ? Math.min(rawDepth, 9999) : 9999;
        c.setExtensionPrompt(INJECT_KEY, text || "", pos, depth, false, role);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Remove every legacy chat-spliced canon note (tagged FALLBACK_TAG) from a chat
 * array. The fallback splice mutates the REAL chat, so without this each
 * generation stacked one more stale note into the chat file. Marker-TEXT
 * matching is deliberately not used: a user-overridden promptHeader makes the
 * note's text unrecognizable — the tag is the identity.
 */
function removeFallbackSplices(chat) {
    if (!Array.isArray(chat)) return;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i][FALLBACK_TAG]) chat.splice(i, 1);
    }
}

let interceptAnnounced = false;
globalThis.CanonGrounding_intercept = async function (chat, contextSize, abort, type) {
    // Only real user-facing generations, and never two passes at once. EVERYTHING
    // below sits under these two guards now - including discovery. It used to run
    // ABOVE them, which meant (a) every quiet/impersonate generation ST performs
    // spent a discovery LLM call plus a probe storm on an unbound chat, and (b) a
    // turn that overlapped the CHAT_CHANGED discovery started a second, identical
    // one. Skipping quiet/impersonate also prevents our own parser call from
    // re-entering this interceptor.
    const genType = type || "normal";
    if (!["normal", "swipe", "regenerate", "continue"].includes(genType)) return;
    if (cgInFlight) return;
    cgInFlight = true;
    const myEpoch = chatEpoch;   // if the chat switches during any await below, drop everything
    try {
        {   // 🔭 self-heals the wiki on ANY turn; the settled pin makes this free.
            // An UNBOUND chat additionally HOLDS for discovery (first-meeting rule):
            // a wrong UNIVERSE on turn one costs more immersion than a short pause.
            const okNow = chatWikiOk();
            const disc = verifyOrDiscoverWiki().catch(() => {});
            if (!okNow && settings().enabled && settings().autoDiscoverWiki) {
                const opening = (chat || []).length <= 2;
                if (opening) {
                    // Turn ONE of a NEW chat: there is no universe yet, so there is no
                    // story to stall - WAIT for discovery and ground THIS very turn.
                    // (This is why manual felt instant and automatic felt late.)
                    await disc;
                } else {
                    // Unbound mid-chat (rare): first-meeting rule - brief bounded hold.
                    await Promise.race([disc, new Promise(r => setTimeout(r, Number(settings().firstMeetWaitMs) || 12000))]);
                }
            }
            if (myEpoch !== chatEpoch) return;   // the chat can switch while discovery holds
        }
        if (!interceptAnnounced) {
            interceptAnnounced = true;
            console.log(`[CanonGrounding] v${CG_VERSION} interceptor active - if you never see this line, ST is not calling the interceptor at all.`);
        }
        const s = settings();
        const promptApiOk = setInjection("");   // start each generation clean; re-set below if needed
        // Old-ST fallback (no setExtensionPrompt): the splice lives in the real
        // chat array, so any note from an earlier turn must come out NOW — before
        // anything below can return early — or stale notes accumulate forever.
        if (!promptApiOk) removeFallbackSplices(chat);
        if (!s.enabled) return;

        const ctx = getContext();
        const scene = sceneMessages(ctx, s.contextWindow);
        const sceneText = scene.join("\n");
        const visibleLen = (ctx.chat || []).filter(m => !m.is_system).length;
        const lastUserMsg = stripMetaBlocks(([...chat].reverse().find(m => m.is_user) || {}).mes || "");
        const lgNames = ledgerNames();
        const pinNames = chatPinNames();
        let cast = null;  // entities present this turn; drives injection when known
        let tierUser = [];    // player-typed grounded names — injection tier 1
        let tierLedger = [];  // on-screen ledger cast — injection tier 2

        // ⏱ IMMERSION CEILING: everything below (parse → verify → audit → ground →
        // pins → pairs → expansion → self-heal) runs as ONE background-capable task.
        // If it beats the deadline, this turn is fully fresh; if not, it CONTINUES in
        // the background (every mutation is epoch/serial-guarded or cache-safe) and
        // this turn injects the last known state.
        const heavy = (async () => {
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
                shouldParse = quick.some(parserMayRevisit);
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
                    cgToast("warning", `Canon parser failing in background: ${lastLlmError || "unknown"}. Sweep/pins still inject.`);
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
                            // World state from the cast (setting + story position):
                            // ONE definition, every parse path — see applyCastWorldState.
                            await applyCastWorldState(names, sceneText, myEpoch);
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
            }
        }
        // The story's REAL cast (Summaryception ledger) that is on-screen right now
        // rides ahead of the parser's judgment — in every mode, not just ledger mode.
        if (lgNames) {
            const onScreen = lgNames.filter(n => mentioned(n.toLowerCase(), sceneText.toLowerCase()));
            if (onScreen.length) {
                await groundNames(onScreen, true);
                if (myEpoch !== chatEpoch) return;
            }
        }

        // Pinned entities: user-decreed always-present. Ground them (cache absorbs
        // repeats), and let them participate in pair dynamics with the live cast.
        if (pinNames.length) {
            await groundNames(pinNames, true);
            if (myEpoch !== chatEpoch) return;
        }

        // SELF-HEALING SECTIONS: an entry grounded before markup containment can
        // carry junk forever (gallery filenames as its "look", wikitable rows in a
        // section) — the cache is permanent, so the extractor fix alone never
        // reaches it. Detect the junk signature and rebuild the entry's sections
        // from a fresh fetch with the CURRENT extractor: one entry per turn, once
        // per entity ever (healTs persists), in the background — same pattern as
        // the dossier self-upgrade, but over the whole chat cache so a
        // single-character scene heals too.
        {
            const store = cache();
            for (const key of Object.keys(store)) {
                const e = store[key];
                if (!e || !e.found || !e.wiki || !entryPoisoned(e)) continue;
                if (e.healV === CG_VERSION) continue;   // this version already rebuilt it
                e.healV = CG_VERSION;
                e.healTs = Date.now();
                (async () => {
                    try {
                        const wt = await fetchWikitext(e.wiki, e.name);
                        if (!wt) return;
                        const rebuilt = await buildEntrySections(e.wiki, e.name, wt, s, e.kind !== "place");
                        if (Object.values(rebuilt).some(Boolean)) {
                            e.sections = rebuilt;
                            e.relRaw = extractSectionRaw(wt, ["relationships", "relationship"], 4000);
                            debug(`♻ sections rebuilt clean: ${e.name}`);
                            saveCache();
                        }
                    } catch (err) { /* once per entity — healTs stays */ }
                })();
                break;
            }
        }

        // Per-pair dynamics: with the cast settled, resolve "how A is around B" for every
        // grounded pair on screen (cached forever per pair; subpage fetches budgeted).
        // The PAIR gate applies ONLY to pair dynamics — background-entity expansion
        // (resolveRelated) and the dossier self-upgrade need just ONE entity on
        // screen. Gating them behind >1 made solo-character scenes silently lose
        // their Context lines and never self-heal legacy dossiers.
        const pairPool = [...(cast || []), ...pinNames];
        if (pairPool.length > 0) {
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
            // SELF-HEALING KNOWLEDGE: a dossier built before the current shape (no
            // "related" key) rebuilds itself in the background — one per turn, once
            // per entity — so old caches upgrade without anyone pressing ✕.
            if (s.llmDossier) {
                for (const e of uniq.values()) {
                    if (e.found && e.dossier && (!("related" in e.dossier) || !("brief" in e.dossier)
                        || !("abilities" in e.dossier)) && !e.dossierUpTs) {
                        e.dossierUpTs = Date.now();
                        (async () => {
                            try {
                                const wt = await fetchWikitext(e.wiki, e.name);
                                if (!wt) return;
                                const d = await buildDossier(e.name, wt, e.relRaw || "");
                                if (d) { e.dossier = normalizeDossier(d); debug(`✦ dossier self-upgraded: ${e.name}`); saveCache(); }
                            } catch (err) { /* retry never — one attempt per entity */ }
                        })();
                        break;
                    }
                }
            }
        }

        })();
        heavy.catch(e => debug(`background canon task failed: ${e.message}`));
        let blockMs = Math.max(300, Number(s.maxBlockMs) || 2000);
        if (needsFirstMeetWait(lastUserMsg, scene.slice(0, -1))) {
            // You just summoned someone new: their canon belongs in THIS reply.
            const meet = Math.max(blockMs, Number(s.firstMeetWaitMs) || 12000);
            debug(`⏱🤝 first meeting in your message — extending wait ${blockMs}ms → ${meet}ms so the introduction is grounded`);
            blockMs = meet;
        }
        // A THROW inside `heavy` must degrade exactly like a TIMEOUT. Bare
        // `heavy.then(() => true)` re-rejects, which threw out of the whole
        // interceptor: setInjection("") had already cleared this turn's canon,
        // so the note was never re-set (total canon loss) and lastInjection kept
        // the PREVIOUS turn's text, so the preview panel lied about it too. The
        // last-known-state fallback below exists for exactly this failure; both
        // slow and broken now reach it.
        const fresh = await Promise.race([
            heavy.then(() => true, () => false),
            new Promise(r => setTimeout(() => r(false), blockMs)),
        ]);
        if (myEpoch !== chatEpoch) return;
        if (!fresh) {
            debug(`⏱ canon still resolving in background (>${blockMs}ms) — injecting last known state; next turn is fresh`);
            if (s.llmParser) cast = pruneStaleCast(visibleLen, scene);
            else if (lgNames) cast = lgNames.filter(n => mentioned(n.toLowerCase(), sceneText.toLowerCase()));
        }

        // PRIORITY TIERS are pure filters over the cache - no network, no LLM - so
        // they belong AFTER the race, not inside the task racing against it.
        // Assigned inside `heavy` they stayed [] on exactly the slow, crowded
        // turns where the cap bites: the player's own typed names silently lost
        // tier 1 and could be trimmed out of their own scene. Computed here they
        // reflect whatever grounding finished in time, on fresh and stale turns
        // alike, and the !fresh branch needs no special case.
        tierUser = extractCandidateNames(lastUserMsg).filter(n => cacheEntryFor(n.toLowerCase()));
        if (lgNames) tierLedger = lgNames.filter(n => mentioned(n.toLowerCase(), sceneText.toLowerCase()));

        // Build the note. Cast-driven when we have one (parser/ledger); scene-scan otherwise.
        // Scene text hasn't changed since the top of the run — reuse it (the old code
        // recomputed sceneMessages a second time for nothing).
        const note = relevantCanonNote(scene, cast, chatArc(), {
            pinNames,
            userNames: tierUser,
            ledgerNames: tierLedger,
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
                // Fallback for very old ST without setExtensionPrompt. The splice
                // lands in the REAL chat array, so without cleanup one stale note
                // accumulated per generation, forever. Remove every previously
                // tagged splice first: one chat carries at most one canon note.
                removeFallbackSplices(chat);
                const injected = { is_user: false, is_system: true, name: "Canon", send_date: Date.now(), mes: note, [FALLBACK_TAG]: true };
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
  try {
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
            quick.some(parserMayRevisit);
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
            if (names.length) {
                await groundNames(names, true);
                if (myEpoch !== chatEpoch) return;
                // The AI is usually the one who moves the story — its own narration
                // entering an event must advance the position too, same rules.
                await applyCastWorldState(names, sceneText, myEpoch);
            }
        }
        return;
    }
    if (ledgerNames()) return;        // ledger already tracks the cast
    if (!s.groundFromReplies) return; // regex fallback is opt-in
    const names = extractCandidateNames(last.mes);
    if (names.length) await groundNames(names); // fills cache; does NOT edit text
  } catch (e) {
    // Top-level containment: this handler is an event subscription — a rejection
    // here is an unhandled promise rejection (fatal on Android webviews) and must
    // never escape into ST's event pipeline.
    try { debug(`post-generation scan failed: ${e && e.message ? e.message : e}`); } catch (e2) {}
  }
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
                <small class="cg-hint">Found automatically for new chats when \ud83d\udd2d discovery (below) is on — this field is the manual OVERRIDE. The part before .fandom.com (e.g. the-eminence-in-shadow) — or a FULL host for non-Fandom MediaWiki sites like wiki.gg (e.g. terraria.wiki.gg). Add several, comma-separated, for a crossover.</small>
                <input id="cg_wikis" class="text_pole" type="text" placeholder="the-eminence-in-shadow">
                <label class="checkbox_label" for="cg_autodiscover"><input id="cg_autodiscover" type="checkbox"><span>\ud83d\udd2d Find the wiki automatically</span></label>
                <small class="cg-hint">On a new chat, the active wiki is checked against your protagonist's name; if it doesn't know them, candidates are proposed (the LLM suggests slugs — including romaji titles — and the REAL wiki API verifies every one, preferring a live wiki.gg over a frozen Fandom migration fork) and this field is filled for you.</small>
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
                <small><b>🗣 Ask Canon</b> — say it in plain words; the extension does it:</small>
                <div style="display:flex; gap:4px; align-items:center;">
                    <input id="cg_ask" class="text_pole" type="text" placeholder='e.g. "pin Rose Oriana" · "set arc to Lawless City" · "never show Ryōko" · "remember: the engagement is broken"' style="flex:1;">
                    <div id="cg_ask_go" class="menu_button" title="Do it">▶</div>
                </div>
                <small id="cg_ask_status" class="cg-hint">—</small>
                <hr>
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
                <label class="checkbox_label">
                    <input id="cg_autoarc" type="checkbox">
                    <span>Auto-advance story position 📖</span>
                </label>
                <small class="cg-hint">When the story ENTERS a canon arc/event ("the Bushin Festival begins"), the position advances itself — full plot summary, spoiler guard, supersedes the old pin. A 📖 story-referee call rules occurring vs merely mentioned, so memories, flashbacks, and comparisons never move it — and the position never slides backward to an event the story already passed. Smart autonomous: the story moves, the extension follows.</small>
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
                <label>Current setting (this chat)</label>
                <div style="display:flex;gap:6px;align-items:center;">
                    <input id="cg_setting_now" class="text_pole" type="text" readonly placeholder="(none — set automatically when a place enters the scene)">
                    <div id="cg_setting_clear" class="menu_button" title="Forget the current setting">✕</div>
                </div>
                <small class="cg-hint">Where the story is happening. Set automatically when the parser sees a place, superseded by the next one, and injected EVERY turn without needing to be named — a room does not have to be mentioned to still be the room. ✕ forgets it (useful when an organisation, not a location, got picked up).</small>
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
                <small class="cg-hint">Temperament, injected as a public BASELINE with framing that tells the model to modulate it — not a script. <b>Regex fallback only</b> — a curated dossier ✦ writes its own block, so this toggle does nothing while one exists.</small>
                <label class="checkbox_label">
                    <input id="cg_relationship" type="checkbox">
                    <span>Relationships / family</span>
                </label>
                <small class="cg-hint">Parents, siblings, key ties. Good for stopping invented family. <b>Regex fallback only</b> — a curated dossier ✦ writes its own block, so this toggle does nothing while one exists.</small>
                <label class="checkbox_label">
                    <input id="cg_dynamics" type="checkbox">
                    <span>Per-pair dynamics ("With Cid: …")</span>
                </label>
                <small class="cg-hint">When two grounded characters share a scene, inject how THIS one acts around THAT one, from the wiki's Relationships subsections (or the X/Relationships subpage). The fix for "stoic on the wiki → stoic with everyone".</small>
                <label class="checkbox_label">
                    <input id="cg_prose" type="checkbox">
                    <span>Prose briefs 📝</span>
                </label>
                <small class="cg-hint">Each character's block opens with the curator's written paragraph instead of "Identity: … Facts: a; b; c" fragments — better flow, fewer label tokens. Appearance and Voice quotes stay verbatim on purpose (exactness is their job). Scene lines (Now/Facts/With/Secrets) stay atomic below.</small>
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
                <small class="cg-hint">Role, affiliation, backstory. Verbose — use only if needed. <b>Regex fallback only</b> — a curated dossier ✦ writes its own block, so this toggle does nothing while one exists.</small>
                <label class="checkbox_label">
                    <input id="cg_abilities" type="checkbox">
                    <span>Powers &amp; Abilities</span>
                </label>
                <small class="cg-hint">Powers, skills, weapons. Verbose, and the model often half-knows these.</small>
                <label class="checkbox_label">
                    <input id="cg_trivia" type="checkbox">
                    <span>Trivia</span>
                </label>
                <small class="cg-hint">"== Trivia ==" bullets — dense fan-level canon (quirks, habits, hidden facts) that humanizes characters beyond the formal sections. <b>Regex fallback only</b> — a curated dossier ✦ writes its own block, so this toggle does nothing while one exists.</small>
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
                <small class="cg-hint">How long the cast parser / dossier curator may take IN THE BACKGROUND. Slow backends (GLM on mobile) need 30–60s — a blown budget silently kills the cast and everything looks dumb.</small>
                <label>Max turn wait (seconds)</label>
                <input id="cg_blockwait" class="text_pole" type="number" min="0.5" max="60" step="0.5">
                <small class="cg-hint">⏱ The immersion ceiling: your storyteller NEVER waits longer than this for canon. Discovery that misses the window keeps working in the background and lands next turn — stale for one turn beats a frozen reply. 1–2s recommended.</small>
                <label>First-introduction wait (seconds)</label>
                <input id="cg_meetwait" class="text_pole" type="number" min="2" max="60" step="1">
                <small class="cg-hint">⏱🤝 When YOUR message names someone brand-new (nothing cached), the extension may wait up to this long so their canon is present in the very first reply about them — a wrong-haired introduction is worse than a short pause. Routine turns still use the ceiling above. Converges: each new name waits once.</small>
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
                <label>Injection depth (messages up from the newest)</label>
                <input id="cg_depth" class="text_pole" type="number" min="0" max="9999">
                <small class="cg-hint">Where the canon note sits in the prompt. 9999 (default) clamps to the very top of chat — right after the system prompt, above other extensions and the first message. 1 = the old behavior, just above the newest message.</small>
                <small class="cg-hint">How many recent visible messages count as the current scene. A character stops injecting once their name scrolls past this many messages. Lower = drops off-screen characters faster.</small>
                <hr>
                <small><b>Size limits</b> — hard caps so a big cast can't balloon the prompt:</small>
                <label>Max characters injected at once</label>
                <input id="cg_maxchars" class="text_pole" type="number" min="1" max="30">
                <small class="cg-hint">Never inject more than this many at once (most recently mentioned win).</small>
                <label>Max characters (text length) per character</label>
                <input id="cg_maxper" class="text_pole" type="number" min="80" max="2000" step="50">
                <small class="cg-hint">Length cap on each character's block. Lower = leaner, trims the wordy categories first.</small>
                <label>Max total length of the character blocks</label>
                <input id="cg_maxtotal" class="text_pole" type="number" min="600" max="20000" step="100">
                <small class="cg-hint">Budget for the CHARACTER BLOCKS. The fixed header (~1.6k), any pinned canon you wrote, and the story-position note ride on top of it and are never trimmed — the header carries the rules that make the rest safe to use, and your pins are decrees. Roughly 4 characters ≈ 1 token.</small>
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
                <label>📖 Story referee (has the story ENTERED this event?)</label>
                <label for="cg_prompt_discover">\ud83d\udd2d Wiki discovery — protagonist \u2192 candidate wiki slugs</label>
                <textarea id="cg_prompt_discover" class="text_pole textarea_compact" rows="4"></textarea>
                <input id="cg_prompt_discover_reset" class="menu_button" type="button" value="Reset \ud83d\udd2d">
                <textarea id="cg_prompt_arcjudge" class="text_pole" rows="5"></textarea>
                <div id="cg_prompt_arcjudge_reset" class="menu_button" title="Restore default">↺ default</div>
                <label>🗣 Ask Canon router (maps your words to an action)</label>
                <textarea id="cg_prompt_ask" class="text_pole" rows="5"></textarea>
                <div id="cg_prompt_ask_reset" class="menu_button" title="Restore default">↺ default</div>
                <hr>
                <div id="cg_factory_reset" class="menu_button" title="Reset every setting and instruction to defaults">♻ Reset ALL settings &amp; instructions to defaults</div>
                <small class="cg-hint">Restores every setting and every instruction to the best-default state. KEPT through the reset: your saved wiki library, active wiki, parser profile, global pinned canon, and all per-chat state (cache, dossiers, pins, arc). Everything else — every toggle, keyword list, cap, budget, and instruction — returns to the best-tested defaults.</small>
                </div>
                </details>
                <details class="cg-group">
                <summary>🩺 Cache &amp; diagnostics</summary>
                <div class="cg-group-body">
                <small><b>Cache</b> — everything grounded so far <b>in this chat</b> (each chat is its own universe; branches inherit):</small>
                <div id="cg_cache_list" class="cg-cache"></div>
                <small class="cg-hint">Facts are fetched from the wiki once per entity, then reused forever (no repeat calls). × removes one entry so it re-fetches next time; "Clear all" wipes everything — do this after changing fields/keywords or fixing a wrong entry. An entry HERE does not mean it injects — "Why each was injected" below is the truth of what entered the note. Switching to another story/chat starts a clean universe automatically — no more clearing between fandoms.</small>
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
    $("#cg_prose").prop("checked", s.proseBriefs).on("input", function () {
        s.proseBriefs = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_lowercase").prop("checked", s.lowercaseNames).on("input", function () {
        s.lowercaseNames = $(this).prop("checked"); saveSettingsDebounced();
    });
    // 🧾 System instructions: box shows the EFFECTIVE text; saving text identical to
    // the default stores "" so future default improvements still reach this user.
    // Every default is a THUNK, resolved at each use. The header's default is
    // persona-dependent (defaultPromptHeader reads name1), and capturing it once at
    // UI-build time made the box lie the moment the persona changed: it displayed
    // the old name while injection used the new one, and one keystroke in that box
    // compared against the STALE default — storing a frozen old-persona header as a
    // literal override, which also opted that user out of every future default.
    const PROMPTS = [
        ["#cg_prompt_header",  "promptHeader",  () => defaultPromptHeader()],
        ["#cg_prompt_parser",  "promptParser",  () => DEFAULT_PROMPT_PARSER],
        ["#cg_prompt_dossier", "promptDossier", () => DEFAULT_PROMPT_DOSSIER],
        ["#cg_prompt_auditor", "promptAuditor", () => DEFAULT_PROMPT_AUDITOR],
        ["#cg_prompt_ask",     "promptAsk",     () => DEFAULT_PROMPT_ASK],
        ["#cg_prompt_arcjudge", "promptArcJudge", () => DEFAULT_PROMPT_ARCJUDGE],
        ["#cg_prompt_discover", "promptDiscover", () => DEFAULT_PROMPT_DISCOVER],
    ];
    for (const [sel, key, def] of PROMPTS) {
        $(sel).val((s[key] || "").trim() || def()).on("input", function () {
            const v = String($(this).val());
            s[key] = (v.trim() === def().trim()) ? "" : v;
            saveSettingsDebounced();
        });
        $(sel + "_reset").on("click", function () {
            s[key] = ""; $(sel).val(def()); saveSettingsDebounced();
            cgToast("info", "Restored default instruction.");
        });
    }
    // A chat switch can switch the persona with it. Any box still showing its
    // DEFAULT (stored "") re-resolves, so the header always displays the text that
    // will actually be injected. A user-authored override is never touched.
    renderPromptDefaults = () => {
        for (const [sel, key, def] of PROMPTS) {
            if (!(s[key] || "").trim()) $(sel).val(def());
        }
    };
    $("#cg_factory_reset").on("click", function () {
        if (!confirm("Reset EVERY Canon Grounding setting and instruction to defaults?\nKept: grounded cache, saved wiki library, per-chat pins/arc.")) return;
        // Behavior resets; CONNECTIONS and USER CONTENT survive: the parser profile
        // is plumbing (wiping it silently kills parser/dossier/auditor until re-picked),
        // and the global pin is your authored canon, not a tunable.
        const keep = { savedWikis: s.savedWikis, wikis: s.wikis, llmProfileId: s.llmProfileId, pinnedGlobal: s.pinnedGlobal };
        for (const k of Object.keys(s)) delete s[k];
        // Migration stamps are deliberately NOT re-applied here (the old code stamped
        // v2/v3/v5 — but not v6/v7 — which locked the reset to STALE pre-migration
        // caps, 400/3000 instead of the current 1100/6000). defaultSettings IS the
        // current default; with no stamps, the next settings() call re-runs the
        // migrations, and each one is an idempotent no-op against current defaults
        // (they only rewrite untouched sentinel values). One source of truth.
        Object.assign(s, structuredClone(defaultSettings), keep);
        saveSettingsDebounced();
        cgToast("success", "Defaults restored. Reloading UI…");
        setTimeout(() => location.reload(), 800);
    });
    $("#cg_pin_global").val(s.pinnedGlobal).on("input", function () {
        s.pinnedGlobal = $(this).val(); saveSettingsDebounced();
    });
    const renderChatPins = () => {
        $("#cg_pin_chat").val(chatPin());
        try { $("#cg_pin_names").val(getContext().chatMetadata?.canon_grounding_pin_names || ""); } catch (e) {}
        try { $("#cg_block_names").val(getContext().chatMetadata?.canon_grounding_block || ""); } catch (e) {}
        try {
            const sk = chatSettingKey();
            const ent = sk ? cache()[sk] : null;
            $("#cg_setting_now").val(ent && ent.name ? ent.name : (sk || ""));
        } catch (e) {}
    };
    renderChatPins();
    renderChatScoped = () => { renderChatPins(); };
    renderCacheHook = renderCacheList;
    $("#cg_pin_chat").on("input", function () { setChatPin("canon_grounding_pin", $(this).val()); });
    $("#cg_pin_names").on("input", function () { setChatPin("canon_grounding_pin_names", $(this).val()); });
    $("#cg_block_names").on("input", function () { setChatPin("canon_grounding_block", $(this).val()); });
    $("#cg_setting_clear").on("click", () => { setChatPin("canon_grounding_setting", ""); renderChatPins(); });
    // Story position (arc/chapter grounding).
    const renderArc = () => {
        const a = chatArc();
        $("#cg_arc_status").text(a ? `✓ ${a.title}${a.mode === "begun" ? " · just begun" : ""} (${a.wiki}) — this chat` : "—");
    };
    renderArcStatus = renderArc;
    $("#cg_arc").val(s.arcTitle || "");
    renderArc();
    const runAsk = async () => {
        const q = String($("#cg_ask").val() || "").trim();
        if (!q) return;
        $("#cg_ask_status").text("working…");
        try {
            const r = await askCanon(q);
            $("#cg_ask_status").text((r.ok ? "✓ " : "✕ ") + r.msg);
            if (r.ok) { $("#cg_ask").val(""); cgToast("success", r.msg); } else cgToast("warning", r.msg);
        } catch (e) {
            // Containment: a failure here (legacy cache shape, transport hiccup) must
            // surface in the status line, not strand the UI on "working…" forever.
            $("#cg_ask_status").text("✕ " + (e && e.message ? e.message : "unexpected error"));
            cgToast("error", `Ask Canon failed: ${e && e.message ? e.message : e}`);
        }
    };
    $("#cg_ask_go").on("click", runAsk);
    $("#cg_ask").on("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); runAsk(); } });
    $("#cg_arc_go").on("click", async function () {
        const q = String($("#cg_arc").val() || "").trim();
        if (!q) return;
        $("#cg_arc_status").text("searching…");
        const got = await groundArc(q);
        if (got) renderArc();
        else $("#cg_arc_status").text("✕ no arc/chapter page found on: " + activeWikis());
    });
    $("#cg_arc_clear").on("click", function () {
        s.arcTitle = ""; setChatArc(null); setChatPin("canon_grounding_arc_reached", []); $("#cg_arc").val("");
        saveSettingsDebounced(); renderArc();
    });
    $("#cg_arc_inject").prop("checked", s.arcInject).on("input", function () {
        s.arcInject = $(this).prop("checked"); saveSettingsDebounced();
    });
    $("#cg_autoarc").prop("checked", s.autoArc).on("input", function () {
        s.autoArc = $(this).prop("checked"); saveSettingsDebounced();
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
    $("#cg_depth").val(s.injectDepth).on("input", function () {
        const n = parseInt($(this).val(), 10);
        s.injectDepth = Number.isFinite(n) && n >= 0 ? Math.min(n, 9999) : 9999;
        saveSettingsDebounced();
    });
    // budget stored in ms, edited in seconds
    $("#cg_budget").val(Math.round((s.parserBudgetMs || 30000) / 1000)).on("input", function () {
        const v = parseInt($(this).val(), 10);
        if (!isNaN(v) && v >= 10) { s.parserBudgetMs = v * 1000; saveSettingsDebounced(); }
    });
    $("#cg_blockwait").val((s.maxBlockMs || 2000) / 1000).on("input", function () {
        const v = parseFloat($(this).val());
        if (!isNaN(v) && v >= 0.3) { s.maxBlockMs = Math.round(v * 1000); saveSettingsDebounced(); }
    });
    $("#cg_meetwait").val((s.firstMeetWaitMs || 12000) / 1000).on("input", function () {
        const v = parseFloat($(this).val());
        if (!isNaN(v) && v >= 2) { s.firstMeetWaitMs = Math.round(v * 1000); saveSettingsDebounced(); }
    });
    $("#cg_selftest").on("click", async function () {
        cgToast("info", "Parser self-test running…");
        const t0 = Date.now();
        const out = await llmCall("You are a connectivity test. Reply with exactly: ok", "Reply with exactly: ok", { maxTokens: 8 });
        const ms = Date.now() - t0;
        if (out) cgToast("success", `Parser backend OK in ${ms}ms — replied: "${clip(out, 40)}"`);
        else cgToast("error", `Parser backend FAILED in ${ms}ms — ${lastLlmError || "unknown"}`);
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
            lastSource = "preview";
            renderLastInjection();
            cgToast(note ? "success" : "warning", note
                ? `Preview built: ${lastMatchReasons.length} entr${lastMatchReasons.length === 1 ? "y" : "ies"} — see "Last injection" below.`
                : `Preview is EMPTY \u2014 ${emptyNoteDiagnosis(scene, cast, {
                    pinNames: chatPinNames(), settingKey: chatSettingKey(),
                  })}.` + wikiStateHint());
        } catch (e) {
            cgToast("error", `Preview failed: ${e.message}`);
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
    numHandler("#cg_maxper", "maxCharsPerChar", 80, 1100);
    numHandler("#cg_maxtotal", "maxTotalChars", 600, 6000);

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
        cgToast("info", "Fields & keywords reset. Clear the cache to re-fetch with the new fields.");
    });

    // Keep the active field and the saved-wiki highlights in sync (single binding).
    $("#cg_wikis").on("input", function () {
        s.wikis = String($(this).val()); saveSettingsDebounced();
        renderSavedWikis();
    });
    // Committing an edit (blur/change) is a DECREE for the CURRENT chat: bind it,
    // settle it as manual, purge foreign canon. The field stays the global default.
    $("#cg_wikis").on("change", function () {
        bindChatWiki(String($(this).val()).trim(), "(manual)", true);
    });

    $("#cg_autodiscover").prop("checked", s.autoDiscoverWiki !== false).on("change", function () {
        s.autoDiscoverWiki = $(this).prop("checked"); saveSettingsDebounced();
    });
    refreshWikiUi = () => { try { $("#cg_wikis").val(settings().wikis); renderSavedWikis(); } catch (e) { /* UI optional */ } };

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
        const st = cache();
        for (const k of Object.keys(st)) delete st[k];
        saveCache();
        parsedWords = new Set();   // let the parser re-evaluate every name again
        lastCast = [];
        lastCastLen = 0;
        renderCacheList();
        cgToast("info", "Canon cache cleared. Send a message (or 'Scan current scene now') to re-ground.");
    });
    $("#cg_rescan").on("click", async function () {
        const st = settings();
        if (!st.enabled) { cgToast("warning", "Canon Grounding is disabled."); return; }
        await verifyOrDiscoverWiki({ force: true });   // \ud83d\udd2d an explicit scan re-opens even a settled chat
        const ctx = getContext();
        const sceneText = sceneMessages(ctx, st.contextWindow).join("\n");
        if (!sceneText.trim()) { cgToast("info", "No visible scene to scan yet."); return; }
        const myEpoch = chatEpoch;   // switching chats mid-scan must not apply old-chat results
        try {
            if (st.llmParser) {
                cgToast("info", "Scanning the current scene…");
                const mySerial = ++parseSerial;
                const parsed = await parseSceneCharacters(sceneText);
                if (myEpoch !== chatEpoch) return;
                for (const n of extractCandidateNames(sceneText)) parsedWords.add(n.toLowerCase());
                if (parsed === null) {
                    cgToast("warning", `Parser: ${lastLlmError || "failed"} — nothing changed.`);
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
                        await applyCastWorldState(names, sceneText, myEpoch);
                        if (myEpoch !== chatEpoch) return;
                        cgToast("success", `Grounded: ${names.join(", ")}`);
                    } else {
                        cgToast("info", "Parser says no canon entities are in this scene.");
                    }
                }
            } else {
                const names = extractCandidateNames(sceneText);
                await groundNames(names);
                if (myEpoch !== chatEpoch) return;
                cgToast("info", `Scanned ${names.length} name(s) from the scene.`);
            }
        } catch (e) {
            cgToast("error", "Scan failed: " + e.message);
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
        // The reasons below are from a PREVIOUS non-empty turn. Leaving them up
        // put "Why each was injected" under a "Nothing injected" banner — a
        // panel that contradicts itself teaches the user to trust neither line.
        const $ghost = $("#cg_why");
        if ($ghost.length) $ghost.empty();
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
    bindChatWiki(val, "(manual)", true);   // a chip tap is a decree for the CURRENT chat too
    renderSavedWikis();
}

function renderSavedWikis() {
    const s = settings();
    const active = activeWikis().split(",").map(x => x.trim()).filter(Boolean);
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
    const $box = $("#cg_cache_list").empty();
    const cc = cache();
    const keys = Object.keys(cc);
    if (!keys.length) { $box.append('<span class="cg-empty">Cache is empty.</span>'); return; }
    for (const key of keys) {
        const e = cc[key];
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
            delete cc[key]; saveCache(); renderCacheList();
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
            try { if (renderCacheHook) renderCacheHook(); } catch (e) { /* UI optional */ }
            try { if (renderPromptDefaults) renderPromptDefaults(); } catch (e) { /* UI optional */ }
            // \ud83d\udd2d fire-and-forget wiki verification/discovery for the newly opened
            // chat — epoch-guarded inside, so a fast chat switch discards it cleanly.
            setTimeout(() => { verifyOrDiscoverWiki().catch(() => {}); }, 0);
        });
    }
    // \ud83d\udd2d the already-open chat never gets a CHAT_CHANGED — verify it on load.
    setTimeout(() => { verifyOrDiscoverWiki().catch(() => {}); }, 2000);
    console.log(`[CanonGrounding] v${CG_VERSION} loaded.`);
});
