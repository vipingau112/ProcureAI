/**
 * Hands the rows the Insights tab is currently showing (real or sample) to custom widgets, so a widget can still draw
 * something sensible if Studio's own data query is slow or comes back in a shape the widget did not expect.
 */
import type { InsightRow } from './insights';

let current: InsightRow[] = [];
const listeners = new Set<() => void>();

export const getInsightRows = (): InsightRow[] => current;

export function setInsightRows(next: InsightRow[]): void {
  if (next === current) return;
  current = next;
  listeners.forEach((fn) => fn());
}

export function subscribeInsightRows(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
