import { describe, expect, it } from "vitest";

import { flattenExpandedRows, scanReducer } from "./scanState";
import type { NodeRow, ScanEvent } from "./types";

function row(id: number, name: string, childCount = 0): NodeRow {
  return {
    id,
    name,
    path: `/root/${name}`,
    kind: childCount > 0 ? "directory" : "file",
    logicalBytes: id * 10,
    allocatedBytes: id * 12,
    fileCount: childCount > 0 ? childCount : 1,
    directoryCount: childCount > 0 ? 1 : 0,
    symlinkCount: 0,
    childCount,
    percentOfRoot: id,
  };
}

describe("scan state", () => {
  it("tracks progress and completion events", () => {
    const progress: ScanEvent = {
      type: "progress",
      entriesScanned: 12,
      bytesScanned: 2048,
      currentPath: "/root/a",
    };
    const completed: ScanEvent = {
      type: "completed",
      summary: {
        root: "/root",
        totalLogicalBytes: 2048,
        totalAllocatedBytes: 4096,
        fileCount: 12,
        directoryCount: 2,
        symlinkCount: 0,
        errorCount: 1,
        cancelled: false,
      },
    };

    const afterProgress = scanReducer(undefined, progress);
    const afterComplete = scanReducer(afterProgress, completed);

    expect(afterProgress.entriesScanned).toBe(12);
    expect(afterProgress.status).toBe("running");
    expect(afterComplete.status).toBe("complete");
    expect(afterComplete.summary?.errorCount).toBe(1);
  });

  it("flattens only expanded cached directories", () => {
    const cache = new Map<number, NodeRow[]>([
      [0, [row(1, "apps", 2), row(2, "notes.txt")]],
      [1, [row(3, "target"), row(4, "node_modules")]],
    ]);

    expect(flattenExpandedRows(0, cache, new Set([0, 1])).map((item) => item.row.name)).toEqual([
      "apps",
      "target",
      "node_modules",
      "notes.txt",
    ]);
    expect(flattenExpandedRows(0, cache, new Set([0])).map((item) => item.row.name)).toEqual([
      "apps",
      "notes.txt",
    ]);
  });
});
