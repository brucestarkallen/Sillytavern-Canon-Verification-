/*
 * Integration simulation for Canon Grounding — self-contained: builds a stub
 * SillyTavern module tree in a temp dir, copies the real index.js in, and drives
 * the actual interceptor through race scenarios (starvation, serial clobber,
 * epoch guard, cast decay, alias dedupe). Run: node test/sim.mjs
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
    if (titles) return { ok: true, json: async () => ({ query: { pages: { 1: { pageid: 1, title: titles } } } }) };
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
    setExtensionPrompt: (key, text) => injections.push(text),
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
    debug: false, llmParser: true, llmProfileId: "p1", parserEveryTurn: false,
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
extension_settings.canon_grounding.cache["alya"] = { name: "Alisa Mikhailovna Kujou", sections: { physical: "hair: silver" }, aliases: ["Alya"], wiki: "testwiki", found: true, ts: Date.now() };
const before = fetchLog.length;
globalThis.__ctx.chat.push(msg("have you seen Alisa Mikhailovna Kujou?", true));
const run5 = intercept(globalThis.__ctx.chat, 4096, () => {}, "normal");
await sleep(20);
T("alias-known name does not re-fire the parser", parseQueue.length === 3);
await run5;
T("no wiki refetch for alias-known name", fetchLog.length === before);
T("exactly one block for the character", (lastInjection().match(/Alisa Mikhailovna Kujou:/g) || []).length === 1);
T("user-asked char force-included in cast injection", /hair: silver/.test(lastInjection()));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
