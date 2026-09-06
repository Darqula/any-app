/**
 * The fixed set of prompts driven by the section-F quality sweep (`.docs/tests-backend.md`
 * F1-F8, `.docs/tests-frontend.md` F1-F9). Fixed on purpose — comparing pass rates over time
 * (or between fill modes) only means something if the prompts are held constant. Add a new
 * prompt only with a deliberate reason, never to chase a rate up.
 *
 * Each prompt is tagged so `checks-rendered.ts` knows which frontend checks apply to it:
 *   - "interactive": F8 ("state visibly changes on interaction") is meaningful here. Left off
 *     prompts where "click things and see if the text changed" would be a coin flip rather
 *     than a real signal (a pure content/reading app has no state to change).
 *   - "form": exercises F4 (click-everything) against real input+submit flows, not just
 *     buttons/links.
 *   - "data": expected to produce a DATA section / collections, so it also exercises the
 *     data-runtime inlining (`renderShellHead`) as a side effect, even though this sweep does
 *     not assert on the data API itself (that is backend section K, already covered).
 *   - "dense": deliberately asks for enough simultaneous content that F2/F3 (no horizontal
 *     overflow at 375px / 1440px) have something to actually catch — a single-card app can't
 *     overflow no matter how broken the CSS is.
 *
 * Ten prompts, chosen so the set as a whole exercises every F case at least once:
 *   F4 (click everything)   -> every prompt has buttons or links
 *   F8 (interactive)        -> counter, timer, todo, expense-tracker, kanban (5 tagged)
 *   forms                   -> contact-form, todo, expense-tracker, weather (4 tagged)
 *   list/data-shaped        -> todo, notes, expense-tracker, recipe-browser, kanban (5 tagged)
 *   visually dense (F2/F3)  -> dashboard, recipe-browser, kanban (3 tagged)
 */

export interface QualityPrompt {
  /** Short, filesystem-safe id — used for artifact filenames and report rows. */
  id: string;
  /** The literal prompt text sent as `POST /generations`'s `prompt` field. */
  prompt: string;
  tags: string[];
}

export const QUALITY_PROMPTS: QualityPrompt[] = [
  {
    id: "counter",
    prompt:
      "A simple counter app: a big number in the middle, plus and minus buttons, and a reset button.",
    tags: ["interactive"],
  },
  {
    id: "todo-list",
    prompt:
      "A to-do list app: a text input and add button, a list of tasks each with a checkbox to mark complete and a delete button, and a count of remaining tasks.",
    tags: ["interactive", "form", "data"],
  },
  {
    id: "pomodoro-timer",
    prompt:
      "A pomodoro-style focus timer: a countdown display, start/pause/reset buttons, and a way to switch between a 25-minute focus session and a 5-minute break.",
    tags: ["interactive"],
  },
  {
    id: "contact-form",
    prompt:
      "A contact form for a small design studio: name, email, and message fields, a submit button, and a confirmation message shown after submitting.",
    tags: ["form"],
  },
  {
    id: "recipe-browser",
    prompt:
      "A recipe browser: a grid of at least eight recipe cards with a title, short description, and prep time, plus a search box that filters the grid by title.",
    tags: ["data", "dense"],
  },
  {
    id: "analytics-dashboard",
    prompt:
      "An analytics dashboard for a small online store: several stat cards (revenue, orders, visitors, conversion rate), a recent-orders table, and a simple bar or line chart drawn with plain HTML/CSS or a cdnjs.cloudflare.com library.",
    tags: ["dense"],
  },
  {
    id: "notes-app",
    prompt:
      "A note-taking app: a list of saved notes in a sidebar, a main area to write and edit the selected note, and buttons to create a new note and delete the current one. Notes must still be there after a page reload.",
    tags: ["data"],
  },
  {
    id: "expense-tracker",
    prompt:
      "A personal expense tracker: a form to add an expense with a description, amount, and category, a list of logged expenses, and a running total. Expenses must still be there after a page reload.",
    tags: ["interactive", "form", "data"],
  },
  {
    id: "weather-widget",
    prompt:
      "A compact weather widget: a city search input, a current-conditions card (temperature, condition, icon or emoji), and a 5-day forecast strip. Use realistic-looking placeholder weather data since there is no live API available.",
    tags: ["form"],
  },
  {
    id: "kanban-board",
    prompt:
      "A kanban task board with three columns (To Do, In Progress, Done), several example cards in each column, a button to add a new card to the To Do column, and a way to move a card to the next column.",
    tags: ["interactive", "data", "dense"],
  },
];
