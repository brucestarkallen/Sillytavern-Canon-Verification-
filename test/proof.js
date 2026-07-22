/*
 * Proof harness for Canon Grounding v0.2.0 — runs the extension's PURE functions
 * (extraction, parsing, matching, caching logic) outside SillyTavern by slicing them
 * from index.js and evaluating them with stubbed ST globals. Asserts the exact
 * behaviors the v0.2.0 fixes claim. Run: node test/proof.js
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

// ---- slice the pieces we need (consts + functions), skipping ESM imports/UI ----
function grab(marker, endMarker) {
    const i = src.indexOf(marker);
    if (i < 0) throw new Error("marker not found: " + marker);
    const j = src.indexOf(endMarker, i);
    if (j < 0) throw new Error("end not found after: " + marker);
    return src.slice(i, j);
}
const pieces = [
    "function ledgerNames() { return null; }  // stub: scan-mode ledger filter (not under test)",
    "let lastMatchReasons = [];               // stub: module-scope diagnostic the note builder writes",
    "let castFocus = {};                      // stub: scene-focus map written by the parser",
    "let castEvidence = {};                   // stub: evidence map written by the parser",
    grab("const STOPWORDS", "function extractCandidateNames"),
    grab("function extractCandidateNames", "// ------"),
    grab("function isMediaTitle", "async function findPageTitle"),
    grab("const PROSE_STOP", "// ------"),
    grab("/** Drop everything inside", "// ------"),
    grab("const NEGATIVE_TTL", "async function ensureGrounded"),
    grab("function clip(", "/**\n * Build the canon note."),
    grab("/**\n * Reasoning models", "async function parseSceneCharacters"),
    grab("/**\n * A multi-token query must be COVERED", "/** Fire-and-forget dossier"),
    grab("function parseDossier", "/**\n * LLM-curated dossier"),
    grab("/**\n * The identity line", "function extractLead"),
    grab("/** Prefer story-structure titles", "// ------"),
    grab("function apiBase", "async function"),
    grab("const CANON_INTENTS", "/**\n * 🗣 ASK CANON"),
    grab("const DEFAULT_PROMPT_HEADER", "const DEFAULT_PROMPT_PARSER"),
    grab("/**\n * ONE Appearance emitter", "// ------"),
];

// stubs for the module-scope things the sliced code touches
const sandbox = {
    settings: () => sandbox.__settings,
    __settings: { cache: {}, contextWindow: 10, useLedger: false },
    debug: () => {},
    lastCast: [],
    lastCastLen: 0,
    console,
};
const body = pieces.join("\n\n") + `
saveCache = () => {};   // persistence is sim's job — the real saveCache needs live ST context
return { extractCandidateNames, normalizeNameWord, isMediaTitle, cleanWikitext,
         extractInfoboxFields, extractSection, extractSectionRaw, extractTrivia,
         extractLead, extractAliases, extractFromProse, mentioned, escapeRegex,
         clip, cacheEntryFor, pruneStaleCast, isUnhandledName, parseNameArray,
         relationFor, pickArcHit, relevantCanonNote, extractQuotes, parseDossier,
         getReasons: () => lastMatchReasons,
         setFocus: (m) => { castFocus = m; },
         setParsedWords: (a) => { parsedWords = new Set(a); },
         setEvidence: (m) => { castEvidence = m; },
         splitEvidenceStrength,
         parseCast, verifyCastEvidence, isDisambiguation, identityLine, isMetaSeriesPage, parseCanonIntent, apiBase, extractDistinguishing, resolveAgainstKnown, titleCoversQuery, needsFirstMeetWait, extractLookProse, tightenLook, entryPoisoned, normWikiSet, missCoversCurrentWikis,
         setCast: (c, l) => { lastCast = c; lastCastLen = l; },
         getCast: () => lastCast };
`;
const api = new Function("settings", "debug", "console", body)(sandbox.settings, sandbox.debug, console);

let pass = 0, fail = 0;
function T(name, cond) {
    if (cond) { pass++; }
    else { fail++; console.log("  FAIL:", name); }
}
function eq(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) console.log(`  FAIL: ${name}\n    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
    ok ? pass++ : fail++;
}

// ---------------------------------------------------------------- extraction
console.log("[extractCandidateNames]");
eq("mid-sentence multiword name", api.extractCandidateNames("Then Rose Oriana entered the hall."), ["Rose Oriana"]);
T("sentence-initial lone cap filtered", !api.extractCandidateNames("Current scene continues quietly.").includes("Current"));
T("McGonagall extracted whole (was 'Gonagall')", api.extractCandidateNames("She saw McGonagall waiting.").includes("McGonagall"));
T("DxD extracted (was missed)", api.extractCandidateNames("The world of DxD is dangerous.").includes("DxD"));
eq("honorific stripped", api.extractCandidateNames("He waved at Alya-chan warmly."), ["Alya"]);
eq("possessive stripped", api.extractCandidateNames("He took Cid's sword away."), ["Cid"]);
T("contraction → stopword filtered", api.extractCandidateNames("Later He'll return to town.").length === 0);
T("ALLCAPS shouting excluded", api.extractCandidateNames("She screamed STOP RIGHT THERE loudly.").length === 0);
eq("lowercase short question", api.extractCandidateNames("whats rose oriana hair color"), ["rose oriana"]);
eq("lowercase honorific normalized", api.extractCandidateNames("tell me about alya-chan today"), ["alya"]);
eq("single lowercase name reachable (was impossible)", api.extractCandidateNames("whats alpha hair color"), ["alpha"]);
T("plain narration no longer manufactures junk", api.extractCandidateNames("she screamed loudly and ran home").length === 0);
T("bare greeting yields no candidate", api.extractCandidateNames("hello").length === 0);
T("trailing verb after name yields no candidate", api.extractCandidateNames("DecayA nods.").length === 0);
eq("bare two-token name still works", api.extractCandidateNames("cid kagenou"), ["cid kagenou"]);
eq("sentence adverb stripped from phrase", api.extractCandidateNames("Suddenly Rose Oriana appeared."), ["Rose Oriana"]);
eq("adverb-glued single name kept mid-phrase", api.extractCandidateNames("Meanwhile Cid sharpened his blade."), ["Cid"]);

// ---------------------------------------------------------------- infobox / sections
console.log("[wikitext extraction]");
const IB = `{{Infobox character
| name = Rose Oriana
| hair = Blonde
| eyes = Blue
| image = Rose.png
| imagewidth = 250px
| relatives = {{Plainlist|
* Raphael Oriana (father)
* Unnamed mother
}}
}}
== Appearance == <!--editor note-->
Rose has long blonde hair and blue eyes, usually tied back.
== Personality ==
Disciplined and earnest.`;
T("infobox hair+eyes found", /hair: Blonde/.test(api.extractInfoboxFields(IB, ["hair", "eyes"])) && /eyes: Blue/.test(api.extractInfoboxFields(IB, ["hair", "eyes"])));
T("image px fields rejected", !/px/.test(api.extractInfoboxFields(IB, ["image", "imagewidth", "hair"])));
T("plainlist relatives survive", /Raphael Oriana/.test(api.extractInfoboxFields(IB, ["relative"])));
T("header with trailing comment now readable (was skipped)", /blonde hair/.test(api.extractSection(IB, ["appearance"])));
const INLINE = `{{Infobox\n| hair = Silver}}\nBody text that must NOT leak into the value.`;
eq("inline-close infobox value doesn't swallow body", api.extractInfoboxFields(INLINE, ["hair"]), "hair: Silver");
const INNER = `{{Infobox\n| alias = {{ubl|Shadow|John Smith}}}}\nBody after.`;
T("inner template close doesn't truncate; box close does", /Shadow/.test(api.extractInfoboxFields(INNER, ["alias"])) && !/Body/.test(api.extractInfoboxFields(INNER, ["alias"])));
T("no raw braces reach output", !/[{}]/.test(api.extractInfoboxFields(IB, ["relative"])));
const OVERRUN = `{{Infobox
| eyes = Green
== Appearance ==
Should never be part of the eyes value.`;
T("value cut at section header over-run", !/never/.test(api.extractInfoboxFields(OVERRUN, ["eyes"])));

// ---------------------------------------------------------------- prose fallback
console.log("[prose physical]");
T("appearance-section prose recoverable without network", /hair: .*blonde/i.test(api.extractFromProse(api.extractSection(IB, ["appearance"], 1500))));
eq("compound color", api.extractFromProse("Sakura is a girl with pastel pink hair and eyes."), "hair: pastel pink; eyes: pastel pink");

// ---------------------------------------------------------------- aliases
console.log("[aliases]");
const AL = `{{Infobox
| alias = Solitary Princess / Alya、アーリャ
| nickname = Alya-chan (by Masachika)
}}`;
const aliases = api.extractAliases(AL, ["alias", "nickname"]);
T("slash-separated aliases split (new)", aliases.includes("Solitary Princess") && aliases.includes("Alya"));
T("(by X) note stripped", aliases.some(a => /Alya-chan/.test(a)) && !aliases.some(a => /Masachika/.test(a)));

// ---------------------------------------------------------------- mentioned()
console.log("[mentioned]");
T("word boundary: Cid ∉ Cidolfus", !api.mentioned("cid", "cidolfus raised his blade"));
T("possessive: Cid's matches", api.mentioned("cid", "cid's blade gleamed"));
T("hyphen boundary: alya-chan matches alya", api.mentioned("alya", "she nudged alya-chan gently"));
T("CYRILLIC now matches (was broken)", api.mentioned("Мария", "затем мария вошла в комнату"));
T("cyrillic non-match stays non-match", !api.mentioned("Мария", "затем алья вошла в комнату"));

// ---------------------------------------------------------------- parseNameArray null vs []
console.log("[parseNameArray failure vs empty]");
eq("model answered [] → []", api.parseNameArray("[]"), []);
eq("fenced array parsed", api.parseNameArray("```json\n[\"Cid Kagenou\", \"Alpha\"]\n```"), ["Cid Kagenou", "Alpha"]);
T("garbage → null (was [])", api.parseNameArray("I cannot help with that.") === null);
T("empty → null (was [])", api.parseNameArray("") === null);
eq("wrapped object's inner array recovered", api.parseNameArray('{"entities": ["Rose Oriana"]}'), ["Rose Oriana"]);

// ---------------------------------------------------------------- alias-aware cache + dedupe
console.log("[cache alias short-circuit]");
sandbox.__settings.cache = {
    "alya": { name: "Alisa Mikhailovna Kujou", sections: { physical: "hair: silver" }, aliases: ["Alya", "Solitary Princess"], found: true, ts: Date.now() },
};
T("canonical name resolves to nickname-keyed entry (no refetch path)", api.cacheEntryFor("alisa mikhailovna kujou")?.key === "alya");
T("second alias resolves too", api.cacheEntryFor("solitary princess")?.key === "alya");
T("isUnhandledName false for alias-known (post-gen gate fix)", api.isUnhandledName("Alisa Mikhailovna Kujou") === false);
sandbox.__settings.wikis = "testwiki";
sandbox.__settings.cache["mitsugoshi"] = { name: "mitsugoshi", sections: {}, found: false, searched: ["testwiki"], ts: Date.now() };
T("fresh negative covering the current wiki list is handled", api.isUnhandledName("Mitsugoshi") === false);
sandbox.__settings.cache["crossover ghost"] = { name: "crossover ghost", sections: {}, found: false, searched: ["some-old-wiki"], ts: Date.now() };
T("fresh negative from a DIFFERENT wiki list re-asks", api.isUnhandledName("Crossover Ghost") === true);
sandbox.__settings.cache["legacy ghost"] = { name: "legacy ghost", sections: {}, found: false, ts: Date.now() };
T("legacy negative (no stamp) re-asks once", api.isUnhandledName("Legacy Ghost") === true);
// A found entry under another key buries a stale miss shadowing the same name.
sandbox.__settings.cache["kenpachi zaraki"] = { name: "Kenpachi Zaraki", sections: {}, found: false, ts: Date.now() };
sandbox.__settings.cache["kenpachi zaraki (bleach)"] = { name: "Kenpachi Zaraki", sections: { look: "An eyepatched giant." }, aliases: ["Kenpachi Zaraki (bleach)"], found: true, ts: Date.now() };
T("found-under-suffixed-key beats the bare-name corpse", api.cacheEntryFor("kenpachi zaraki")?.entry.sections.look === "An eyepatched giant.");
T("the corpse is buried (panel row gone)", !("kenpachi zaraki" in sandbox.__settings.cache));
T("…and the gate re-routes to the found entry", api.isUnhandledName("Kenpachi Zaraki") === false);
sandbox.__settings.cache["mitsugoshi"].ts = Date.now() - 1000 * 60 * 60 * 25; // 25h old
T("EXPIRED negative is unhandled again (was handled forever)", api.isUnhandledName("Mitsugoshi") === true);

// ---------------------------------------------------------------- cast decay
console.log("[pruneStaleCast]");
sandbox.__settings.contextWindow = 10;
sandbox.__settings.cache = {
    "alya": { name: "Alisa Mikhailovna Kujou", sections: { physical: "x" }, aliases: ["Alya"], found: true, ts: Date.now() },
    "cid kagenou": { name: "Cid Kagenou", sections: { physical: "x" }, aliases: [], found: true, ts: Date.now() },
};
api.setCast(["Alisa Mikhailovna Kujou", "Cid Kagenou"], 20);
eq("within grace window → full cast kept", api.pruneStaleCast(25, ["she smiled", "the rain fell"]).length, 2);
api.setCast(["Alisa Mikhailovna Kujou", "Cid Kagenou"], 20);
const pruned = api.pruneStaleCast(40, ["alya leaned closer", "the rain fell"]); // 20 msgs later, only Alya named
eq("past grace: off-screen char dropped, mentioned (via alias) kept", pruned, ["Alisa Mikhailovna Kujou"]);
eq("prune writes back (ghost stays gone)", api.getCast(), ["Alisa Mikhailovna Kujou"]);
api.setCast([], 0);
eq("empty cast → []", api.pruneStaleCast(50, ["anything"]), []);

// ---------------------------------------------------------------- v0.3: trivia
console.log("[trivia]");
const TRIV = `== Trivia ==\n* Alpha secretly keeps every note Cid has ever written her.\n* [[Piped link|Her favorite tea]] is chamomile, per the author Q&A.\n* short\n* Alpha secretly keeps every note Cid has ever written her.\n== Gallery ==\n* notatrivia.png`;
const triv = api.extractTrivia(TRIV, ["trivia"]);
T("FIRST bullet survives when section starts with '*' (was dropped)", triv.startsWith("Alpha secretly keeps"));
T("bullets extracted + piped link cleaned", /secretly keeps every note/.test(triv) && /favorite tea/.test(triv) && !/Piped link/.test(triv));
T("short bullets dropped, duplicates deduped", !/(^|; )short/.test(triv) && triv.indexOf("secretly keeps") === triv.lastIndexOf("secretly keeps"));
T("bullets outside the Trivia section excluded", !/notatrivia/.test(triv));
T("maxBullets honored", api.extractTrivia(TRIV, ["trivia"], 1).split("; ").length === 1);

// ---------------------------------------------------------------- v0.3: raw subtree + relationFor
console.log("[relationFor]");
const RELPAGE = `== Relationships ==\nGeneral intro line.\n=== Cid Kagenou ===\nUtterly devoted to him; around Cid her stoic mask slips into open warmth.\n=== Beta ===\nTrusted fellow founder.\n== Trivia ==\n* x`;
const relRaw = api.extractSectionRaw(RELPAGE, ["relationships"]);
T("raw subtree keeps subsection headers", /=== Cid Kagenou ===/.test(relRaw) && /=== Beta ===/.test(relRaw));
T("raw subtree stops at sibling section", !/Trivia/.test(relRaw));
T("subsection hit via full name", /stoic mask slips/.test(api.relationFor(relRaw, ["Cid Kagenou"])));
T("subsection hit via ALIAS (Cid → Cid Kagenou)", /stoic mask slips/.test(api.relationFor(relRaw, ["Cid"])));
T("other subsection not leaked", !/devoted/.test(api.relationFor(relRaw, ["Beta"])));
const RELFLAT = `== Relationships ==\nShe treats most of Shadow Garden formally. Around Cid, however, she softens completely and defers to his every whim.\n\nWith strangers she is curt.`;
T("paragraph fallback when no subsections", /softens completely/.test(api.relationFor(api.extractSectionRaw(RELFLAT, ["relationships"]), ["Cid"])));
T("no mention → empty", api.relationFor(relRaw, ["Rose Oriana"]) === "");

// ---------------------------------------------------------------- v0.3: arc picking
console.log("[pickArcHit]");
T("exact title wins", api.pickArcHit(["Lawless City", "Lawless City Arc"], "lawless city") === "Lawless City");
T("structural title preferred over character page", api.pickArcHit(["Alexia Midgar", "Lawless City Arc"], "lawless") === "Lawless City Arc");
T("subpages skipped for structural pick", api.pickArcHit(["Cid Kagenou/Chapter Notes", "Chapter 45"], "chapter 45 stuff") === "Chapter 45");
T("no hits → null", api.pickArcHit([], "anything") === null);

// ---------------------------------------------------------------- v0.3: note framing + dynamics + arc
console.log("[note builder]");
sandbox.__settings = {
    cache: {
        "alpha": { name: "Alpha", found: true, wiki: "w", aliases: [],
                   sections: { physical: "hair: blonde", personality: "Stoic, commanding presence", trivia: "Keeps every note Cid wrote her" },
                   rel: { "cid kagenou": "Around Cid her stoic mask slips into open warmth." } },
        "cid kagenou": { name: "Cid Kagenou", found: true, wiki: "w", aliases: ["Cid"],
                   sections: { physical: "hair: black" }, rel: {} },
    },
    physical: true, personality: true, relationship: true, biography: false, abilities: false, trivia: true,
    relationDynamics: true, maxCharacters: 8, maxCharsPerChar: 700, maxTotalChars: 4500,
    arcInject: true, arcNote: { title: "Lawless City Arc", wiki: "w", summary: "Shadow Garden infiltrates the lawless city." },
    llmParser: true, contextWindow: 10,
};
const note = api.relevantCanonNote(["alpha nodded at cid kagenou"], ["Alpha", "Cid Kagenou"]);
T("framing: behavior-not-a-rule present", /DESCRIPTIVE — how this person has tended to act — never a rule/.test(note) && /overrides the baseline/.test(note));
T("per-pair dynamics line injected", /- With Cid Kagenou: Around Cid her stoic mask slips/.test(note));
T("dynamics line sits under Personality", note.indexOf("Personality: Stoic") < note.indexOf("With Cid Kagenou:"));
T("trivia line injected", /- Trivia: Keeps every note/.test(note));
T("arc block + spoiler guard on top", /STORY POSITION — Lawless City Arc/.test(note) && /never foreshadow/.test(note) && note.indexOf("STORY POSITION") < note.indexOf("Alpha:"));
sandbox.__settings.arcInject = false;
T("arc toggle off → no arc block", !/STORY POSITION/.test(api.relevantCanonNote(["alpha"], ["Alpha"])));
sandbox.__settings.arcInject = true;
sandbox.__settings.cache = {};
T("arc-only note injects with empty cast", /STORY POSITION/.test(api.relevantCanonNote([], [])));
sandbox.__settings.arcNote = null;
T("nothing at all → empty note", api.relevantCanonNote([], []) === "");

// ---------------------------------------------------------------- v0.4: voice quotes
console.log("[extractQuotes]");
const QSEC = `== Quotes ==\n* "I am [[Atomic (spell)|Atomic]]." — Lawless City\n* ''The truth hides in the shadows.''\n{{Quote|A mob character should act like a mob.|Cid|ch. 12}}\n* "I am Atomic." — repeated\n* "${"x".repeat(200)}"\n* "ok"`;
T("FIRST quote bullet survives leading-'*' body", api.extractQuotes(`== Quotes ==\n* "Unique first line here."`).includes("Unique first line here."));
const qs = api.extractQuotes(QSEC);
T("bullet quote extracted, link cleaned, attribution tail cut", /"I am Atomic\."/.test(qs) && !/Lawless City/.test(qs) && !/spell/.test(qs));
T("{{Quote|…}} template param lifted before cleaning", /mob character should act like a mob/.test(qs));
T("duplicates deduped (case-insensitive)", qs.match(/I am Atomic/g).length === 1);
T("monologue (>160) and fragment (<4) filtered", !/xxxxx/.test(qs) && !/"ok"/.test(qs));
T("cap at 3 samples", api.extractQuotes(QSEC + '\n* "Extra line four here."\n* "Extra line five here."').split(" / ").length <= 3);
T("empty section → empty", api.extractQuotes("") === "");

console.log("[note: voice]");
sandbox.__settings = {
    cache: {
        "alpha": { name: "Alpha", found: true, wiki: "w", aliases: [],
                   sections: { personality: "Stoic, commanding", voice: '"Shadow Garden moves tonight." / "Sloppy."' },
                   rel: { "cid kagenou": "Openly devoted." } },
        "cid kagenou": { name: "Cid Kagenou", found: true, wiki: "w", aliases: ["Cid"], sections: { physical: "hair: black" }, rel: {} },
    },
    physical: true, personality: true, relationship: true, biography: false, abilities: false, trivia: true, voice: true,
    relationDynamics: true, maxCharacters: 8, maxCharsPerChar: 700, maxTotalChars: 4500,
    arcInject: false, arcNote: null, llmParser: true, contextWindow: 10,
};
const vnote = api.relevantCanonNote(["alpha spoke"], ["Alpha", "Cid Kagenou"]);
T("voice line injected", /- Voice: "Shadow Garden moves tonight\."/.test(vnote));
T("voice ordered after dynamics", vnote.indexOf("With Cid Kagenou:") < vnote.indexOf("- Voice:"));
T("anti-parroting clause in header", /STYLE SAMPLES/.test(vnote) && /never repeat the sample lines/.test(vnote));
sandbox.__settings.voice = false;
T("voice toggle off → no voice line", !/- Voice:/.test(api.relevantCanonNote(["alpha spoke"], ["Alpha"])));

// ---------------------------------------------------------------- v0.5: fixes
console.log("[v0.5 fixes]");
const RELMULTI = `== Relationships ==\nShe respects Beta as her oldest comrade and studies alongside her.\n\nWith Cid she abandons formality entirely, hovering over him with unguarded warmth.\n\nGamma reports to her weekly.`;
const relmulti = api.extractSectionRaw(RELMULTI, ["relationships"]);
T("paragraph fallback returns the MENTIONING paragraph", /unguarded warmth/.test(api.relationFor(relmulti, ["Cid"])) && !/oldest comrade/.test(api.relationFor(relmulti, ["Cid"])));
T("first-paragraph mention still works", /oldest comrade/.test(api.relationFor(relmulti, ["Beta"])));
const QFIX = `== Quotes ==\n{{Quote|quote=Speak plainly.|Cid|ch. 3}}\n* "Half - broken - but alive."\n* Just a passing line — to Cid, ch. 12`;
const qfix = api.extractQuotes(QFIX);
T("named template param prefix stripped", /"Speak plainly\."/.test(qfix) && !/quote=/.test(qfix));
T("dash INSIDE quotation marks preserved", /"Half - broken - but alive\."/.test(qfix));
T("unquoted attribution tail still cut", /"Just a passing line"/.test(qfix) && !/ch\. 12/.test(qfix));
sandbox.__settings.arcInject = true;
sandbox.__settings.arcNote = { title: "Legacy Arc", wiki: "w", summary: "Legacy pin." };
T("per-chat arc param overrides legacy settings pin", /Chat Arc/.test(api.relevantCanonNote([], [], { title: "Chat Arc", wiki: "w", summary: "Chat pin." })) && !/Legacy Arc/.test(api.relevantCanonNote([], [], { title: "Chat Arc", wiki: "w", summary: "Chat pin." })));
T("explicit per-chat null suppresses legacy pin", api.relevantCanonNote([], [], null) === "");
T("undefined arc arg falls back to legacy", /Legacy Arc/.test(api.relevantCanonNote([], [])));
sandbox.__settings.arcNote = null;
T("[[File:…|thumb|Caption]] vanishes whole (no param leak)", api.cleanWikitext("Her cloak [[File:cloak.png|thumb|the cloak]] is black.") === "Her cloak is black.");
const TRIVFILE = `== Trivia ==\n* Her design changed in volume 3. [[File:old.png|200px|old design]]\n* Something else entirely here.`;
T("trivia bullet keeps text, drops file link", /design changed in volume 3\./.test(api.extractTrivia(TRIVFILE, ["trivia"])) && !/200px|old design/.test(api.extractTrivia(TRIVFILE, ["trivia"])));
sandbox.__settings.cache = { "alpha": { name: "Alpha", found: true, wiki: "w", aliases: [], sections: { physical: "hair: blonde" }, rel: {} } };
const knote = api.relevantCanonNote(["alpha"], ["Alpha"]);
T("knowledge-scope clause present (hidden-identity guard)", /KNOWLEDGE SCOPE/.test(knote) && /Hidden identities/.test(knote) && /never let a character/.test(knote));

// ---------------------------------------------------------------- v0.6: dossier + pins
console.log("[parseDossier]");
T("fenced JSON with chatter parsed", api.parseDossier('Sure! ```json\n{"identity":"Second princess of Oriana.","facts":["Student council president."],"secrets":[],"voice":[],"dynamics":{}}\n``` hope that helps').identity === "Second princess of Oriana.");
T("garbage → null", api.parseDossier("I cannot help with that.") === null);
T("array root → null", api.parseDossier('["not","a","dossier"]') === null);
T("empty-everything → null", api.parseDossier('{"identity":"","facts":[],"secrets":[],"voice":[],"dynamics":{}}') === null);
T("string fact coerced to array", api.parseDossier('{"identity":"x is y","facts":"Single fact."}').facts[0] === "Single fact.");
T("long fact clipped ≤200", api.parseDossier(`{"identity":"x","facts":["${"a".repeat(400)}"]}`).facts[0].length <= 200);
T("dynamics capped at 6", Object.keys(api.parseDossier(`{"identity":"x","dynamics":{${Array.from({length:9},(_,i)=>`"P${i}":"line ${i}"`).join(",")}}}`).dynamics).length === 6);

console.log("[note: dossier + identity + pins]");
sandbox.__settings = {
    cache: {
        "rose": { name: "Rose Oriana", found: true, wiki: "w", aliases: ["Rose"],
                  sections: { identity: "Rose Oriana is the second princess of the Oriana Kingdom.", physical: "hair: blond", personality: "Dignified.", trivia: "Loves swords." },
                  rel: {},
                  dossier: { identity: "Second princess of Oriana; student council president at Midgar Academy.",
                             facts: ["Wields the Oriana sword style.", "Engaged under political pressure to Perv Asshat."],
                             secrets: ["Becomes Shadow Garden's 666 after fleeing the kingdom."],
                             voice: ["I will protect my kingdom myself."],
                             dynamics: { "Cid Kagenou": "Sees him as an unremarkable classmate — and later, her savior." } } },
        "cid kagenou": { name: "Cid Kagenou", found: true, wiki: "w", aliases: ["Cid"], sections: { identity: "Cid Kagenou is a student at Midgar Academy.", physical: "hair: black" }, rel: {} },
    },
    physical: true, personality: true, relationship: true, biography: false, abilities: false, trivia: true, voice: true,
    relationDynamics: true, maxCharacters: 8, maxCharsPerChar: 900, maxTotalChars: 4500,
    arcInject: false, arcNote: null, llmParser: true, contextWindow: 10, llmDossier: true, pinnedGlobal: "",
};
const dnote = api.relevantCanonNote(["rose oriana drew her sword at cid kagenou"], ["Rose Oriana", "Cid Kagenou"]);
T("dossier identity leads the block", /- Identity: Second princess of Oriana; student council president/.test(dnote));
T("dossier facts joined", /- Facts: Wields the Oriana sword style\.; Engaged under political pressure/.test(dnote));
T("dossier dynamics used when no wiki pair slice", /- With Cid Kagenou: Sees him as an unremarkable classmate/.test(dnote));
T("secret line labeled for the KNOWLEDGE SCOPE guard", /- Secret \(unrevealed in-story — guard per KNOWLEDGE SCOPE\): Becomes Shadow Garden's 666/.test(dnote));
T("dossier suppresses regex personality/trivia fragments", !/- Personality: Dignified\./.test(dnote) && !/- Trivia: Loves swords\./.test(dnote));
T("dossier voice preferred", /- Voice: "I will protect my kingdom myself\."/.test(dnote));
api.relevantCanonNote(["rose oriana"], ["Rose Oriana"]);
T("reason marks curated entity with ✦", api.getReasons().some(r => /Rose Oriana/.test(r) && /✦/.test(r)));
sandbox.__settings.cache["rose"].rel["cid kagenou"] = "Wiki-sliced: cannot meet his eyes since the festival.";
T("wiki pair slice outranks dossier dynamics", /- With Cid Kagenou: Wiki-sliced: cannot meet his eyes/.test(api.relevantCanonNote(["rose glanced at cid kagenou"], ["Rose Oriana", "Cid Kagenou"])));
delete sandbox.__settings.cache["rose"].dossier;
const lnote = api.relevantCanonNote(["rose oriana"], ["Rose Oriana"]);
T("legacy path: identity ALWAYS injected (biography off)", /- Identity: Rose Oriana is the second princess of the Oriana Kingdom\./.test(lnote));
T("identity line precedes appearance", lnote.indexOf("- Identity:") < lnote.indexOf("- Appearance:"));
const pnote = api.relevantCanonNote([], [], null, { globalPin: "Never kill named characters without my OK.", chatPin: "Rose's engagement is already broken in this timeline.", pinNames: ["Rose"] });
T("pinned canon text block above entity blocks", /PINNED CANON \(user-authored — absolute, always in effect\):\nNever kill named characters without my OK\.\nRose's engagement is already broken in this timeline\./.test(pnote) && pnote.indexOf("PINNED CANON") < pnote.indexOf("Rose Oriana:"));
T("pinned entity forced with empty cast and empty scene", /Rose Oriana:/.test(pnote) && /- Identity: Rose Oriana is the second princess/.test(pnote));
T("pin + cast dedupe: one block", (api.relevantCanonNote(["rose oriana"], ["Rose Oriana"], null, { pinNames: ["Rose"] }).match(/Rose Oriana:/g) || []).length === 1);

// ---------------------------------------------------------------- v0.7: scene focus + accuracy
console.log("[v0.7 smartness]");
const pc = api.parseCast('```json\n[{"name":"Rose Oriana","now":"her engagement is being challenged"},"Cid Kagenou",{"name":"Rose Oriana","now":"dupe"}]\n```');
T("parseCast: objects + strings mixed, deduped by name", pc.length === 2 && pc[0].now === "her engagement is being challenged" && pc[1].name === "Cid Kagenou" && pc[1].now === "");
T("parseCast: [] stays explicit-empty", Array.isArray(api.parseCast("[]")) && api.parseCast("[]").length === 0);
T("parseCast: garbage → null", api.parseCast("no entities to speak of") === null);
T("parseNameArray compat view", JSON.stringify(api.parseNameArray('[{"name":"Alpha","now":"x"},"Beta"]')) === '["Alpha","Beta"]');
T("disambig template detected", api.isDisambiguation("{{Disambiguation}}\nRose may refer to several characters."));
T("'may refer to' lead detected", api.isDisambiguation("'''Rose''' may refer to:\n* [[Rose Oriana]]\n* [[Rose (episode)]]"));
T("normal page not flagged", !api.isDisambiguation("'''Rose Oriana''' is the second princess of the Oriana Kingdom. She may also be seen at the academy."));
const LONGLEAD = "'''Alexia Midgar''' is the second princess of the Midgar Kingdom and a student at the academy where she first met Cid. " + "She ".repeat(80);
T("identityLine cuts at a sentence boundary", api.identityLine(LONGLEAD).endsWith("met Cid."));
sandbox.__settings.cache = {
    "rose": { name: "Rose Oriana", found: true, wiki: "w", aliases: ["Rose"],
              sections: { identity: "Rose Oriana is the second princess of the Oriana Kingdom." }, rel: {},
              dossier: { identity: "Second princess of the Oriana Kingdom.",
                         facts: ["Second princess of the Oriana Kingdom", "Wields the Oriana sword style."],
                         secrets: [], voice: [], dynamics: {} } },
};
api.setFocus({ "rose oriana": "her engagement is being challenged publicly" });
const fnote = api.relevantCanonNote(["rose"], ["Rose Oriana"]);
T("Now line injected from scene focus", /- Now: her engagement is being challenged publicly/.test(fnote));
T("Now sits directly under Identity", fnote.indexOf("- Identity:") < fnote.indexOf("- Now:") && fnote.indexOf("- Now:") < fnote.indexOf("- Facts:"));
T("fact duplicated by identity dropped, distinct fact kept", !/- Facts: Second princess/.test(fnote) && /- Facts: Wields the Oriana sword style\./.test(fnote));
api.setFocus({ "rose": "alias-keyed focus works" });
T("focus reachable via alias key", /- Now: alias-keyed focus works/.test(api.relevantCanonNote(["rose"], ["Rose Oriana"])));
api.setFocus({});
T("no focus → no Now line", !/- Now:/.test(api.relevantCanonNote(["rose"], ["Rose Oriana"])));

// ---------------------------------------------------------------- v0.8: smart sweep
console.log("[smart sweep]");
sandbox.__settings.cache = {
    "rose": { name: "Rose Oriana", found: true, wiki: "w", aliases: ["Rose"],
              sections: { identity: "Rose Oriana is the second princess of the Oriana Kingdom." }, rel: {} },
    "alpha": { name: "Alpha", found: true, wiki: "w", aliases: [],
               sections: { identity: "Alpha is the first of the Seven Shadows." }, rel: {} },
};
api.setFocus({});
const snote = api.relevantCanonNote(["alpha watched from the rooftop as they spoke"], ["Rose Oriana"]);
T("cast entity injected", /Rose Oriana:/.test(snote));
T("cached entity named in scene injected WITHOUT being in cast", /Alpha:/.test(snote) && /Alpha is the first of the Seven Shadows/.test(snote));
api.relevantCanonNote(["alpha watched"], ["Rose Oriana"]);
T("sweep reason says no parser needed", api.getReasons().some(r => /Alpha/.test(r) && /no parser needed/.test(r)));
T("un-mentioned cached entity NOT swept in", !/Alpha:/.test(api.relevantCanonNote(["rose oriana stood alone"], ["Rose Oriana"])));

// ---------------------------------------------------------------- v0.8.2: reasoning-model output
console.log("[reasoning models]");
const THOUGHT = "<think>Let me check who is present. The scene shows [Alpha] and someone at index [0]. I should list them.</think>\n[{\"name\":\"Alpha\",\"now\":\"issuing orders\"}]";
T("think-block brackets no longer poison the array slice", api.parseCast(THOUGHT)[0].name === "Alpha" && api.parseCast(THOUGHT)[0].now === "issuing orders");
T("unclosed/stray think close handled", api.parseCast("reasoning noise with [junk] here</think>[\"Beta\"]")[0].name === "Beta");
T("prose bracket before real array skipped", api.parseCast('I see [several] people. Final answer: ["Cid Kagenou"]')[0].name === "Cid Kagenou");
T("cast [] still explicit-empty after strip", Array.isArray(api.parseCast("<think>nobody [relevant]</think>[]")) && api.parseCast("<think>nobody [relevant]</think>[]").length === 0);
T("garbage still null", api.parseCast("<think>hmm [x]</think>no array follows") === null);
const DTHOUGHT = "<think>The page mentions {her role} and {secrets}.</think>```json\n{\"identity\":\"First of the Seven Shadows.\",\"facts\":[],\"secrets\":[],\"voice\":[],\"dynamics\":{}}\n```";
T("dossier survives think-block braces", api.parseDossier(DTHOUGHT).identity === "First of the Seven Shadows.");
T("brackets inside JSON strings don't break balance", api.parseCast('[{"name":"Alpha","now":"quoting [redacted] orders"}]')[0].now === "quoting [redacted] orders");

// ---------------------------------------------------------------- v0.8.3: truncation salvage
console.log("[truncation salvage]");
const TRUNC = '```json\n[{"name": "Cid Kagenou", "now": "Confronted by Alpha about woman in his"}, {"name": "Alpha", "now": "demanding answers"}, {"name": "Beta", "now": "watching from the doo';
const sal = api.parseCast(TRUNC);
T("token-ceiling cutoff keeps every complete element", sal.length === 2 && sal[0].name === "Cid Kagenou" && sal[1].name === "Alpha");
T("complete element data intact after salvage", sal[0].now === "Confronted by Alpha about woman in his" && sal[1].now === "demanding answers");
T("cut right after a comma salvages cleanly", api.parseCast('[{"name":"Alpha","now":"x"},').length === 1);
T("truncated bare-string array salvages", api.parseCast('["Alpha", "Beta", "Ci').length === 2);
T("nothing complete → still null", api.parseCast('[{"name": "Al') === null);
T("full arrays untouched by salvage path", api.parseCast('[{"name":"Alpha","now":"complete"}]')[0].now === "complete");

// ---------------------------------------------------------------- v0.9: big-wiki template dialects
console.log("[big-wiki dialects]");
const COTE = `{{Character/Y3\n|LNImageY1 = \n|MAImageY1 = \n|ANImageY1 = Hondo Anime.png\n|name = Ryōtarō Hondō\n|kanji = 本堂遼太郎\n|status = Active\n|status2 = Active\n|Y1occupation = Student\n|Y2occupation = Student\n|haircolor = Blue\n|if = {{#if: {{{x|}}} | a | b}}\n}}\n'''Ryōtarō Hondō''' is a student of Class 1-B.\n== Appearance ==\nBlue hair.`;
T("triple-brace infobox never leaks into identity", api.identityLine(COTE) === "Ryōtarō Hondō is a student of Class 1-B.");
T("cleanWikitext drops the whole exotic infobox", !/LNImageY1|MAImage/.test(api.cleanWikitext(COTE)));
T("identity junk-guard rejects param soup", api.identityLine("{{Broken\n'''X''' |LNImageY1 = |name = X |kanji = 本") === "");
const cif = api.extractInfoboxFields(COTE, ["status", "occupation"]);
T("year-prefixed keys normalized + deduped (one occupation, one status)", (cif.match(/occupation:/g) || []).length === 1 && (cif.match(/status:/g) || []).length === 1 && !/Y1|status2/.test(cif));
T("series' own page detected as meta", api.isMetaSeriesPage("'''Yōkoso Jitsuryoku''' , abbreviated You-Zitsu, is a Japanese light novel series written by Shōgo Kinugasa."));
T("character page not flagged as meta", !api.isMetaSeriesPage("'''Rose Oriana''' is the second princess of the Oriana Kingdom."));
const dmeta = api.parseDossier('{"identity":"A 17-year-old student.","facts":["Her birthday is January 1.","No information about her personality is provided in the source material."],"secrets":["The source does not mention any secrets, not specified further."],"voice":[],"dynamics":{}}');
T("meta-apology facts filtered out", dmeta.facts.length === 1 && dmeta.facts[0] === "Her birthday is January 1." && dmeta.secrets.length === 0);

// ---------------------------------------------------------------- v0.9.2: parser judgment + blocklist
console.log("[blocklist / parser judgment]");
sandbox.__settings.cache = {
    "nanase": { name: "Tsubasa Nanase", found: true, wiki: "w", aliases: ["Nanase"],
                sections: { identity: "Tsubasa Nanase is a first-year student." }, rel: {} },
    "ans": { name: "Advanced Nurturing High School", found: true, wiki: "w", aliases: ["ANHS"],
                sections: { identity: "Advanced Nurturing High School is a government-established institution." }, rel: {} },
    "nishikawa": { name: "Ryōko Nishikawa", found: true, wiki: "w", aliases: ["Nishikawa"],
                sections: { identity: "Ryōko Nishikawa is a student." }, rel: {} },
};
api.setFocus({});
const pj = api.relevantCanonNote(["nanase bowed as they entered the school grounds"], ["Tsubasa Nanase", "Advanced Nurturing High School"]);
T("REVERT LOCK: parser-cast entity injects without a literal mention ('the school')", /Advanced Nurturing High School:/.test(pj));
const bl = api.relevantCanonNote(["nanase and nishikawa laughed together"], ["Tsubasa Nanase", "Ryōko Nishikawa"], null, { blockNames: ["Ryōko Nishikawa"] });
T("blocked entity never injects even when cast AND literally mentioned", /Tsubasa Nanase:/.test(bl) && !/Nishikawa:/.test(bl));
T("block works by alias too", !/Nishikawa:/.test(api.relevantCanonNote(["nishikawa waved"], ["Ryōko Nishikawa"], null, { blockNames: ["nishikawa"] })));
T("block outranks a conflicting pin", !/Nishikawa:/.test(api.relevantCanonNote([], [], null, { pinNames: ["Ryōko Nishikawa"], blockNames: ["Ryōko Nishikawa"] })));
T("block does not touch other sweep entities", /Nanase:/.test(api.relevantCanonNote(["nanase smiled"], [], null, { blockNames: ["Ryōko Nishikawa"] })) || /Tsubasa Nanase:/.test(api.relevantCanonNote(["nanase smiled"], [], null, { blockNames: ["Ryōko Nishikawa"] })));

// ---------------------------------------------------------------- v0.10: evidence verification
console.log("[evidence verification]");
const SCENE = "Nanase bowed as they entered the school grounds. \"Welcome,\" she said softly.";
const RAWCAST = [
    { name: "Tsubasa Nanase", now: "greeting them", evidence: "Nanase bowed" },
    { name: "Advanced Nurturing High School", now: "setting", evidence: "the school grounds" },
    { name: "Ryōko Nishikawa", now: "likely nearby", evidence: "her classmates gathered" },
    { name: "Kazuomi Hōsen", now: "", evidence: "" },
];
const kept = api.verifyCastEvidence(RAWCAST, SCENE);
T("evidenced entities survive (direct + indirect reference)", kept.length === 2 && kept[0].name === "Tsubasa Nanase" && kept[1].name === "Advanced Nurturing High School");
T("fabricated evidence (not in scene) drops the entity", !kept.some(c => c.name === "Ryōko Nishikawa"));
T("no evidence + name not in scene drops the entity", !kept.some(c => c.name === "Kazuomi Hōsen"));
T("evidence check is case/whitespace-insensitive", api.verifyCastEvidence([{ name: "X", now: "", evidence: "THE   SCHOOL grounds" }], SCENE).length === 1);
T("evidence-less element kept when its NAME is in the text (compat)", api.verifyCastEvidence([{ name: "Nanase", now: "", evidence: "" }], SCENE).length === 1);
T("all-fabricated cast verifies to explicit empty", api.verifyCastEvidence([{ name: "Ghost", now: "", evidence: "never said" }], SCENE).length === 0);
T("parseCast passes evidence through", api.parseCast('[{"name":"Alpha","now":"x","evidence":"quoted words"}]')[0].evidence === "quoted words");

// ---------------------------------------------------------------- v0.11: auditor split + setting persistence
console.log("[auditor split / setting persistence]");
const SC2 = "Nanase bowed as they entered the school grounds where her classmates gathered.";
const split = api.splitEvidenceStrength([
    { name: "Tsubasa Nanase", now: "", evidence: "Nanase bowed" },
    { name: "Advanced Nurturing High School", now: "", evidence: "the school grounds" },
    { name: "Ryōko Nishikawa", now: "", evidence: "her classmates gathered" },
    { name: "Kakeru Ryūen", now: "", evidence: "" },
], SC2);
T("name-token evidence is strong", split.strong.some(c => c.name === "Tsubasa Nanase"));
T("place-name + place-evidence pair is strong (ANS survives)", split.strong.some(c => c.name === "Advanced Nurturing High School"));
T("generic evidence is WEAK → goes to the auditor, not the cast", split.weak.some(c => c.name === "Ryōko Nishikawa"));
T("evidence-less element is UNPROVEN: routed weak with the name as the claim", split.weak.some(c => c.name === "Kakeru Ryūen" && c.evidence === "Kakeru Ryūen"));
T("generic + evidence-less both queue for the auditor", split.weak.length === 2);
sandbox.__settings.cache = {
    "ans": { name: "Advanced Nurturing High School", found: true, wiki: "w", aliases: ["ANHS"], kind: "place",
             sections: { identity: "Advanced Nurturing High School is a government-established institution." }, rel: {} },
    "nanase": { name: "Tsubasa Nanase", found: true, wiki: "w", aliases: [], kind: "character",
             sections: { identity: "Tsubasa Nanase is a first-year student." }, rel: {} },
};
api.setFocus({}); api.setEvidence({});
const setnote = api.relevantCanonNote(["she walked silently down the corridor"], ["Tsubasa Nanase"], null, { settingKey: "ans" });
T("current setting injects with ZERO mention in prose", /Advanced Nurturing High School:/.test(setnote));
api.relevantCanonNote(["she walked"], [], null, { settingKey: "ans" });
T("setting reason says it persists", api.getReasons().some(r => /current setting \(persists without mention\)/.test(r)));
T("blocklist still beats the setting", !/Advanced Nurturing High School:/.test(api.relevantCanonNote([], [], null, { settingKey: "ans", blockNames: ["ANHS"] })));
api.setEvidence({ "tsubasa nanase": "Nanase bowed" });
api.relevantCanonNote(["nanase bowed"], ["Tsubasa Nanase"]);
T("Why-these carries the evidence quote", api.getReasons().some(r => /Tsubasa Nanase/.test(r) && /evidence: "Nanase bowed"/.test(r)));
api.setEvidence({});

// ---------------------------------------------------------------- v0.12: prompt overrides
console.log("[prompt overrides]");
T("default header applies when override empty", /\[CANON REFERENCE/.test(api.relevantCanonNote(["nanase smiled"], ["Tsubasa Nanase"])) );
sandbox.__settings.promptHeader = "[MY CUSTOM FRAME]\n";
T("header override replaces the default wholesale", (function(){ const n = api.relevantCanonNote(["nanase smiled"], ["Tsubasa Nanase"]); return /\[MY CUSTOM FRAME\]/.test(n) && !/\[CANON REFERENCE/.test(n); })());
sandbox.__settings.promptHeader = "";
T("empty override falls back to default again", /\[CANON REFERENCE/.test(api.relevantCanonNote(["nanase smiled"], ["Tsubasa Nanase"])));

// ---------------------------------------------------------------- v0.13: lowercase gate + smart expansion
console.log("[lowercase gate / smart expansion]");
T("dossier parses related background entities (string back-compat)", api.parseDossier('{"identity":"Second princess.","related":["Oriana Kingdom","Midgar Academy"]}').related.map(r => r.name).join("|") === "Oriana Kingdom|Midgar Academy");
sandbox.__settings.cache = {
    "rose": { name: "Rose Oriana", found: true, wiki: "w", aliases: [], kind: "character",
              sections: { identity: "Rose Oriana is the second princess of the Oriana Kingdom." }, rel: {},
              dossier: { identity: "Second princess of the Oriana Kingdom.", facts: [], secrets: [], voice: [],
                         related: ["Oriana Kingdom"], dynamics: {} } },
    "oriana kingdom": { name: "Oriana Kingdom", found: true, wiki: "w", aliases: [], kind: "place",
              sections: { identity: "The Oriana Kingdom is a small nation famed for its sword saints." }, rel: {} },
};
api.setFocus({}); api.setEvidence({});
sandbox.__settings.smartExpansion = true;
const sx = api.relevantCanonNote(["rose oriana drew her blade"], ["Rose Oriana"]);
T("Smarter AI ON: Context line carries the kingdom", /- Context: Oriana Kingdom — The Oriana Kingdom is a small nation/.test(sx));
sandbox.__settings.smartExpansion = false;
T("Smarter AI OFF = strict: no Context line", !/- Context:/.test(api.relevantCanonNote(["rose oriana drew her blade"], ["Rose Oriana"])));
sandbox.__settings.smartExpansion = true;
T("blocklist beats Context expansion", !/- Context:/.test(api.relevantCanonNote(["rose oriana drew"], ["Rose Oriana"], null, { blockNames: ["Oriana Kingdom"] })));

// ---------------------------------------------------------------- v0.14: scene-conditional context
console.log("[scene-conditional context]");
T("related {name,why} parsed; strings back-compat", (function(){
    const d = api.parseDossier('{"identity":"x is y","related":[{"name":"Oriana Kingdom","why":"her homeland"},"Midgar Academy"]}');
    return d.related.length === 2 && d.related[0].why === "her homeland" && d.related[1].name === "Midgar Academy" && d.related[1].why === "";
})());
sandbox.__settings.cache = {
    "rose": { name: "Rose Oriana", found: true, wiki: "w", aliases: [], kind: "character",
              sections: { identity: "Rose Oriana is the second princess." }, rel: {},
              dossier: { identity: "Second princess of the Oriana Kingdom.", facts: [], secrets: [], voice: [],
                         related: [ { name: "Oriana Kingdom", why: "her homeland and throne" },
                                    { name: "Oriana Sword Style", why: "her school of swordsmanship" } ], dynamics: {} } },
    "oriana kingdom": { name: "Oriana Kingdom", found: true, wiki: "w", aliases: [], kind: "place",
              sections: { identity: "The Oriana Kingdom is a small nation." }, rel: {} },
    "oriana sword style": { name: "Oriana Sword Style", found: true, wiki: "w", aliases: [], kind: "place",
              sections: { identity: "The Oriana Sword Style is a royal school of swordsmanship." }, rel: {} },
};
api.setEvidence({});
api.setFocus({ "rose oriana": "locked in a swordsmanship duel" });
const duel = api.relevantCanonNote(["their blades met in the courtyard"], ["Rose Oriana"]);
T("duel focus surfaces the SWORD school, not the kingdom", /- Context: Oriana Sword Style \(her school of swordsmanship\)/.test(duel) && !/- Context: Oriana Kingdom/.test(duel));
api.setFocus({ "rose oriana": "defending her claim to the throne" });
const court = api.relevantCanonNote(["the court murmured"], ["Rose Oriana"]);
T("throne focus surfaces the KINGDOM", /- Context: Oriana Kingdom \(her homeland and throne\)/.test(court) && !/Sword Style/.test(court));
api.setFocus({});
const idle = api.relevantCanonNote(["she sipped her tea quietly"], ["Rose Oriana"]);
T("no match anywhere → ONE anchor line only (less, not more)", (idle.match(/- Context:/g) || []).length === 1);
sandbox.__settings.cache["oriana kingdom"].kind = "place";
const dedup = api.relevantCanonNote(["she sipped tea"], ["Rose Oriana"], null, { settingKey: "oriana kingdom" });
T("background entity already present as a block gets NO duplicate Context line", /Oriana Kingdom:/.test(dedup) && !/- Context: Oriana Kingdom/.test(dedup));

// ---------------------------------------------------------------- v0.16: apiBase hosts + intent parse
console.log("[hosts / ask-canon intent]");
T("bare subdomain → fandom", api.apiBase("the-eminence-in-shadow") === "https://the-eminence-in-shadow.fandom.com/api.php");
T("dotted entry → full MediaWiki host (wiki.gg)", api.apiBase("terraria.wiki.gg") === "https://terraria.wiki.gg/api.php");
T("scheme/path stripped from pasted URLs", api.apiBase("https://terraria.wiki.gg/wiki/Guide") === "https://terraria.wiki.gg/api.php");
T("intent parsed with fences + chatter", JSON.stringify(api.parseCanonIntent('sure! ```json\n{"action":"pin","target":"Rose Oriana"}\n```')) === '{"action":"pin","target":"Rose Oriana"}');
T("unknown action → null", api.parseCanonIntent('{"action":"summon","target":"X"}') === null);
T("missing target → null", api.parseCanonIntent('{"action":"pin","target":""}') === null);

// ---------------------------------------------------------------- v0.17: autonomy
console.log("[autonomy]");
T("event names detected (arc/festival/exam/war)", ["Bushin Festival", "Lawless City Arc", "Sports Festival", "Special Exam", "Great War"].every(n => /\b(arc|saga|festival|exam|examination|tournament|war|battle|incident|trial|ceremony|raid|expedition|invasion|uprising|rebellion|massacre|banquet|gala|election)\b/i.test(n)));
T("plain places and people are NOT events", !["Advanced Nurturing High School", "Rose Oriana", "Oriana Kingdom", "Midgar Academy"].some(n => /\b(arc|saga|festival|exam|examination|tournament|war|battle|incident|trial|ceremony|raid|expedition|invasion|uprising|rebellion|massacre|banquet|gala|election)\b/i.test(n)));

// ---------------------------------------------------------------- v0.18: curated selection
console.log("[curated selection]");
sandbox.__settings.cache = {
    "rose": { name: "Rose Oriana", found: true, wiki: "w", aliases: [], kind: "character",
              sections: { identity: "Rose Oriana is the second princess." }, rel: {},
              dossier: { identity: "Second princess of the Oriana Kingdom.",
                         facts: ["Her birthday is in spring.", "She wields the Oriana sword style in duels.",
                                 "She once trained under the royal instructor.", "Her favorite tea is chamomile."],
                         secrets: [], voice: [], related: [], dynamics: {} } },
};
api.setEvidence({});
api.setFocus({ "rose oriana": "locked in a sword duel" });
const hotf = api.relevantCanonNote(["their duel began in earnest"], ["Rose Oriana"]);
T("duel scene surfaces the sword fact FIRST", /- Facts: She wields the Oriana sword style in duels\./.test(hotf));
api.setFocus({});
const coldf = api.relevantCanonNote(["she hummed a tune"], ["Rose Oriana"]);
T("idle scene shows only 3 anchor facts", ((coldf.match(/- Facts: [^\n]*/) || [""])[0].match(/;/g) || []).length === 2 && !/chamomile/.test(coldf));
// ---------------------------------------------------------------- v0.19: prose briefs
console.log("[prose briefs]");
T("dossier parses the brief", api.parseDossier('{"identity":"x","brief":"A composed princess who hides steel beneath courtesy, she measures every room before she speaks."}').brief.startsWith("A composed princess"));
sandbox.__settings.cache = {
    "rose": { name: "Rose Oriana", found: true, wiki: "w", aliases: [], kind: "character",
              sections: { identity: "Rose Oriana is the second princess.", physical: "hair: blond" }, rel: {},
              dossier: { identity: "Second princess of the Oriana Kingdom.",
                         brief: "A composed princess who hides steel beneath courtesy, Rose measures every room before she speaks and bleeds for her kingdom in private.",
                         facts: ["She wields the Oriana sword style."], secrets: [], voice: [], related: [], dynamics: {} } },
};
api.setEvidence({}); api.setFocus({});
sandbox.__settings.proseBriefs = true;
const pn = api.relevantCanonNote(["rose entered"], ["Rose Oriana"]);
T("brief opens the block as prose (no Identity label)", /Rose Oriana:\n  A composed princess who hides steel/.test(pn) && !/- Identity:/.test(pn));
T("appearance stays verbatim beneath the brief", /- Appearance: hair: blond/.test(pn));
sandbox.__settings.proseBriefs = false;
T("toggle off → labeled Identity returns", /- Identity: Second princess of the Oriana Kingdom\./.test(api.relevantCanonNote(["rose entered"], ["Rose Oriana"])));
sandbox.__settings.proseBriefs = true;
delete sandbox.__settings.cache["rose"].dossier.brief;
T("brief-less dossier falls back to Identity line", /- Identity: Second princess/.test(api.relevantCanonNote(["rose entered"], ["Rose Oriana"])));

