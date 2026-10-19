# AI Browser Agent: Milestone 1

A Chrome extension (Manifest V3) where an LLM operates the current page only through a small set of
permission-gated tools. You type an instruction; Gemini picks an element; the extension highlights it and
asks before clicking.

## Setup

```bash
npm install
npm run build        # or: npm run watch
npm run serve:test   # serves test-page/ at http://localhost:8080
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, choose `dist/`.
2. Open http://localhost:8080 and click the extension's toolbar icon to open the side panel.
3. Get a free API key at https://aistudio.google.com/apikey, paste it in **Settings** → **Save**.

After code changes: rebuild, then click the reload icon on the extension card and reload the web page.

## How a request flows

```
side panel UI ──instruction──▶ agent.ts (Gemini function-calling loop)
                                   │ functionCall
                                   ▼
                              tools.ts executeTool ──▶ permissions.ts (risk + approval)
                                   │ approved only
                                   ▼
                              controller.ts ──chrome.tabs.sendMessage──▶ content script (DOM)
```

| File | Role |
|---|---|
| `src/shared/protocol.ts` | The only commands the content script understands |
| `src/content/dom-snapshot.ts` | Scans visible interactive elements, assigns numeric IDs, keyword search |
| `src/content/highlight.ts` | Orange overlay box that follows the element |
| `src/content/index.ts` | Message handler: snapshot / find / describe / highlight / click |
| `src/browser/controller.ts` | Extension-side handle on one tab; injects the content script on demand |
| `src/agent/permissions.ts` | Risk levels, high-impact keyword check, `Approver` type |
| `src/agent/tools.ts` | Provider-neutral tool schemas + `executeTool` (the permission gate) |
| `src/agent/agent.ts` | System prompt and the request → functionCall → functionResponse loop (Gemini) |
| `src/sidepanel/main.ts` | UI, event log, approval card |
| `src/background.ts` | Opens the side panel on toolbar click |

## Safety properties

- The model can only call fixed tools (`get_page_content`, `find_element`, `highlight_element`, `click_element`,
  `type_text`, `select_option`, `ask_user`); there is no "run JavaScript" path anywhere in the protocol.
- Every page-changing tool highlights the element and asks first (one approval per action, showing the exact
  text or option); high-impact targets (delete, buy, submit, password fields…) get a red badge.
- After each action the agent is told what changed (navigation, dialogs, field values, new text on the page),
  so it can notice when something didn't work instead of assuming success.
- Risk is computed from the real element in the DOM, not from the model's description of it.
- The target tab is locked when a run starts.
- Page text is treated as untrusted data in the system prompt; the approval gate is the real backstop.
- The API key lives in `chrome.storage.local` and is sent straight from the extension to the Gemini API.
  This is fine for a personal dev tool; a shipped product would route calls through its own backend.
- Gemini's free tier may use prompts (including page content) to improve Google's products, so avoid
  running the agent on pages with private data while on the free tier.

## Model

Pick the model in the side panel's **Settings**. The list only has Gemini free-tier models
(`FREE_MODELS` in `src/agent/agent.ts`); the default is `gemini-3.5-flash-lite`. Each model has its own
free quota, so if one returns a rate-limit error, switch to another. `gemini-3.6-flash` is smarter but its free
tier allows only about 20 requests per day (roughly 6 instructions).
