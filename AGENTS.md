# AGENTS.md — read this before you touch anything

You are working on **Canon Grounding**, a SillyTavern extension. The owner (LO) runs
long-form director-style roleplay and coordinates several AI sessions against this
repo. He is not here to test your guesses. Diagnose, fix, gate, push — in one pass.

**The repo is the source of truth, not your memory and not a prior session's summary.**
Fresh-clone, run the gate, then work.

---

## 1. The gate — run all three, every time

```bash
cp index.js /tmp/cg.mjs && node --check /tmp/cg.mjs   # 1. syntax, in the ESM mode ST actually runs
node test/proof.js                                    # 2. pure functions
node test/sim.mjs                                     # 3. end-to-end sim
```

**The expected counts live in the README's newest changelog entry, and nowhere else.**
A number duplicated in two files is a number that will disagree with itself. Read it
there, and if what you get back is lower, something regressed — find it before doing
anything else. Never write a count you have not just seen in output.

`node --check index.js` on the raw file parses it as CommonJS and **silently accepts
things ESM rejects**. Always check the `.mjs` copy. This is not pedantry; the runtime
is ESM.

There is no ESLint config in this repo. The three commands above are the whole gate.

---

## 2. The laws — every one of these was paid for with a real bug

### A proof of the function is not a proof of the call
`isDisambiguation()` and `isMetaSeriesPage()` existed, had passing assertions, and the
file header claimed disambiguation pages were skipped. **Neither had a single call
site.** For versions, a plainly-titled disambiguation page injected *"Rose may refer
to: …"* as a character's canon identity, with a green gate the whole time.

Every guard needs a **wiring witness** in `sim.mjs` that proves it is *called*, and
where. Comments are stripped before counting, so a mention cannot pass for a call.

The same trap caught v0.57.0: an assertion handed `extractSectionRaw` its own argument
list, so deleting the product's list left the suite green. **If your test constructs
the input the product is supposed to supply, you are testing the function, not the
feature.**

### A guard that has never failed is unproven
Negative-test every new guard: reintroduce the exact bug in a scratch copy, run both
suites, confirm exit 1 **and** read which assertion fired. Several guards in this
session survived their first negative test — not because they worked, but because no
assertion discriminated. If it stays green, your test is wrong. Fix it, don't count it.

Some things are **fast paths, not guards** — they cannot be made to fail because the
surrounding code already guarantees the outcome. Label them in the source and do not
claim them as coverage.

### A local heuristic must never override a signal the system already has
This is the single root cause behind most of this session's bugs. Four faces of it:

| The cheap guess | What it overrode |
|---|---|
| Capitalisation decides what is a name | the parser had already read the scene |
| A `{WATCHLIST}` footer counts as attendance | `[ACW:]` literally means off-screen |
| A combat keyword list gates abilities | the parser had said `need: powers` |
| A flat per-character budget | the note had already ranked everyone |

When the model has read the scene, its read wins. Local heuristics are fallbacks for
when it hasn't, never vetoes over it.

### The test suite can encode the bug
An assertion named *"lowercase prose sharing a name token sweeps NOBODY"* used the
invented string `"the rukia flowers bloomed"`. Passing it **required** ignoring
lowercase name mentions — the owner's actual bug. Every session ran the gate, saw
green, and moved on.

When a test fails, decide out loud whether the **TEST** or the **CODE** is wrong, and
say which. Sometimes the honest answer is that the test was enforcing a defect.

### A budget is a ceiling, not a target
An unused allowance is not spent. Categories the scene does not need are **dropped**,
not merely ranked last.

### The harness slices product code by text markers
`proof.js` builds its sandbox by `grab(startMarker, endMarker)` against `index.js` —
and several markers are **doc comments**. Moving a comment silently moves a boundary,
and overlapping slices evaluate functions twice. That is legal JavaScript, so it is
silent until a `const` lands in a doubled span and the harness dies with a
SyntaxError. `grab()` now refuses to build a body it cannot prove is disjoint. If it
throws about overlapping slices, fix the markers — do not widen them past each other.

---

## 3. The pipeline — where a symptom lives

A character can be missing at any of eleven stages. Find the stage before you fix
anything; a character blocked at stage 1 never reaches stage 7 to reveal stage 7 is
also broken.

