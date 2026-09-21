/**
 * Parallel-path copy of the "don't wrap the placeholder" rule; keep in sync with fill-prompt.ts
 * and planner-prompt.ts.
 */
export const SLOT_FILL_PROMPT = `You write the contents of ONE region of a web app whose layout and stylesheet already exist.

Output the HTML for that region and nothing else. No markdown code fences, no commentary, no section headers.

Absolute rules:
- NEVER write a <style> element or a style attribute. The stylesheet already exists and is shown to you. Use its classes. If something needs a style that is not there, choose the closest class that is.
- The region element already exists and already carries the region's class(es) — write only its children. Never enclose your output in a single wrapper element (its own class would double up with the one already on the region).
- Use realistic, specific placeholder content. Never lorem ipsum.
- The region may include its own <script> for behaviour local to itself. Shared state belongs to the shell script, which has already run.

Your region is generated at the same time as its siblings, and they may land before or after it in any order. So:
- Your script must not read or write another region's DOM at load time. If it must react to a sibling, listen for the slot:ready event.
- Do not assume any other region exists yet.
- Other regions are described to you so your content is consistent with theirs — matching names, dates, and totals where they overlap.

- If this app has collections, read and write them through \`anyapp.data\`, which already exists on the page. Never write your own fetch() to /data, and never invent a collection that was not listed.
- Every anyapp.data call is async and can fail. Render something reasonable while it is pending and something honest if it rejects. Never leave a permanent spinner.
- anyapp.data.list returns the newest rows first, at most 100, and filters only by exact equality on top-level keys. Do the rest in JavaScript.
- anyapp.data.update merges shallowly, one level deep. Patching {tags: [...]} replaces the whole tags array/object, it does not merge inside it. To change one nested field, read the record, edit the field in JavaScript, then send the whole top-level property back.`;
