// Turns the live DOM into a compact list the LLM can reason about.
// Each interactive element gets a numeric ID; the agent refers to elements only
// by these IDs, and this registry maps them back to real DOM nodes.

import type { ElementId, ElementInfo, PageSnapshot, PageState, SnapshotItem } from "../shared/protocol";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=tab]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=combobox]",
  "[role=option]",
  "[role=textbox]",
  "[aria-haspopup]",
  "[onclick]",
  "[role=treeitem]",
  "[role=gridcell]",
  "[contenteditable=true]",
  "[contenteditable='']",
  "[tabindex='0']",
].join(",");

// Many apps (Gmail, Slack…) make plain <div>s clickable with JavaScript and give
// them no role. The only outside sign is the pointer cursor, so we use that too.
const POINTER_CANDIDATE_TAGS = new Set(["DIV", "SPAN", "LI", "TD", "TR", "IMG", "SVG", "IMAGE"]);

const DIALOG_SELECTOR = "dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]";

// Long pages: everything in an open dialog and on screen is always listed, plus the
// start and end of the page; the middle is collapsed into a "skipped" marker.
// find_element still searches every element, so nothing is unreachable.
const FULL_LIST_LIMIT = 120;
const HEAD_COUNT = 50;
const TAIL_COUNT = 25;
const MAX_TEXT_LENGTH = 80;
const MAX_OPTIONS = 25;
const MAX_TEXT_LINES = 20000;

// WeakMap so the same element keeps its ID across rescans within a page load.
const idByElement = new WeakMap<Element, ElementId>();
const elementById = new Map<ElementId, Element>();
// Apps like Gmail re-render constantly, replacing nodes with identical copies.
// Remembering each ID's fingerprint (tag + role + name) lets a replacement keep
// the old ID, and lets an action on a stale ID find the new node.
const fingerprintById = new Map<ElementId, string>();
const idByFingerprint = new Map<string, ElementId>();
// Fingerprints seen on more than one element at once (e.g. a "Delete" button on
// every row). Matching by fingerprint could pick the wrong row, so never do it.
const ambiguousFingerprints = new Set<string>();
let nextId = 1;

export const getElement = (id: ElementId): Element | null => {
  const element = elementById.get(id);
  if (element?.isConnected) return element;
  return relocate(id);
};

const relocate = (id: ElementId): Element | null => {
  const fingerprint = fingerprintById.get(id);
  if (!fingerprint || ambiguousFingerprints.has(fingerprint)) return null;
  const matches = scanInteractiveElements().filter((candidate) => fingerprintOf(candidate) === fingerprint);
  const replacement = matches.length === 1 ? matches[0] : undefined;
  if (!replacement) return null;
  bind(replacement, id);
  return replacement;
};

export const takeSnapshot = (): PageSnapshot => {
  const visible = scanInteractiveElements();
  // Elements inside an open dialog come first: that's where the user's attention is.
  const inDialog = visible.filter(isInOpenDialog).map(describeElement);
  const rest = collapseMiddle(visible.filter((element) => !isInOpenDialog(element)).map(describeElement));
  const items = [...inDialog, ...rest];
  const skippedElements = items.reduce((total, item) => total + ("skipped" in item ? item.skipped : 0), 0);
  return {
    url: location.href,
    title: document.title,
    headings: collectHeadings(),
    dialogs: openDialogNames(),
    items,
    totalElements: visible.length,
    skippedElements,
  };
};

const collapseMiddle = (elements: ElementInfo[]): SnapshotItem[] => {
  if (elements.length <= FULL_LIST_LIMIT) return elements;
  const isKept = (element: ElementInfo, index: number) =>
    index < HEAD_COUNT || index >= elements.length - TAIL_COUNT || element.inViewport;

  const items: SnapshotItem[] = [];
  elements.forEach((element, index) => {
    if (isKept(element, index)) {
      items.push(element);
      return;
    }
    const previous = items.at(-1);
    if (previous && "skipped" in previous) previous.skipped++;
    else items.push({ skipped: 1 });
  });
  return items;
};

