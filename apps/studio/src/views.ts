import type { Generation } from "@any-app/store";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function previewFrame(id: string, sandboxUrl: string): string {
  // allow-scripts WITHOUT allow-same-origin gives the frame an opaque origin, on top of
  // the fact that it is already served from a different host. Do not add
  // allow-same-origin — it would undo the sandbox attribute entirely.
  return `<iframe
    class="preview"
    src="${sandboxUrl}/preview/${escapeHtml(id)}"
    sandbox="allow-scripts allow-forms allow-popups"
    title="Generated app preview"></iframe>`;
}

export function generationList(generations: Generation[]): string {
  if (generations.length === 0) {
    return `<p class="empty">No apps yet. Describe one above.</p>`;
  }
  return generations
    .map(
      (g) => `<li>
        <button hx-get="/generations/${g.id}/frame"
                hx-target="#stage"
                hx-swap="innerHTML">${escapeHtml(g.prompt.slice(0, 80))}</button>
        <span class="status status-${g.status}">${g.status}</span>
      </li>`,
    )
    .join("");
}

export function homePage(generations: Generation[], sandboxUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>any-app studio</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/2.0.4/htmx.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; display: grid;
         grid-template-columns: 320px 1fr; height: 100vh; }
  aside { border-right: 1px solid #8883; padding: 16px; overflow-y: auto; }
  main { display: flex; flex-direction: column; }
  form { display: flex; gap: 8px; padding: 16px; border-bottom: 1px solid #8883; }
  textarea { flex: 1; min-height: 64px; font: inherit; padding: 8px; resize: vertical; }
  button { font: inherit; padding: 8px 14px; cursor: pointer; }
  #stage { flex: 1; display: flex; }
  .preview { flex: 1; border: 0; width: 100%; height: 100%; background: #fff; }
  .placeholder { margin: auto; opacity: .6; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { display: grid; gap: 2px; }
  li button { text-align: left; width: 100%; }
  .status { font-size: 12px; opacity: .7; }
  .status-failed { color: #b00020; }
  .empty { opacity: .6; }
</style>
</head>
<body>
  <aside>
    <h1>any-app</h1>
    <ul id="generation-list">${generationList(generations)}</ul>
  </aside>
  <main>
    <form hx-post="/generations" hx-target="#stage" hx-swap="innerHTML">
      <textarea name="prompt" placeholder="Describe the app you want…" required></textarea>
      <button type="submit">Generate</button>
    </form>
    <div id="stage"><p class="placeholder">Your app will appear here.</p></div>
  </main>
</body>
</html>`;
}
