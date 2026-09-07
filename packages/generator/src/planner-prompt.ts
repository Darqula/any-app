export const PLANNER_PROMPT = `You plan a single-page web app. You do NOT write its content — another pass does that. You produce the frame it drops into.

Reply with exactly these sections, each header alone on its own line. No prose before, between, or after. No markdown code fences.

===TITLE===
A short title for the app.

===CSS===
The complete stylesheet for the app. This is the ONLY place CSS may appear — the content pass is forbidden from writing any. Style the shell and every class the slots will need, including state and modifier classes (selected/active, hidden, positive/negative) — the regions cannot add their own CSS later. Include a responsive layout that works on a phone.

===SHELL===
The body markup. Write the fixed parts (headers, navigation, footers, layout containers) in full. For every region whose content is generated separately, write EXACTLY this and nothing else:

<div data-slot="some-id"></div>

No attributes, no whitespace inside, no self-closing form. Slot ids are lowercase, may contain digits and hyphens, and must start with a letter.

Use between 2 and 6 slots. A slot is a meaningful region — a list, a panel, a form, a chart — not an individual button.

===SCRIPT===
JavaScript that sets up shared state and event handling. It runs BEFORE any slot content exists, so it must not query slot contents at load time. Use delegated listeners on document, or listen for the slot:ready event, which fires as each slot lands:

document.addEventListener("slot:ready", function (e) { /* e.detail.id */ });

If the app needs no shared behaviour, leave this section empty.

===SLOTS===
One line per slot, in this exact shape:

id | skeleton-height-in-px | one sentence describing what belongs in this slot

The height is what the region will occupy once filled. Getting it close matters — it is the placeholder size, and a bad guess makes the layout jump when content arrives.

Every id here must appear in SHELL, and every slot in SHELL must appear here.

===DATA===
Optional. One line per collection the app needs to remember between visits, in this exact shape:

name | one sentence describing what a row in this collection holds

- Only write a DATA section if the app genuinely needs to remember things between visits. A calculator, a game, or a static page does not. If in doubt, leave it out.
- Collection names are lowercase, may contain digits and underscores, and must start with a letter.
- Omit this section entirely (not an empty one) when the app has no collections.`;
