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
    const sr = u.searchParams.get("srsearch");
    const list = u.searchParams.get("list");
    if (u.hostname === "foundsaga.fandom.com" || u.hostname === "foundsaga.wiki.gg") {
        if (list === "recentchanges") return { ok: true, json: async () => ({ query: { recentchanges: [{ timestamp: u.hostname.endsWith("wiki.gg") ? "2026-06-01T00:00:00Z" : "2023-01-01T00:00:00Z" }] } }) };
        if (sr) return { ok: true, json: async () => ({ query: { search: [{ title: "Zar Blade" }] } }) };
    }
    if (u.hostname.startsWith("missslug.") && sr) return { ok: true, json: async () => ({ query: { search: [] } }) };
    if (u.hostname === "verifyless.fandom.com") {
        // a wiki that cleanly has NOTHING: exact-title misses, search comes back empty
        if (titles) return { ok: true, json: async () => ({ query: { pages: { "-1": { title: titles, missing: "" } } } }) };
        if (sr) return { ok: true, json: async () => ({ query: { search: [] } }) };
    }
    if (u.hostname === "memory-alpha.fandom.com" && sr) {
        // a real Star Trek wiki: it knows Star Trek, and nothing else
        const hit = /spock|kirk|enterprise|vulcan/i.test(sr) ? [{ title: sr }] : [];
        return { ok: true, json: async () => ({ query: { search: hit } }) };
    }
    if (u.hostname === "alice.fandom.com" && sr) {
        // a real wiki that happens to share the card's name — it knows "Alice"
        return { ok: true, json: async () => ({ query: { search: /alice/i.test(sr) ? [{ title: "Alice" }] : [] } }) };
    }
    if (u.hostname.endsWith(".wiki.gg") && !u.hostname.startsWith("foundsaga") && sr) {
        return { ok: false, json: async () => ({}) };   // no wiki.gg fork for these
    }
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
    // A plainly-titled disambiguation page — the shape isMediaTitle CANNOT catch,
    // because the title is just a name. Its lead is a link list.
    if (page === "Dabchar") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`{{Disambiguation}}
'''Dabchar''' may refer to:
* [[Dabchar Oriana]], the second princess
* [[Dabchar (episode)]], the fourth episode` } } }) };
    // The franchise's OWN page: meta, not world. Injecting it tells the model it
    // is inside a manga.
    if (page === "Metaseries") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`'''Metaseries''' is a Japanese light novel series written by Some Author.
{{Infobox
| hair = n/a
}}
== Personality ==
N/A.` } } }) };
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
    if (page === "Blademaster") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`'''Blademaster''' is a wandering duelist.
{{Infobox
| hair = ash grey
| relative = Kestrel (sister)
}}
== Appearance ==
Blademaster is a lean figure with ash grey hair.
== Personality ==
Terse.
== Powers and Abilities ==
His signature technique is '''Falling Star''', a downward cut that shatters guard. He also uses '''Wind Read''' to anticipate a blade.` } } }) };
    if (page === "Tailchar") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`'''Tailchar''' is a knight-commander.
{{Infobox
| hair = Tailchar-colored
}}
== Personality ==
${"Tailchar is stern, unyielding, and utterly devoted to duty. ".repeat(10)}Yet in her final year she laughs easily and forgives quickly.` } } }) };
    if (page === "Harvest Banquet") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`The '''Harvest Banquet''' is the kingdom's grand autumn feast.
== Summary ==
Nobles gather at the palace; a poisoning is uncovered; the banquet ends in chaos.` } } }) };
    if (page === "Winter Gala") return { ok: true, json: async () => ({ parse: { wikitext: { "*":
`The '''Winter Gala''' is the capital's midwinter celebration.
== Summary ==
The gala opens with a masquerade and closes with a duel on the ice.` } } }) };
    if (page) return { ok: true, json: async () => ({ parse: { wikitext: { "*": `{{Infobox\n| hair = ${page}-colored\n}}\n== Personality ==\nCalm.` } } }) };
    return { ok: true, json: async () => ({}) };
};

const parseQueue = [];
const sentPrompts = [];
const svc = { sendRequest: (id, messages) => {
    sentPrompts.push((messages || []).map(m => m.content).join("\n"));
    return new Promise((resolve, reject) => parseQueue.push({ resolve, reject }));
} };

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
    contextWindow: 10, maxCharacters: 8, maxTokensPerChar: 100, maxTotalTokens: 750,
    // 8000, not 30000: two scenarios deliberately WAIT OUT the block to prove the
    // starvation path, and at 30000 each burned a real 30s of wall clock — 62s of
    // gate for two assertions. 8000 clears the slowest real scenario (the cache
    // self-heal chain, which fails at 3000) with headroom, proves the identical
    // 195, and runs stably. A gate nobody wants to sit through is a gate that
    // gets skipped. Product defaults are untouched: 2000 block, 12000 first-meet.
    debug: false, llmParser: true, llmProfileId: "p1", parserEveryTurn: false, llmDossier: false, castAuditor: false, lowercaseNames: false, maxBlockMs: 8000, firstMeetWaitMs: 8000,
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
// Matches the call by shape, not by its exact argument list — the property is
// "the epoch guard is the very next statement", which an added argument does not
// change. Pinning the literal call made a signature change look like a bug.
T("interceptor discards on epoch change after parse", /parseSceneCharacters\(sceneText[^)]*\);\s*\n\s*if \(myEpoch !== chatEpoch\) return;/.test(src));
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
// v0.50.0: a NEW player message always earns a look — the heuristics that used to
// veto it were the bug source. The waste guard that still matters is the RE-parse:
// the same message, swiped or regenerated, must not spend a second call.
T("a new player message earns a look", parseQueue.length === 4);
parseQueue[3].resolve('["DecayA"]');
const qSwipe = parseQueue.length;
await intercept(globalThis.__ctx.chat, 4096, () => {}, "swipe");
await sleep(20);
T("the SAME message does not re-parse (swipe is free)", parseQueue.length === qSwipe);
await run4;
T("mentioned entity survives decay", /DecayA-colored/.test(lastInjection()));
T("off-screen entity dropped by decay", !/DecayB-colored/.test(lastInjection()));