// ---------------------------------------------------------------- v0.20.1: hair survives + whole-line budget
console.log("[hair / whole-line budget]");
T("{{Color|#hex|Royal Blue}} yields its text", api.extractInfoboxFields("{{X\n|haircolor = {{Color|#4169e1|Royal Blue}}\n|eyecolor = Magenta\n}}", ["hair","eye"]) === "haircolor: Royal Blue; eyecolor: Magenta");
T("{{nowrap}}/{{small}} unwrap too", api.cleanWikitext("Height: {{nowrap|175 cm}} tall, {{small|approx.}}") === "Height: 175 cm tall, approx.");
sandbox.__settings.cache = {
    "hondo": { name: "Ryōtarō Hondō", found: true, wiki: "w", aliases: [], kind: "character",
              sections: { identity: "A student of Class 1-B.", physical: "haircolor: Blue; eyecolor: Magenta" }, rel: {},
              dossier: { identity: "A student of Class 1-B.",
                         brief: "B".repeat(400),
                         facts: ["F1 " + "x".repeat(120) + " end.", "F2 " + "y".repeat(120) + " end.", "F3 short."],
                         secrets: [], voice: [], related: [], dynamics: {} } },
};
api.setEvidence({}); api.setFocus({});
sandbox.__settings.maxCharsPerChar = 620;
const wb = api.relevantCanonNote(["hondō spoke"], ["Ryōtarō Hondō"]);
T("over-budget drops WHOLE trailing lines, never amputates mid-fact", !/…/.test(wb.split("Ryōtarō Hondō:")[1] || "") || !/- Facts: [^\n]*…/.test(wb));
T("appearance line survives the budget squeeze", /- Appearance: haircolor: Blue; eyecolor: Magenta/.test(wb));
T("name + brief always ride", /Ryōtarō Hondō:\n  BBBB/.test(wb));
sandbox.__settings.maxCharsPerChar = 1100;

