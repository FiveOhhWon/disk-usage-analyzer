import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  applyVersion,
  buildReleaseFiles,
  classifyArtifact,
  readProjectVersions,
} from "./release-utils.mjs";

async function makeTempDir() {
  return mkdtemp(path.join(tmpdir(), "dua-release-utils-"));
}

describe("classifyArtifact", () => {
  it("maps Tauri bundle extensions to release platforms and bundle types", () => {
    expect(classifyArtifact("Disk Usage Analyzer_0.1.0_aarch64.dmg")).toEqual({
      platform: "macos",
      target: "aarch64-apple-darwin",
      bundle: "dmg",
    });
    expect(classifyArtifact("Disk Usage Analyzer_0.1.0_x64-setup.exe")).toEqual({
      platform: "windows",
      target: "x86_64-pc-windows-msvc",
      bundle: "nsis",
    });
    expect(classifyArtifact("disk-usage_0.1.0_amd64.AppImage")).toEqual({
      platform: "linux",
      target: "x86_64-unknown-linux-gnu",
      bundle: "appimage",
    });
    expect(classifyArtifact("disk-usage_0.1.0_amd64.deb")).toEqual({
      platform: "linux",
      target: "x86_64-unknown-linux-gnu",
      bundle: "deb",
    });
  });

  it("rejects unsupported files so release jobs fail before uploading junk", () => {
    expect(() => classifyArtifact("notes.txt")).toThrow(/Unsupported release artifact/);
  });
});

describe("buildReleaseFiles", () => {
  it("copies artifacts into R2 keys and writes pinned/latest manifests", async () => {
      const root = await makeTempDir();
      try {
        const inputDir = path.join(root, "input");
        const outputDir = path.join(root, "output");
        await mkdir(path.join(inputDir, "macos"), { recursive: true });
        await mkdir(path.join(inputDir, "windows"), { recursive: true });
        await writeFile(path.join(inputDir, "macos", "Disk Usage Analyzer_0.1.0_aarch64.dmg"), "mac");
        await writeFile(path.join(inputDir, "windows", "Disk Usage Analyzer_0.1.0_x64-setup.exe"), "win");

      const result = await buildReleaseFiles({
        inputDir,
        outputDir,
        channel: "nightly",
        version: "0.1.0-nightly.20260423.7",
        commit: "abc1234",
        createdAt: "2026-04-23T20:00:00.000Z",
        baseUrl: "https://disk-usage-analyzer-downloads.example.workers.dev",
      });

      expect(result.manifest.artifacts.map((artifact) => artifact.platform)).toEqual(["macos", "windows"]);
      expect(result.manifest.artifacts[0]).toMatchObject({
        fileName: "Disk Usage Analyzer_0.1.0_aarch64.dmg",
        r2Key:
          "artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer_0.1.0_aarch64.dmg",
        downloadUrl:
          "https://disk-usage-analyzer-downloads.example.workers.dev/artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer_0.1.0_aarch64.dmg",
      });

      const copied = await stat(
        path.join(
          outputDir,
          "artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer_0.1.0_aarch64.dmg",
        ),
      );
      expect(copied.size).toBe(3);

      const latest = JSON.parse(await readFile(path.join(outputDir, "manifests/nightly/latest.json"), "utf8"));
      const pinned = JSON.parse(
        await readFile(path.join(outputDir, "manifests/nightly/0.1.0-nightly.20260423.7.json"), "utf8"),
      );
      expect(latest).toEqual(pinned);
      expect(latest.artifacts[1].sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("version helpers", () => {
  it("updates and reads package, Cargo workspace, and Tauri versions", async () => {
    const root = await makeTempDir();
    try {
      await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "disk-usage-analyzer", version: "0.1.0" }));
      await writeFile(path.join(root, "Cargo.toml"), '[workspace.package]\nversion = "0.1.0"\n');
      await writeFile(path.join(root, "tauri.conf.json"), JSON.stringify({ version: "0.1.0" }));

      await applyVersion(root, "0.1.0-nightly.20260423.7", {
        tauriConfigPath: "tauri.conf.json",
      });

      expect(await readProjectVersions(root, { tauriConfigPath: "tauri.conf.json" })).toEqual({
        packageJson: "0.1.0-nightly.20260423.7",
        cargoWorkspace: "0.1.0-nightly.20260423.7",
        tauriConfig: "0.1.0-nightly.20260423.7",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
