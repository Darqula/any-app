# Editing: incidents and traps

Background for `packages/generator/src/edit*.ts` and `apps/studio/src/{edits,activity,conversation}.ts`.

## Targets

One target per request: `css` (whole-stylesheet rewrite), `slot <id>` (one region) or `shell` (the fixed frame:
heading, caption, footer, wrappers). Slots and CSS apply live by `postMessage`; the frame cannot be patched in
place, so the page reloads the iframe. The dropdown sends `@shell` for the frame ("@" cannot begin a region id).

## Router history (both found live on the tic-tac-toe app, 2026-09-21)

1. "Add a dark theme switch" was routed to `css` because the old prompt said "prefer css on a tie". The
   stylesheet edit wrote light/dark rules "applied by the theme switch" for a switch that did not exist, and
   the studio reported "Updated styling." Fix: a stylesheet can only restyle what exists; anything that adds a
   control or behaviour goes to a region; `css` only for purely visual or genuinely vague requests.
2. "Remove the … caption" went to `status-bar` three times, each saving a version and reporting
   "Updated status-bar." while the caption stayed: it lived in the frame, which no edit could reach. Fix:
   `shell` is a third router answer and the router is shown the frame markup.

Live probes after both fixes: 7/7 routed correctly; a real frame edit removed the caption in 4.5 s.
**Known limit:** a request needing both a control and theme rules still gets one target; it goes to the
region that will hold the control and a follow-up can style it. Multi-target edits would be a larger change.

A truncated or `"empty"` router reply is a `RoutingError` (friendly retry hint), not a 500 (S14); a real
`"declined"` refusal must propagate. On the reasoning default model, hidden reasoning eating the budget is
more likely than a mid-answer cutoff.

## Prompts and guards

- Models ignore "no `<style>`": asked to add a button to a slot, one wrote the button *and* a `<style>` block,
  which still takes effect via `innerHTML` and reintroduces classes the CSS editor never sees (and, with
  parallel fill, conflicting rules per class). Hence `stripStyleTags` / `unwrapStyleTag`.
- The CSS prompt's last two rules ("only style what exists"; "if it needs a new control return the stylesheet
  unchanged") back up the router: the "Styling" dropdown bypasses it, and the model once invented rules for a
  non-existent control and spent ~11k completion tokens on it.
- `looksTruncated`: asked to "add a small icon before the Search label" the model returned only
  `<label>…</label><input>`, dropping every other control (including one a previous edit had added), despite
  "output the whole region". A length floor, not a tuned threshold; a truncated stylesheet is worse (it
  unstyles the whole app).
- **No-op guard:** an unchanged result is a 422, nothing saved. Three "remove the caption" edits each saved a
  version and reported success while changing nothing.
- Frame rewrites must keep every region placeholder exactly once, empty (`checkShellEdit`, 502 otherwise);
  class names and ids scripts depend on are not checked.
- A region holding the failed-fill placeholder is *filled*, not edited (edit prompt says "keep everything",
  which would preserve the apology paragraph).
- Edits are also capped by the monthly limit (they used to bypass it), scoped to the editor.

## Live edit state and the conversation log

- `activity.ts` is in memory on purpose: an edit never changes `status`, the flag is only true for the seconds
  a model call runs, and a restart correctly forgets it. Delete refuses mid-edit because usage rows carry a
  `generation_id` foreign key: a delete between the model call and the usage write would fail the write and
  the tokens would never count against the cap. `beginEdit`'s end runs after the usage write.
- The follow-up is logged when accepted, not on success; the pending row is derived from live state so a crash
  leaves nothing to clean up; `firstMessage` is `generations.prompt`, so older apps need no backfill.


## Measured cost of an edit (2026-08-31, `longcat-2.0`)

A full generation was ~11.4k tokens; a slot edit 1.5-3.5k (13-31%, flat however many slots the app has), a CSS
edit ~1.3k (~12%), a router call ~260-290. Rows with no plan (the linear fallback's output) cannot be edited
and must be regenerated: `getFilledApp` returns null for them.
