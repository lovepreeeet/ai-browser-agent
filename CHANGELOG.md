# Changelog

## 0.2.0 (2026-10-22)

### New

- **Auto-approve mode.** A new **Approve: Manual / Auto** switch in the side panel header. In Auto mode, normal
  actions (clicks, typing, choosing options) run without asking; the element still flashes on the page and the
  log shows "✓ Auto-approved". **High-impact actions (delete, buy, pay, send, submit, password fields…) always
  ask, in both modes.** The setting is remembered.
- **Reads page text, not just buttons.** New `read_page_text` tool reads all visible text (paragraphs, messages,
  plain URLs, prices) in numbered chunks of about 150 lines, or searches it and returns matches with surrounding
  lines. `get_page_content` now includes a short text preview. Fixes the agent being unable to see anything
  that isn't a link, button or field (for example plain text below a URL).
- **Works inside embedded frames.** The agent now sees and acts on elements in iframes, including cross-origin
  ones such as Gmail's Chat sidebar. Elements are labelled `(in frame <host>)`.
- **Sees into shadow DOM** (web components).
- **Finds clickable `<div>`s** that have no button role or label (detected by their pointer cursor), and uses
  tooltip text as a name.

### Improved

- **Stable element IDs on re-rendering pages.** When an app replaces an element with an identical copy, it keeps
  the same ID, and an action on a stale ID finds the new copy. Skipped for elements that appear more than once,
  so it can never pick the wrong row.
- Elements inside shadow DOM are no longer wrongly reported as covered.
- The side panel tells you when the agent has only read part of a long page's text.

### Test pages

- `frames.html`: cross-origin chat frame, shadow-DOM button, constantly re-rendered button.
- `text.html`: plain text below a URL and a fact buried deep in a long page.

## 0.1.0 (2026-10-19)

First version.

- Side panel where you type a request; Gemini (free tier) chooses actions through fixed tools; every action is
  highlighted and needs your approval; high-impact actions get a red warning.
- Tools: `get_page_content`, `find_element`, `highlight_element`, `click_element`, `type_text`,
  `select_option`, `ask_user`. No way for the model to run code on a page.
- Understands field labels, current values, dropdown options, open popups and covered elements; works inside
  an already-open popup instead of reopening it.
- Reports what changed after each action (navigation, popups, field values, new text), and finishes
  send/search requests (works with rich-text editors like ChatGPT's).
- Asks you when unsure (`ask_user`), and asks for guidance when it detects it is stuck in a loop.
- Conversation memory with **New chat**; long pages show start, end and on-screen elements with the middle
  skipped (and still searchable).
- Free-tier model picker, automatic retries with a live countdown, and clear errors for bad keys and quotas.
- Privacy policy (`PRIVACY.md`) and extension icons.
