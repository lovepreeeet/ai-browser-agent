// The tool registry: what the LLM is told it can do (schemas), and the single
// executeTool() function that actually does it. Every tool call from the model
// goes through executeTool, which is where the permission gate lives.

import type { BrowserController } from "../browser/controller";
import type { ElementInfo, PageSnapshot, PageState, SnapshotItem } from "../shared/protocol";
import { assessRisk, requiresApproval, type ApprovalMode, type Approver, type AskUser, type ToolKind } from "./permissions";

/** Provider-neutral tool description: plain JSON Schema for the parameters. */
export type ToolSchema = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type ToolDefinition = ToolSchema & { kind: ToolKind };

export type ToolContext = {
  browser: BrowserController;
  approve: Approver;
  askUser: AskUser;
  approvalMode: ApprovalMode;
};

const ELEMENT_ID = { type: "integer", description: "Element id from get_page_content or find_element" };
const REASON = { type: "string", description: "One short sentence for the user explaining why" };

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    kind: "observe",
    name: "get_page_content",
    description:
      "Returns the page URL, title, headings, open dialogs, and a numbered list of visible interactive elements " +
      "with their labels, current values, dropdown options and states, plus a short preview of the page text. " +
      "Use the numeric ids in other tools. To read the page's text itself, use read_page_text.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    kind: "observe",
    name: "find_element",
    description:
      "Searches visible interactive elements by label, placeholder, value or option text and returns up to 5 best matches.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Words to look for, e.g. 'claim offer'" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    kind: "observe",
    name: "read_page_text",
    description:
      "Reads the visible text of the page (paragraphs, messages, emails, prices, plain URLs, everything, not just " +
      "buttons and links), including embedded frames. Returns numbered lines, a chunk at a time. " +
      "With a query, returns only the lines containing those words plus the lines around them. " +
      "Use it whenever you need information from the page or have to find text that isn't an interactive element.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for; empty string to read in order" },
        start_line: { type: "integer", description: "Line number to start reading from (1 for the top)" },
      },
      required: ["query", "start_line"],
      additionalProperties: false,
    },
  },
  {
    kind: "observe",
    name: "highlight_element",
    description: "Visually highlights an element on the page so the user can see it. Does not change the page.",
    parameters: {
      type: "object",
      properties: { element_id: ELEMENT_ID, label: { type: "string", description: "Short label shown above the highlight" } },
      required: ["element_id", "label"],
      additionalProperties: false,
    },
  },
  {
    kind: "act",
    name: "click_element",
    description:
      "Clicks an element. The extension may ask the user for permission first. " +
      "The result reports what changed on the page (navigation, dialogs opened/closed, element state).",
    parameters: {
      type: "object",
      properties: { element_id: ELEMENT_ID, reason: REASON },
      required: ["element_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    kind: "act",
    name: "type_text",
    description:
      "Replaces the content of a text field (input, textarea or rich-text editor) with the given text. " +
      "Set submit to true to press Enter afterwards (to send a message, run a search, submit a single-field form). " +
      "No need to click the field first. The result reports what the field contains afterwards.",
    parameters: {
      type: "object",
      properties: {
        element_id: ELEMENT_ID,
        text: { type: "string", description: "The exact text to type" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        reason: REASON,
      },
      required: ["element_id", "text", "submit", "reason"],
      additionalProperties: false,
    },
  },
  {
    kind: "act",
    name: "select_option",
    description:
      "Chooses an option in a native <select> dropdown (elements listed with options=[...]). " +
      "For custom dropdowns (role=combobox, aria-haspopup), click the dropdown, then click the option.",
    parameters: {
      type: "object",
      properties: {
        element_id: ELEMENT_ID,
        option: { type: "string", description: "The option's visible text, as listed in options=[...]" },
        reason: REASON,
      },
      required: ["element_id", "option", "reason"],
      additionalProperties: false,
    },
  },
  {
    kind: "ask",
    name: "ask_user",
    description:
      "Asks the user a question and waits for the answer. Use it when the request is ambiguous or information is " +
      "missing (which item, which value, dropdown vs. text field…) instead of guessing. Offer short choices when possible.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "A short, specific question" },
        choices: { type: "array", items: { type: "string" }, description: "2-5 suggested answers; may be empty" },
      },
      required: ["question", "choices"],
      additionalProperties: false,
    },
  },
];

/** The schemas sent to the LLM (our private `kind` field is stripped). */
export const toolSchemas: ToolSchema[] = TOOL_DEFINITIONS.map(({ kind: _kind, ...schema }) => schema);

/**
 * `content` goes to the model; `notice` (optional) is shown to the user;
 * `action` names a page action that was actually performed, for stuck detection;
 * `autoApproved` is set when that action ran without asking (auto mode).
 */
