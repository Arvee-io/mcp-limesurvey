/**
 * Keeping the answer of a spec tool within LIMESURVEY_MAX_RESPONSE_CHARS: the lists of a result (errors, warnings,
 * differences, ...) are cut, never silently. The caller reports the full numbers (errors_total, ...) and truncated.
 */
import type { JsonValue } from "./types.js";

/** No list shows more than this many entries, however large the limit is. */
export const MAX_LIST_ENTRIES = 200;

/** Length of the structured content of a workflow answer: what LIMESURVEY_MAX_RESPONSE_CHARS is compared with. */
export function structuredSize(workflow: string, result: JsonValue): number {
  return JSON.stringify({ workflow, result }).length;
}

/**
 * Cuts the lists until fits(cut) is true: first every list to MAX_LIST_ENTRIES entries, then all lists are halved
 * (keeping the start of each) until the result fits. If it does not fit even with empty lists, the empty lists are
 * returned: nothing more can be cut. The lists keep their order, so the first entries are the ones that stay.
 */
export function capLists<T extends Record<string, readonly unknown[]>>(lists: T, fits: (cut: T) => boolean): T {
  const names = Object.keys(lists);
  const cut: Record<string, readonly unknown[]> = {};
  for (const name of names) cut[name] = (lists[name] ?? []).slice(0, MAX_LIST_ENTRIES);
  const hasEntries = (): boolean => names.some((name) => (cut[name]?.length ?? 0) > 0);
  while (!fits(cut as T) && hasEntries()) {
    for (const name of names) {
      const list = cut[name] ?? [];
      cut[name] = list.slice(0, Math.floor(list.length / 2));
    }
  }
  return cut as T;
}