// ---------------------------------------------------------------- v0.21: full-body appearance
console.log("[full-body appearance]");
T("distinguishing prose extracted (Gamma's mole)", api.extractDistinguishing("Gamma is a tall, beautiful woman. She has a beauty mark under her left eye. Her hair reaches her waist.") === "She has a beauty mark under her left eye.");
T("build sentences count as distinguishing", /slender but deceptively strong/.test(api.extractDistinguishing("She appears slender but deceptively strong in close combat.")));
T("cap at 2 sentences", api.extractDistinguishing("A scar marks his brow, old and pale. A tattoo winds down his arm in black ink. A mole sits at his jaw for good measure.").split(". ").length <= 2 + 1);
T("plain description yields nothing", api.extractDistinguishing("He has brown hair and wears the school uniform neatly.") === "");
T("no marker sentence over 180 chars", api.extractDistinguishing("A scar " + "x".repeat(200) + ".") === "");

// ---------------------------------------------------------------- v0.21.1: attribute completion
console.log("[attribute completion]");
T("prose extractor finds hair phrase (sanity)", /hair: (long )?dark/i.test(api.extractFromProse("Hiyori has long dark hair and violet eyes.")) || /dark hair/i.test(api.extractFromProse("Hiyori has long dark hair and violet eyes.")));
// ---------------------------------------------------------------- v0.21.2: Hiyori's page, verbatim
console.log("[hiyori verbatim]");
const HIYORI = "Hiyori has mid-back length silver hair, which she ties back with black ribbons. She has light purple eyes. She is usually seen wearing her school uniform with grey thigh-high socks and brown loafers.";
const hp = api.extractFromProse(HIYORI);
T("silver hair extracted cleanly (not 'length silver')", /hair: silver/.test(hp) && !/length/.test(hp));
T("modifier kept for eyes", /eyes: light purple/.test(hp));
// ---------------------------------------------------------------- v0.22: known-canon snap + coverage
console.log("[known-canon / coverage]");
sandbox.__settings.cache = {
    "kakeru ryuen": { name: "Kakeru Ryūen", found: true, wiki: "w", aliases: ["Ryūen"], kind: "character",
                      sections: { identity: "Leader of Class C." }, rel: {} },
    "akito miyake": { name: "Akito Miyake", found: true, wiki: "w", aliases: ["Miyake"], kind: "character",
                      sections: { identity: "A student of Class C." }, rel: {} },
};
const snapped = api.resolveAgainstKnown([{ name: "Miyake Kakeru", now: "talking", evidence: "Kakeru" }]);
T("bare 'Kakeru' snaps the hybrid to the established Kakeru Ryūen", snapped[0].name === "Kakeru Ryūen" && snapped[0].now === "talking");
sandbox.__settings.cache["kakeru hondo"] = { name: "Kakeru Hondō", found: true, wiki: "w", aliases: [], kind: "character", sections: { identity: "x" }, rel: {} };
T("two cached Kakerus = ambiguous → untouched", api.resolveAgainstKnown([{ name: "Miyake Kakeru", now: "", evidence: "Kakeru" }])[0].name === "Miyake Kakeru");
delete sandbox.__settings.cache["kakeru hondo"];
T("multi-word evidence never snaps", api.resolveAgainstKnown([{ name: "Miyake Kakeru", now: "", evidence: "Kakeru laughed" }])[0].name === "Miyake Kakeru");
T("coverage: hybrid query rejected by wrong page", api.titleCoversQuery("Miyake Kakeru", "Akito Miyake", []) === false);
T("coverage: expansion allowed (Rose → Rose Oriana)", api.titleCoversQuery("Rose", "Rose Oriana", []) === true);
T("coverage: nickname passes via alias (Alya)", api.titleCoversQuery("Alya", "Alisa Mikhailovna Kujou", ["Alya"]) === true);

