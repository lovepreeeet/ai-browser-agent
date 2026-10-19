// Notices when the agent is going in circles instead of making progress.
// This lives in code rather than in the prompt because a model that is stuck
// usually doesn't realise it: it keeps believing the next attempt will work.

const MAX_CYCLE_LENGTH = 8;
const SINGLE_ACTION_REPEATS = 3;
const MAX_CONSECUTIVE_ERRORS = 3;

export class StuckDetector {
  /** Performed page actions in order, e.g. `type "staging" into "Name"`. */
  private actions: string[] = [];
  private consecutiveErrors = 0;

  record(result: { isError: boolean; action?: string }): void {
    this.consecutiveErrors = result.isError ? this.consecutiveErrors + 1 : 0;
    if (result.action) this.actions.push(result.action);
  }

  /** Describes the problem if the agent looks stuck, otherwise null. */
  check(): string | null {
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      return `my last ${this.consecutiveErrors} attempts all failed`;
    }
    const cycle = findRepeatedCycle(this.actions);
    if (cycle) return `I keep repeating the same steps without getting anywhere (${cycle.join(" → ")})`;
    return null;
  }

  /** Called after the user has given guidance, so old history doesn't re-trigger. */
  reset(): void {
    this.actions = [];
    this.consecutiveErrors = 0;
  }
}

/**
 * Returns the repeating block if the latest actions are the same block done
 * again: [A, B, C, A, B, C], or a single action three times in a row.
 * Different typed values make different actions, so legitimate repetition
 * ("add 5 different expenses") doesn't count.
 */
const findRepeatedCycle = (actions: string[]): string[] | null => {
  for (let length = 1; length <= MAX_CYCLE_LENGTH; length++) {
    const repeats = length === 1 ? SINGLE_ACTION_REPEATS : 2;
    if (actions.length < length * repeats) break;
    const latest = actions.slice(-length);
    const allSame = Array.from({ length: repeats - 1 }, (_, index) => {
      const end = actions.length - length * (index + 1);
      return actions.slice(end - length, end);
    }).every((block) => block.every((action, position) => action === latest[position]));
    if (allSame) return latest;
  }
  return null;
};
