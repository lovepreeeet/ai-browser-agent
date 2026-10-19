// The extension-side handle on one browser tab. It is the only code that
// talks to the content script, and it only sends commands from the fixed
// protocol. It knows nothing about LLMs or permissions.

import type {
  ContentCommand,
  ContentResponse,
  ElementId,
  ElementInfo,
  PageSnapshot,
  PageState,
} from "../shared/protocol";

const PAGE_LOAD_TIMEOUT_MS = 10_000;

export class BrowserController {
  constructor(private readonly tabId: number) {}

  static async forActiveTab(): Promise<BrowserController> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error("No active tab found.");
    if (!isScriptableUrl(tab.url)) {
      throw new Error(`The agent can't run on this page (${tab.url ?? "unknown URL"}). Open a normal http(s) page.`);
    }
    return new BrowserController(tab.id);
  }

  snapshot(): Promise<PageSnapshot> {
    return this.send<PageSnapshot>({ type: "snapshot" });
  }

  pageState(): Promise<PageState> {
    return this.send<PageState>({ type: "pageState" });
  }

  find(query: string): Promise<ElementInfo[]> {
    return this.send<ElementInfo[]>({ type: "find", query });
  }

  describe(id: ElementId): Promise<ElementInfo | null> {
    return this.send<ElementInfo | null>({ type: "describe", id });
  }

  async highlight(id: ElementId, label: string): Promise<void> {
    await this.send({ type: "highlight", id, label });
  }

  async clearHighlight(): Promise<void> {
    await this.send({ type: "clearHighlight" });
  }

  async click(id: ElementId): Promise<void> {
    await this.send({ type: "click", id });
  }

  async type(id: ElementId, text: string, submit: boolean): Promise<void> {
    await this.send({ type: "type", id, text, submit });
  }

  async select(id: ElementId, option: string): Promise<string> {
    const { selected } = await this.send<{ selected: string }>({ type: "select", id, option });
    return selected;
  }

  private async send<T>(command: ContentCommand): Promise<T> {
    await this.waitForPageLoad();
    await this.ensureContentScript();
    const response: ContentResponse = await chrome.tabs.sendMessage(this.tabId, command);
    if (!response.ok) throw new Error(response.error);
    return response.data as T;
  }

  // After a click navigates, the old page (and its content script) is gone;
  // wait until the new page has loaded before talking to it.
  private async waitForPageLoad(): Promise<void> {
    const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
    while ((await chrome.tabs.get(this.tabId)).status === "loading" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // We inject on demand instead of declaring content_scripts in the manifest,
  // so the script only runs on pages where you actually use the agent.
  private async ensureContentScript(): Promise<void> {
    try {
      await chrome.tabs.sendMessage(this.tabId, { type: "ping" } satisfies ContentCommand);
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: this.tabId }, files: ["content.js"] });
    }
  }
}

const isScriptableUrl = (url: string | undefined): boolean =>
  url !== undefined && /^(https?|file):/.test(url) && !url.startsWith("https://chromewebstore.google.com");
