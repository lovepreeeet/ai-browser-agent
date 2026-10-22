// The permission system. The decision is made here, in code, from the tool's
// declared kind and the real element, never from what the model says
// about it. A prompt injection can make the model *want* to click "Delete
// account", but it can't change the result of assessRisk().

import type { ElementInfo } from "../shared/protocol";

/** Declared on every tool: does it look at the page, change it, or talk to the user? */
export type ToolKind = "observe" | "act" | "ask";

export type RiskLevel = "low" | "medium" | "high";

export type ApprovalRequest = {
  /** What will happen, e.g. `Type "ai" into input "Search" and press Enter`. */
  summary: string;
  reason: string;
  risk: RiskLevel;
  element: ElementInfo;
};

/**
 * Anything that can answer "may I do this?". In M1 that's the approval card
 * in the side panel; in M3 a voice "yes/no" will implement the same type.
 */
export type Approver = (request: ApprovalRequest) => Promise<boolean>;

// Words that suggest an action is hard to undo or has real-world effects.
const HIGH_IMPACT_PATTERN =
  /\b(buy|purchase|pay|checkout|check out|place order|order now|subscribe|delete|remove|erase|send|submit|confirm|transfer|withdraw|unsubscribe|cancel|deactivate|close account|sign out|log ?out|password|settings)\b/i;

/**
 * Lets the agent ask the user a question mid-task. Resolves to the answer, or
 * null if the user dismissed it. Like Approver, M3's voice layer can implement it.
 */
export type AskUser = (question: string, choices: string[]) => Promise<string | null>;

export const assessRisk = (kind: ToolKind, element?: ElementInfo): RiskLevel => {
  if (kind !== "act") return "low";
  if (element && isHighImpact(element)) return "high";
  return "medium";
};

/**
 * The user's setting. "manual": ask before every page-changing action.
 * "auto": run normal actions without asking. High-impact actions (delete, buy,
 * send, submit, passwords…) ALWAYS ask, whatever the mode; the mode can't
 * switch that off.
 */
export type ApprovalMode = "manual" | "auto";

export const requiresApproval = (risk: RiskLevel, mode: ApprovalMode): boolean => {
  if (risk === "high") return true;
  if (risk === "medium") return mode === "manual";
  return false;
};

const isHighImpact = (element: ElementInfo): boolean => {
  if (element.type === "password") return true;
  const description = [element.text, element.href ?? "", element.type === "submit" ? "submit" : ""].join(" ");
  return HIGH_IMPACT_PATTERN.test(description);
};