console.log("[5] alias dedupe, zero refetch");
globalThis.__ctx.chatMetadata.canon_grounding_cache = globalThis.__ctx.chatMetadata.canon_grounding_cache || {};
globalThis.__ctx.chatMetadata.canon_grounding_cache["alya"] = { name: "Alisa Mikhailovna Kujou", sections: { physical: "hair: silver" }, aliases: ["Alya"], wiki: "testwiki", found: true, ts: Date.now() };
const before = fetchLog.length;
const qAliasStart = parseQueue.length;
globalThis.__ctx.chat.push(msg("have you seen Alisa Mikhailovna Kujou?", true));
const run5 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("a new player message parses even when the name is alias-known", parseQueue.length === qAliasStart + 1);
parseQueue[qAliasStart].resolve('["Alisa Mikhailovna Kujou"]');
const qAlias = parseQueue.length;
await intercept(globalThis.__ctx.chat, 4096, () => {}, "regenerate");
await sleep(20);
T("...and regenerating the same message spends nothing", parseQueue.length === qAlias);
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
T("groundArc captures its epoch at entry", /async function groundArc\(query, opts = \{\}\) \{\s*\n\s*const myEpoch = chatEpoch;/.test(src));
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
extension_settings.canon_grounding.maxTokensPerChar = 300;
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
T("anti-rigidity header rides every note", /same reaction repeated while things escalate/.test(lastInjection()));
extension_settings.canon_grounding.personality = false;
extension_settings.canon_grounding.maxTokensPerChar = 100;

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
T("the player naming someone earns a parse", parseQueue.length === q15c + 1);
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
await sleep(20);
// The neutral player turn is new, so exactly ONE parse fires for it. The scenario's
// point is that the AI's ACW ticker adds no round trip of its own, and that a name
// appearing ONLY in a ticker never reaches the note — so the parse must actually
// complete, or the assertion below would be reading a stale note from turn 15.
T("ticker names add no parser round trip of their own", parseQueue.length === q16 + 1);
parseQueue[q16].resolve('["Zarblade"]');
await run16;
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

console.log("[18] powers reach the model, and only when the scene is about them");
S.llmDossier = true; S.abilities = true; S.relationshipKeywords = "relative";
const q18 = parseQueue.length;
globalThis.__ctx.chat.push(msg("At the gate stands Blademaster, silent.", false));
const run18 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
parseQueue[q18]?.resolve('["Blademaster"]');
await run18;
await sleep(40);   // ensureGrounded finishes, scheduleDossier queues its call
const digest18 = sentPrompts[sentPrompts.length - 1] || "";
T("the curator is shown the ABILITIES section", /Falling Star/.test(digest18) && /Wind Read/.test(digest18));
T("the curator is shown the INFOBOX", /INFOBOX:/.test(digest18) && /Kestrel/.test(digest18));
parseQueue[parseQueue.length - 1]?.resolve(JSON.stringify({
    identity: "A wandering duelist.", brief: "A terse swordsman who speaks with the blade.",
    facts: ["Travels alone"], secrets: [], voice: [],
    abilities: ["Falling Star: downward cut that shatters guard", "Wind Read: anticipates a blade"],
    dynamics: {}, related: [],
}));
await sleep(40);
const cache18 = globalThis.__ctx.chatMetadata.canon_grounding_cache;
T("the dossier carries abilities", (cache18.blademaster?.dossier?.abilities || []).length === 2);
S.parserEveryTurn = false;
globalThis.__ctx.chat.push(msg("They share bread by the fire and say little.", true));
await intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
T("a quiet scene pays nothing for powers", !/Abilities:/.test(lastInjection()));
globalThis.__ctx.chat.push(msg("Steel rings as he draws to fight.", true));
await intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
T("a fight gets the arsenal", /Abilities:.*Falling Star/.test(lastInjection()));
S.llmDossier = false; S.abilities = false;

console.log("[19] a cached lie heals itself, even if an older fix already healed the entry");
const cache19 = globalThis.__ctx.chatMetadata.canon_grounding_cache;
cache19.healme = { name: "Healme", found: true, wiki: "testwiki", aliases: [], rel: {},
    // healTs proves an EARLIER generation of the self-heal already touched this entry.
    // A one-shot stamp would lock the lie in forever; the stamp is per fix generation.
    healTs: Date.now() - 999999,
    sections: { physical: "height: 2.3", identity: "Someone." }, ts: Date.now() };
S.parserEveryTurn = false;
// The self-heal is deliberately ONE entry per turn (no stampede), and other
// entries from earlier scenarios are queued ahead of this one — so drive turns
// until it comes up rather than asserting it happens immediately.
for (let turn = 0; turn < 8 && !cache19.healme.healV; turn++) {
    globalThis.__ctx.chat.push(msg("The fire burns low.", true));
    await intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
    await sleep(40);
}
T("the implausible height is gone", !/2\.3/.test(cache19.healme.sections.physical || ""));
T("the entry was rebuilt from the wiki", /Healme-colored/.test(cache19.healme.sections.physical || ""));
T("the heal is stamped with the fix generation", !!cache19.healme.healV);

// [20] v0.34.1 — background-entity expansion was gated behind pairPool.length > 1,
// so a SOLO character scene never grounded its dossier "related" entities and the
// Context line could never appear. Pair dynamics need two; expansion needs one.
console.log("[20] solo scene still grounds background entities (pair-gate decoupled)");
const cache20 = globalThis.__ctx.chatMetadata.canon_grounding_cache;
cache20.solochar = { name: "Solochar", found: true, wiki: "testwiki", aliases: [], rel: {},
    sections: { physical: "hair: red" },
    dossier: { identity: "A lone knight.", brief: "", facts: [], secrets: [], voice: [], abilities: [],
               dynamics: {}, related: [{ name: "Solo Kingdom", why: "her homeland" }] }, ts: Date.now() };
S.llmDossier = true;
S.parserEveryTurn = true;
globalThis.__ctx.chat.push(msg("Solochar walks the road alone.", false));
const q20 = parseQueue.length;
const f20 = fetchLog.length;
const run20 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("parser fired for the solo scene", parseQueue.length === q20 + 1);
parseQueue[q20]?.resolve('["SoloChar"]');
await run20;
await sleep(30);
T("background entity fetched for a ONE-character cast (was gated behind pairs)",
    fetchLog.slice(f20).some(u => decodeURIComponent(u).toLowerCase().includes("solo kingdom")));
T("…and it landed in the cache as a found entry", !!(cache20["solo kingdom"] && cache20["solo kingdom"].found));
S.parserEveryTurn = false;
S.llmDossier = false;

// [21] v0.34.1 — the first-meeting wait fired on ANY pair of novel lowercase
// tokens, so ordinary prose ("the river water runs cold") bought the same 12s
// stall as a real first meeting. A candidate/pair built ENTIRELY from common
// English words is prose; one uncommon token keeps the signal.
console.log("[21] first-meeting wait: prose pairs ignored, real names still wait");
S.lowercaseNames = true;
S.maxBlockMs = 250;
S.firstMeetWaitMs = 1500;
const q21a = parseQueue.length;
const logs21a = [];
const origLog21 = console.log;
console.log = (...a) => { logs21a.push(a.join(" ")); };
globalThis.__ctx.chat.push(msg("the river water runs cold", true));
const t21a = Date.now();
const run21a = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(30);
parseQueue[q21a]?.resolve('[]');   // the parser gate itself still fires — cheap, and it converges
await run21a;
console.log = origLog21;
T("common prose pair: NO first-meeting wait", !logs21a.some(l => l.includes("first meeting")));
T("common prose pair: turn returned near the normal ceiling", Date.now() - t21a < 1200);
const q21b = parseQueue.length;
const logs21b = [];
console.log = (...a) => { logs21b.push(a.join(" ")); };
globalThis.__ctx.chat.push(msg("zephira voss walks in", true));
const run21b = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(30);
console.log = origLog21;
T("a real lowercase name STILL extends the wait (no detection regression)",
    logs21b.some(l => l.includes("first meeting")));
parseQueue[q21b]?.resolve('["Zephira Voss"]');
await run21b;
S.lowercaseNames = false;
S.maxBlockMs = 8000;
S.firstMeetWaitMs = 8000;

// [22] v0.34.1 — static witnesses for the structural fixes.
console.log("[22] static witnesses");
T("default caps ARE the current defaults (stale 400/3000 literals gone)",
    /maxTokensPerChar: 275/.test(src) && /maxTotalTokens: 1500/.test(src));
T("factory reset does not re-stamp migrations (stale-cap lock gone)",
    /Object\.assign\(s, structuredClone\(defaultSettings\), keep\)/.test(src));
T("related-expansion decoupled from the pair gate", /pairPool\.length > 0/.test(src));
T("pair dynamics still require an actual pair", /uniq\.size > 1\) \{\s*\n\s*await resolveRelations/.test(src));
T("fallback splices are tagged and actively removed",
    /canon_grounding_fallback/.test(src) && /function removeFallbackSplices/.test(src) && /\[FALLBACK_TAG\]: true/.test(src));
T("every toast goes through the explicit escaping helper (no raw toastr calls)",
    !/toastr\?\.\w+\?\./.test(src) && /toastr\?\.\[kind\]\?\.\(escapeHtml\(msg\)/.test(src));
T("dossier reads normalized against legacy shapes",
    /function normalizeDossier/.test(src) && /const d = normalizeDossier\(entry\.dossier\)/.test(src));
T("Ask Canon is contained", /const runAsk = async \(\) => \{[\s\S]{0,220}try \{/.test(src));
T("post-generation scan is contained", /async function onMessageReceived\(\) \{\s*try/.test(src));
T("decay handles chat shrinkage explicitly",
    /const delta = visibleLen - lastCastLen;\s*\n\s*if \(delta >= 0 && delta <= s\.contextWindow\)/.test(src));
// Scoped to the function it is about. It used to count occurrences across the
// WHOLE file, so any other consumer of the shared lexicon broke it — which is a
// test pinning a global number while claiming something local.
// The wait no longer keeps its own copy of "known" — it delegates to the same
// predicate the gate uses, which is the whole point of the v0.46.0 fix.
T("first-meeting wait delegates to the shared predicate, keeping no copy",
    (() => { const f = src.slice(src.indexOf("function needsFirstMeetWait")).split("\nfunction ")[0];
        return /novelNameTokens\(/.test(f) && !/parsedWords\.has\(/.test(f) && !/prior\.has\(/.test(f); })());

// [23] v0.35.0 — autonomous story position: the story ENTERING an event advances
// the pin (begun mode); a mere mention does not; and the position never regresses
// to an event already passed (no referee call is even spent on it).
console.log("[23] auto story position: enter advances, mention doesn't, never regresses");
const S23 = extension_settings.canon_grounding;
const md23 = globalThis.__ctx.chatMetadata;
delete md23.canon_grounding_arc; delete md23.canon_grounding_arc_reached;
const q23a = parseQueue.length;
globalThis.__ctx.chat.push(msg("Lanterns rise as the Harvest Banquet begins around us.", false));
const run23a = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("parser fired for the event", parseQueue.length === q23a + 1);
parseQueue[q23a].resolve('[{"name":"Harvest Banquet","now":"beginning","evidence":"Harvest Banquet begins"}]');
await sleep(60);
T("story referee consulted for a NEW candidate event", parseQueue.length === q23a + 2);
T("the referee is shown the scene and the candidate", /Candidate event: "Harvest Banquet"/.test(sentPrompts[sentPrompts.length - 1] || ""));
parseQueue[q23a + 1].resolve('{"advance": true}');
await run23a;
await sleep(80);   // fire-and-forget groundArc completes
T("position advanced to the event", md23.canon_grounding_arc?.title === "Harvest Banquet");
T("auto pin is BEGUN mode (arc summary is future, not past)", md23.canon_grounding_arc?.mode === "begun");
globalThis.__ctx.chat.push(msg("And then the music keeps on playing softly.", true));
await intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
T("begun framing injected: summary marked NOT yet occurred",
    /Harvest Banquet \(just beginning\)/.test(lastInjection()) && /NOT yet happened/.test(lastInjection()));
// --- a mere MENTION of a different event must not move the position ---
const q23b = parseQueue.length;
globalThis.__ctx.chat.push(msg("She fondly recalled last year's Winter Gala.", false));
const run23b = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
parseQueue[q23b].resolve('[{"name":"Winter Gala","now":"remembered","evidence":"Winter Gala"}]');
await sleep(60);
T("referee consulted for the mentioned event", parseQueue.length === q23b + 2);
parseQueue[q23b + 1].resolve('{"advance": false}');
await run23b;
await sleep(60);
T("a memory does NOT move the story position", md23.canon_grounding_arc?.title === "Harvest Banquet");
// --- the story then really enters the Gala ---
S23.parserEveryTurn = true;
const q23c = parseQueue.length;
globalThis.__ctx.chat.push(msg("Snow falls as the Winter Gala begins.", false));
const run23c = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
parseQueue[q23c].resolve('[{"name":"Winter Gala","now":"beginning","evidence":"Winter Gala begins"}]');
await sleep(60);
parseQueue[q23c + 1].resolve('{"advance": true}');
await run23c;
await sleep(80);
T("position advanced to the new event", md23.canon_grounding_arc?.title === "Winter Gala");
T("superseded position remembered as reached", (md23.canon_grounding_arc_reached || []).includes("harvest banquet"));
// --- a reference BACK to the passed event: no regression, and no referee spent ---
const q23d = parseQueue.length;
globalThis.__ctx.chat.push(msg("Talk of the Harvest Banquet still lingers.", false));
const run23d = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
parseQueue[q23d].resolve('[{"name":"Harvest Banquet","now":"referenced","evidence":"Harvest Banquet"}]');
await run23d;
await sleep(60);
T("no referee call for an already-reached event", parseQueue.length === q23d + 1);
T("the position never slid backward", md23.canon_grounding_arc?.title === "Winter Gala");
S23.parserEveryTurn = false;

// [24] v0.35.0 — static witnesses for the story-referee wiring.
console.log("[24] v0.35.0 static witnesses — story referee wiring");
T("world-state applier: ONE definition, three call paths (interceptor, post-gen, rescan)",
    (src.match(/await applyCastWorldState\(names, sceneText, myEpoch\)/g) || []).length === 3);
T("high-water mark checked BEFORE a referee call is spent",
    /arcAlreadyReached\(hit\.entry\.name, cur, chatArcReached\(\)\)\) continue;\s*\n\s*const go = await judgeArcAdvance/.test(src));
T("referee fails safe: no verdict, no advancement",
    /async function judgeArcAdvance/.test(src) && /if \(!out\) return false;/.test(src));
T("manual pin is a decree: reached list wiped; auto appends",
    /if \(mode !== "begun"\) return \{ note: \{ \.\.\.note, mode: "reached" \}, reached: \[\] \};/.test(src));
T("clearing the position also clears the tracker's memory",
    /setChatArc\(null\); setChatPin\("canon_grounding_arc_reached", \[\]\);/.test(src));
T("the referee prompt is user-visible like every other (🧾 wired)",
    /\["#cg_prompt_arcjudge",\s*"promptArcJudge",[^\]]*DEFAULT_PROMPT_ARCJUDGE\]/.test(src) && /cg_prompt_arcjudge_reset/.test(src));

// [25] v0.36.0 — 🔭 wiki discovery: verify first, discover when needed, settle forever.
console.log("[25] wiki discovery: verify -> discover -> settle, wiki.gg beats a frozen fork");
const S25 = extension_settings.canon_grounding;
S25.autoDiscoverWiki = true;
S25.promptDiscover = "";
globalThis.__ctx.name2 = "Zar Blade";
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
S25.wikis = "";
const f25 = fetchLog.length, q25 = parseQueue.length;
const p25a = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
T("empty config goes straight to the proposer", parseQueue.length === q25 + 1);
parseQueue[q25].resolve('{"franchise":"Found Saga","slugs":["foundsaga"]}');
await p25a;
T("both hosts probed for the candidate",
    fetchLog.slice(f25).some(u => u.includes("foundsaga.fandom.com") && u.includes("srsearch"))
    && fetchLog.slice(f25).some(u => u.includes("foundsaga.wiki.gg") && u.includes("srsearch")));
T("stale-fork rule consulted recent changes on both",
    fetchLog.slice(f25).filter(u => u.includes("recentchanges")).length === 2);
T("live wiki.gg beat the frozen fandom fork — as the CHAT's binding", globalThis.__ctx.chatMetadata.canon_grounding_wiki === "foundsaga.wiki.gg");
T("the GLOBAL field is untouched by discovery", S25.wikis === "");
T("discovered wiki saved to the library", S25.savedWikis.includes("foundsaga.wiki.gg"));
const ok25 = globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
T("chat settled with a verified pin", ok25 && ok25.wikis === "foundsaga.wiki.gg" && ok25.name === "Zar Blade" && !ok25.failed);
// settled: a second call must cost NOTHING — no LLM, no fetches
const f25b = fetchLog.length, q25b = parseQueue.length;
await globalThis.CanonGrounding_verifyWiki();
T("settled chat costs zero LLM and zero fetches", parseQueue.length === q25b && fetchLog.length === f25b);
// verify-path: pin gone but the config is right -> one probe confirms, no LLM spent
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
const q25c = parseQueue.length;
await globalThis.CanonGrounding_verifyWiki();
T("a correct existing config is verified without any LLM call", parseQueue.length === q25c);
const ok25c = globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
T("verification re-pins the chat", ok25c && ok25c.name === "Zar Blade" && !ok25c.failed);
// failure settles: candidates that exist but DON'T know the protagonist are rejected
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki;
S25.wikis = "";
const q25d = parseQueue.length;
const p25d = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
parseQueue[q25d].resolve('{"franchise":"Missing","slugs":["missslug"]}');
await p25d;
T("an ok-but-empty wiki is structurally rejected, config untouched", S25.wikis === "");
const ok25d = globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
T("failure settles with a marked pin", ok25d && ok25d.failed === true);
const q25e = parseQueue.length, f25e = fetchLog.length;
await globalThis.CanonGrounding_verifyWiki();
T("a failed chat never nags again", parseQueue.length === q25e && fetchLog.length === f25e);
S25.wikis = "testwiki";
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki;
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;

// [27] v0.36.1 — an ORIGINAL protagonist must not break discovery: the LLM's
// canon names verify the (correct) ACTIVE config, which settles silently —
// no candidate probing, no recentchanges, and absolutely no "not found".
console.log("[27] OC protagonist: canon names settle a correct manual config");
S25.wikis = "foundsaga.wiki.gg";
globalThis.__ctx.name2 = "Jovan Custom";
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
const f27 = fetchLog.length, q27 = parseQueue.length;
const p27 = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
T("card-name probe missed, so the proposer was consulted", parseQueue.length === q27 + 1);
parseQueue[q27].resolve('{"franchise":"Found Saga","slugs":["foundsaga"],"names":["Zar Blade"]}');
await p27;
const w27 = fetchLog.slice(f27);
T("the correct manual config was NOT touched", S25.wikis === "foundsaga.wiki.gg");
const ok27 = globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
T("chat settled as verified, not failed", ok27 && ok27.name === "Jovan Custom" && !ok27.failed);
T("exactly two probes: the OC name (miss), then the canon name (hit)",
    w27.filter(u => u.includes("srsearch")).length === 2);
T("no candidate machinery ran at all", w27.filter(u => u.includes("recentchanges")).length === 0
    && !w27.some(u => u.includes("foundsaga.fandom.com")));
globalThis.__ctx.name2 = "Zar Blade";
S25.wikis = "testwiki";

// [28] v0.37.0 — ANY turn self-heals the wiki: an ordinary intercept (no names,
// no parser) is enough to verify and pin an unverified chat, at zero LLM cost.
console.log("[28] the interceptor itself triggers wiki verification");
S25.wikis = "foundsaga.wiki.gg";
globalThis.__ctx.name2 = "Zar Blade";
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
const q28 = parseQueue.length;
globalThis.__ctx.chat.push(msg("The wind blows through empty halls.", true));
await intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(80);
const ok28 = globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;
T("a plain turn verified and pinned the chat", ok28 && ok28.name === "Zar Blade" && !ok28.failed);
// Discovery itself must still be free: the only call this turn is the cast parse
// the player's new message earns.
T("verification itself cost zero LLM calls (only the turn's own parse)", parseQueue.length <= q28 + 1);
globalThis.__ctx.name2 = "Zar Blade";
S25.wikis = "testwiki";
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki;
delete globalThis.__ctx.chatMetadata.canon_grounding_wiki_ok;

// [29] v0.38.0 — the universe is CHAT-SCOPED and DECLARATION-AWARE.
console.log("[29] chat-scoped universe: empty-chat settlement re-opens on the declaration");
const ctxB29 = { ...globalThis.__ctx, chat: [], chatMetadata: {} };
globalThis.__ctx = ctxB29;
ctxB29.name2 = "Jovan Custom";
S25.wikis = "testwiki";
const q29 = parseQueue.length;
const p29a = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
parseQueue[q29].resolve('{"franchise":"Unknown","slugs":["missslug"]}');
await p29a;
T("an EMPTY chat settles as failed, not bound",
    ctxB29.chatMetadata.canon_grounding_wiki_ok?.failed === true && !ctxB29.chatMetadata.canon_grounding_wiki);
// stale canon from another universe sits in this chat's cache
ctxB29.chatMetadata.canon_grounding_cache = {
    "old guy":  { name: "Old Guy",  found: true, wiki: "oldwiki", sections: {} },
    "zarblade": { name: "Zarblade", found: true, wiki: "foundsaga.wiki.gg", sections: {} },
};
// THE DECLARATION ARRIVES — the fingerprint changes, the settlement re-opens
ctxB29.chat.push(msg("#Found Saga. Mc Jovan at the academy library.", true));
const q29b = parseQueue.length;
const p29b = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
T("a fandom declared in message ONE re-opens a failed settlement", parseQueue.length === q29b + 1);
parseQueue[q29b].resolve('{"franchise":"Found Saga","slugs":["foundsaga"],"names":["Zar Blade"]}');
await p29b;
T("the chat received its OWN binding", ctxB29.chatMetadata.canon_grounding_wiki === "foundsaga.wiki.gg");
T("the GLOBAL field was never touched", S25.wikis === "testwiki");
T("foreign-universe canon was purged, same-universe canon kept",
    !ctxB29.chatMetadata.canon_grounding_cache["old guy"] && !!ctxB29.chatMetadata.canon_grounding_cache["zarblade"]);
const q29c = parseQueue.length;
ctxB29.chat.push(msg("The rain keeps falling.", true));   // message TWO — the opening is still being written
await globalThis.CanonGrounding_verifyWiki();
T("opening still filling: the re-check spends ZERO LLM", parseQueue.length === q29c);
T("and the binding stands", ctxB29.chatMetadata.canon_grounding_wiki === "foundsaga.wiki.gg");
const q29d = parseQueue.length, f29d = fetchLog.length;
ctxB29.chat.push(msg("Night falls over the academy.", true));   // message THREE — beyond the opening
await globalThis.CanonGrounding_verifyWiki();
T("beyond the opening: settled at ZERO cost, forever", parseQueue.length === q29d && fetchLog.length === f29d);

// [31] v0.39.0 — turn ONE of a new chat WAITS for its universe and grounds
// in the SAME interception: discovery → bind → parse → ground → inject, one turn.
console.log("[31] turn one: discover, bind, and INJECT in the same interception");
const ctxD31 = { ...globalThis.__ctx, chat: [], chatMetadata: {} };
globalThis.__ctx = ctxD31;
ctxD31.name2 = "Jovan Custom";
S25.wikis = "testwiki";
ctxD31.chat.push(msg("#Found Saga. Zar Blade waits by the gate.", true));
const f31 = fetchLog.length, q31 = parseQueue.length;
const run31 = intercept(ctxD31.chat, 4096, () => {}, "normal");
await sleep(20);
T("discovery consulted FIRST (the turn is holding for it)", parseQueue.length === q31 + 1);
parseQueue[q31].resolve('{"franchise":"Found Saga","slugs":["foundsaga"],"names":["Zar Blade"]}');
await sleep(60);
T("scene parser runs AFTER the universe is bound", parseQueue.length === q31 + 2);
parseQueue[q31 + 1].resolve('[{"name":"Zar Blade","now":"waiting","evidence":"Zar Blade waits"}]');
await run31;
const w31 = fetchLog.slice(f31);
T("the chat bound before grounding", ctxD31.chatMetadata.canon_grounding_wiki === "foundsaga.wiki.gg");
T("grounding fetched canon from the DISCOVERED universe",
    w31.some(u => u.includes("foundsaga.wiki.gg") && u.includes("page=")));
T("and never from the stale default", !w31.some(u => u.includes("testwiki") && u.includes("page=")));
T("the injection landed on THIS turn, in the new header voice",
    /Zar Blade/.test(lastInjection()) && /Author's note — canon/.test(lastInjection()));

// [26] v0.36.0 — static witnesses for the discovery wiring.
console.log("[26] v0.36.0 static witnesses — wiki discovery wiring");
T("verify the ACTIVE config before spending any discovery LLM",
    /const quick = \(ok && ok\.via && !ok\.manual\)/.test(src) && src.indexOf('hostKnowsAny(w, quick)') < src.indexOf('llmCall(s.promptDiscover'));
T("structural verification: a probe must HIT a canon name, fetch-ok is not enough",
    /if \(\(hits \|\| \[\]\)\.some\(t => titleMatchesName\(t, n\)\)\) return n;/.test(src));
T("the ACTIVE config is re-verified with CANON names before any candidate",
    /for \(const w of active\) \{\s*\n\s*if \(!probes\.length\) break;\s*\n\s*const knownAs = await hostKnowsAny\(w, probes\);/.test(src));
T("both-hosts hit -> the stale-fork rule decides",
    /pickLiveHost\(fRc, gRc\) === "gg" \? `\$\{slug\}\.wiki\.gg` : slug/.test(src));
T("discovery fires on CHAT_CHANGED, fire-and-forget",
    /setTimeout\(\(\) => \{ verifyOrDiscoverWiki\(\)\.catch\(\(\) => \{\}\); \}, 0\);/.test(src));
T("settlement is keyed on the FINGERPRINT of what discovery saw",
    /if \(!opts\.force && ok && ok\.fp === fp\) return;/.test(src));
T("a manual decree is never second-guessed",
    /if \(ok && ok\.manual\) return;/.test(src));
T("discovery NEVER writes the global field", !/s\.wikis = stored/.test(src));
T("every grounding path reads the CHAT's universe",
    (src.match(/const wikis = activeWikis\(\)\.split/g) || []).length === 2
    && /searched: normWikiSet\(activeWikis\(\)\)/.test(src));
T("an unbound chat HOLDS for its universe on turn one",
    /await Promise\.race\(\[disc,/.test(src));
T("turn ONE of a NEW chat waits for discovery outright (no race to lose)",
    /const opening = \(chat \|\| \[\]\)\.length <= 2;/.test(src) && /if \(opening\) \{[\s\S]{0,320}await disc;/.test(src));
T("the discovery call has a snappy budget — it cannot eat the whole turn",
    /budgetMs: Math\.min\(Number\(s\.parserBudgetMs\) \|\| 30000, 15000\)/.test(src));
T("re-checks probe the name that WORKED before (via), zero-LLM",
    /hostKnowsAny\(w, quick\)/.test(src) && /via: String\(via \|\| verifiedName/.test(src));
T("binding a universe purges foreign canon (one writer)",
    (src.match(/purgeForeignEntries\(/g) || []).length === 2);
T("failure is remembered, not retried forever",
    /failed: true, ts: Date\.now\(\)/.test(src));
T("discovery self-heals from EVERY entry point: chat change, boot, and the interceptor",
    (src.match(/verifyOrDiscoverWiki\(\)\.catch\(\(\) => \{\}\)/g) || []).length === 3);
T("the Scan button AWAITS discovery, and FORCES it — an explicit scan re-opens\n     a settled or failed chat instead of being swallowed by the fingerprint",
    /await verifyOrDiscoverWiki\(\{ force: true \}\);/.test(src));
T("an EMPTY preview names the wiki state instead of leaving the user guessing",
    /wikiStateHint\(\)/.test(src) && /NOT verified for this chat yet/.test(src));
T("the discovery prompt is user-visible like every other (🧾 wired)",
    /\["#cg_prompt_discover",\s*"promptDiscover",[^\]]*DEFAULT_PROMPT_DISCOVER\]/.test(src) && /cg_prompt_discover_reset/.test(src));

// [32] v0.40.0 — LO's live report: SillyTavern's NEUTRAL card on a blank chat.
// There is no protagonist and nothing the story has said, so there is nothing a
// universe could be proven with. Discovery must not run at all.
console.log("[32] the neutral card on a blank chat: nothing is spent, nothing is bound");
const ctx32 = { ...globalThis.__ctx, chat: [], chatMetadata: {}, characters: undefined, characterId: undefined };
globalThis.__ctx = ctx32;
ctx32.name2 = "Assistant";
S25.wikis = "";
const q32 = parseQueue.length, f32 = fetchLog.length;
await globalThis.CanonGrounding_verifyWiki();
T("no proposer was consulted — the model is never asked to invent a universe", parseQueue.length === q32);
T("no wiki was probed", fetchLog.length === f32);
T("nothing was bound", !ctx32.chatMetadata.canon_grounding_wiki);
T("and nothing was SETTLED either — the next turn re-checks for free",
    !ctx32.chatMetadata.canon_grounding_wiki_ok);
// the same blank chat, once the story actually speaks, is allowed to discover
ctx32.chat.push(msg("#Found Saga. The gates of the academy stood open.", true));
const q32b = parseQueue.length;
const p32b = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
T("the moment the chat says something, discovery runs", parseQueue.length === q32b + 1);
parseQueue[q32b].resolve('{"franchise":"Found Saga","slugs":["foundsaga"],"names":["Zar Blade"]}');
await p32b;
T("a DECLARED universe binds on the user's own word", ctx32.chatMetadata.canon_grounding_wiki === "foundsaga.wiki.gg");
T("and it records that a declaration is what proved it",
    ctx32.chatMetadata.canon_grounding_wiki_ok?.viaDecl === true);

// [33] v0.40.0 — a hallucinated universe cannot certify itself. memory-alpha
// really does know Spock; that has never been evidence about THIS chat.
console.log("[33] the proposer hallucinates a franchise the chat has never mentioned");
const ctx33 = { ...globalThis.__ctx, chat: [], chatMetadata: {}, characters: undefined, characterId: undefined };
globalThis.__ctx = ctx33;
ctx33.name2 = "Jovan Custom";
S25.wikis = "";
ctx33.chat.push(msg("Jovan Oda walked the halls of the Seireitei toward the Gotei barracks.", true));
const q33 = parseQueue.length, f33 = fetchLog.length;
const p33 = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
parseQueue[q33].resolve('{"franchise":"Star Trek","evidence":"the USS Enterprise","slugs":["memory-alpha"],"names":["Spock","James T. Kirk"]}');
await p33;
const w33 = fetchLog.slice(f33).filter(u => u.includes("srsearch"));
T("memory-alpha was NOT bound", ctx33.chatMetadata.canon_grounding_wiki !== "memory-alpha");
T("nothing at all was bound", !ctx33.chatMetadata.canon_grounding_wiki);
T("the chat settled as failed, honestly", ctx33.chatMetadata.canon_grounding_wiki_ok?.failed === true);
T("\"Spock\" was never used as a key — the chat never says it",
    !w33.some(u => /srsearch=Spock/i.test(u)));
T("nor was the invented quote — it is not in the text either",
    !w33.some(u => /USS\+Enterprise|USS%20Enterprise/i.test(u)));
T("the keys came from the CHAT: its own proper nouns were probed",
    w33.some(u => /srsearch=Seireitei/i.test(u)));

// [34] v0.40.0 — the law is not blanket refusal. Let the chat actually mention
// the canon name and the very same proposal binds.
console.log("[34] the same proposal, once the chat really says it, binds");
const ctx34 = { ...globalThis.__ctx, chat: [], chatMetadata: {}, characters: undefined, characterId: undefined };
globalThis.__ctx = ctx34;
ctx34.name2 = "Jovan Custom";
S25.wikis = "";
ctx34.chat.push(msg("Spock raised an eyebrow as the shuttle docked.", true));
const q34 = parseQueue.length;
const p34 = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
parseQueue[q34].resolve('{"franchise":"Star Trek","slugs":["memory-alpha"],"names":["Spock"]}');
await p34;
T("a canon name the chat DOES say is proof, and the universe binds",
    ctx34.chatMetadata.canon_grounding_wiki === "memory-alpha");
T("the pin records the term that proved it", ctx34.chatMetadata.canon_grounding_wiki_ok?.via === "Spock");

// [35] v0.40.0 — a wiki may not be certified by the string that named it.
console.log("[35] the card name cannot certify a wiki named after the card");
const ctx35 = { ...globalThis.__ctx, chat: [], chatMetadata: {}, characters: undefined, characterId: undefined };
globalThis.__ctx = ctx35;
ctx35.name2 = "Alice";
S25.wikis = "";
ctx35.chat.push(msg("Alice tended the greenhouse in silence.", true));
const q35 = parseQueue.length;
const p35 = globalThis.CanonGrounding_verifyWiki();
await sleep(20);
parseQueue[q35].resolve('{"franchise":"","evidence":"","slugs":[],"names":[]}');
await p35;
T("alice.fandom.com knowing an \"Alice\" is not evidence — nothing bound",
    !ctx35.chatMetadata.canon_grounding_wiki);
T("the chat settled as failed rather than guessing",
    ctx35.chatMetadata.canon_grounding_wiki_ok?.failed === true);

// [36] v0.40.0 — static witnesses for the evidence law.
console.log("[36] v0.40.0 static witnesses — the evidence law");
T("no evidence -> discovery returns BEFORE the proposer is ever called",
    src.indexOf("if (!probeName && !terms.length)") < src.indexOf("llmCall(s.promptDiscover"));
T("no evidence -> no pin is written, so the hold costs nothing and re-checks",
    /if \(!probeName && !terms\.length\) \{[\s\S]{0,200}return;\s*\n\s*\}/.test(src));
T("a placeholder card name never becomes a protagonist",
    /const probeName = \(rawName && !isPlaceholderName\(rawName\)\) \? rawName : "";/.test(src));
T("candidate keys are chat-grounded: model names must survive groundedNames",
    /const grounded = groundedNames\(/.test(src) && /for \(const n of grounded\) addProof\(n\);/.test(src));
T("the proposer's quote must be findable in the text before it is trusted",
    /const quoteOk = quoted && quoted\.length >= 3 &&/.test(src));
T("a candidate can never be proven by the string that generated it",
    /proofPool\.filter\(t => !cand\.from \|\| normName\(t\) !== normName\(cand\.from\)\)/.test(src));
T("a declaration is a decree: it only has to be REAL, not to pass a title match",
    /const declaredAs = declaredCandidate\(slug, declarations\);/.test(src)
    && /hostHasAnything\(slug, declaredAs\)/.test(src));
T("a declared binding re-verifies the way it was PROVEN, not more strictly",
    /const reDecl = !!\(ok && ok\.viaDecl && ok\.via\);/.test(src));
T("discovery reads the whole card and the latest scenes, not a 600-char slice",
    /function discoveryCorpus\(ctx\)/.test(src) && /add\(ch\.scenario, 800\);/.test(src)
    && /msgs\.slice\(0, 2\)\.concat\(msgs\.slice\(-6\)\)/.test(src));
T("candidate probing is bounded — a total miss cannot grind the turn",
    /let probeBudget = 24;/.test(src));
T("the proposer is told that guessing is worse than nothing",
    /guessing is worse than nothing/.test(src));

// [37] v0.40.1 — static witnesses: the preview measures, the ghost panel clears.
console.log("[37] v0.40.1 static witnesses — measured preview, no ghost reasons");
T("the empty-preview toast calls the DIAGNOSIS, not a canned three-claim string",
    /Preview is EMPTY \\u2014 \$\{emptyNoteDiagnosis\(scene, cast, \{/.test(src)
    && !/nothing cached is named in the scene window, cast is empty, and no pins\/arc are set/.test(src));
T("the diagnosis is measured: counts, pin resolution, and the meta-only hunt",
    /function emptyNoteDiagnosis\(rawMsgs, castNames, extras = \{\}\)/.test(src)
    && /setting pin DANGLES/.test(src) && /ONLY inside \[META:\] blocks/.test(src));
T("an empty injection CLEARS the why-panel — no reasons under a Nothing banner",
    /const \$ghost = \$\("#cg_why"\);\s*\n\s*if \(\$ghost\.length\) \$ghost\.empty\(\);/.test(src));
T("unclosed meta blocks are line-bounded — a stray bracket cannot blind the scene",
    /\[\^\\\]\\n\]\*/.test(src.match(/function stripMetaBlocks[\s\S]{0,2600}?\n\}/)[0]));
T("the setting pin resolves through cacheEntryFor, not exact-key-or-nothing",
    /const direct = store\[sk\] && store\[sk\]\.found \? \{ key: sk, entry: store\[sk\] \} : cacheEntryFor\(sk\);/.test(src));
T("the preview stamps its source",
    /lastSource = "preview";/.test(src));

// ---------------------------------------------------------------------------
// [38] v0.41.0 — ONE discovery at a time, and only on real turns.
// Four entry points (chat change, boot, interceptor, Scan) all get "not
// settled" from an unbound chat until a pin is written, so they used to stack:
// two or three full runs, each spending its own LLM call and probe storm.
console.log("[38] discovery is single-flight, and quiet generations spend nothing");
const ctx38 = { ...globalThis.__ctx, chat: [], chatMetadata: {} };
globalThis.__ctx = ctx38;
ctx38.name2 = "Jovan Custom";
S25.wikis = "";
ctx38.chat.push(msg("#Found Saga. Zar Blade waits by the gate.", true));
{
    const q38 = parseQueue.length, f38 = fetchLog.length;
    // three concurrent callers, exactly as the live entry points collide
    const a = globalThis.CanonGrounding_verifyWiki();
    const b = globalThis.CanonGrounding_verifyWiki();
    const c = globalThis.CanonGrounding_verifyWiki();
    await sleep(20);
    T("three concurrent callers spend exactly ONE discovery LLM call", parseQueue.length === q38 + 1);
    parseQueue[q38].resolve('{"franchise":"Found Saga","slugs":["foundsaga"],"names":["Zar Blade"]}');
    await Promise.all([a, b, c]);
    T("all three callers get the same settled result", ctx38.chatMetadata.canon_grounding_wiki === "foundsaga.wiki.gg");
    T("and only one probe storm was paid for",
        fetchLog.slice(f38).filter(u => u.includes("srsearch")).length <= 6);
}
{
    // the slot must be RELEASED before the promise resolves, or the very next
    // caller gets handed the finished run's stale result instead of a new one
    delete ctx38.chatMetadata.canon_grounding_wiki_ok;
    delete ctx38.chatMetadata.canon_grounding_wiki;
    S25.wikis = "";
    const q38b = parseQueue.length;
    const p = globalThis.CanonGrounding_verifyWiki();
    await sleep(20);
    parseQueue[q38b].resolve('{"franchise":"Found Saga","slugs":["foundsaga"],"names":["Zar Blade"]}');
    await p;
    delete ctx38.chatMetadata.canon_grounding_wiki_ok;
    delete ctx38.chatMetadata.canon_grounding_wiki;
    S25.wikis = "";
    const q38c = parseQueue.length;
    const p2 = globalThis.CanonGrounding_verifyWiki();
    await sleep(20);
    T("the in-flight slot is released before resolution — the NEXT call really runs",
        parseQueue.length === q38c + 1);
    parseQueue[q38c].resolve('{"franchise":"Found Saga","slugs":["foundsaga"],"names":["Zar Blade"]}');
    await p2;
}
{
    // a QUIET generation is not a turn: it must not reach discovery at all
    delete ctx38.chatMetadata.canon_grounding_wiki_ok;
    delete ctx38.chatMetadata.canon_grounding_wiki;
    S25.wikis = "";
    const q38d = parseQueue.length, f38d = fetchLog.length;
    await intercept(ctx38.chat, 4096, () => {}, "quiet");
    T("a quiet generation spends no LLM and no fetches", parseQueue.length === q38d && fetchLog.length === f38d);
    await intercept(ctx38.chat, 4096, () => {}, "impersonate");
    T("an impersonate generation spends nothing either", parseQueue.length === q38d && fetchLog.length === f38d);
    T("and nothing was bound behind the user's back", !ctx38.chatMetadata.canon_grounding_wiki_ok);
}

// [39] v0.41.0 — static witnesses for the three structural fixes.
console.log("[39] v0.41.0 static witnesses — guards, degradation, and pure tiers");
T("the genType + in-flight guards sit ABOVE the discovery block",
    src.indexOf('if (!["normal", "swipe", "regenerate", "continue"].includes(genType)) return;')
    < src.indexOf("const disc = verifyOrDiscoverWiki().catch(() => {});"));
T("cgInFlight is claimed before discovery can await",
    src.indexOf("cgInFlight = true;") < src.indexOf("const disc = verifyOrDiscoverWiki().catch(() => {});"));
T("a chat switch during the discovery hold is dropped",
    /if \(myEpoch !== chatEpoch\) return;   \/\/ the chat can switch while discovery holds/.test(src));
T("a THROW in the heavy task degrades exactly like a TIMEOUT",
    /heavy\.then\(\(\) => true, \(\) => false\),/.test(src));
T("discovery is single-flight, and a forced scan queues instead of merging",
    /if \(discoverInFlight && !opts\.force\) return discoverInFlight;/.test(src)
    && /if \(prior\) await prior\.catch\(\(\) => \{\}\);/.test(src));
T("the in-flight slot is released in a finally, not a chained promise",
    /finally \{ if \(discoverInFlight === self\) discoverInFlight = null; \}/.test(src));
T("priority tiers are computed AFTER the race, not inside the racing task",
    src.indexOf("const fresh = await Promise.race([")
    < src.indexOf("tierUser = castNamedIn(lastUserMsg);"));
T("the racing task no longer assigns the tiers itself",
    !/tierUser = userNames\.filter/.test(src) && !/tierLedger = lgNames\.filter\(n => mentioned\(n\.toLowerCase\(\), sceneText\.toLowerCase\(\)\)\);\s*\n\s*if \(tierLedger\.length\)/.test(src));
T("a meta block's terminator must be its OWN (no borrowing across an opener)",
    /\[\^\\\]\\\[\]\*\\\]/.test(src.match(/function stripMetaBlocks[\s\S]{0,2600}?\n\}/)[0]));
T("the four dossier-inert category toggles say so in the UI",
    (src.match(/Regex fallback only<\/b>/g) || []).length === 4);
T("the total cap names what it actually budgets, in tokens",
    /Max tokens for all people together/.test(src)
    && /ride on top of it and are never trimmed/.test(src)
    && /<b>not a target<\/b>/.test(src));
T("the people count is not called 'characters' any more",
    /Max people injected at once/.test(src) && !/Max characters injected at once/.test(src));

// [44] v0.43.0 BEHAVIORAL: the wrong page never reaches the note. The structural
// witnesses below prove the call sites exist; this proves the OUTCOME, driving the
// real interceptor against a real-shaped disambiguation page and a real-shaped
// franchise page. Both are named by the PARSER, i.e. trusted — which is exactly
// the path that had no gate at all: the caller vouches for the NAME, we chose the
// PAGE, and a router page is not an entity no matter who asked for it.
console.log("[44] v0.43.0 a router page and a franchise page never inject");
{
    const ctx44 = { ...globalThis.__ctx, chat: [], chatMetadata: { canon_grounding_wiki: "genericwiki" }, characters: undefined, characterId: undefined };
    globalThis.__ctx = ctx44;
    S25.wikis = "genericwiki";
    ctx44.chat = [msg("hello", true), msg("Dabchar and Metaseries and Realchar all arrive.")];
    // Turn one names all three. Earlier scenarios can still have grounding in
    // flight, so the assertions ride the SETTLED state on turn two rather than
    // racing this turn's immersion ceiling — the fix under test is which pages
    // are allowed to ground, not how fast they do it.
    // Earlier scenarios can leave parse requests in flight on the shared queue,
    // so resolve every pending one rather than indexing a position we only think
    // is ours — an unresolved request would burn this turn's whole budget.
    let drained44 = 0;
    const turn44 = async (text) => {
        if (text) ctx44.chat.push(msg(text));
        const run = intercept(ctx44.chat, 4096, () => {}, "normal");
        await sleep(20);
        for (; drained44 < parseQueue.length; drained44++)
            parseQueue[drained44].resolve('["Dabchar", "Metaseries", "Realchar"]');
        await run;
        await sleep(150);        // let background grounding finish and the cache settle
    };
    drained44 = parseQueue.length;
    await turn44(null);                                              // introduce
    await turn44("Dabchar and Metaseries and Realchar are still here.");  // settle

    const f44 = fetchLog.length;
    await turn44("And they remain.");                                // measured turn
    const note44 = lastInjection();
    T("the ordinary character on the same turn DID inject (the path works)",
        /Realchar-colored/.test(note44));
    T("the disambiguation page never reaches the note",
        !/may refer to/i.test(note44) && !/Dabchar-colored/.test(note44));
    T("the franchise's own page never reaches the note",
        !/light novel series/i.test(note44) && !/Metaseries-colored/.test(note44));
    // and it SETTLES: a meta page never becomes an entity, so naming it again
    // must not re-hit the wiki for the same dead page. "not-character" would
    // have — that reason is deliberately re-fetched for trusted callers.
    T("the settled meta page is not re-fetched every turn",
        !fetchLog.slice(f44).some(u => /page=Dabchar/.test(u) || /page=Metaseries/.test(u)));
}

// [41] v0.43.0 — THE WIRING LAW. proof.js proves a function's behavior; nothing
// proved it was CALLED. isDisambiguation and isMetaSeriesPage had passing
// assertions, an accurate header comment claiming "disambiguation pages
// skipped", and ZERO call sites — so a plainly-titled dab page ("Rose") ground
// straight through and injected "Rose may refer to: …" as her canon identity,
// with a green gate the whole time. A pure-function proof is only half a proof.
console.log("[41] v0.43.0 the wiring law — every guard has a CALL SITE");
{
    // Comments mention these by name; only real calls count.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const callsTo = fn =>
        (code.match(new RegExp("(?<!function\\s)\\b" + fn + "\\s*\\(", "g")) || []).length;

    T("isDisambiguation is actually CALLED, not merely defined", callsTo("isDisambiguation") >= 1);
    T("isMetaSeriesPage is actually CALLED, not merely defined", callsTo("isMetaSeriesPage") >= 1);

    // WHERE matters as much as whether. The page-validity check must run before
    // anything reads the text, and above the trusted/untrusted character gate:
    // the caller vouches for the NAME, we chose the PAGE, so trust cannot carry.
    const ensure = src.slice(src.indexOf("async function ensureGrounded"));
    const guard = ensure.indexOf("if (isDisambiguation(wikitext) || isMetaSeriesPage(wikitext))");
    const charGate = ensure.indexOf("const charSignal = extractInfoboxFields(wikitext,");
    T("the page-validity guard sits ABOVE the character-signal gate",
        guard > -1 && charGate > -1 && guard < charGate);
    T("the guard is unconditional — no `trusted` escape hatch",
        !/if \(!trusted && \(isDisambiguation|trusted \&\& isDisambiguation/.test(src));

    // A meta page never becomes valid, so it must SETTLE. "not-character" is the
    // one reason re-fetched for trusted callers (a place/org is still lore) —
    // reusing it would re-hit the wiki for the same dead page every single turn.
    T("a meta page gets its OWN miss reason", /missReason = "meta-page";/.test(src));
    T("only 'not-character' is re-fetched for trusted callers",
        /existing\.reason === "not-character" && trusted/.test(src)
        && !/existing\.reason === "meta-page"/.test(src));

    // The story position is the same wrong-info surface: extractLead on a router
    // page would pin "X may refer to: …" as where the story stands.
    const arc = src.slice(src.indexOf("async function groundArc"));
    T("groundArc refuses a disambiguation page too",
        arc.indexOf('debug(`⚠ arc "${title}" is a disambiguation page') > -1
        && arc.indexOf('debug(`⚠ arc "${title}" is a disambiguation page') < arc.indexOf("const summary = extractSection"));
}

// [42] v0.43.0 — a persona-dependent default may never be CAPTURED. The note
// header resolves name1 at injection time; the settings box froze it at
// UI-build time, so after a persona change the box displayed one name while
// injection used another — and one keystroke there compared against the stale
// default and stored a frozen old-persona header as a literal override, which
// also opts that user out of every future default improvement.
console.log("[42] v0.43.0 instruction defaults resolve live, never captured");
{
    const table = src.slice(src.indexOf("const PROMPTS = ["), src.indexOf("$(\"#cg_factory_reset\")"));
    T("every default in the PROMPTS table is a thunk",
        (table.match(/\(\) => /g) || []).length >= 7
        && !/"promptHeader",\s*defaultPromptHeader\(\)/.test(table));
    T("the box, the comparison and the reset all CALL the thunk",
        /\|\| def\(\)\)\.on\("input"/.test(table)
        && /v\.trim\(\) === def\(\)\.trim\(\)/.test(table)
        && /\$\(sel\)\.val\(def\(\)\);/.test(table));
    T("a chat switch re-resolves any box still showing its default",
        /renderPromptDefaults = \(\) => \{/.test(src)
        && /if \(!\(s\[key\] \|\| ""\)\.trim\(\)\) \$\(sel\)\.val\(def\(\)\);/.test(src)
        && /if \(renderPromptDefaults\) renderPromptDefaults\(\);/.test(src));
    T("a user-authored override is never overwritten by the refresh",
        /if \(!\(s\[key\] \|\| ""\)\.trim\(\)\)/.test(src));
    T("injection still resolves the header live",
        /\(\(settings\(\)\.promptHeader \|\| ""\)\.trim\(\) \|\| defaultPromptHeader\(\)\)/.test(src));
}

// [43] v0.43.0 — no doc block may describe a function that is not the next one
// down. Ten of them had come adrift across many edit sessions: cleanWikitext,
// extractLead, groundArc, relevantCanonNote, abilityLine, buildDossier, llmCall
// and others were undocumented while their docs sat above their neighbours —
// which is how an editor ends up confidently changing the wrong function.
console.log("[43] v0.43.0 every doc block attaches to a declaration");
{
    const lines = src.split("\n");
    const orphans = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*\/\*\*/.test(lines[i])) continue;
        let j = i; while (j < lines.length && !/\*\//.test(lines[j])) j++;
        let k = j + 1; while (k < lines.length && lines[k].trim() === "") k++;
        const nxt = (lines[k] || "").trim();
        if (!/^(export\s+)?(async\s+)?function\b|^(const|let|var|class)\b/.test(nxt))
            orphans.push(`L${i + 1} -> ${nxt.slice(0, 50)}`);
    }
    T(`no stranded doc blocks (found ${orphans.length}${orphans.length ? ": " + orphans[0] : ""})`,
        orphans.length === 0);
}

// [45] v0.44.0 — the live report: the story addresses Rukia, Rukia never injects,
// and an irrelevant cached character rides instead. Three layers had to hold.
console.log("[45] v0.44.0 page choice and miss durability");
{
    // Search rank is relevance, not identity — the tightest COVERING title wins.
    const pick = src.slice(src.indexOf("const usable = hits.filter"), src.indexOf("return pick ? pick.title"));
    T("the search filters media titles before choosing", /const usable = hits\.filter\(h => !isMediaTitle\(h\.title\)\);/.test(pick));
    T("covering titles are preferred, shortest first",
        /titleCoversQuery\(name, h\.title, \[\]\)/.test(pick)
        && /b\.title\.length < a\.title\.length \? b : a/.test(pick));
    T("relevance order is still the fallback when nothing covers", /: usable\[0\]/.test(pick));
    // One TTL definition, both consumers — the gate and the grounder must agree, or
    // a name heals in one and stays dead in the other.
    T("the negative horizon is one function", /function negativeTtl\(entry\)/.test(src));
    T("ensureGrounded uses it", /Date\.now\(\) - existing\.ts < negativeTtl\(existing\)/.test(src));
    T("the parser gate uses it too", /Date\.now\(\) - neg\.ts < negativeTtl\(neg\)/.test(src));
    T("no raw NEGATIVE_TTL comparison survives in either miss check",
        !/existing\.ts < NEGATIVE_TTL/.test(src) && !/neg\.ts < NEGATIVE_TTL/.test(src));
}

// [46] v0.45.0 — THE GATE. The live report: "you talk to rukia" and Rukia never
// injects while an irrelevant cached character does. Nothing here is about the
// wiki; the parser was never asked to look at all.
console.log("[46] v0.45.0 the gate: vocabulary, one veto law, and the ledger");
{
    // 1. A null parse is a TIMEOUT. The model ruled on nothing, so nothing is learned.
    const learn = src.slice(src.indexOf("LEARNING REQUIRES AN ANSWER"), src.indexOf("null = call failed"));
    T("word learning is inside an `if (parsed)`", /if \(parsed\) \{[\s\S]*parsedWords\.add/.test(learn));
    T("a failed parse burns nothing",
        !/^\s*for \(const n of quick\) parsedWords\.add/m.test(
            src.slice(src.indexOf("if (mySerial === parseSerial)"), src.indexOf("LEARNING REQUIRES AN ANSWER"))));

    // 2. ONE veto law. The lowercase path used to read parsedWords directly, making
    //    a ruling permanent for the chat, while the capitalised path could revisit.
    T("there is a single veto predicate", /function parserVetoHolds\(lc\)/.test(src));
    T("the capitalised path uses it", /return !parserVetoHolds\(n\.toLowerCase\(\)\);/.test(src));
    T("the lowercase path uses it too",
        /parserVetoHolds\(t\) \|\| !!cacheEntryFor\(t\)/.test(src));
    T("neither path reads parsedWords raw as a permanent veto",
        !/parsedWords\.has\(t\) \|\| !!cacheEntryFor\(t\)/.test(src));
    T("the veto expires with the miss that made it",
        /missCoversCurrentWikis\(neg, activeWikis\(\)\)\s*\n\s*&& \(Date\.now\(\) - neg\.ts < negativeTtl\(neg\)\)/.test(src));

    // 3. Vocabulary, not adjacency. The pair rule rotted shut as ordinary verbs were
    //    learned, and never tested the last token as a pair's first half at all.
    T("the pair rule is gone", !/hasNovelLowercasePair/.test(src));
    T("one novel token is enough", /return toks\.filter\(t => !known\(t\)\);/.test(src)
        && /function hasNovelLowercaseName\(text\) \{ return novelNameTokens\(text\)\.length > 0; \}/.test(src));
    T("the shared common-word lexicon gates it",
        /COMMON_LOWERCASE\.has\(t\) \|\|/.test(src.slice(src.indexOf("function novelNameTokens"))));

    // 4. The ledger is certainty and costs nothing. It was computed directly above
    //    the gate and used only for injection tiers.
    T("the ledger can open the gate", /lgNames && lgNames\.length/.test(src));
    T("it matches name TOKENS, so a first name counts",
        /nameTokens\(n\)\.some\(t => t\.length >= 3 && !NOISE_WORDS\.has\(t\) && mentioned\(t, lcUser\)\)/.test(src));
    T("it only fires for cast we have not grounded",
        /lgNames\.some\(n =>\s*\n\s*isUnhandledName\(n\) &&/.test(src));
}

// [47] v0.47.0 — WHOSE TO INJECT. The tier system was already correct ("caps
// always trim from the bottom, so the people you are actually talking to
// survive") — its INPUT was blind. Tier 1 read capitalised candidates only, so a
// player who types "you talk to rukia" produced an empty tier 1 on every turn:
// the character being addressed got no priority, fell through to the sweep, and
// was trimmed. Capitalisation is a guess about how someone types, not a test of
// whether a token is a name.
console.log("[47] v0.47.0 selection is case-blind");
{
    T("tier 1 uses the case-blind resolver", /tierUser = castNamedIn\(lastUserMsg\);/.test(src));
    T("no capitalisation heuristic feeds tier 1",
        !/tierUser = extractCandidateNames/.test(src));
    T("one owner map, one definition", /function nameTokenOwners\(\)/.test(src));
    const sweep = src.slice(src.indexOf("First-name sweep:"), src.indexOf("if (hit) admit(entry, hit, key"));
    T("the sweep matches case-insensitively", /"iu"\)\.test\(m\)/.test(sweep));
    T("the sweep no longer demands proper-noun casing", !/\/\^\\p\{Lu\}\/u\.test\(t\)/.test(sweep));
    T("the sweep still refuses ordinary vocabulary and shared tokens",
        /COMMON_LOWERCASE\.has\(t\)/.test(sweep) && /tokenOwner\.get\(t\) === \(entry\.name \|\| ""\)/.test(sweep));
    T("castNamedIn returns mentions in sentence order",
        /hits\.sort\(\(a, b\) => a\.at - b\.at\)\.map\(h => h\.name\)/.test(src));
    T("the tier comment still promises what the code now delivers",
        /characters the PLAYER just named/.test(src) && /Caps always trim[\s\S]{0,12}from the bottom/.test(src));
}

// [48] v0.48.0 — the cast pipeline must not depend on how the model phrased its
// evidence, and the auditor must not be able to delete the person being addressed.
console.log("[48] v0.48.0 evidence and authority");
{
    const v = src.slice(src.indexOf("function verifyCastEvidence"), src.indexOf("function resolveAgainstKnown"));
    T("evidence may be canonicalised, not only echoed", /const tokenInScene = \(frag\) =>/.test(v));
    T("the token must be a WORD, not a substring", /\(\?<!\[\\\\p\{L\}\\\\p\{N\}\]\)/.test(v));
    T("ordinary vocabulary can never be the proof",
        /!NOISE_WORDS\.has\(t\) && !COMMON_LOWERCASE\.has\(t\)/.test(v));
    T("the literal check is still tried first", /inScene\(claim\) \|\| tokenInScene\(claim\)/.test(v));

    const sp = src.slice(src.indexOf("function splitEvidenceStrength"), src.indexOf("function verifyCastEvidence"));
    T("the player's own words are authority", /THE PLAYER'S OWN WORDS ARE AUTHORITY/.test(sp));
    T("player-named entities skip the referee", /if \(playerNamed\(c\.name\)\) \{ strong\.push/.test(sp));
    T("authority is threaded as a parameter, not module state",
        /function splitEvidenceStrength\(cast, sceneText, userMsg = ""\)/.test(src)
        && !/let lastParsedUserMsg/.test(src));
    T("every parse call passes the player's message",
        (src.match(/parseSceneCharacters\(sceneText, /g) || []).length === 4  // 1 definition + 3 call sites
        && !/parseSceneCharacters\(sceneText\)/.test(src));
}

// [49] v0.49.0 — the allocator and the sweep order.
console.log("[49] v0.49.0 presence before depth, recency before insertion order");
{
    const nb = src.slice(src.indexOf("BUDGET: PRESENCE BEFORE DEPTH"), src.indexOf("lastMatchReasons = reasons;"));
    T("an over-budget block skips, never abandons the rest",
        /continue;   \/\/ NOT break/.test(nb) && !/\belse break;/.test(nb));
    T("pass one gives every admitted character an anchor line",
        /const drafts = new Array\(built\.length\)\.fill\(null\);/.test(nb));
    T("pass two spends what is left, in tier order",
        /for \(let li = 1; li < built\[i\]\.lines\.length; li\+\+\)/.test(nb));
    T("all four passes respect the total budget",
        (nb.match(/total \+ \w+\.length > totalCap/g) || []).length === 4);
    T("the per-character cap still bounds depth, now weighted by importance",
        /drafts\[i\]\.length \+ add\.length > charCap\(i\)/.test(nb)
        && /const charCap = \(i\) =>/.test(src));
    T("the lead keeps the full allowance", /Math\.max\(0\.5, 1 - i \* 0\.15\)/.test(src));
    T("the taper has a floor, so nobody loses identity or appearance",
        /Math\.max\(180, Math\.round\(perCap \* share\)\)/.test(src));
    T("pins and the setting are never tapered",
        /if \(!s\.dynamicNote \|\| built\[i\]\.pinned \|\| built\[i\]\.setting\) return perCap;/.test(src));
    T("the count cap now bounds the BUILD pass", /if \(built\.length >= s\.maxCharacters\) break;/.test(src));
    T("the sweep orders by recency, not cache insertion",
        /sweptHits\.sort\(\(a, b\) => b\.at - a\.at\);/.test(src));
    T("smart-expansion Context lines are depth, never presence",
        src.indexOf("Context: ") > src.indexOf("const lines = [];"));
}

// [50] v0.50.0 — scan the player's input, lead with who they addressed, and make
// "Last injection" mean what it says.
console.log("[50] v0.50.0 scan, lead, snapshot");
{
    T("a new player message always earns a parse",
        /let shouldParse = s\.parserEveryTurn\s*\n\s*\|\| \(!!lastUserMsg\.trim\(\) && lastUserMsg !== gateLastUserMsg\);/.test(src));
    T("the consumed message is recorded so a swipe is free",
        /gateLastUserMsg = lastUserMsg;/.test(src));
    T("the heuristics are kept only as the fallback below it",
        src.indexOf("lastUserMsg !== gateLastUserMsg") < src.indexOf("shouldParse = quick.some(parserMayRevisit)"));
    T("who the player named leads the note, then scene recency",
        /present\.sort\(\(a, b\) => \(rank\(a\) - rank\(b\)\) \|\| \(salience\.get\(b\) - salience\.get\(a\)\)\);/.test(src)
        && /const rank = \(p\) => \(p\.pinned \|\| p\.setting\) \? 0 : \(isNamed\(p\) \? 1 : 2\);/.test(src));
    T("player-named matches every identity the entry answers to",
        /\[p\.entry\.name, p\.matchedName, \.\.\.\(p\.entry\.aliases \|\| \[\]\)\]/.test(src));
    T("both routes to player-named are unioned",
        /\.\.\.\(extras\.userNames \|\| \[\]\)\.map/.test(src) && /castNamedIn\(extras\.userMsg\)/.test(src));
    T("pins and the setting still outrank everything",
        /\(p\.pinned \|\| p\.setting\) \? 0/.test(src));
    T("the player's message reaches the note builder", /userMsg: lastUserMsg,/.test(src));
    T("the panel snapshots reasons WITH the note",
        /lastReasons = lastMatchReasons\.slice\(\);/.test(src)
        && /for \(const r of lastReasons\)/.test(src)
        && !/for \(const r of lastMatchReasons\)/.test(src));
}

// [51] v0.51.0 — a watchlist is the opposite of attendance.
console.log("[51] v0.51.0 director apparatus is not the scene");
{
    const sm = src.match(/function stripMetaBlocks[\s\S]{0,2600}?\n\}/)[0];
    T("the <details> director fold is removed", /<details\\b\[\\s\\S\]\*\?/.test(sm));
    T("an unclosed fold (stream cut) still strips to the end", /\(\?:<\\\/details>\|\$\)/.test(sm));
    T("paired {PULSE}…{/PULSE} containers are removed", /\\\{\(\[A-Za-z\]/.test(sm));
    T("the bracket-tag rule is still there", /\[A-Z\]\[A-Z0-9 _&-\]/.test(sm));
    T("Now: is no longer emitted as canon", /const focusLine = \(\) => "";/.test(src));
    T("scene recency is measured from the visible prose", /const lastSeen = \(p\) =>/.test(src));
}

// [52] v0.52.0 — a relationship belongs to the PAIR, not to one character's budget.
console.log("[52] v0.52.0 the relationship pass");
{
    T("pair dynamics are collected apart from ordinary depth", /const dyn = \[\];/.test(src));
    T("both emitters feed the dynamics band",
        (src.match(/dyn\.push\(\.\.\.dynLines\(\)\);/g) || []).length === 2
        && !/lines\.push\(\.\.\.dynLines\(\)\)/.test(src));
    T("the bands are carried on the built entry", /built\.push\(\{ entry, matchedName, pinned, swept, setting, lines: rest, look, dyn \}\);/.test(src));
    T("appearance is allocated before the relationship pass",
        src.indexOf("PASS ONE-AND-A-HALF") < src.indexOf("PASS TWO — WHO THESE PEOPLE ARE"));
    T("it gets its own pass, before any solo depth",
        src.indexOf("PASS TWO — WHO THESE PEOPLE ARE TO EACH OTHER") > 0
        && src.indexOf("PASS TWO — WHO THESE PEOPLE ARE TO EACH OTHER") < src.indexOf("PASS THREE — everything else"));
    T("dynamics only ever name a CO-PRESENT character",
        /for \(const \{ entry: other \} of present\)/.test(src));
    T("it informs, never scripts — the preamble still says so",
        /that dynamic overrides the baseline/.test(src) && /never a script/.test(src));
}

// [53] v0.53.0 — smart dynamic note, on the call we already make.
console.log("[53] v0.53.0 the scene decides which canon leads");
{
    T("the parser is asked what this moment NEEDS", /\\"need\\": \\"1-3 comma-separated/.test(src));
    T("the vocabulary is closed, not freeform",
        /powers, appearance, personality, relationships, history, secrets, /.test(src));
    T("it costs no extra call — it rides the existing parser output",
        (src.match(/await parseSceneCharacters\(/g) || []).length === 3
        && !/llmCall\(\s*composerPrompt/.test(src));
    T("the parser carries need through", /if \(typeof x\.need === "string"\)/.test(src)
        && /out\.push\(\{ name, now, need, evidence \}\);/.test(src));
    T("need is a snapshot of THIS parse, reset with focus",
        (src.match(/castFocus = \{\}; castNeed = \{\};/g) || []).length === 4);
    T("the model chooses a CATEGORY; the extension writes the words",
        /const i = wanted\.findIndex\(lb => line\.startsWith/.test(src));
    T("ordering is stable, so equal ranks are never reshuffled", /\(a\.r - b\.r\) \|\| \(a\.i - b\.i\)/.test(src));
    T("a powers-only scene skips the relationship pass", /if \(s\.dynamicNote && \/powers\/\.test\(nd\) && !\/relationship\/\.test\(nd\)\) continue;/.test(src));
    T("the mode is on by default — nothing to configure", /dynamicNote: true,/.test(src));
}

// [54] v0.54.0 — appearance is pinned, and the mode is switchable.
console.log("[54] v0.54.0 appearance pinned, mode switchable");
{
    const f = src.slice(src.indexOf("function orderLinesByNeed"), src.indexOf("function relevantCanonNote"));
    T("appearance is lifted out before anything is re-ranked",
        /const look = lines\.findIndex\(l => l\.startsWith\("  - Appearance"\)\);/.test(f));
    T("the no-need branch pins it too", /if \(!need\) \{[\s\S]{0,220}Appearance/.test(f));
    T("Smart dynamic order has a real UI toggle", /id="cg_dynamic_note" type="checkbox"/.test(src));
    T("the toggle is bound to the setting and saved",
        /\$\("#cg_dynamic_note"\)\.prop\("checked", s\.dynamicNote\)\.on\("input"/.test(src)
        && /s\.dynamicNote = \$\(this\)\.prop\("checked"\); saveSettingsDebounced\(\);/.test(src));
    T("the hint explains what OFF means, not just ON", /<b>Off<\/b> = the fixed order/.test(src));
}

// [55] v0.56.0 — mentioning a place is not travelling to it.
console.log("[55] v0.56.0 the setting needs the same judge the arc has");
{
    const w = src.slice(src.indexOf("async function applyCastWorldState"), src.indexOf("function splitEvidenceStrength"));
    T("the place path asks the judge before moving the story",
        /const moved = await judgeArcAdvance\(sceneText, hit\.entry\.name/.test(w));
    T("an unchanged setting costs nothing", /if \(chatSettingKey\(\) === hit\.key\) continue;/.test(w));
    T("the first place still pins for free", /if \(!chatSettingKey\(\)\) \{ setChatPin/.test(w));
    T("the pin only happens if the judge agreed",
        /if \(moved\) \{\s*\n\s*setChatPin\("canon_grounding_setting", hit\.key\);/.test(w));
    T("a chat switch mid-judgement discards the result", /if \(myEpoch !== chatEpoch\) return;[\s\S]{0,80}if \(moved\)/.test(w));
}

// [56] v0.57.0 — the WIRING for a place's description. The proof-side assertion
// hands extractSectionRaw its own list, so it proves the extractor and not the
// product. This proves the product actually asks for those sections.
console.log("[56] v0.57.0 place description is wired, not just possible");
{
    const call = src.slice(src.indexOf("const appearanceProse = cleanWikitext("),
                           src.indexOf("let physical = extractInfoboxFields"));
    for (const sec of ["geography", "layout", "architecture", "description", "structure", "overview"])
        T(`the product asks for "${sec}"`, new RegExp(`"${sec}"`).test(call));
    T("a person's own Appearance section is still asked for first",
        call.indexOf('"appearance"') < call.indexOf('"geography"'));
}

// [57] v0.58.0 — AGENTS.md must stay true. A briefing file that drifts is worse
// than none: the next session trusts it, runs the wrong command, or believes a
// count that has since moved. Anything it ASSERTS about this repo is checked here.
console.log("[57] v0.58.0 the briefing file is not allowed to rot");
{
    const ag = fs.readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
    T("it does not duplicate a count that would drift out of sync",
        !/\d{3} passed/.test(ag) && /README's newest changelog entry/.test(ag));
    T("the README does carry a measured count for the current release",
        /test\/sim\.mjs`? \(?\d{3}/.test(fs.readFileSync(new URL("../README.md", import.meta.url), "utf8")));
    T("it gives the ESM-copy syntax check, not node --check index.js",
        /cp index\.js \/tmp\/cg\.mjs && node --check \/tmp\/cg\.mjs/.test(ag));
    T("it names the settings the code actually has",
        /maxTokensPerChar/.test(ag) && /maxTotalTokens/.test(ag)
        && /maxTokensPerChar/.test(src) && /maxTotalTokens/.test(src));
    T("it does not promise an ESLint gate this repo has no config for",
        /no ESLint config/.test(ag));
    T("every pipeline stage it lists exists in the code",
        ["stripMetaBlocks", "verifyCastEvidence", "findPageTitle", "negativeTtl", "castNamedIn"]
            .every(fn => ag.includes(fn) && src.includes("function " + fn)));
}

// [40] the stamp must match the manifest. ST decides whether to auto-update by
// reading manifest.version; a feature commit that bumps only CG_VERSION ships an
// extension nobody's install will pull. The history has that drift in it.
console.log("[40] version stamp == manifest version");
// [58] v0.59.0 ⌀ negative verification — asked-about, not in canon
console.log("[58] v0.59.0 ⌀ negative verification — the wiki's silence is reported");
{
    // Wiring witnesses: the guard must be CALLED, from the one door, and the
    // emptiness check must count the notice as content — comments stripped, so
    // a mention cannot pass for a call.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const callsTo = fn => (code.match(new RegExp("(?<!function\\s)\\b" + fn + "\\s*\\(", "g")) || []).length;
    T("unverifiedNamed is actually CALLED, not merely defined", callsTo("unverifiedNamed") >= 1);
    const rcn = code.slice(code.indexOf("function relevantCanonNote"), code.indexOf("function getProfiles"));
    T("…and the call site is INSIDE the note builder (one door, every surface)", /unverifiedNamed\(/.test(rcn));
    T("the empty-note check counts the notice as content",
        /!blocks\.length && !arcBlock && !pinBlock && !unvBlock/.test(src));
    T("the preview reads the player's message like the turn does",
        /userMsg: lastUserMsg/.test(src.slice(src.indexOf('$("#cg_preview")'))));
    T("only settled no-page/meta-page misses qualify — not-character is not absence",
        /e\.reason !== "no-page" && e\.reason !== "meta-page"/.test(src));

    // Live: a fresh chat bound to a wiki that has nothing; the player asks about
    // an event; the SAME turn grounds the miss and the note reports the absence.
    // Same convention as [8]: no CHAT_CHANGED wiring in the sim harness — the
    // swap is direct. Fresh metadata means a fresh per-chat cache; stale module
    // cast state can admit nobody (nothing it names exists in this chat's cache).
    globalThis.__ctx.chat = [];
    // The settled pin, in the shape bindChatWiki actually writes for a manual
    // binding — a guessed shape sent discovery hunting and stalled the turn.
    globalThis.__ctx.chatMetadata = {
        canon_grounding_wiki: "verifyless",
        canon_grounding_wiki_ok: { wikis: "verifyless", name: "sim", fp: "(manual)", manual: true, ts: Date.now() },
    };
    // The arc judge is its own feature with its own tests; "Feast" would summon
    // it here and park the turn on an LLM call this scenario never answers.
    extension_settings.canon_grounding.autoArc = false;
    const q58 = parseQueue.length;
    globalThis.__ctx.chat.push(msg("Do you remember the Winter Blood Feast?", true));
    const run58 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
    await sleep(20);
    T("the recall question opens the parser gate", parseQueue.length === q58 + 1);
    if (parseQueue.length === q58 + 1) parseQueue[q58].resolve('[{"name": "Winter Blood Feast", "now": "asked about", "need": "history", "evidence": "Winter Blood Feast"}]');
    await run58;
    const cache58 = globalThis.__ctx.chatMetadata.canon_grounding_cache || {};
    T("the miss settled as a durable no-page verdict",
        !!cache58["winter blood feast"] && cache58["winter blood feast"].found === false
        && cache58["winter blood feast"].reason === "no-page");
    T("the SAME turn's note reports the absence",
        /Not found in this story's canon sources/.test(lastInjection()) && /"Winter Blood Feast"/.test(lastInjection()));
    T("…as a real injection, even with zero grounded cast", lastInjection().length > 0);

    // Responsive, not sticky: a turn that does not name it carries no notice.
    // A new player message always earns a parse — answer each one, or the turn
    // parks on the race and the assertion measures the timeout, not the feature.
    globalThis.__ctx.chat.push(msg("She only nods."));
    globalThis.__ctx.chat.push(msg("you nod back", true));
    const q58b = parseQueue.length;
    const run58b = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
    await sleep(20);
    if (parseQueue.length > q58b) parseQueue[q58b].resolve("[]");
    await run58b;
    T("a turn that does not name it is clean", !/Not found in this story's canon sources/.test(lastInjection()));

    // The toggle is honored end-to-end.
    extension_settings.canon_grounding.reportUnverified = false;
    globalThis.__ctx.chat.push(msg("the Winter Blood Feast, again?", true));
    const q58c = parseQueue.length;
    const run58c = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
    await sleep(20);
    if (parseQueue.length > q58c) parseQueue[q58c].resolve('[{"name": "Winter Blood Feast", "now": "asked again", "need": "history", "evidence": "Winter Blood Feast"}]');
    await run58c;
    T("toggle off → the interceptor injects no notice", !/Not found in this story's canon sources/.test(lastInjection()));
    extension_settings.canon_grounding.reportUnverified = true;
    extension_settings.canon_grounding.autoArc = true;
}

{
    const mf = JSON.parse(fs.readFileSync(path.join(here, "..", "manifest.json"), "utf8"));
    const stamp = (src.match(/const CG_VERSION = "([^"]+)"/) || [])[1];
    T(`manifest ${mf.version} === CG_VERSION ${stamp}`, !!stamp && stamp === mf.version);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
