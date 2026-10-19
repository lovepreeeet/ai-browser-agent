# Privacy Policy: AI Browser Agent

_Last updated: 19 October 2026_

AI Browser Agent is a Chrome extension that completes tasks on the current web page after you describe
them in plain language. This policy explains what data the extension handles, where it goes, and what
stays on your device.

## Summary

- The extension has **no servers of its own**. It does not collect analytics, track you, or sell data.
- Page content is sent to **Google's Gemini API** only while you are running a request.
- Your Gemini API key and settings are stored **only in your browser**.

## What is sent to Google Gemini, and when

Nothing is sent until you type a request and press **Run**. While a request is running, the extension
sends the following to the Google Gemini API (`generativelanguage.googleapis.com`) using your own API key:

- **Your request** and any answers you give when the agent asks you a question.
- **Content of the current tab** that the agent needs to decide its next step:
  - the page address (URL) and title
  - headings
  - the labels, text, current values and options of buttons, links, form fields and dropdowns
  - names of open dialogs or popups
  - short excerpts of text that appears on the page after an action (for example a success or error message)
- **Earlier messages in the same chat**, so follow-up requests make sense. Old page content is removed
  from this history, and the chat is cleared when you click **New chat** or close the side panel.

**Password fields are never sent.** The extension replaces any password value with `••••` before
anything leaves your browser.

The extension only reads the tab you are working in, and only while a request is running. It does not
read other tabs, your browsing history, cookies, or page content in the background.

Google processes this data under the
[Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms) and the
[Google Privacy Policy](https://policies.google.com/privacy). Please note that on the **free tier of the
Gemini API, Google may use submitted content to improve its products**, and it may be reviewed by
people. Avoid using the agent on pages that contain sensitive information, or use a paid Gemini API key,
which Google does not use for product improvement.

## What is stored on your device

Stored in Chrome's local extension storage (`chrome.storage.local`), on your computer only:

- your Gemini API key
- the Gemini model you selected

The current chat is kept in memory only while the side panel is open. You can remove all stored data at
any time by uninstalling the extension.

## What the extension does not do

- It does not send data to the developer or to any server other than the Google Gemini API.
- It does not use analytics, advertising or tracking.
- It does not sell, rent or share your data with third parties.
- It does not use your data for anything other than carrying out the requests you make.
- It does not use or transfer data to determine creditworthiness or for lending purposes.

## Actions on web pages

The extension can click, type and choose options on the current page, but only after you approve each
action in the side panel. It cannot run arbitrary code on websites; it can only use a fixed set of
built-in functions.

## Children

The extension is not directed at children under 13 and does not knowingly collect their data.

## Changes to this policy

If this policy changes, the updated version will be published at this address with a new
"Last updated" date.

## Contact

Questions or concerns: open an issue at
<https://github.com/lovepreeeet/ai-browser-agent/issues>.
