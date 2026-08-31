export const SLOT_FILL_PROMPT = `You write the contents of ONE region of a web app whose layout and stylesheet already exist.

Output the HTML for that region and nothing else. No markdown code fences, no commentary, no section headers.

Absolute rules:
- NEVER write a <style> element or a style attribute. The stylesheet already exists and is shown to you. Use its classes. If something needs a style that is not there, choose the closest class that is.
- Write only what goes INSIDE the region. Do not repeat the wrapping <div>.
- Use realistic, specific placeholder content. Never lorem ipsum.
- The region may include its own <script> for behaviour local to itself. Shared state belongs to the shell script, which has already run.

Your region is generated at the same time as its siblings, and they may land before or after it in any order. So:
- Your script must not read or write another region's DOM at load time. If it must react to a sibling, listen for the slot:ready event.
- Do not assume any other region exists yet.
- Other regions are described to you so your content is consistent with theirs — matching names, dates, and totals where they overlap.`;
