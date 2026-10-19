// The contract between the side panel (controller) and the content script.
// The content script handles ONLY these commands — there is no "run this code"
// message, so nothing the LLM says can become JavaScript on the page.

export type ElementId = number;

/** What the agent is allowed to know about one interactive element. */
export type ElementInfo = {
  id: ElementId;
  tag: string;
  role: string | null;
  /** Accessible name: aria-label, <label> text, or visible text. */
  text: string;
  type: string | null;
  href: string | null;
  placeholder: string | null;
  /** Current value of a field (passwords are masked), or selected option of a dropdown. */
  value: string | null;
  /** Option labels of a <select>. */
  options: string[] | null;
  checked: boolean | null;
  expanded: boolean | null;
  disabled: boolean;
  inViewport: boolean;
  /** Inside the currently open dialog/popup. */
  inDialog: boolean;
  /** Something else (e.g. a popup overlay) is on top of it, so it can't be clicked right now. */
  covered: boolean;
};

/** Stands in for a run of elements left out of a long page's list. */
export type SkippedRun = { skipped: number };

export type SnapshotItem = ElementInfo | SkippedRun;

export type PageSnapshot = {
  url: string;
  title: string;
  headings: string[];
  /** Names of open dialogs/popups. */
  dialogs: string[];
  /** Elements in display order, with SkippedRun markers where the middle of a long page was left out. */
  items: SnapshotItem[];
  totalElements: number;
  skippedElements: number;
};

/** A cheap summary used to detect what an action changed. */
export type PageState = {
  url: string;
  title: string;
  dialogs: string[];
  /** Visible text, one entry per line, to spot messages that appear after an action. */
  textLines: string[];
};

export type ContentCommand =
  | { type: "ping" }
  | { type: "snapshot" }
  | { type: "pageState" }
  | { type: "find"; query: string }
  | { type: "describe"; id: ElementId }
  | { type: "highlight"; id: ElementId; label: string }
  | { type: "clearHighlight" }
  | { type: "click"; id: ElementId }
  | { type: "type"; id: ElementId; text: string; submit: boolean }
  | { type: "select"; id: ElementId; option: string };

export type ContentResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };
