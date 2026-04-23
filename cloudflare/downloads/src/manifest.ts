export type ReleaseChannel = "nightly" | "stable";
export type ReleasePlatform = "macos" | "windows" | "linux";

export type ReleaseArtifact = {
  platform: ReleasePlatform;
  target: string;
  bundle: string;
  fileName: string;
  size: number;
  sha256: string;
  r2Key: string;
  downloadUrl: string;
};

export type ReleaseManifest = {
  schemaVersion: 1;
  channel: ReleaseChannel;
  version: string;
  commit: string;
  createdAt: string;
  signed: boolean;
  artifacts: ReleaseArtifact[];
};

const channels = new Set<ReleaseChannel>(["nightly", "stable"]);
const platforms = new Set<ReleasePlatform>(["macos", "windows", "linux"]);

export function isReleaseChannel(value: string | null | undefined): value is ReleaseChannel {
  return value === "nightly" || value === "stable";
}

export function isReleasePlatform(value: string | null | undefined): value is ReleasePlatform {
  return value === "macos" || value === "windows" || value === "linux";
}

export function assertReleaseChannel(value: string | null | undefined): ReleaseChannel {
  if (!isReleaseChannel(value)) {
    throw new Response(JSON.stringify({ error: "invalid_channel" }), {
      status: 400,
      headers: { "content-type": "application/json;charset=UTF-8" },
    });
  }
  return value;
}

export function assertReleasePlatform(value: string | null | undefined): ReleasePlatform {
  if (!isReleasePlatform(value)) {
    throw new Response(JSON.stringify({ error: "invalid_platform" }), {
      status: 400,
      headers: { "content-type": "application/json;charset=UTF-8" },
    });
  }
  return value;
}

export function validateManifest(manifest: ReleaseManifest): ReleaseManifest {
  if (
    manifest?.schemaVersion !== 1 ||
    !channels.has(manifest.channel) ||
    typeof manifest.version !== "string" ||
    typeof manifest.commit !== "string" ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.signed !== "boolean" ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error("Invalid release manifest");
  }
  for (const artifact of manifest.artifacts) {
    if (
      !platforms.has(artifact.platform) ||
      typeof artifact.target !== "string" ||
      typeof artifact.bundle !== "string" ||
      typeof artifact.fileName !== "string" ||
      typeof artifact.size !== "number" ||
      typeof artifact.sha256 !== "string" ||
      typeof artifact.r2Key !== "string" ||
      typeof artifact.downloadUrl !== "string"
    ) {
      throw new Error("Invalid release manifest artifact");
    }
  }
  return manifest;
}
