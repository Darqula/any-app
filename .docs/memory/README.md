# Agent memory: incidents, findings and traps

Background for whoever works on this repo next; **not for developers reading the source**. Code comments are short
and self-contained and never point here. These files hold what a comment cannot: incidents with numbers and dates,
measurements, rejected designs, and traps that span several files. Each states the *why* behind guarded behaviour,
so read the matching file before changing it, and add to it when a fix or a live finding teaches something
non-obvious (keep the essential why in a short comment as well).

Locked decisions (`architecture.md`), open issues (`open-problems.md`) and the case
lists (`tests-backend.md`, `tests-frontend.md`, `tests/README.md`) stay where they are; these notes complement them.
Content that a short comment or the code already states is deliberately not repeated here.

| File | Covers |
| --- | --- |
| [`document-model.md`](document-model.md) | tolerant placeholder scan, `sanitizePlaceholders`, the `.hidden` fallback and its rejected designs |
| [`runtime-in-generated-apps.md`](runtime-in-generated-apps.md) | exactly-once slot scripts, `slot:ready`, the token placeholder |
| [`security.md`](security.md) | view grants, app tokens, cookies/sessions, the cross-site request guard, the sharing posture |
| [`providers.md`](providers.md) | gateway session header, cache layout and zero-cache-read causes, abort and truncation incidents, usage ordering, Anthropic adapter don'ts |
| [`generation-pipeline.md`](generation-pipeline.md) | `parsePlan`, the S13 prompt contract and probe history, parallel-fill findings, design choices not to reverse |
| [`editing.md`](editing.md) | router history, edit-prompt guards, the no-op guard, edit activity and conversation log |
| [`data-api.md`](data-api.md) | why `records` is separate, microsecond cursor incident, query-parser trap, sandbox error handling |
| [`studio-server.md`](studio-server.md) | stream-route incidents (owner from the row, persist-before-end), planner-failure capture, serving-path traps, what is deliberately not built |
| [`studio-ui.md`](studio-ui.md) | template-literal and htmx traps, out-of-band composition, live sidebar, dialogs |
| [`testing-harness.md`](testing-harness.md) | scratch-database, process, port and fake-provider traps |
| [`test-case-notes.md`](test-case-notes.md) | suite traps, verified-by-breaking cases, flake history |
| [`model-and-sweep-history.md`](model-and-sweep-history.md) | resolved provider/model investigations and the quality sweeps, with their numbers |
| [`quality-harness.md`](quality-harness.md) | the paid section-F sweep, check semantics, the S13 probe and its misread |