export const getPageState = (): PageState => ({
  url: location.href,
  title: document.title,
  dialogs: openDialogNames(),
  textLines: pageTextLines(),
});

/**
 * All visible text on the page, one entry per non-empty line: paragraphs,
 * messages, plain URLs, prices… not just interactive elements. innerText
 * skips hidden elements and can't see into shadow roots, so we add those.
 */
export const pageTextLines = (): string[] => {
  const chunks = [document.body?.innerText ?? ""];
  collectShadowText(document, chunks);
  return chunks
    .flatMap((chunk) => chunk.split("\n"))
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, MAX_TEXT_LINES);
};

const collectShadowText = (root: Document | ShadowRoot, chunks: string[]): void => {
  for (const element of root.querySelectorAll("*")) {
    if (!element.shadowRoot) continue;
    for (const child of element.shadowRoot.children) {
      if (child instanceof HTMLElement && !["STYLE", "SCRIPT"].includes(child.tagName)) chunks.push(child.innerText);
    }
    collectShadowText(element.shadowRoot, chunks);
  }
};

export const describeById = (id: ElementId): ElementInfo | null => {
  const element = getElement(id);
  return element ? describeElement(element) : null;
};

/** Simple keyword ranking over names, placeholders, values and options. */
export const findElements = (query: string, limit = 5): ElementInfo[] => {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const phrase = words.join(" ");

  return scanInteractiveElements()
    .map((element) => {
      const info = describeElement(element);
      const haystack = normalize([info.text, info.placeholder, info.value, ...(info.options ?? [])].join(" "));
      let score = words.filter((word) => haystack.includes(word)).length;
      if (haystack.includes(phrase)) score += words.length;
      if (info.inDialog) score += 0.5;
      if (info.covered) score -= 1;
      return { info, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ info }) => info);
};

const scanInteractiveElements = (): Element[] => {
  const found: Element[] = [];
  collectCandidates(document, found);
  return found.filter(isVisible);
};

// Walks the whole tree in document order, including open shadow roots, which
// document.querySelectorAll can't see into (web components, some Google UIs).
const collectCandidates = (root: Document | ShadowRoot, found: Element[]): void => {
  for (const element of root.querySelectorAll("*")) {
    if (element.matches(INTERACTIVE_SELECTOR) || isPointerTarget(element)) found.push(element);
    if (element.shadowRoot) collectCandidates(element.shadowRoot, found);
  }
};

const isPointerTarget = (element: Element): boolean => {
  if (!POINTER_CANDIDATE_TAGS.has(element.tagName.toUpperCase())) return false;
  if (getComputedStyle(element).cursor !== "pointer") return false;
  // Only the outermost pointer element counts, not every child inside it.
  const parent = element.parentElement;
  if (parent && getComputedStyle(parent).cursor === "pointer") return false;
  if (element.parentElement?.closest(INTERACTIVE_SELECTOR)) return false;
  return accessibleName(element).trim() !== "";
};

const fingerprintOf = (element: Element): string =>
  [element.tagName, element.getAttribute("role") ?? "", truncate(accessibleName(element))].join("|");

const bind = (element: Element, id: ElementId): void => {
  idByElement.set(element, id);
  elementById.set(id, element);
};

const assignId = (element: Element): ElementId => {
  const existing = idByElement.get(element);
  if (existing !== undefined) return existing;

  const fingerprint = fingerprintOf(element);
  const previousId = idByFingerprint.get(fingerprint);
  if (previousId !== undefined) {
    if (elementById.get(previousId)?.isConnected) ambiguousFingerprints.add(fingerprint);
    else if (!ambiguousFingerprints.has(fingerprint)) {
      bind(element, previousId); // an identical element was re-rendered: keep its ID
      return previousId;
    }
  }

  const id = nextId++;
  bind(element, id);
  fingerprintById.set(id, fingerprint);
  idByFingerprint.set(fingerprint, id);
  return id;
};

