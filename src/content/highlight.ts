// Draws a box over an element so the user can see what the agent means.
// The overlay is a separate fixed-position node, so we never modify the
// page's own styles, and pointer-events:none keeps it from blocking clicks.

const OVERLAY_ID = "__ai-agent-highlight__";

let trackedElement: Element | null = null;
let frameRequest = 0;

export const highlightElement = (element: Element, label: string): void => {
  clearHighlight();
  element.scrollIntoView({ block: "center", behavior: "instant" });

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  Object.assign(overlay.style, {
    position: "fixed",
    zIndex: "2147483647",
    pointerEvents: "none",
    border: "3px solid #f97316",
    borderRadius: "6px",
    background: "rgba(249, 115, 22, 0.15)",
    boxShadow: "0 0 0 4px rgba(249, 115, 22, 0.35)",
    transition: "all 80ms linear",
  });

  const tag = document.createElement("div");
  tag.textContent = label;
  Object.assign(tag.style, {
    position: "absolute",
    top: "-26px",
    left: "-3px",
    padding: "2px 8px",
    font: "600 12px/20px system-ui, sans-serif",
    color: "#fff",
    background: "#f97316",
    borderRadius: "4px",
    whiteSpace: "nowrap",
  });
  overlay.appendChild(tag);
  document.documentElement.appendChild(overlay);

  trackedElement = element;
  followElement(overlay);
};

export const clearHighlight = (): void => {
  cancelAnimationFrame(frameRequest);
  trackedElement = null;
  document.getElementById(OVERLAY_ID)?.remove();
};

// Re-position every frame so the box stays on target while the page scrolls.
const followElement = (overlay: HTMLElement): void => {
  if (!trackedElement?.isConnected) {
    clearHighlight();
    return;
  }
  const rect = trackedElement.getBoundingClientRect();
  overlay.style.top = `${rect.top - 4}px`;
  overlay.style.left = `${rect.left - 4}px`;
  overlay.style.width = `${rect.width + 8}px`;
  overlay.style.height = `${rect.height + 8}px`;
  frameRequest = requestAnimationFrame(() => followElement(overlay));
};
