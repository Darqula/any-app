# Document model: shell, slots, `.hidden` fallback

Background for `packages/protocol/src/slots.ts`. The code comments state the rules; this keeps the
incidents, measurements and rejected designs behind them.

## Invariants worth remembering

- `renderDocument` is the one definition of a document; the live stream is an incremental emission of
  exactly it (that is what makes replay match what was watched), and edits re-render through it.
- A field added to a persisted JSONB shape (`collections`, Phase 5) needs a migration of *reads*
  (`getFilledApp` defaults it), not just of writers.
- `SLOT_ID_PATTERN` must start with a letter, which is why the edit form can use `@shell` as a reserved
  value that cannot collide with a region id. `COLLECTION_PATTERN` is shared by the planner, `records` and
  the fill prompts so a name the planner accepts is never one the data API rejects.

## Tolerant placeholder scan

The planner is asked for `<div data-slot="id"></div>` but routinely writes
`<div class="panel" data-slot="chart"></div>` or `<span data-slot="…">`. A byte-exact regex missed those:
**28% of real generations** fell to the linear fallback ("shell contains no slot placeholders"), plus
silent partial drops when only some placeholders matched (`model-and-sweep-history.md`, quality sweeps). After
S13 told the planner to put the region's class on the placeholder, `PlanError` rose from 10% to 26% until
boolean/unquoted/`data-col2`-style attributes were accepted too.

Traps: `GENERIC_ATTR` is a separate regex from `ATTR` because it is applied with `exec` in a loop; a
boolean attribute is stored as `""` and re-emitted as `hidden=""`; scripts are masked with equal-length
spaces so indexes stay valid and `el.innerHTML = '<div data-slot="x">'` is not read as a placeholder;
`scanPlaceholders` skips already-rendered output (`id="slot-…"`) since S12 made `renderSkeletons` emit
`data-slot` itself. Non-whitespace content is never accepted (genuinely ambiguous).

## `sanitizePlaceholders`

Strips content the model wrote inside a placeholder. It is safe because `swap()` overwrites a region's
contents unconditionally, but it is a **safety net, not the primary fix**: the planner prompt fix (name the
skeleton as the reason the slot must stay empty) landed first and a 6-prompt live probe on 2026-09-08 came
back clean. It deliberately refuses void tags, self-closing tags, unmatched closers and **nested slots**
(deleting a nested one would drop a distinct planned region), so those keep failing loudly with
`PlanError`. It is idempotent.

## The `.hidden` fallback (`utilityCss`)

Why it exists: fill is told never to write `<style>`, but the planner writes the stylesheet before any
region's states are known, so slot content routinely emits `class="panel hidden"` with no rule that hides
an element carrying just `hidden`. `.hidden` is the one state class safe to guess (one reasonable meaning);
`.active`/`.selected`/`.positive` must not get guessed styling.

**Two questions, two predicates, never merge them.** `CSS_CLASS_SELECTOR` answers "is `hidden` styled at
all" (F8's class-usage check; a compound `.form-panel.hidden` counts). `hasStandaloneHiddenSelector`
answers "will adding `hidden` to an arbitrary element hide it" (a compound rule does not). Live proof: a
planner defined only `.confirmation-panel.hidden{display:none}` while a script toggled `hidden` on
`.contact-form`; the gate asked F8's question, stood down, and the form never hid.

`CSS_CLASS_SELECTOR` has no lookbehind on purpose: it hid the second class of a compound selector
(`.ctrl-btn.start`) and produced 12 of 27 false "undefined" offenders on the 20 saved documents.

**Accepted trade-off:** a planner that meant `.hidden` only with a companion class for a fade
(`.panel.hidden{opacity:0;transition:…}`) now also gets `display:none`, so it snaps instead of fading. An
element that never hides is a functional bug; a snap is cosmetic. Revisit with real evidence if that
judgement stops holding.

**Rejected designs:** folding `.hidden{display:none}` into `SKELETON_CSS` (emitted before the planner
sheet) loses to any later equal-specificity planner rule such as `.confirmation-panel{display:block}`,
which is exactly the observed bug; `!important` would clobber a planner that defined `.hidden` itself
(e.g. `visibility:hidden` plus a transition). So: emit last, and only in the planner's silence.