// ---------------------------------------------------------------- v0.23: first-meeting wait
console.log("[first-meeting wait]");
sandbox.__settings.cache = { "rose oriana": { name: "Rose Oriana", found: true, wiki: "w", aliases: ["Rose"], kind: "character", sections: { identity: "x" }, rel: {} } };
sandbox.__settings.lowercaseNames = true;
api.setParsedWords([]);
T("uncached capitalized name in user msg → wait", api.needsFirstMeetWait("You meet Alexia Midgar at the gate") === true);
T("cached name → no wait", api.needsFirstMeetWait("You greet Rose Oriana warmly") === false);
T("novel lowercase pair → wait", api.needsFirstMeetWait("you meet alexia midgar quietly") === true);
api.setParsedWords(["alexia", "midgar"]);
T("learned words never re-trigger (converges)", api.needsFirstMeetWait("you meet alexia midgar quietly", ["earlier you meet people quietly all the time"]) === false);
T("conversation vocabulary counts as known (verbs never gate)", api.needsFirstMeetWait("you embrace rose oriana warmly", ["you embrace people warmly often"]) === false);
api.setParsedWords([]);
T("empty message → no wait", api.needsFirstMeetWait("") === false);

// ---------------------------------------------------------------- v0.24: look prose (Ayanokōji verbatim)
console.log("[look prose]");
const AYAN = "Kiyotaka is a tall and lean young man with brown hair, brown eyes, and a fair complexion. He is usually seen wearing a standard school uniform. Outside of school, he wears a white hoodie covering a green shirt with an orange stripe along with brown pants. He is also seen wearing a blue vest over a white shirt and brown pants. He has grown taller since his first arrival at the school.";
const lk = api.extractLookProse(AYAN);
T("look = wiki's own opening description, sentence-cut", lk.startsWith("Kiyotaka is a tall and lean young man") && /fair complexion/.test(lk) && lk.length <= 300 && /[.!?]$/.test(lk));
const tl = api.tightenLook(lk, "Kiyotaka Ayanokōji");
T("tighten: leading name never re-paid", tl.startsWith("A tall and lean young man with brown hair") && !/Kiyotaka/.test(tl));
T("tighten: scaffolding compressed", /Usually wears a standard school uniform\./.test(tl) && !/usually seen wearing/i.test(tl));
T("tighten: facts intact", /fair complexion/.test(tl) && /brown hair/.test(tl));
T("tighten: 'has' form works", api.tightenLook("Gamma has a beauty mark under her left eye.", "Gamma") === "Has a beauty mark under her left eye.");
T("empty prose → empty look", api.extractLookProse("") === "");
sandbox.__settings.cache = {
    "ayan": { name: "Kiyotaka Ayanokōji", found: true, wiki: "w", aliases: [], kind: "character",
              sections: { identity: "A student.", physical: "haircolor: Brown; eyecolor: Brown; height: 176 cm",
                          look: "A tall and lean young man with brown hair, brown eyes, and a fair complexion. Usually wears a standard school uniform." }, rel: {} },
};
api.setEvidence({}); api.setFocus({});
const an = api.relevantCanonNote(["ayanokōji watched"], ["Kiyotaka Ayanokōji"]);
T("Appearance leads with prose, robotic facts deduped into bracket", /- Appearance: A tall and lean young man/.test(an) && !/haircolor: Brown/.test(an) && /\[height: 176 cm\]/.test(an));
delete sandbox.__settings.cache["ayan"].sections.look;
T("no look → plain facts line (fallback intact)", /- Appearance: haircolor: Brown; eyecolor: Brown; height: 176 cm/.test(api.relevantCanonNote(["ayanokōji watched"], ["Kiyotaka Ayanokōji"])));