1. **Gate** — does the parser get asked at all? A new player message always earns a
   parse; an unchanged one (swipe/regenerate) is free.
2. **Scene text** — `stripMetaBlocks` removes `[TAG:]` rows, `<details>` director
   folds and `{PULSE}…{/PULSE}` containers. A watchlist is the opposite of attendance.
3. **Parser** — returns `{name, now, need, evidence}`. `need` is a closed vocabulary.
4. **Evidence** — `verifyCastEvidence` accepts a literal quote **or** a distinctive
   token of it appearing as a word. Ordinary vocabulary never counts as proof.
5. **Authority / auditor** — anything the player named is strong and skips the Cast
   Auditor. The auditor is a second LLM call that fails closed; it must never be able
   to delete the person being addressed.
6. **Lookup** — `findPageTitle` prefers the tightest *covering* title. Fight pages
   (`X vs. Y`), disambiguation pages and franchise pages are rejected.
7. **Negative cache** (`negativeTtl`) — `no-page` is durable (24h). Every other
   reason means *our* resolution failed and heals in 20 minutes.
8. **Selection & order** (`castNamedIn`) — pins/setting, then whoever the player
   named, then scene recency. Case-blind throughout.
9. **Budget** — four passes: presence → appearance → pair dynamics → depth.
   Verbosity must never delete someone who is in the scene.
10. **Absence (⌀)** — `unverifiedNamed`, called only inside `relevantCanonNote` (the
    one door: live turn, preview and every future surface agree). A settled
    `no-page`/`meta-page` miss the player just named is reported as not-in-canon —
    but only when the reference is VOUCHED (the miss's `trusted` stamp:
    parser/ledger/pin asked) **or** the message itself shows ask-intent (a question,
    a trigger word, or the name typed capitalised). A regex candidate that once
    failed a lookup ("nod back") has neither and stays silent: a guess that went
    nowhere is not evidence of absence.
11. **Presentation (✒ Advanced)** — with `composerMode` on, the raced task KICKS a
    DETACHED composition (`composeInFlight` guard — the race never waits) of
    `lastScreenParts`, the note that actually went out. `composeNote` writes CANON
    BACKGROUND only: narrating the current scene is banned and the scene is not even
    sent. `composedNoteValid` refuses any composition that drops a cast member,
    loses an appearance detail, leaks scaffolding, or balloons; the injector swaps it
    in only when `parts.key` — a STABLE facts fingerprint (sections + dossier facts +
    relation keys per character, scene-independent) — matches what is on screen, so a
    landed composition stays landed until canon itself changes. Whether the
    protagonist is themself a canon character is DERIVED per call (`mcCanonName`,
    name or alias, found entries only). Every failure — and the mode being off — is
    exactly the assembled note of stage 9, at identical speed.

---

## 4. Invariants — breaking these is a regression even if the gate passes

- **Case-blind everywhere.** The owner types lowercase (`you talk to rukia`). Any new
  name matching must not depend on capitalisation.
- **Identity and Appearance always ride**, in both modes, in that order. A wrong face
  is the failure this extension exists to prevent.
- **The player's own words are authority.** Anyone they named leads the note, gets the
  full budget share, and skips the referee.
- **Canon states what is true in the source material.** Scene state (`Now:`) is the
  story's job and is not printed — it contradicted the Identity line.
- **The model chooses categories; the extension writes the words.** Every emitted fact
  comes from verified cache. Never let a model compose note prose.
- **Nothing requires configuration.** Defaults must be right. New behaviour ships on.
- **Budgets are in tokens** (`maxTokensPerChar`, `maxTotalTokens`, ~4 chars/token).
  `maxCharacters` counts **people**.

---

## 5. Release discipline

- Python exact-string replace with `assert s.count(old) == 1` before every edit.
  It aborts loudly on drift instead of silently matching the wrong place.
- Bump `manifest.json` **and** `CG_VERSION` together — sim asserts they match.
- README changelog, newest first, with counts measured from real output.
- `git ls-remote` before and after every push; then **fresh-clone and re-run the gate
  against the remote tree**, not your working copy.
- Remove scratch scripts and `node_modules` before committing.
