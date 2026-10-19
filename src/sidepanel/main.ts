// Side panel UI: collects the instruction, shows what the agent is doing,
// and implements the Approver as an Approve/Deny card. It only talks to
// the agent through runAgent() and the AgentEvent stream, so M3 can add a
// voice front-end next to it without touching the agent.

import { createConversation, DEFAULT_MODEL, FREE_MODELS, runAgent, type AgentEvent } from "../agent/agent";
import type { ApprovalRequest, Approver, AskUser } from "../agent/permissions";

const API_KEY_STORAGE_KEY = "geminiApiKey";
const MODEL_STORAGE_KEY = "geminiModel";

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id} in sidepanel.html`);
  return element as T;
};

const log = byId<HTMLElement>("log");
const form = byId<HTMLFormElement>("command-form");
const instructionInput = byId<HTMLTextAreaElement>("instruction");
const runButton = byId<HTMLButtonElement>("run");
const apiKeyInput = byId<HTMLInputElement>("api-key");
const modelSelect = byId<HTMLSelectElement>("model");
const settings = byId<HTMLDetailsElement>("settings");
const approval = byId<HTMLElement>("approval");
const question = byId<HTMLElement>("question");
const newChatButton = byId<HTMLButtonElement>("new-chat");

// The agent remembers earlier requests in this panel until "New chat".
let conversation = createConversation();

const addEntry = (kind: string, text: string): HTMLElement => {
  const entry = document.createElement("div");
  entry.className = `entry ${kind}`;
  entry.textContent = text; // textContent, never innerHTML: page text must not become markup here
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
  return entry;
};

// One log line that counts down every second, then says it's retrying.
const showCountdown = (reason: string, seconds: number): void => {
  const entry = addEntry("status", "");
  let remaining = Math.ceil(seconds);
  const render = () => {
    entry.textContent = remaining > 0 ? `⏳ ${reason}; retrying in ${remaining}s…` : `⏳ ${reason}; retrying now…`;
  };
  render();
  const timer = setInterval(() => {
    remaining--;
    render();
    if (remaining <= 0) clearInterval(timer);
  }, 1000);
};

const showEvent = (event: AgentEvent): void => {
  switch (event.type) {
    case "status":
      addEntry("status", event.text);
      break;
    case "tool_call":
      addEntry("tool", `→ ${event.name}(${JSON.stringify(event.input)})`);
      break;
    case "tool_result":
      addEntry(event.isError ? "tool error" : "tool", `← ${firstLine(event.content)}`);
      break;
    case "reply":
      addEntry("reply", event.text);
      break;
    case "wait":
      showCountdown(event.reason, event.seconds);
      break;
  }
};

const firstLine = (text: string): string => {
  const lines = text.split("\n");
  return lines.length > 1 ? `${lines[0]} … (+${lines.length - 1} lines)` : text;
};

const askForApproval: Approver = (request: ApprovalRequest) =>
  new Promise((resolve) => {
    const badge = byId("approval-risk");
    badge.textContent = request.risk === "high" ? "High impact" : "Action";
    badge.className = `badge ${request.risk}`;
    byId("approval-action").textContent = `${request.summary}?`;
    byId("approval-reason").textContent = request.reason;
    approval.hidden = false;

    const approveButton = byId<HTMLButtonElement>("approve");
    const denyButton = byId<HTMLButtonElement>("deny");
    const finish = (approved: boolean) => {
      approval.hidden = true;
      approveButton.onclick = null;
      denyButton.onclick = null;
      addEntry("status", approved ? "✓ You approved" : "✗ You denied");
      resolve(approved);
    };
    approveButton.onclick = () => finish(true);
    denyButton.onclick = () => finish(false);
    denyButton.focus(); // the safe choice is the default focus
  });

const askQuestion: AskUser = (text, choices) =>
  new Promise((resolve) => {
    addEntry("reply", `❓ ${text}`);
    byId("question-text").textContent = text;
    const choiceList = byId("question-choices");
    choiceList.replaceChildren();
    const answerInput = byId<HTMLInputElement>("question-answer");
    const answerForm = byId<HTMLFormElement>("question-form");
    const dismissButton = byId<HTMLButtonElement>("question-dismiss");
    answerInput.value = "";
    question.hidden = false;

    const finish = (answer: string | null) => {
      question.hidden = true;
      answerForm.onsubmit = null;
      dismissButton.onclick = null;
      addEntry(answer === null ? "status" : "user", answer ?? "(skipped)");
      resolve(answer);
    };
    for (const choice of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = choice;
      button.onclick = () => finish(choice);
      choiceList.appendChild(button);
    }
    answerForm.onsubmit = (event) => {
      event.preventDefault();
      if (answerInput.value.trim()) finish(answerInput.value.trim());
    };
    dismissButton.onclick = () => finish(null);
    answerInput.focus();
  });

const loadApiKey = async (): Promise<string> => {
  const stored = await chrome.storage.local.get(API_KEY_STORAGE_KEY);
  const key = stored[API_KEY_STORAGE_KEY];
  return typeof key === "string" ? key : "";
};

const loadModel = async (): Promise<string> => {
  const stored = await chrome.storage.local.get(MODEL_STORAGE_KEY);
  const model = stored[MODEL_STORAGE_KEY];
  return typeof model === "string" && FREE_MODELS.some((free) => free === model) ? model : DEFAULT_MODEL;
};

byId("save-key").addEventListener("click", async () => {
  await chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKeyInput.value.trim() });
  settings.open = false;
  addEntry("status", "API key saved.");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const instruction = instructionInput.value.trim();
  if (!instruction) return;

  const apiKey = await loadApiKey();
  if (!apiKey) {
    settings.open = true;
    addEntry("error", "Add your Gemini API key in Settings first.");
    return;
  }

  addEntry("user", instruction);
  addEntry("status", "Starting…");
  instructionInput.value = "";
  runButton.disabled = true;
  newChatButton.disabled = true;
  try {
    await runAgent({ apiKey, model: modelSelect.value, instruction, conversation, approve: askForApproval, askUser: askQuestion, onEvent: showEvent });
    addEntry("status", "Done.");
  } catch (error) {
    addEntry("error", error instanceof Error ? error.message : String(error));
  } finally {
    runButton.disabled = false;
    newChatButton.disabled = false;
    instructionInput.focus();
  }
});

newChatButton.addEventListener("click", () => {
  conversation = createConversation();
  log.replaceChildren();
  addEntry("status", "New chat started. The agent has forgotten earlier requests.");
  instructionInput.focus();
});

// Enter runs, Shift+Enter adds a newline.
instructionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

for (const model of FREE_MODELS) modelSelect.add(new Option(model, model));
loadModel().then((model) => {
  modelSelect.value = model;
});
modelSelect.addEventListener("change", () => {
  chrome.storage.local.set({ [MODEL_STORAGE_KEY]: modelSelect.value });
});

loadApiKey().then((key) => {
  apiKeyInput.value = key;
  if (!key) settings.open = true;
});