// ---------------------------------------------------------------- v0.26: markup containment (Tsunade verbatim)
console.log("[markup containment]");
const TSU = `'''Tsunade''' is a fair-skinned kunoichi. <!-- lead comment > with angle -->
<gallery>
Lead Tsunade.png|In the lead.
</gallery>
== Appearance == <!--images-->
<gallery widths="120" mode="packed-hover">
Kid Tsunade.png|Tsunade as a child.
Tsunade full.png|Tsunade's full appearance.
Tsunade off jacket.png|Tsunade without her haori.
Tsunade shinobi outfit.png|Tsunade in her shinobi outfit.
</gallery>
Tsunade is a fair-skinned woman with brown eyes and straight blonde hair. She is often seen wearing a grass-green haori.
<tabber>
Part I=[[File:TsunadeP1.png|thumb]]
|-|Part II=In Part II her attire changes little.
</tabber>
== Background ==
{| class="wikitable"
! Arc !! Role
|-
| Search || Legendary Sannin
|}
Tsunade left the village after the war.
__NOTOC__
`;
const tsuProse = api.cleanWikitext(api.extractSectionRaw(TSU, ["appearance", "physical appearance"], 4000));
const tsuLook = api.tightenLook(api.extractLookProse(tsuProse), "Tsunade");
T("gallery filenames never reach the look", !/\.png/i.test(tsuLook) && !/\|/.test(tsuLook));
T("look = the wiki's real description", tsuLook.startsWith("A fair-skinned woman with brown eyes and straight blonde hair"));
T("tabber prose survives, plumbing dies", /In Part II her attire changes little/.test(tsuProse) && !/Part I=/.test(tsuProse) && !/\|-\|/.test(tsuProse));
T("lead gallery + angle-bearing comment never reach identity", api.identityLine(TSU) === "Tsunade is a fair-skinned kunoichi.");
const tsuBg = api.cleanWikitext(api.extractSectionRaw(TSU, ["background"], 4000));
T("wikitable removed whole, surrounding prose survives", tsuBg === "Tsunade left the village after the war.");
T("unclosed gallery drops to end (no filename leak)", !/\.png/i.test(api.cleanWikitext("<gallery>\nA b.png|x\nB c.png|y")));
T("unclosed table drops to end, prior prose survives", api.cleanWikitext("Real prose here.\n{| class=\"wikitable\"\n! h\n|-\n| cell") === "Real prose here.");
T("nested table peeled clean", api.cleanWikitext("Before.\n{|\n| outer\n{|\n| inner\n|}\n|}\nAfter.") === "Before. After.");
T("bare image-entry line dies whole", api.cleanWikitext("Solid prose.\nKid Tsunade.png|Tsunade as a child.\nMore prose.") === "Solid prose. More prose.");
T("prose merely mentioning a filename mid-sentence survives", /portrait\.png on her desk/.test(api.cleanWikitext("She kept portrait.png on her desk that day.")));
T("magic words stripped", api.cleanWikitext("Prose. __NOTOC__ More.") === "Prose. More.");
T("comment containing '>' removed entirely", api.cleanWikitext("A. <!-- x > y --> B.") === "A. B.");

// ---------------------------------------------------------------- v0.26: anti-rigidity payload
console.log("[anti-rigidity]");
const hdrNote = api.relevantCanonNote(["ayanokōji watched"], ["Kiyotaka Ayanokōji"]);
T("header: behavior material declared DESCRIPTIVE, never a rule", /DESCRIPTIVE — how this person has tended to act — never a rule/.test(hdrNote));
T("header: under-pressure clause present (danger/pain/grief)", /Under pressure \(danger, pain, temptation, grief, exhaustion\)/.test(hdrNote));
T("header: stubborn-under-torture is named and de-robotized", /stubborn character threatened with torture is not a wall/.test(hdrNote));
T("header: identical repetition under escalation = portrayal error", /identical reaction repeated while circumstances escalate is a portrayal error/.test(hdrNote));
T("header: reacts to what JUST happened", /react to what JUST happened/.test(hdrNote));
T("header: hard-facts authority scoped away from behavior", /HARD FACTS \(appearance, relations, history, events\)/.test(hdrNote));
T("dossier brief: temperament as tendency, not law", /write temperament as living tendency, not law/.test(src));
T("dossier brief: absolutist wording banned unless sourced", /avoid absolutist wording \("always", "never", "nothing can"\) unless the source itself insists/.test(src));
T("regex personality routes through head+tail sampling", /personality: join\(\s*extractInfoboxFields\(wikitext, perKw\),\s*sampleSection\(extractSection\(wikitext, perKw, 4000\), 500\)\s*\)/.test(src));

