/**
 * The fixed prompts of the section-F sweep. Fixed so pass rates stay comparable over time and between fill modes: add one only deliberately.
 * Tags choose the applicable rendered checks: interactive (F8), form (F4 with real inputs), data (collections), dense (F2/F3 overflow).
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
