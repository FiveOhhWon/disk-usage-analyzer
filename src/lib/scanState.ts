import type { FlatRow, NodeRow, ScanEvent, ScanSummary, ScanStatus } from "./types";

export interface ScanProgressState {
  status: "idle" | ScanStatus;
  root: string | null;
  entriesScanned: number;
  bytesScanned: number;
  currentPath: string | null;
  summary: ScanSummary | null;
  errors: Array<{ path: string; message: string }>;
}

export const initialScanProgress: ScanProgressState = {
  status: "idle",
  root: null,
  entriesScanned: 0,
  bytesScanned: 0,
  currentPath: null,
  summary: null,
  errors: [],
};

export function scanReducer(
  state: ScanProgressState = initialScanProgress,
  event: ScanEvent,
): ScanProgressState {
  switch (event.type) {
    case "started":
      return {
        ...initialScanProgress,
        status: "running",
        root: event.root,
      };
    case "progress":
      return {
        ...state,
        status: "running",
        entriesScanned: event.entriesScanned,
        bytesScanned: event.bytesScanned,
        currentPath: event.currentPath,
      };
    case "error":
      return {
        ...state,
        errors: [...state.errors, { path: event.path, message: event.message }],
      };
    case "completed":
      return {
        ...state,
        status: "complete",
        summary: event.summary,
        currentPath: null,
      };
    case "cancelled":
      return {
        ...state,
        status: "cancelled",
        summary: event.summary,
        currentPath: null,
      };
  }
}

export function flattenExpandedRows(
  rootId: number,
  childCache: Map<number, NodeRow[]>,
  expanded: Set<number>,
): FlatRow[] {
  if (!expanded.has(rootId)) {
    return [];
  }

  const flattened: FlatRow[] = [];
  const visit = (parentId: number, depth: number) => {
    const children = childCache.get(parentId) ?? [];
    for (const row of children) {
      flattened.push({ row, depth });
      if (row.childCount > 0 && expanded.has(row.id)) {
        visit(row.id, depth + 1);
      }
    }
  };

  visit(rootId, 0);
  return flattened;
}
