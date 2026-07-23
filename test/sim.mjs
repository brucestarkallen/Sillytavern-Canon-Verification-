/*
 * Integration simulation for Canon Grounding — self-contained: builds a stub
 * SillyTavern module tree in a temp dir, copies the real index.js in, and drives
 * the actual interceptor through race scenarios (starvation, serial clobber,
 * epoch guard, cast decay, alias dedupe, dossier chat-switch isolation).
 * Run: node test/sim.mjs
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-sim-"));
const extDir = path.join(root, "public/scripts/extensions/third-party/canon");
fs.mkdirSync(extDir, { recursive: true });
fs.copyFileSync(path.join(here, "..", "index.js"), path.join(extDir, "index.js"));
fs.writeFileSync(path.join(root, "public/scripts/extensions.js"),
`export const extension_settings = {};
export function getContext() { return globalThis.__ctx; }
`);
fs.writeFileSync(path.join(root, "public/script.js"),
`export function saveSettingsDebounced() {}
export const event_types = { MESSAGE_RECEIVED: "mr", CHAT_CHANGED: "cc" };
export const eventSource = { on: (e, f) => { (globalThis.__handlers ||= {})[e] = f; } };
export const chat_metadata = {};
`);

let pass = 0, fail = 0;
const T = (name, cond) => { cond ? pass++ : (fail++, console.log("  FAIL:", name)); };

const fetchLog = [];
globalThis.fetch = async (url) => {
    fetchLog.push(url);
    const u = new URL(url);
    const titles = u.searchParams.get("titles");
    const page = u.searchParams.get("page");
    if (u.hostname.startsWith("bleachstub")) {
        if (titles === "Zarblade") return { ok: true, json: async () => ({ query: { pages: { 9: { pageid: 9, title: "Zarblade" } } } }) };
        if (titles) return { ok: true, json: async () => ({ query: { pages: { "-1": { title: titles, missing: "" } } } }) };
        if (page === "Zarblade") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`'''Zarblade''' is a rogue captain.
{{Infobox
| hair = white
}}
== Appearance ==
Zarblade is a towering swordsman with white hair.
== Personality ==
Boisterous.` } } }) };
        return { ok: true, json: async () => ({}) };
    }
    if (titles === "Zarblade") return { ok: true, json: async () => ({ query: { pages: { "-1": { title: titles, missing: "" } } } }) };  // exists ONLY on bleachstub
    if (titles) return { ok: true, json: async () => ({ query: { pages: { 1: { pageid: 1, title: titles } } } }) };
    if (page === "Gallerychar") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`'''Gallerychar''' is a legendary healer.
== Appearance ==
<gallery widths="120" mode="packed-hover">
Kid Gallerychar.png|As a child.
Gallerychar full.png|Full appearance.
</gallery>
Gallerychar is a fair-skinned woman with brown eyes and straight blonde hair.
== Personality ==
Calm.` } } }) };
    if (page === "Healchar") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`'''Healchar''' is a wandering medic.
{{Infobox
| hair = copper
}}
== Appearance ==
<gallery>
Kid Healchar.png|As a child.
</gallery>
Healchar is a fair-skinned woman with emerald eyes and copper hair.
== Personality ==
Calm.` } } }) };
    if (page === "Tailchar") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`'''Tailchar''' is a knight-commander.
{{Infobox
| hair = Tailchar-colored
}}
== Personality ==
${"Tailchar is stern, unyielding, and utterly devoted to duty. ".repeat(10)}Yet in her final year she laughs easily and forgives quickly.` } } }) };
    if (page) return { ok: true, json: async () => ({ parse: { wikitext: { "*": `{{Infobox\n| hair = ${page}-colored\n}}\n== Personality ==\nCalm.` } } }) };
    return { ok: true, json: async () => ({}) };
};

const parseQueue = [];
const svc = { sendRequest: () => new Promise((resolve, reject) => parseQueue.push({ resolve, reject })) };

let injections = [];
globalThis.__ctx = {
    chat: [],
    chatMetadata: {},
    ConnectionManagerRequestService: svc,
    extensionSettings: {},
    setExtensionPrompt: (key, text, pos, depth) => { injections.push(text); globalThis.__lastDepth = depth; },
    extension_prompt_types: { IN_CHAT: 1 },
    extension_prompt_roles: { SYSTEM: 0 },
};
const el = { length: 0, text: () => el, empty: () => el, append: () => el, val: () => "", prop: () => el, on: () => el };
globalThis.$ = () => el;
globalThis.jQuery = () => {};
globalThis.toastr = undefined;

const { extension_settings } = await import(pathToFileURL(path.join(root, "public/scripts/extensions.js")).href);
extension_settings.canon_grounding = {
    enabled: true, wikis: "testwiki", savedWikis: [],
    fields: "hair", relationshipKeywords: "relative", biographyKeywords: "history",
    personalityKeywords: "personality", abilitiesKeywords: "power", aliasKeywords: "alias",
    physical: true, personality: false, relationship: false, biography: false, abilities: false,
    contextWindow: 10, maxCharacters: 8, maxCharsPerChar: 400, maxTotalChars: 3000,
    debug: false, llmParser: true, llmProfileId: "p1", parserEveryTurn: false, llmDossier: false, castAuditor: false, lowercaseNames: false, maxBlockMs: 30000, firstMeetWaitMs: 30000,
    useLedger: false, groundFromReplies: true, cache: {}, migrated_v2: true,
};
await import(pathToFileURL(path.join(extDir, "index.js")).href);
const intercept = globalThis.CanonGrounding_intercept;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const msg = (mes, user = false) => ({ mes, is_user: user, is_system: false });
const lastInjection = () => injections[injections.length - 1] || "";
const src = fs.readFileSync(path.join(here, "..", "index.js"), "utf8");

console.log("[1] gate + parse + injection");
globalThis.__ctx.chat = [msg("hello", true), msg("A stranger speaks with FreshChar quietly.")];
const run1 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("parse requested for genuinely new mid-sentence name", parseQueue.length === 1);
parseQueue[0].resolve('["FreshChar"]');
await run1;
T("injection carries wiki facts", /FreshChar-colored/.test(lastInjection()));
T("bare 'hello' never grounded", !fetchLog.some(u => /titles=[Hh]ello/.test(u)));

console.log("[2] second entity joins");
globalThis.__ctx.chat.push(msg("Suddenly StaleChar and FreshChar argue."));
const run2 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("gate re-fires on new name (adverb glue stripped)", parseQueue.length === 2);
parseQueue[1].resolve('["StaleChar", "FreshChar"]');
await run2;
T("both entities injected", /StaleChar-colored/.test(lastInjection()) && /FreshChar-colored/.test(lastInjection()));

console.log("[3] async-safety wiring (static)");
T("CHAT_CHANGED bumps epoch", /CHAT_CHANGED[\s\S]{0,400}chatEpoch\+\+/.test(src));
T("interceptor discards on epoch change after parse", /parseSceneCharacters\(sceneText\);\s*\n\s*if \(myEpoch !== chatEpoch\) return;/.test(src));
T("post-gen scan discards on epoch change", /if \(myEpoch !== chatEpoch\) return;\s*\/\/ chat switched while parsing/.test(src));
T("post-gen scan discards when superseded (serial)", /if \(mySerial !== parseSerial\) return;/.test(src));
T("post-gen scan no longer holds cgInFlight (starvation fix)", !/cgInFlight = true; \/\/ block the interceptor/.test(src));
T("ledger cast grounded as trusted", /await groundNames\(cast, true\);/.test(src));

console.log("[4] cast decay");
globalThis.__ctx.chat.push(msg("Then DecayA and DecayB spar fiercely."));
const run3 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
parseQueue[2].resolve('["DecayA", "DecayB"]');
await run3;
T("cast holds both before decay", /DecayA-colored/.test(lastInjection()) && /DecayB-colored/.test(lastInjection()));
for (let i = 0; i < 12; i++) globalThis.__ctx.chat.push(msg("DecayA waits patiently."));
globalThis.__ctx.chat.push(msg("DecayA nods.", true));
const run4 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("gate stays quiet (no new names, no junk candidates)", parseQueue.length === 3);
await run4;
T("mentioned entity survives decay", /DecayA-colored/.test(lastInjection()));
T("off-screen entity dropped by decay", !/DecayB-colored/.test(lastInjection()));

console.log("[5] alias dedupe, zero refetch");
globalThis.__ctx.chatMetadata.canon_grounding_cache = globalThis.__ctx.chatMetadata.canon_grounding_cache || {};
globalThis.__ctx.chatMetadata.canon_grounding_cache["alya"] = { name: "Alisa Mikhailovna Kujou", sections: { physical: "hair: silver" }, aliases: ["Alya"], wiki: "testwiki", found: true, ts: Date.now() };
const before = fetchLog.length;
globalThis.__ctx.chat.push(msg("have you seen Alisa Mikhailovna Kujou?", true));
const run5 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("alias-known name does not re-fire the parser", parseQueue.length === 3);
await run5;
// v0.3 pair dynamics legitimately fetch the "X/Relationships" SUBPAGE (once per
// character, ever). That is a different call class from re-grounding an entity —
// the invariant under test is that alias-known ENTITY lookups never re-hit the wiki.
const entityFetches = fetchLog.slice(before).filter(u => !decodeURIComponent(u).includes("/Relationships"));
T("no wiki refetch for alias-known name", entityFetches.length === 0);
const relFetches = fetchLog.filter(u => decodeURIComponent(u).includes("/Relationships"));
T("dynamics subpage never fetched twice for the same character", new Set(relFetches).size === relFetches.length);
T("exactly one block for the character", (lastInjection().match(/Alisa Mikhailovna Kujou:/g) || []).length === 1);
T("user-asked char force-included in cast injection", /hair: silver/.test(lastInjection()));

console.log("[6] settled pair costs zero");
const settled = fetchLog.length;
globalThis.__ctx.chat.push(msg("Alisa smiled warmly at DecayA.", true));
await intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
T("settled pair: zero fetches of ANY kind on later turns", fetchLog.length === settled);

console.log("[7] smart sweep: AI names a cached, un-cast entity");
// FreshChar was grounded in scenario 1 but is NOT in the current cast. The AI's
// own reply naming them must be enough — inject with no parser round trip.
globalThis.__ctx.chat.push(msg("Suddenly FreshChar stepped out of the crowd.", false));
const sweepFetches = fetchLog.length;
await intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
T("cached entity named by the AI is injected", /FreshChar:/.test(lastInjection()));
T("sweep costs zero fetches", fetchLog.length === sweepFetches);

console.log("[8] dossier chat-switch isolation (same key, two universes)");
// Ground a brand-new character in chat A with dossiers ON, switch to chat B
// (which has its OWN same-named character) while the dossier LLM call is still
// pending, then let it finish. The dossier must land on A's entry object and
// NEVER on B's — key-lookup-after-await was exactly how one universe's dossier
// used to overwrite another's.
extension_settings.canon_grounding.llmDossier = true;
const ctxA = globalThis.__ctx;
const cacheA = ctxA.chatMetadata.canon_grounding_cache;
const qBase = parseQueue.length;
ctxA.chat.push(msg("Then Twinname enters the room quietly.", false));
const run8 = intercept(ctxA.chat, 4096, () => {}, "normal");
await sleep(20);
T("parse fired for the new name", parseQueue.length === qBase + 1);
parseQueue[qBase].resolve('["Twinname"]');
await run8;
await sleep(30);   // let ensureGrounded finish + scheduleDossier queue its LLM call
T("chat A grounded the character", !!(cacheA.twinname && cacheA.twinname.found));
T("dossier LLM call is in flight", parseQueue.length === qBase + 2);
T("in-flight stamp sits on A's entry", !!cacheA.twinname.dossierTs);
// --- switch to chat B while the dossier builds ---
globalThis.__ctx = { ...ctxA, chat: [], chatMetadata: { canon_grounding_cache: {
    twinname: { name: "Twinname", sections: { physical: "hair: black" }, aliases: [], wiki: "testwiki", found: true, ts: Date.now() },
} } };
const cacheB = globalThis.__ctx.chatMetadata.canon_grounding_cache;
// No CHAT_CHANGED event needed: the dossier fix is ENTRY-binding, not epoch —
// getContext() now resolving to chat B is exactly the hazard under test.
parseQueue[qBase + 1].resolve('{"identity":"UNIVERSE-A person","brief":"built from chat A wikitext"}');
await sleep(30);
T("B's same-named character got NO dossier", !cacheB.twinname.dossier);
T("B's entry carries no in-flight stamp either", !cacheB.twinname.dossierTs);
T("the dossier landed on A's entry (the one that asked)", !!(cacheA.twinname.dossier && cacheA.twinname.dossier.identity === "UNIVERSE-A person"));
extension_settings.canon_grounding.llmDossier = false;

console.log("[9] cross-chat write guards (static witnesses)");
T("scheduleDossier is entry-bound (signature)", /function scheduleDossier\(entry, name, wikitext, relRaw\)/.test(src));
T("dossier .then never re-looks-up by key", !/buildDossier\([^)]*\)\.then\(d => \{\s*\n\s*const e = cache\(\)/.test(src));
T("groundArc captures its epoch at entry", /async function groundArc\(query\) \{\s*\n\s*const myEpoch = chatEpoch;/.test(src));
T("groundArc drops a stale arc instead of pinning it", /if \(myEpoch !== chatEpoch\) return null;\s*\/\/ chat switched mid-fetch/.test(src));
T("askCanon captures its epoch at entry", /async function askCanon\(request\) \{\s*\n\s*const myEpoch = chatEpoch;/.test(src));
T("askCanon drops a stale command after the router call", /chat changed while the command was being read/.test(src));
T("askCanon pin re-checks after its own await", /await groundNames\(\[t\], true\);\s*\n\s*if \(myEpoch !== chatEpoch\) return \{ ok: false, msg: "chat changed/.test(src));
T("askCanon arc reports a drop honestly (not a fake miss)", /story position not pinned \(the command was aimed at the previous chat\)/.test(src));

console.log("[10] gallery containment through the real ground→inject pipeline");
const q10 = parseQueue.length;
globalThis.__ctx.chat.push(msg("At the gate stands Gallerychar, waiting.", false));
const run10 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("parse fired for Gallerychar", parseQueue.length === q10 + 1);
parseQueue[q10].resolve('["Gallerychar"]');
await run10;
T("Appearance = the wiki's real prose", /- Appearance: A fair-skinned woman with brown eyes and straight blonde hair/.test(lastInjection()));
T("no gallery filename anywhere in the injection", !/\.png/i.test(lastInjection()) && !/\|As a child/.test(lastInjection()));

console.log("[11] personality baseline carries the humanizing tail (head+tail sample)");
extension_settings.canon_grounding.personality = true;
extension_settings.canon_grounding.maxCharsPerChar = 1200;
const q11 = parseQueue.length;
globalThis.__ctx.chat.push(msg("Then Tailchar arrives in full armor.", false));
const run11 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("parse fired for Tailchar", parseQueue.length === q11 + 1);
parseQueue[q11].resolve('["Tailchar"]');
await run11;
T("absolutist head still present (top of section preserved)", /stern, unyielding/.test(lastInjection()));
T("humanizing TAIL survives into the injected baseline", /laughs easily and forgives quickly/.test(lastInjection()));
T("head+tail seam marks the sample", /\[…\]/.test(lastInjection()));
T("anti-rigidity header rides every note", /Under pressure \(danger, pain, temptation, grief, exhaustion\)/.test(lastInjection()));
extension_settings.canon_grounding.personality = false;
extension_settings.canon_grounding.maxCharsPerChar = 400;

console.log("[12] poisoned cache self-heals from a fresh fetch");
const healCache = globalThis.__ctx.chatMetadata.canon_grounding_cache;
healCache["healchar"] = { name: "Healchar", sections: {
    identity: "A medic.",
    physical: "hair: copper",
    look: "Kid Healchar.png|As a child. Healchar full.png|Full appearance.",
}, aliases: [], rel: {}, wiki: "testwiki", kind: "character", found: true, ts: Date.now() };
globalThis.__ctx.chat.push(msg("Nearby, Healchar hums a tune.", false));
const run12 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await run12;
T("poisoned look was live before the heal (bug real)", /Kid Healchar\.png/.test(lastInjection()));
await sleep(40);   // background heal: fetch + rebuild
T("heal stamped once-per-entity", !!healCache["healchar"].healTs);
T("look rebuilt to the wiki's real prose", /^A fair-skinned woman with emerald eyes and copper hair\.$/.test(healCache["healchar"].sections.look || ""));
T("no image junk anywhere in rebuilt sections", !Object.values(healCache["healchar"].sections).some(v => /\.png/i.test(v || "")));
const run12b = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await run12b;
T("next turn injects the healed look", /- Appearance: A fair-skinned woman with emerald eyes and copper hair/.test(lastInjection()) && !/\.png/i.test(lastInjection()));

console.log("[13] adding a wiki revives a fresh 'not found' (the Bleach-crossover bug)");
const S = extension_settings.canon_grounding;
const q13 = parseQueue.length;
globalThis.__ctx.chat.push(msg("Across the courtyard, Zarblade laughed.", false));
const run13 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("parse fired for the new name", parseQueue.length === q13 + 1);
parseQueue[q13]?.resolve('["Zarblade"]');
await run13;
const healCache2 = globalThis.__ctx.chatMetadata.canon_grounding_cache;
T("missed on the configured wiki → negative cached", healCache2["zarblade"] && healCache2["zarblade"].found === false);
T("the miss remembers WHAT it searched", JSON.stringify(healCache2["zarblade"].searched) === '["testwiki"]');
T("nothing injected for the miss", !/Zarblade/.test(lastInjection()));
S.wikis = "testwiki, bleachstub";
const q13b = parseQueue.length;
globalThis.__ctx.chat.push(msg("Once more, Zarblade drew his blade.", false));
const run13b = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("gate re-asks: the old miss doesn't speak for the new wiki", parseQueue.length === q13b + 1);
parseQueue[q13b]?.resolve('["Zarblade"]');
await run13b;
T("grounded from the ADDED wiki", healCache2["zarblade"] && healCache2["zarblade"].found === true && healCache2["zarblade"].wiki === "bleachstub");
T("…and injected this very turn", /- Appearance: A towering swordsman with white hair/.test(lastInjection()) && /Zarblade/.test(lastInjection()));
S.wikis = "testwiki";

console.log("[14] found-under-suffixed-key buries the bare-name corpse");
healCache2["ghostblade"] = { name: "Ghostblade", sections: {}, found: false, searched: ["testwiki"], ts: Date.now() };
healCache2["ghostblade (bleachstub)"] = { name: "Ghostblade", sections: { look: "A pale duelist.", personality: "Wry." },
    aliases: ["Ghostblade (bleachstub)"], rel: {}, wiki: "bleachstub", kind: "character", found: true, ts: Date.now() };
globalThis.__ctx.chat.push(msg("By the well, Ghostblade waits.", false));
const run14 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await run14;
T("bare mention injects the suffix-keyed entry", /- Appearance: A pale duelist/.test(lastInjection()));
T("the shadowing ✕ row is buried", !("ghostblade" in healCache2));

console.log("[15] 'you talked to Rukia' — a first-name mention outranks the stale cast");
const q15a = parseQueue.length;
globalThis.__ctx.chat.push(msg("Beside the brazier, Vandrel Kuchor sharpens a blade.", false));
const run15a = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
parseQueue[q15a]?.resolve('["Vandrel Kuchor"]');
await run15a;
T("multi-word character grounded", !!healCache2["vandrel kuchor"]?.found);
S.parserEveryTurn = true;
S.contextWindow = 1;   // the old full-name mention has scrolled out of the scene
const q15b = parseQueue.length;
globalThis.__ctx.chat.push(msg("At the arch, Zarblade waits alone.", false));
const run15b = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
parseQueue[q15b]?.resolve('["Zarblade"]');
await run15b;
S.parserEveryTurn = false;
T("cast swapped to the previous-scene character", /Zarblade/.test(lastInjection()) && !/Vandrel/.test(lastInjection()));
const q15c = parseQueue.length;
globalThis.__ctx.chat.push(msg("Later that night, you talked with Vandrel by the gate.", true));
const run15c = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await run15c;
T("no parser round trip needed for a cached first name", parseQueue.length === q15c);
parseQueue[q15c]?.resolve('["Vandrel Kuchor"]');
const inj15 = lastInjection();
T("the character you addressed IS injected", /Vandrel Kuchor/.test(inj15));
T("…and rides FIRST, ahead of the stale cast", inj15.indexOf("Vandrel Kuchor") >= 0 && inj15.indexOf("Vandrel Kuchor") < inj15.indexOf("Zarblade"));
T("no duplicate cache key for the short form", !("vandrel" in healCache2));
S.contextWindow = 10;

console.log("[16] a whereabouts ticker is not the scene");
const q16 = parseQueue.length;
S.contextWindow = 2;   // [15]'s real prose mentions of Vandrel scroll out — the ticker is his ONLY appearance
globalThis.__ctx.chat.push(msg("The night drags on quietly.", true));   // neutral player turn: nobody user-named
globalThis.__ctx.chat.push(msg("Dusk settles over the camp as Zarblade stirs.\n[ACW: Vandrel Kuchor | Far ridge | resting] [ACW: Nimbler Vosk | Archives | idle]", false));
const run16 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await run16;
T("ticker names never reach the parser (no round trip)", parseQueue.length === q16);
parseQueue[q16]?.resolve('[]');
T("cached character named ONLY in the ticker is NOT injected", !/Vandrel/.test(lastInjection()));
T("the real cast is untouched", /Zarblade/.test(lastInjection()));
S.contextWindow = 10;

console.log("[17] injection depth: top-of-chat by default, user-tunable");
T("default depth parks canon at the top of chat", globalThis.__lastDepth === 9999);
S.injectDepth = 3;
globalThis.__ctx.chat.push(msg("Embers pop softly beside Zarblade.", false));
const run17 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await run17;
T("depth setting is honored live", globalThis.__lastDepth === 3);
S.injectDepth = 9999;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
