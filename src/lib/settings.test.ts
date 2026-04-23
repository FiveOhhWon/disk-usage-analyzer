import { describe, expect, it } from "vitest";

import { addRecentRoot, normalizeRoots, toggleFavorite } from "./settings";

describe("settings helpers", () => {
  it("deduplicates recents, keeps newest first, and caps the list", () => {
    const roots = normalizeRoots([
      "/tmp/a",
      "/tmp/b",
      "/tmp/a",
      "  ",
      "/tmp/c",
      "/tmp/d",
    ], 3);

    expect(roots).toEqual(["/tmp/d", "/tmp/c", "/tmp/a"]);
  });

  it("adds a recent root to the front without duplicates", () => {
    expect(addRecentRoot(["/tmp/a", "/tmp/b"], "/tmp/b")).toEqual([
      "/tmp/b",
      "/tmp/a",
    ]);
  });

  it("toggles favorites without disturbing other roots", () => {
    expect(toggleFavorite(["/tmp/a"], "/tmp/b")).toEqual(["/tmp/a", "/tmp/b"]);
    expect(toggleFavorite(["/tmp/a", "/tmp/b"], "/tmp/a")).toEqual(["/tmp/b"]);
  });
});