const describeElement = (element: Element): ElementInfo => {
  const rect = element.getBoundingClientRect();
  const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
  return {
    id: assignId(element),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    text: truncate(accessibleName(element)),
    type: element.getAttribute("type"),
    href: element.getAttribute("href"),
    placeholder: element.getAttribute("placeholder"),
    value: currentValue(element),
    options: element instanceof HTMLSelectElement ? selectOptions(element) : null,
    checked: checkedState(element),
    expanded: booleanAttribute(element, "aria-expanded"),
    disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
    inViewport,
    inDialog: isInOpenDialog(element),
    covered: inViewport && isCovered(element),
    frame: null, // filled in by the controller, which knows which frame answered
  };
};

// The name a screen reader would announce. For form fields this is usually the
// <label>, which is what tells "Amount" apart from "Description".
const accessibleName = (element: Element): string => {
  const ariaLabel = element.getAttribute("aria-label") || element.getAttribute("data-tooltip");
  if (ariaLabel?.trim()) return ariaLabel;

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim()) return text;
  }

  if (isFormField(element)) {
    const labelText = Array.from(element.labels ?? [], (label) => label.innerText).join(" ");
    if (labelText.trim()) return labelText;
    if (element instanceof HTMLInputElement && ["submit", "button"].includes(element.type)) return element.value;
    return element.getAttribute("title") ?? element.getAttribute("name") ?? "";
  }

  const text = element instanceof HTMLElement ? element.innerText : element.textContent;
  if (text?.trim()) return text;
  return element.getAttribute("title") ?? element.querySelector("img")?.getAttribute("alt") ?? "";
};

const isFormField = (element: Element): element is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
  element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;

const currentValue = (element: Element): string | null => {
  if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.text.trim() ?? null;
  if (element instanceof HTMLInputElement) {
    if (["checkbox", "radio", "submit", "button", "reset", "file", "image"].includes(element.type)) return null;
    if (element.type === "password") return element.value ? "••••" : "";
    return truncate(element.value);
  }
  if (element instanceof HTMLTextAreaElement) return truncate(element.value);
  if (element instanceof HTMLElement && element.isContentEditable) return truncate(element.innerText);
  return null;
};

const selectOptions = (select: HTMLSelectElement): string[] =>
  Array.from(select.options)
    .slice(0, MAX_OPTIONS)
    .map((option) => option.text.trim());

const checkedState = (element: Element): boolean | null => {
  if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) return element.checked;
  return booleanAttribute(element, "aria-checked") ?? booleanAttribute(element, "aria-selected");
};

const booleanAttribute = (element: Element, name: string): boolean | null => {
  const value = element.getAttribute(name);
  return value === null ? null : value === "true";
};

const openDialogs = (): Element[] => Array.from(document.querySelectorAll(DIALOG_SELECTOR)).filter(isVisible);

const openDialogNames = (): string[] => openDialogs().map((dialog) => truncate(dialogName(dialog)) || "(untitled)");

const dialogName = (dialog: Element): string =>
  dialog.getAttribute("aria-label") ||
  document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent ||
  dialog.querySelector("h1, h2, h3, h4, legend")?.textContent ||
  "";

const isInOpenDialog = (element: Element): boolean => {
  const dialog = element.closest(DIALOG_SELECTOR);
  return dialog !== null && isVisible(dialog);
};

// Hit-test the element's center: if the topmost thing there is unrelated
// (e.g. a modal backdrop), a real user couldn't click it right now.
const isCovered = (element: Element): boolean => {
  const rect = element.getBoundingClientRect();
  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
  // Ask the element's own root: inside a shadow root, document.elementFromPoint
  // would only return the shadow host and make everything look covered.
  const root = element.getRootNode();
  const topmost = (root instanceof ShadowRoot ? root : document).elementFromPoint(x, y);
  if (!topmost) return false;
  return !element.contains(topmost) && !topmost.contains(element) && topmost.closest("label") === null;
};

const isVisible = (element: Element): boolean => {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
};

const collectHeadings = (): string[] =>
  Array.from(document.querySelectorAll("h1, h2, h3"))
    .filter(isVisible)
    .map((heading) => truncate(heading.textContent ?? ""))
    .filter(Boolean)
    .slice(0, 20);

const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const truncate = (text: string): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_TEXT_LENGTH ? `${clean.slice(0, MAX_TEXT_LENGTH)}…` : clean;
};
