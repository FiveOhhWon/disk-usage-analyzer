// @vitest-environment node
import { describe, expect, it } from "vitest";

import worker from "./index";

type StoredObject = {
  body: string;
  httpMetadata?: {
    contentType?: string;
  };
};

class MockR2Object {
  constructor(
    readonly key: string,
    readonly body: string,
    readonly httpMetadata: StoredObject["httpMetadata"] = {},
  ) {}

  writeHttpMetadata(headers: Headers) {
    if (this.httpMetadata?.contentType) {
      headers.set("content-type", this.httpMetadata.contentType);
    }
  }

  async text() {
    return this.body;
  }
}

class MockR2Bucket {
  constructor(private readonly objects: Record<string, StoredObject>) {}

  async get(key: string) {
    const object = this.objects[key];
    if (!object) return null;
    return new MockR2Object(key, object.body, object.httpMetadata);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    return {
      objects: Object.keys(this.objects)
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key })),
      truncated: false,
    };
  }
}

function makeEnv(objects: Record<string, StoredObject>) {
  return {
    RELEASES: new MockR2Bucket(objects),
    ASSETS: {
      fetch: async () => new Response("<!doctype html><title>Downloads</title>", {
        headers: { "content-type": "text/html;charset=UTF-8" },
      }),
    },
  } as unknown as Env;
}

const nightlyManifest = {
  schemaVersion: 1,
  channel: "nightly",
  version: "0.1.0-nightly.20260423.7",
  commit: "abc1234",
  createdAt: "2026-04-23T20:00:00.000Z",
  signed: false,
  artifacts: [
    {
      platform: "macos",
      target: "aarch64-apple-darwin",
      bundle: "dmg",
      fileName: "Disk Usage Analyzer.dmg",
      size: 7,
      sha256: "f".repeat(64),
      r2Key: "artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer.dmg",
      downloadUrl:
        "https://disk-usage-analyzer-downloads.example.workers.dev/artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer.dmg",
    },
  ],
};

describe("downloads Worker", () => {
  it("serves the static landing page through the assets binding", async () => {
    const response = await worker.fetch(new Request("https://downloads.example/"), makeEnv({}));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Downloads");
  });

  it("returns the latest manifest for a valid channel", async () => {
    const env = makeEnv({
      "manifests/nightly/latest.json": {
        body: JSON.stringify(nightlyManifest),
        httpMetadata: { contentType: "application/json" },
      },
    });

    const response = await worker.fetch(new Request("https://downloads.example/api/releases/latest?channel=nightly"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toContain("max-age=60");
    expect(await response.json()).toEqual(nightlyManifest);
  });

  it("streams the latest artifact for a platform from the manifest", async () => {
    const env = makeEnv({
      "manifests/nightly/latest.json": {
        body: JSON.stringify(nightlyManifest),
        httpMetadata: { contentType: "application/json" },
      },
      "artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer.dmg": {
        body: "dmgdata",
        httpMetadata: { contentType: "application/x-apple-diskimage" },
      },
    });

    const response = await worker.fetch(new Request("https://downloads.example/download/nightly/macos"), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-apple-diskimage");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="Disk Usage Analyzer.dmg"');
    expect(response.headers.get("x-checksum-sha256")).toBe("f".repeat(64));
    expect(await response.text()).toBe("dmgdata");
  });

  it("streams a pinned artifact by channel, version, platform, and file", async () => {
    const env = makeEnv({
      "artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer.dmg": {
        body: "dmgdata",
        httpMetadata: { contentType: "application/x-apple-diskimage" },
      },
    });

    const response = await worker.fetch(
      new Request(
        "https://downloads.example/artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer.dmg",
      ),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dmgdata");
  });

  it("streams a pinned artifact by the documented channel, version, and file route", async () => {
    const env = makeEnv({
      "artifacts/nightly/0.1.0-nightly.20260423.7/macos/Disk%20Usage%20Analyzer.dmg": {
        body: "dmgdata",
        httpMetadata: { contentType: "application/x-apple-diskimage" },
      },
    });

    const response = await worker.fetch(
      new Request("https://downloads.example/artifacts/nightly/0.1.0-nightly.20260423.7/Disk%20Usage%20Analyzer.dmg"),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("dmgdata");
  });

  it("rejects unsafe artifact paths and unknown channels", async () => {
    const env = makeEnv({});

    const unsafe = await worker.fetch(
      new Request("https://downloads.example/artifacts/nightly/0.1.0-nightly.20260423.7/macos/..%2Fsecret"),
      env,
    );
    const invalidChannel = await worker.fetch(
      new Request("https://downloads.example/api/releases/latest?channel=beta"),
      env,
    );

    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toMatchObject({ error: "invalid_artifact_path" });
    expect(invalidChannel.status).toBe(400);
    expect(await invalidChannel.json()).toMatchObject({ error: "invalid_channel" });
  });
});