export type ToolResult = { content: string; isError: boolean; notice?: string; action?: string; autoApproved?: boolean };

type ToolOutput = string | { content: string; notice?: string; action?: string; autoApproved?: boolean };

export const executeTool = async (
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> => {
  try {
    const output = await runTool(name, input, context);
    return typeof output === "string" ? { content: output, isError: false } : { ...output, isError: false };
  } catch (error) {
    return { content: error instanceof Error ? error.message : String(error), isError: true };
  }
};

const DECLINED = "The user DECLINED this action. Do not retry it; use ask_user or stop.";

// How long to let the page react (animations, network, re-render) before
// checking what an action changed.
const SETTLE_MS = 800;

const runTool = async (name: string, input: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> => {
  const { browser } = context;
  switch (name) {
    case "get_page_content": {
      const [snapshot, textLines] = await Promise.all([browser.snapshot(), browser.readText()]);
      const content = `${formatSnapshot(snapshot)}\n${formatTextPreview(textLines)}`;
      if (snapshot.skippedElements === 0) return content;
      const shown = snapshot.totalElements - snapshot.skippedElements;
      return {
        content,
        notice: `Long page: the agent sees ${shown} of ${snapshot.totalElements} elements (the middle part was skipped). Ask it to search for something specific if you need it.`,
      };
    }

    case "read_page_text": {
      const lines = await browser.readText();
      const query = readString(input, "query").trim();
      if (query) return searchText(lines, query);
      return readTextChunk(lines, readInteger(input, "start_line"));
    }

    case "find_element": {
      const matches = await browser.find(readString(input, "query"));
      return matches.length ? matches.map(formatElement).join("\n") : "No matching elements.";
    }

    case "highlight_element": {
      await browser.highlight(readInteger(input, "element_id"), readString(input, "label"));
      return "Highlighted.";
    }

    case "click_element": {
      const element = await requireElement(browser, readInteger(input, "element_id"));
      const before = await browser.pageState();
      if (element.covered && !element.inDialog && before.dialogs.length > 0) {
        throw new Error(
          `[${element.id}] is behind the open dialog ${before.dialogs.map(quote).join(", ")}. ` +
            "Work inside the dialog (it may already be what you need) or close it first.",
        );
      }
      const summary = `Click ${element.tag} "${element.text}"`;
      const decision = await askPermission(context, element, summary, readString(input, "reason"));
      if (decision === "declined") return DECLINED;
      await browser.click(element.id);
      return {
        content: `Clicked ${formatElement(element)}. ${await describeChanges(browser, before, element.id)}`,
        action: summary,
        autoApproved: decision === "auto",
      };
    }

    case "type_text": {
      const element = await requireElement(browser, readInteger(input, "element_id"));
      const text = readString(input, "text");
      const submit = readBoolean(input, "submit");
      const summary = `Type "${text}" into "${fieldName(element)}"${submit ? " and press Enter" : ""}`;
      const decision = await askPermission(context, element, summary, readString(input, "reason"));
      if (decision === "declined") return DECLINED;
      const before = await browser.pageState();
      await browser.type(element.id, text, submit);
      const changes = await describeChanges(browser, before, element.id);
      const hint = submit ? await submitHint(browser, element.id, text) : "";
      return {
        content: `Typed "${text}"${submit ? " and pressed Enter" : ""}. ${changes}${hint}`,
        action: summary,
        autoApproved: decision === "auto",
      };
    }

    case "select_option": {
      const element = await requireElement(browser, readInteger(input, "element_id"));
      const option = readString(input, "option");
      const summary = `Choose "${option}" in "${fieldName(element)}"`;
      const decision = await askPermission(context, element, summary, readString(input, "reason"));
      if (decision === "declined") return DECLINED;
      const before = await browser.pageState();
      const selected = await browser.select(element.id, option);
      return {
        content: `Selected "${selected}". ${await describeChanges(browser, before, element.id)}`,
        action: summary,
        autoApproved: decision === "auto",
      };
    }

    case "ask_user": {
      const answer = await context.askUser(readString(input, "question"), readStringArray(input, "choices"));
      return answer === null ? "The user dismissed the question. Stop and summarize what was done." : `The user answered: ${answer}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
};

const requireElement = async (browser: BrowserController, elementId: number): Promise<ElementInfo> => {
  const element = await browser.describe(elementId);
  if (!element) throw new Error(`Element ${elementId} no longer exists. Call get_page_content again.`);
  return element;
};

type Decision = "approved" | "auto" | "declined";

// How long an auto-approved target stays highlighted, so you can see what's happening.
const AUTO_HIGHLIGHT_MS = 600;

/**
 * The permission gate for every page-changing action: decide the risk from the
 * real element and the user's approval mode. If approval is needed, highlight
 * the element and ask; otherwise flash the highlight and go ahead.
 */
const askPermission = async (
  { browser, approve, approvalMode }: ToolContext,
  element: ElementInfo,
  summary: string,
  reason: string,
): Promise<Decision> => {
  const risk = assessRisk("act", element);
  if (!requiresApproval(risk, approvalMode)) {
    await browser.highlight(element.id, "Auto-approved").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, AUTO_HIGHLIGHT_MS));
    await browser.clearHighlight();
    return "auto";
  }
  await browser.highlight(element.id, risk === "high" ? "⚠ Needs approval" : "Needs approval");
  try {
    return (await approve({ summary, reason, risk, element })) ? "approved" : "declined";
  } finally {
    await browser.clearHighlight();
  }
};

/**
 * Tells the agent what an action actually did. Without this the model has to
 * assume success. With it, it can notice "the dialog is still open" or "my text
 * is still in the box" and react.
 */
const describeChanges = async (browser: BrowserController, before: PageState, elementId: number): Promise<string> => {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const after = await browser.pageState().catch(() => null);
  if (!after) return "Could not read the page afterwards; call get_page_content.";
  if (after.url !== before.url) return `The page navigated to ${after.url}; element ids changed, call get_page_content.`;

  const notes: string[] = [];
  const opened = after.dialogs.filter((dialog) => !before.dialogs.includes(dialog));
  const closed = before.dialogs.filter((dialog) => !after.dialogs.includes(dialog));
  if (opened.length) notes.push(`Dialog opened: ${opened.map(quote).join(", ")}.`);
  if (closed.length) notes.push(`Dialog closed: ${closed.map(quote).join(", ")}.`);
  if (after.title !== before.title) notes.push(`Title changed to ${quote(after.title)}.`);
  const newText = newLines(before.textLines, after.textLines);
  if (newText.length) notes.push(`New text on the page: ${newText.map(quote).join(", ")}.`);

  const element = await browser.describe(elementId).catch(() => null);
  if (!element) notes.push("The element is no longer on the page.");
  else {
    if (element.value !== null) notes.push(`The field now contains ${quote(element.value)}.`);
    if (element.expanded !== null) notes.push(element.expanded ? "It is now expanded." : "It is now collapsed.");
    if (element.checked !== null) notes.push(element.checked ? "It is now checked/selected." : "It is now unchecked.");
  }
  return notes.length ? notes.join(" ") : "No visible change detected (same URL, same dialogs).";
};

const TEXT_PREVIEW_LINES = 12;
const TEXT_CHUNK_LINES = 150;
const MAX_TEXT_LINE_LENGTH = 300;
const SEARCH_CONTEXT_LINES = 2;
const MAX_SEARCH_OUTPUT_LINES = 60;

const numbered = (lines: string[], start: number): string[] =>
  lines.map((line, index) => `${start + index}: ${line.length > MAX_TEXT_LINE_LENGTH ? `${line.slice(0, MAX_TEXT_LINE_LENGTH)}…` : line}`);

const formatTextPreview = (lines: string[]): string =>
  lines.length === 0
    ? "Page text: (none)"
    : [
        `Page text: ${lines.length} lines. First ${Math.min(TEXT_PREVIEW_LINES, lines.length)} shown; use read_page_text for the rest:`,
        ...numbered(lines.slice(0, TEXT_PREVIEW_LINES), 1),
      ].join("\n");

// Reads the page text a chunk at a time, like scrolling, and says where the next chunk starts.
const readTextChunk = (lines: string[], requestedStart: number): ToolOutput => {
  if (lines.length === 0) return "The page has no visible text.";
  const start = Math.min(Math.max(requestedStart, 1), lines.length);
  const end = Math.min(start + TEXT_CHUNK_LINES - 1, lines.length);
  const content = [`Page text, lines ${start}-${end} of ${lines.length}:`, ...numbered(lines.slice(start - 1, end), start)];
  if (end >= lines.length) return [...content, "(end of page text)"].join("\n");
  return {
    content: [...content, `More text below: call read_page_text with start_line=${end + 1}.`].join("\n"),
    notice: `Long page text: the agent read lines ${start}-${end} of ${lines.length}. Ask it to read further or search for something specific.`,
  };
};

// Finds lines containing the query words and returns them with nearby lines for context.
const searchText = (lines: string[], query: string): string => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = lines.map((line) => line.toLowerCase());
  let hits = lower.flatMap((line, index) => (words.every((word) => line.includes(word)) ? [index] : []));
  let note = "";
  if (hits.length === 0) {
    hits = lower.flatMap((line, index) => (words.some((word) => line.includes(word)) ? [index] : []));
    note = " (no line has all the words; showing lines with any of them)";
  }
  if (hits.length === 0) return `No text on the page matches "${query}". Try other words, or read the page with read_page_text.`;

  const shown = new Set<number>();
  for (const hit of hits) {
    for (let index = hit - SEARCH_CONTEXT_LINES; index <= hit + SEARCH_CONTEXT_LINES; index++) {
      if (index >= 0 && index < lines.length) shown.add(index);
    }
  }
  const ordered = [...shown].sort((a, b) => a - b).slice(0, MAX_SEARCH_OUTPUT_LINES);
  const output: string[] = [`${hits.length} line(s) match "${query}"${note}, of ${lines.length} lines in total:`];
  ordered.forEach((index, position) => {
    if (position > 0 && index !== (ordered[position - 1] ?? index) + 1) output.push("…");
    output.push(...numbered([lines[index] ?? ""], index + 1));
  });
  if (shown.size > ordered.length) output.push("(more matches not shown; use a more specific query)");
  return output.join("\n");
};

const MAX_NEW_LINES = 5;
const MAX_LINE_LENGTH = 120;

// Text that appeared after the action: success messages, errors, toasts, new list items.
const newLines = (before: string[], after: string[]): string[] => {
  const seen = new Set(before);
  return after
    .filter((line) => !seen.has(line))
    .slice(0, MAX_NEW_LINES)
    .map((line) => (line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line));
};

const submitHint = async (browser: BrowserController, elementId: number, text: string): Promise<string> => {
  const element = await browser.describe(elementId).catch(() => null);
  if (element?.value && element.value.includes(text.slice(0, 20))) {
    return " The text is still in the field, so Enter probably did not submit it: click the send/submit button next to it.";
  }
  return "";
};

// Compact, line-per-element text costs far fewer tokens than JSON
// and is easy for the model (and you) to read.
const formatSnapshot = (snapshot: PageSnapshot): string =>
  [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Headings: ${snapshot.headings.join(" | ") || "(none)"}`,
    snapshot.dialogs.length
      ? `OPEN DIALOG: ${snapshot.dialogs.map(quote).join(", ")}. Work inside it; elements marked (covered) are behind it.`
      : "Open dialogs: none",
    snapshot.skippedElements
      ? `LONG PAGE: ${snapshot.totalElements} elements; ${snapshot.skippedElements} in the middle were skipped. ` +
        "Use find_element to search them."
      : `Elements: ${snapshot.totalElements}`,
    "Interactive elements:",
    ...snapshot.items.map(formatItem),
  ].join("\n");

const formatItem = (item: SnapshotItem): string =>
  "skipped" in item ? `… ${item.skipped} elements skipped here (middle of the page) …` : formatElement(item);

const formatElement = (element: ElementInfo): string => {
  const kind = element.type ? `${element.tag}[type=${element.type}]` : element.role ? `${element.tag}[role=${element.role}]` : element.tag;
  const parts = [`[${element.id}] ${kind} ${quote(element.text)}`];
  if (element.placeholder) parts.push(`placeholder=${quote(element.placeholder)}`);
  if (element.value !== null) parts.push(`value=${quote(element.value)}`);
  if (element.options) parts.push(`options=[${element.options.join(" | ")}]`);
  if (element.checked !== null) parts.push(element.checked ? "(checked)" : "(unchecked)");
  if (element.expanded !== null) parts.push(element.expanded ? "(expanded)" : "(collapsed)");
  if (element.href) parts.push(`-> ${element.href}`);
  if (element.frame) parts.push(`(in frame ${element.frame})`);
  if (element.inDialog) parts.push("(in dialog)");
  if (element.covered) parts.push("(covered)");
  if (element.disabled) parts.push("(disabled)");
  if (!element.inViewport) parts.push("(off-screen)");
  return parts.join(" ");
};

const fieldName = (element: ElementInfo): string => element.text || element.placeholder || element.tag;

const quote = (text: string): string => `"${text}"`;

// Tool inputs come from the model, so check them like any external input.
const readString = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Expected "${key}" to be a string.`);
  return value;
};

const readStringArray = (input: Record<string, unknown>, key: string): string[] => {
  const value = input[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Expected "${key}" to be a list of strings.`);
  }
  return value;
};

const readBoolean = (input: Record<string, unknown>, key: string): boolean => {
  const value = input[key];
  if (typeof value !== "boolean") throw new Error(`Expected "${key}" to be true or false.`);
  return value;
};

const readInteger = (input: Record<string, unknown>, key: string): number => {
  const value = input[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Expected "${key}" to be an integer.`);
  return value;
};