// ---------------------------------------------------------------- v0.27: poisoned-entry detection
console.log("[poisoned entries]");
T("gallery-junk look flags as poisoned", api.entryPoisoned({ sections: { look: "Kid Tsunade.png|Tsunade as a child. Tsunade full.png|Full." } }) === true);
T("wikitable junk flags as poisoned", api.entryPoisoned({ sections: { biography: '{| class="wikitable" ! Arc' } }) === true);
T("magic-word junk flags as poisoned", api.entryPoisoned({ sections: { trivia: "Likes tea. __NOTOC__" } }) === true);
T("tab plumbing flags as poisoned", api.entryPoisoned({ sections: { personality: "Stoic. |-|Part II=Kind." } }) === true);
T("depth-12 nested table peels completely", (() => {
    let d = "cell"; for (let i = 0; i < 12; i++) d = `{| class="n${i}"\n|-\n| ${d}\n|}`;
    const out = api.cleanWikitext(`Before.\n${d}\nAfter.`);
    return !out.includes("{|") && !out.includes("|}") && !out.includes("cell") && /Before\./.test(out) && /After\./.test(out);
})());
T("unclosed table swallows to end (MediaWiki-faithful)", (() => {
    const out = api.cleanWikitext("Prose stays.\n{| class=\"x\"\n|-\n| row\nno close ever");
    return out.includes("Prose stays.") && !out.includes("{|") && !out.includes("row");
})());
T("clean sections never flag", api.entryPoisoned({ sections: { look: "A fair-skinned woman with brown eyes.", personality: "Stern at work […] soft with family." } }) === false);
T("sectionless entry never flags", api.entryPoisoned({ found: true }) === false);

