import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App";
import { api } from "./lib/api";

vi.mock("./lib/api", () => ({
  api: {
    listVolumes: vi.fn(),
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
  },
}));

describe("App", () => {
  beforeEach(() => {
    vi.mocked(api.listVolumes).mockResolvedValue([
      {
        name: "Macintosh HD",
        mountPoint: "/",
        fileSystem: "apfs",
        totalBytes: 1000,
        availableBytes: 250,
        isRemovable: false,
      },
    ]);
    vi.mocked(api.getSettings).mockResolvedValue({
      recentRoots: ["/Users/levi"],
      favoriteRoots: ["/Volumes/5TB"],
    });
  });

  it("renders volumes, recents, favorites, and the empty scan state", async () => {
    render(<App />);

    expect(await screen.findByText("Macintosh HD")).toBeInTheDocument();
    expect(screen.getByText("/Users/levi")).toBeInTheDocument();
    expect(screen.getByText("/Volumes/5TB")).toBeInTheDocument();
    expect(screen.getAllByText("No scan loaded").length).toBeGreaterThan(0);
  });
});
