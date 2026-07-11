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
    grab("const STOPWORDS", "function extractCandidateNames"),
    grab("function extractCandidateNames", "// ------"),
    grab("function isMediaTitle", "async function findPageTitle"),
    grab("const PROSE_STOP", "// ------"),
    grab("function cleanWikitext", "// ------"),
    grab("const NEGATIVE_TTL", "async function ensureGrounded"),
    grab("function clip(", "/**\n * Build the canon note."),
    grab("function parseNameArray", "/**\n * Arbiter-style"),
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
         extractInfoboxFields, extractSection, extractLead, extractAliases,
         extractFromProse, mentioned, escapeRegex, clip, cacheEntryFor,
         pruneStaleCast, isUnhandledName, parseNameArray,
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

// ---------------------------------------------------------------- misc
console.log("[misc]");
T("media page rejected", api.isMediaTitle("The Eminence in Shadow (Light Novel)"));
T("subpage rejected", api.isMediaTitle("Cid Kagenou/Relationships"));
T("(Character) disambig allowed", !api.isMediaTitle("Shadow (Character)"));
T("clip trims on word boundary", api.clip("alpha beta gamma delta", 12) === "alpha beta…");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
