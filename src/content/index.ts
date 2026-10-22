// Content script entry: a small, fixed command handler living inside the page.
// It is injected on demand by the browser controller (see browser/controller.ts).

import type { ContentCommand, ContentResponse } from "../shared/protocol";
import { clearHighlight, highlightElement } from "./highlight";
import { describeById, findElements, getElement, getPageState, pageTextLines, takeSnapshot } from "./dom-snapshot";

declare global {
  interface Window {
    __aiAgentInstalled?: boolean;
  }
}

// Gives rich editors (ProseMirror, Lexical…) a moment to sync their state with the DOM.
const EDITOR_SETTLE_MS = 150;

const handleCommand = async (command: ContentCommand): Promise<ContentResponse> => {
  try {
    return { ok: true, data: await runCommand(command) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const runCommand = (command: ContentCommand): unknown | Promise<unknown> => {
  switch (command.type) {
    case "ping":
      return "pong";
    case "snapshot":
      return takeSnapshot();
    case "pageState":
      return getPageState();
    case "find":
      return findElements(command.query);
    case "describe":
      return describeById(command.id);
    case "highlight":
      highlightElement(requireElement(command.id), command.label);
      return null;
    case "clearHighlight":
      clearHighlight();
      return null;
    case "click":
      return clickElement(command.id);
    case "type":
      return typeText(command.id, command.text, command.submit);
    case "select":
      return selectOption(command.id, command.option);
    case "readText":
      return pageTextLines();
  }
};

const clickElement = (id: number): { clicked: true } => {
  const element = requireElement(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Element ${id} is not clickable`);
  if (element.matches(":disabled")) throw new Error(`Element ${id} is disabled`);
  clearHighlight();
  element.scrollIntoView({ block: "center", behavior: "instant" });
  element.click();
  return { clicked: true };
};

const typeText = async (id: number, text: string, submit: boolean): Promise<{ typed: true }> => {
  const element = requireElement(id);
  if (!isTextField(element)) throw new Error(`Element ${id} is not a text field. Pick an input, textarea or editable element.`);
  if (element.matches(":disabled") || element.matches(":read-only:not([contenteditable])")) {
    throw new Error(`Element ${id} is disabled or read-only`);
  }
  clearHighlight();
  element.scrollIntoView({ block: "center", behavior: "instant" });
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    setNativeValue(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    replaceEditableText(element, text);
  }
  if (submit) {
    await new Promise((resolve) => setTimeout(resolve, EDITOR_SETTLE_MS));
    pressEnter(element);
  }
  return { typed: true };
};

// Rich-text editors (e.g. ChatGPT's message box) keep their own document model
// and ignore direct textContent changes. Inserting through the browser's editing
// command fires the same beforeinput/input events as real typing.
const replaceEditableText = (element: HTMLElement, text: string): void => {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const inserted = document.execCommand("insertText", false, text);
  if (!inserted) {
    element.textContent = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
};

const selectOption = (id: number, option: string): { selected: string } => {
  const element = requireElement(id);
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`Element ${id} is not a <select>. For a custom dropdown, click it, then click the option.`);
  }
  const wanted = option.trim().toLowerCase();
  const options = Array.from(element.options);
  const match =
    options.find((candidate) => candidate.text.trim().toLowerCase() === wanted || candidate.value.toLowerCase() === wanted) ??
    options.find((candidate) => candidate.text.toLowerCase().includes(wanted));
  if (!match) {
    throw new Error(`No option "${option}". Available: ${options.map((candidate) => candidate.text.trim()).join(", ")}`);
  }
  clearHighlight();
  element.scrollIntoView({ block: "center", behavior: "instant" });
  setNativeValue(element, match.value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: match.text.trim() };
};

const TEXT_INPUT_TYPES = ["", "text", "search", "email", "url", "tel", "password", "number"];

const isTextField = (element: Element): element is HTMLElement =>
  (element instanceof HTMLInputElement && TEXT_INPUT_TYPES.includes(element.type)) ||
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLElement && element.isContentEditable);

// Frameworks like React track input values through the prototype's setter, so a
// plain `element.value = text` can be silently overwritten by their state.
const setNativeValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void => {
  const prototype = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
};

const pressEnter = (element: HTMLElement): void => {
  const init: KeyboardEventInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
  const notHandled = element.dispatchEvent(new KeyboardEvent("keydown", init));
  element.dispatchEvent(new KeyboardEvent("keypress", init));
  element.dispatchEvent(new KeyboardEvent("keyup", init));
  // Synthetic key events don't trigger the browser's built-in "Enter submits the
  // form", so do it ourselves unless the page's own key handler already did.
  const form = element.closest("form");
  if (notHandled && form) form.requestSubmit();
};

const requireElement = (id: number): Element => {
  const element = getElement(id);
  if (!element) throw new Error(`No element with id ${id}. It may have been removed; take a fresh page snapshot.`);
  return element;
};

// Injection can happen more than once on the same page; register only once.
if (!window.__aiAgentInstalled) {
  window.__aiAgentInstalled = true;
  chrome.runtime.onMessage.addListener((command: ContentCommand, _sender, sendResponse) => {
    handleCommand(command).then(sendResponse);
    return true; // keeps the message channel open for the async response
  });
}
