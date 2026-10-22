# AI Browser Agent

A Chrome extension (Manifest V3) that completes tasks on the current web page from a plain-language
instruction. Gemini decides what to do; the extension does it through a small set of fixed, permission-gated
tools, highlighting each element and asking before it acts.

> "Claim the offer." · "Search for artificial intelligence." · "Add a food expense of 12 for lunch." ·
> "Open the chat with Harish Rana." · "What's written below the admin URL?"

See [CHANGELOG.md](CHANGELOG.md) for what's new in each version.

## Features

- **Plain-language tasks:** clicks, typing, dropdowns, searches and multi-step forms, continuing step by
  step until the request is done.
- **You stay in control:** every action highlights its target on the page. In **Manual** mode you approve each
  action; in **Auto** mode normal actions run on their own. High-impact actions (delete, buy, pay, send, submit,
  password fields…) **always** ask, in both modes.
- **Understands the page:** field labels and current values, dropdown options, checked/expanded state, open
  popups, and elements hidden behind them.
- **Reads page text:** paragraphs, messages, plain URLs and prices, not just buttons; reads long pages in chunks
  or searches them.
- **Works on complex apps:** sees inside embedded frames (e.g. Gmail's Chat sidebar) and shadow DOM, finds
  clickable `<div>`s with no button role, and keeps element IDs stable while the page re-renders.
- **Checks its work:** after each action it's told what changed (navigation, popups, field values, new text), so
  it notices when something didn't work.
- **Asks instead of guessing:** when a request is ambiguous it asks you with clickable choices; if it starts
  going in circles, it stops and asks you what to do.
- **Remembers the chat:** follow-ups like "add another one, but with 20" work; **New chat** clears it.
- **Long pages:** shows the start, end, on-screen part and any open popup; tells you the middle was skipped
  and can still search it.
- **Free to run:** uses the Gemini API free tier, with live countdowns and automatic retries on rate limits.

## Setup

```bash
npm install
npm run build        # or: npm run watch
npm run serve:test   # serves test-page/ at http://localhost:8080
```

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, choose `dist/`.
2. Open http://localhost:8080 and click the extension's toolbar icon to open the side panel.
3. Get a free API key at https://aistudio.google.com/apikey and paste it in **Settings** → **Save**.

After code changes: rebuild, click the reload icon on the extension card, then reload the web page.

## Using it

| Control | What it does |
|---|---|
| Instruction box | Type a request; **Enter** runs it, **Shift+Enter** adds a new line |
| **Approve: Manual / Auto** | Manual asks before every action. Auto runs normal actions without asking (they still flash on the page and show as "✓ Auto-approved" in the log). High-impact actions always ask |
| Approval card | **Approve** or **Deny** the highlighted action. Deny is the default focus |
| "Needs your input" card | The agent's questions, and the "I seem to be stuck" prompt. Pick a choice or type instructions |
| **New chat** | Clears the conversation memory and the log |
| **Settings** | Gemini API key and model |

## Test pages

`npm run serve:test`, then open:

| Page | Exercises |
|---|---|
| `/index.html` | Buttons and links, search box, expense popup with a dropdown, rich-text chat box, high-impact "Delete account", prompt-injection text, disabled and off-screen buttons |
| `/long.html` | 300 items; the target sits in the skipped middle of the list |
| `/frames.html` | Cross-origin chat frame made of plain `<div>`s, a shadow-DOM button, a button re-rendered every 500 ms |
| `/text.html` | Plain text below a URL, plus a fact buried at line 371 of 407 |

## How it works

```
side panel UI ──instruction──▶ agent.ts (Gemini function-calling loop, chat memory, stuck detection)
                                   │ functionCall
                                   ▼
                              tools.ts executeTool ──▶ permissions.ts (risk + approval mode)
                                   │ approved only
                                   ▼
                              controller.ts ──chrome.tabs.sendMessage──▶ content script in each frame (DOM)
```

The agent runs an **observe → act → check** loop: read the page, take one step, read what changed, repeat.
It never runs code on the page; it can only call these tools:

| Tool | Kind | Purpose |
|---|---|---|
| `get_page_content` | observe | Interactive elements with labels, values, options and states; open dialogs; a text preview |
| `find_element` | observe | Search elements by label, placeholder, value or option text |
| `read_page_text` | observe | Read the page's text in chunks, or search it with context |
| `highlight_element` | observe | Draw the orange box around an element |
| `click_element` | act | Click (refused if the element is behind an open dialog) |
| `type_text` | act | Replace a field's text, optionally pressing Enter; works with rich-text editors |
| `select_option` | act | Choose an option in a `<select>` dropdown |
| `ask_user` | ask | Ask the user a question with suggested answers |

| File | Role |
|---|---|
| `src/shared/protocol.ts` | The only commands the content script understands |
| `src/content/dom-snapshot.ts` | Scans elements (including shadow DOM and pointer-clickable divs), stable IDs, page text, long-page collapsing |
| `src/content/highlight.ts` | Orange overlay box that follows the element |
| `src/content/index.ts` | Message handler: snapshot / find / read text / highlight / click / type / select |
| `src/browser/controller.ts` | Handle on one tab: injects into every frame and maps frame-local IDs to tab-wide ones |
| `src/agent/permissions.ts` | Risk levels, high-impact check, approval modes, `Approver` / `AskUser` types |
| `src/agent/tools.ts` | Tool schemas, `executeTool` (the permission gate) and change reporting |
| `src/agent/agent.ts` | System prompt, Gemini loop, conversation memory, retries |
| `src/agent/stuck-detector.ts` | Notices repeated action cycles and repeated failures |
| `src/sidepanel/main.ts` | UI: log, approval and question cards, settings, countdowns |
| `src/background.ts` | Opens the side panel on toolbar click |

## Safety and privacy

- No "run JavaScript" path exists anywhere in the protocol; the model can only call the tools above.
- Risk is computed in code from the real element in the page, not from what the model says about it.
- High-impact actions always require approval; the approval mode can't turn that off.
- The target tab is locked when a request starts.
- Page text is treated as untrusted data: the agent is told never to follow instructions found on a page, and
  the approval gate is the real backstop.
- The API key is stored in `chrome.storage.local` and sent only to the Gemini API. Password values are masked
  before anything leaves the browser.
- Gemini's free tier may use prompts (including page content) to improve Google's products; avoid using it on
  pages with private data. Full details in [PRIVACY.md](PRIVACY.md).

## Models (free tier)

Pick the model in **Settings**. The list (`FREE_MODELS` in `src/agent/agent.ts`) only has Gemini free-tier
models; the default is `gemini-3.5-flash-lite`. Each model has its own free quota, so on a rate-limit error
switch to another. `gemini-3.6-flash` is smarter, but its free tier allows only about 20 requests per day
(roughly 6 instructions).

## Known limitations

- Closed shadow roots and some script-created `about:blank` frames can't be read by any extension.
- `chrome://` pages and the Chrome Web Store can't be automated.
- Element IDs are valid for the current page only; the agent re-reads the page for each new request.
