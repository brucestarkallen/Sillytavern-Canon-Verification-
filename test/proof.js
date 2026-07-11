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
    grab("const STOPWORDS", "function extractCandidateNames"),
    grab("function extractCandidateNames", "// ------"),
    grab("function isMediaTitle", "async function findPageTitle"),
    grab("const PROSE_STOP", "// ------"),
    grab("function cleanWikitext", "// ------"),
    grab("const NEGATIVE_TTL", "async function ensureGrounded"),
    grab("function clip(", "/**\n * Build the canon note."),
    grab("/**\n * Parse the cast parser", "/**\n * Arbiter-style"),
    grab("function parseDossier", "/**\n * LLM-curated dossier"),
    grab("/**\n * The identity line", "function extractLead"),
    grab("/** Prefer story-structure titles", "// ------"),
    grab("function relevantCanonNote", "// ------"),
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
return { extractCandidateNames, normalizeNameWord, isMediaTitle, cleanWikitext,
         extractInfoboxFields, extractSection, extractSectionRaw, extractTrivia,
         extractLead, extractAliases, extractFromProse, mentioned, escapeRegex,
         clip, cacheEntryFor, pruneStaleCast, isUnhandledName, parseNameArray,
         relationFor, pickArcHit, relevantCanonNote, extractQuotes, parseDossier,
         getReasons: () => lastMatchReasons,
         setFocus: (m) => { castFocus = m; },
         parseCast, isDisambiguation, identityLine,
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
sandbox.__settings.cache["mitsugoshi"] = { name: "mitsugoshi", sections: {}, found: false, ts: Date.now() };
T("fresh negative is handled", api.isUnhandledName("Mitsugoshi") === false);
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
T("framing: baseline-not-script present", /BASELINE, not a script/.test(note) && /overrides the baseline/.test(note));
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
T("wiki pair slice outranks dossier dynamics", /- With Cid Kagenou: Wiki-sliced: cannot meet his eyes/.test(api.relevantCanonNote(["rose"], ["Rose Oriana", "Cid Kagenou"])));
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

// ---------------------------------------------------------------- misc
console.log("[misc]");
T("media page rejected", api.isMediaTitle("The Eminence in Shadow (Light Novel)"));
T("subpage rejected", api.isMediaTitle("Cid Kagenou/Relationships"));
T("(Character) disambig allowed", !api.isMediaTitle("Shadow (Character)"));
T("clip trims on word boundary", api.clip("alpha beta gamma delta", 12) === "alpha beta…");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
