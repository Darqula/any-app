/**
 * Tokens and base rules shared by every studio page. Dark follows the OS via prefers-color-scheme (no toggle,
 * nothing stored). Component rules use tokens, not hex values. The generated-app iframe is not themed.
 */
export const THEME_CSS = `
  :root {
    color-scheme: light dark;
    --bg: #f7f8fa;
    --panel: #ffffff;
    --border: #e5e8ee;
    --text: #1a202c;
    --muted: #64707f;
    --faint: #9aa3b2;
    --accent: #3b5bdb;
    --accent-hover: #3450c4;
    --accent-fg: #ffffff;
    --accent-soft: #eef1fd;
    --hover: #f1f3f8;
    --input-bg: #fcfcfd;
    --input-focus-bg: #ffffff;
    --focus-ring: rgba(59, 91, 219, .16);
    --btn-disabled: #b9c4e8;
    --ok: #0a7d2c;
    --bad: #b00020;
    --danger-fg: #ffffff;
    --warn-bg: #fff8e6;
    --warn-text: #7a5b00;
    --warn-border: #f3e3ad;
    --pill-border: #d6defb;
    --status-complete-bg: #e6f6ec;
    --status-complete-fg: #0a7d2c;
    --status-streaming-bg: #eef1fd;
    --status-streaming-fg: #3b5bdb;
    --status-pending-bg: #e3e7ef;
    --status-pending-fg: #64707f;
    --status-failed-bg: #fdeaea;
    --status-failed-fg: #b00020;
    --toast-ok-bg: #12321f;
    --toast-ok-fg: #b8f0cb;
    --toast-bad-bg: #3a1116;
    --toast-bad-fg: #ffc2c7;
    --shadow: 0 8px 24px rgba(26, 32, 44, .18);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --border: #262b36;
      --text: #e6e9ef;
      --muted: #9aa3b2;
      --faint: #6b7385;
      --accent: #7c93f5;
      --accent-hover: #93a6f8;
      --accent-fg: #0f1115;
      --accent-soft: rgba(124, 147, 245, .14);
      --hover: #1e222b;
      --input-bg: #12151b;
      --input-focus-bg: #12151b;
      --focus-ring: rgba(124, 147, 245, .28);
      --btn-disabled: #3a4258;
      --ok: #5fd18a;
      --bad: #ff8a94;
      --danger-fg: #1a0a0c;
      --warn-bg: #2a2413;
      --warn-text: #f1d48a;
      --warn-border: #4a3f1c;
      --pill-border: rgba(124, 147, 245, .35);
      --status-complete-bg: rgba(95, 209, 138, .14);
      --status-complete-fg: #5fd18a;
      --status-streaming-bg: rgba(124, 147, 245, .16);
      --status-streaming-fg: #9db0fa;
      --status-pending-bg: #2a2f3b;
      --status-pending-fg: #9aa3b2;
      --status-failed-bg: rgba(255, 138, 148, .14);
      --status-failed-fg: #ff8a94;
      --toast-ok-bg: #1b4a2e;
      --toast-ok-fg: #c8f6d7;
      --toast-bad-bg: #5a1a22;
      --toast-bad-fg: #ffd0d4;
      --shadow: 0 8px 24px rgba(0, 0, 0, .5);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Inter", "Segoe UI", system-ui, sans-serif;
    font-size: 14px; line-height: 1.5;
    background: var(--bg); color: var(--text);
  }
  button { font: inherit; cursor: pointer; }
  a { color: var(--accent); text-decoration: none; }
  code {
    font-size: .92em; padding: 1px 5px; border-radius: 5px;
    background: var(--hover); color: var(--text);
  }
  input, select, textarea {
    font: inherit; color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--border); border-radius: 10px;
    padding: 8px 12px;
    transition: border-color .15s, box-shadow .15s;
  }
  input:focus, select:focus, textarea:focus {
    outline: 0; border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--focus-ring); background: var(--input-focus-bg);
  }
  ::placeholder { color: var(--faint); }
  .btn-accent, .newapp {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--accent); color: var(--accent-fg);
    border: 0; border-radius: 8px; padding: 4px 10px;
    font-size: 12px; font-weight: 600;
  }
  .btn-accent:hover, .newapp:hover { background: var(--accent-hover); }
  .hint { font-size: 12px; color: var(--muted); margin: 0; }
  .edit-ok { color: var(--ok); margin: 0; }
  .edit-problem, .problem { color: var(--bad); margin: 0; }
  .empty, .placeholder { color: var(--faint); }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; color: var(--text); }
  .brand-mark {
    width: 24px; height: 24px; border-radius: 7px; flex: none;
    background: linear-gradient(135deg, #3b5bdb, #7048e8);
  }
`;