// ---------------------------------------------------------------- v0.28: a miss binds only the wikis it searched
console.log("[miss scope]");
T("wiki set normalizes: trim, case, dedupe, sort", JSON.stringify(api.normWikiSet(" B , a ,b,,A ")) === '["a","b"]');
T("same list → miss still speaks", api.missCoversCurrentWikis({ searched: ["a", "b"] }, "b, a") === true);
T("wiki ADDED → miss is stale", api.missCoversCurrentWikis({ searched: ["a"] }, "a, bleach") === false);
T("wiki removed → still covered", api.missCoversCurrentWikis({ searched: ["a", "b"] }, "a") === true);
T("legacy miss (no stamp) → always stale", api.missCoversCurrentWikis({ found: false, ts: 1 }, "a") === false);
T("case-insensitive coverage", api.missCoversCurrentWikis({ searched: ["bleach"] }, "Bleach") === true);

// ---------------------------------------------------------------- misc
console.log("[misc]");
T("media page rejected", api.isMediaTitle("The Eminence in Shadow (Light Novel)"));
T("subpage rejected", api.isMediaTitle("Cid Kagenou/Relationships"));
T("(Character) disambig allowed", !api.isMediaTitle("Shadow (Character)"));
T("clip trims on word boundary", api.clip("alpha beta gamma delta", 12) === "alpha beta…");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
