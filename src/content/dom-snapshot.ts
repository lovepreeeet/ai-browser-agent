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
  "[contenteditable=true]",
  "[contenteditable='']",
].join(",");

const DIALOG_SELECTOR = "dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]";

// Long pages: everything in an open dialog and on screen is always listed, plus the
// start and end of the page; the middle is collapsed into a "skipped" marker.
// find_element still searches every element, so nothing is unreachable.
const FULL_LIST_LIMIT = 120;
const HEAD_COUNT = 50;
const TAIL_COUNT = 25;
const MAX_TEXT_LENGTH = 80;
const MAX_OPTIONS = 25;
const MAX_TEXT_LINES = 3000;

// WeakMap so the same element keeps its ID across rescans within a page load.
const idByElement = new WeakMap<Element, ElementId>();
const elementById = new Map<ElementId, Element>();
let nextId = 1;

export const getElement = (id: ElementId): Element | null => {
  const element = elementById.get(id);
  if (!element || !element.isConnected) return null;
  return element;
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
  textLines: document.body.innerText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_TEXT_LINES),
});

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

const scanInteractiveElements = (): Element[] =>
  Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isVisible);

const assignId = (element: Element): ElementId => {
  const existing = idByElement.get(element);
  if (existing !== undefined) return existing;
  const id = nextId++;
  idByElement.set(element, id);
  elementById.set(id, element);
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
  };
};

// The name a screen reader would announce. For form fields this is usually the
// <label>, which is what tells "Amount" apart from "Description".
const accessibleName = (element: Element): string => {
  const ariaLabel = element.getAttribute("aria-label");
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
  const topmost = document.elementFromPoint(x, y);
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
