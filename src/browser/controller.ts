// The extension-side handle on one browser tab. It is the only code that
// talks to the content script, and it only sends commands from the fixed
// protocol. It knows nothing about LLMs or permissions.
//
// A page can embed other pages in frames (Gmail's Chat sidebar is one). Each
// frame gets its own copy of the content script with its own element IDs, so
// this class gives every element a tab-wide ID and remembers which frame
// (and which frame-local ID) it maps to.

import type {
  ContentCommand,
  ContentResponse,
  ElementId,
  ElementInfo,
  PageSnapshot,
  PageState,
  SnapshotItem,
} from "../shared/protocol";

const PAGE_LOAD_TIMEOUT_MS = 10_000;
const MAIN_FRAME = 0;
const MAX_FIND_RESULTS = 8;

type FrameInfo = { frameId: number; url: string };
type ElementLocation = { frameId: number; localId: ElementId };

export class BrowserController {
  private readonly idByLocation = new Map<string, ElementId>();
  private readonly locationById = new Map<ElementId, ElementLocation>();
  private readonly frameUrls = new Map<number, string>();
  private nextId = 1;
  private highlightedFrame: number | null = null;

  constructor(private readonly tabId: number) {}

  static async forActiveTab(): Promise<BrowserController> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error("No active tab found.");
    if (!isScriptableUrl(tab.url)) {
      throw new Error(`The agent can't run on this page (${tab.url ?? "unknown URL"}). Open a normal http(s) page.`);
    }
    return new BrowserController(tab.id);
  }

  /** One snapshot of the whole tab: the main page plus every frame that has elements. */
  async snapshot(): Promise<PageSnapshot> {
    const frames = await this.prepareFrames();
    const results = await Promise.all(
      frames.map(async (frame) => ({
        frame,
        snapshot: await this.sendToFrame<PageSnapshot>(frame.frameId, { type: "snapshot" }).catch(() => null),
      })),
    );
    const main = results.find(({ frame }) => frame.frameId === MAIN_FRAME)?.snapshot;
    if (!main) throw new Error("Could not read the page. Reload it and try again.");

    const merged: PageSnapshot = { ...main, items: [], dialogs: [], totalElements: 0, skippedElements: 0 };
    for (const { frame, snapshot } of results) {
      if (!snapshot || snapshot.totalElements === 0) continue;
      merged.items.push(...snapshot.items.map((item) => this.globalItem(frame, item)));
      merged.dialogs.push(...snapshot.dialogs);
      merged.totalElements += snapshot.totalElements;
      merged.skippedElements += snapshot.skippedElements;
    }
    return merged;
  }

  async pageState(): Promise<PageState> {
    const frames = await this.prepareFrames();
    const states = await Promise.all(
      frames.map((frame) => this.sendToFrame<PageState>(frame.frameId, { type: "pageState" }).catch(() => null)),
    );
    const main = states[frames.findIndex((frame) => frame.frameId === MAIN_FRAME)];
    if (!main) throw new Error("Could not read the page.");
    // URL and title come from the main page; dialogs and text from every frame,
    // so a message appearing in an embedded chat still counts as a change.
    const others = states.filter((state): state is PageState => state !== null && state !== main);
    return {
      ...main,
      dialogs: [...main.dialogs, ...others.flatMap((state) => state.dialogs)],
      textLines: [...main.textLines, ...others.flatMap((state) => state.textLines)],
    };
  }

  /** Visible text of the main page, then of each frame (under a "--- Frame: host ---" line). */
  async readText(): Promise<string[]> {
    const frames = await this.prepareFrames();
    const texts = await Promise.all(
      frames.map((frame) => this.sendToFrame<string[]>(frame.frameId, { type: "readText" }).catch(() => [])),
    );
    return frames.flatMap((frame, index) => {
      const lines = texts[index] ?? [];
      if (frame.frameId === MAIN_FRAME || lines.length === 0) return lines;
      return [`--- Frame: ${hostOf(frame.url)} ---`, ...lines];
    });
  }

  async find(query: string): Promise<ElementInfo[]> {
    const frames = await this.prepareFrames();
    const results = await Promise.all(
      frames.map(async (frame) => {
        const matches = await this.sendToFrame<ElementInfo[]>(frame.frameId, { type: "find", query }).catch(() => []);
        return matches.map((info) => this.globalInfo(frame, info));
      }),
    );
    return results.flat().slice(0, MAX_FIND_RESULTS);
  }

  async describe(id: ElementId): Promise<ElementInfo | null> {
    const location = this.locationById.get(id);
    if (!location) return null;
    const info = await this.sendToFrame<ElementInfo | null>(location.frameId, { type: "describe", id: location.localId });
    if (!info) return null;
    return this.globalInfo({ frameId: location.frameId, url: this.frameUrls.get(location.frameId) ?? "" }, info);
  }

  async highlight(id: ElementId, label: string): Promise<void> {
    const location = this.requireLocation(id);
    await this.clearHighlight();
    await this.sendToFrame(location.frameId, { type: "highlight", id: location.localId, label });
    this.highlightedFrame = location.frameId;
  }

  async clearHighlight(): Promise<void> {
    if (this.highlightedFrame === null) return;
    await this.sendToFrame(this.highlightedFrame, { type: "clearHighlight" }).catch(() => undefined);
    this.highlightedFrame = null;
  }

  async click(id: ElementId): Promise<void> {
    const location = this.requireLocation(id);
    await this.sendToFrame(location.frameId, { type: "click", id: location.localId });
  }

  async type(id: ElementId, text: string, submit: boolean): Promise<void> {
    const location = this.requireLocation(id);
    await this.sendToFrame(location.frameId, { type: "type", id: location.localId, text, submit });
  }

  async select(id: ElementId, option: string): Promise<string> {
    const location = this.requireLocation(id);
    const { selected } = await this.sendToFrame<{ selected: string }>(location.frameId, {
      type: "select",
      id: location.localId,
      option,
    });
    return selected;
  }

  private requireLocation(id: ElementId): ElementLocation {
    const location = this.locationById.get(id);
    if (!location) throw new Error(`Unknown element id ${id}. Call get_page_content again.`);
    return location;
  }

  private globalItem(frame: FrameInfo, item: SnapshotItem): SnapshotItem {
    return "skipped" in item ? item : this.globalInfo(frame, item);
  }

  private globalInfo(frame: FrameInfo, info: ElementInfo): ElementInfo {
    const key = `${frame.frameId}:${info.id}`;
    let id = this.idByLocation.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.idByLocation.set(key, id);
      this.locationById.set(id, { frameId: frame.frameId, localId: info.id });
    }
    return { ...info, id, frame: frame.frameId === MAIN_FRAME ? null : hostOf(frame.url) };
  }

  private async sendToFrame<T>(frameId: number, command: ContentCommand): Promise<T> {
    await this.waitForPageLoad();
    const response: ContentResponse = await chrome.tabs.sendMessage(this.tabId, command, { frameId });
    if (!response.ok) throw new Error(response.error);
    return response.data as T;
  }

  /**
   * Waits for the page to load, then makes sure every frame has the content
   * script. We inject on demand instead of declaring content_scripts in the
   * manifest, so it only runs on pages where you actually use the agent.
   */
  private async prepareFrames(): Promise<FrameInfo[]> {
    await this.waitForPageLoad();
    const probes = await chrome.scripting.executeScript({
      target: { tabId: this.tabId, allFrames: true },
      func: () => ({
        installed: Boolean((window as { __aiAgentInstalled?: boolean }).__aiAgentInstalled),
        url: location.href,
      }),
    });
    const missing = probes.filter((probe) => !probe.result?.installed).map((probe) => probe.frameId);
    if (missing.length) {
      // Some frames (error pages, sandboxed ads) refuse injection; skip those.
      await chrome.scripting
        .executeScript({ target: { tabId: this.tabId, frameIds: missing }, files: ["content.js"] })
        .catch(() => undefined);
    }
    const frames = probes.map((probe) => ({ frameId: probe.frameId, url: probe.result?.url ?? "" }));
    for (const frame of frames) this.frameUrls.set(frame.frameId, frame.url);
    return frames;
  }

  // After a click navigates, the old page (and its content script) is gone;
  // wait until the new page has loaded before talking to it.
  private async waitForPageLoad(): Promise<void> {
    const deadline = Date.now() + PAGE_LOAD_TIMEOUT_MS;
    while ((await chrome.tabs.get(this.tabId)).status === "loading" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

const isScriptableUrl = (url: string | undefined): boolean =>
  url !== undefined && /^(https?|file):/.test(url) && !url.startsWith("https://chromewebstore.google.com");

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || "embedded frame";
  } catch {
    return "embedded frame";
  }
};
