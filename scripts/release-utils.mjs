import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportedChannels = new Set(["nightly", "stable"]);

function assertSafeSegment(name, value) {
  if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`${name} must be a non-empty path segment`);
  }
}

function inferTarget(fileName, platform) {
  const lower = fileName.toLowerCase();
  if (platform === "macos") {
    if (lower.includes("aarch64") || lower.includes("arm64")) return "aarch64-apple-darwin";
    if (lower.includes("x64") || lower.includes("x86_64") || lower.includes("x86-64")) return "x86_64-apple-darwin";
    return "universal-apple-darwin";
  }
  if (platform === "windows") {
    if (lower.includes("aarch64") || lower.includes("arm64")) return "aarch64-pc-windows-msvc";
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "linux") {
    if (lower.includes("aarch64") || lower.includes("arm64")) return "aarch64-unknown-linux-gnu";
    return "x86_64-unknown-linux-gnu";
  }
  return platform;
}

export function classifyArtifact(filePath) {
  const fileName = path.basename(filePath);
  const lower = fileName.toLowerCase();

  let platform;
  let bundle;
  if (lower.endsWith(".dmg")) {
    platform = "macos";
    bundle = "dmg";
  } else if (lower.endsWith(".appimage")) {
    platform = "linux";
    bundle = "appimage";
  } else if (lower.endsWith(".deb")) {
    platform = "linux";
    bundle = "deb";
  } else if (lower.endsWith(".exe")) {
    platform = "windows";
    bundle = "nsis";
  } else if (lower.endsWith(".msi")) {
    platform = "windows";
    bundle = "msi";
  } else {
    throw new Error(`Unsupported release artifact: ${filePath}`);
  }

  return {
    platform,
    target: inferTarget(fileName, platform),
    bundle,
  };
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const contents = await readFile(filePath);
  hash.update(contents);
  return hash.digest("hex");
}

function encodeKey(parts) {
  return parts.map((part) => encodeURIComponent(part)).join("/");
}

export async function buildReleaseFiles(options) {
  const { inputDir, outputDir, channel, version, commit, createdAt, baseUrl } = options;

  if (!supportedChannels.has(channel)) {
    throw new Error(`Unsupported release channel: ${channel}`);
  }
  assertSafeSegment("version", version);

  const base = new URL(baseUrl);
  const artifactFiles = (await walkFiles(inputDir))
    .filter((file) => !file.endsWith(".sha256") && !file.endsWith(".sig"))
    .sort((a, b) => a.localeCompare(b));

  if (artifactFiles.length === 0) {
    throw new Error(`No release artifacts found in ${inputDir}`);
  }

  const artifacts = [];
  for (const artifactPath of artifactFiles) {
    const classification = classifyArtifact(artifactPath);
    const fileName = path.basename(artifactPath);
    const r2Key = encodeKey(["artifacts", channel, version, classification.platform, fileName]);
    const outputPath = path.join(outputDir, r2Key);
    const fileStat = await stat(artifactPath);

    await mkdir(path.dirname(outputPath), { recursive: true });
    await copyFile(artifactPath, outputPath);

    const downloadUrl = new URL(`/${r2Key}`, base).toString();
    artifacts.push({
      ...classification,
      fileName,
      size: fileStat.size,
      sha256: await sha256File(artifactPath),
      r2Key,
      downloadUrl,
    });
  }

  const manifest = {
    schemaVersion: 1,
    channel,
    version,
    commit,
    createdAt,
    signed: false,
    artifacts,
  };

  const pinnedManifest = path.join(outputDir, "manifests", channel, `${version}.json`);
  const latestManifest = path.join(outputDir, "manifests", channel, "latest.json");
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  await mkdir(path.dirname(pinnedManifest), { recursive: true });
  await writeFile(pinnedManifest, manifestJson);
  await writeFile(latestManifest, manifestJson);

  const summary = [
    `# ${version} ${channel} artifacts`,
    "",
    ...artifacts.map((artifact) => `- ${artifact.platform} ${artifact.bundle}: ${artifact.downloadUrl}`),
    "",
  ].join("\n");
  await writeFile(path.join(outputDir, "release-summary.md"), summary);

  return { manifest, outputDir };
}

function replaceTomlWorkspaceVersion(contents, version) {
  if (!contents.includes("[workspace.package]")) {
    throw new Error("Cargo.toml must contain [workspace.package]");
  }
  const pattern = /(\[workspace\.package\][\s\S]*?^version\s*=\s*)"[^"]+"/m;
  if (!pattern.test(contents)) {
    throw new Error("Cargo.toml must contain [workspace.package] version");
  }
  return contents.replace(pattern, `$1"${version}"`);
}

export async function applyVersion(rootDir, version, options = {}) {
  const tauriConfigPath = options.tauriConfigPath ?? "src-tauri/tauri.conf.json";
  const packageJsonPath = path.join(rootDir, "package.json");
  const cargoTomlPath = path.join(rootDir, "Cargo.toml");
  const tauriPath = path.join(rootDir, tauriConfigPath);

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.version = version;
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const cargoToml = await readFile(cargoTomlPath, "utf8");
  await writeFile(cargoTomlPath, replaceTomlWorkspaceVersion(cargoToml, version));

  const tauriConfig = JSON.parse(await readFile(tauriPath, "utf8"));
  tauriConfig.version = version;
  await writeFile(tauriPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);
}

function readCargoWorkspaceVersion(contents) {
  const match = contents.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error("Cargo.toml must contain [workspace.package] version");
  }
  return match[1];
}

export async function readProjectVersions(rootDir, options = {}) {
  const tauriConfigPath = options.tauriConfigPath ?? "src-tauri/tauri.conf.json";
  const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const cargoToml = await readFile(path.join(rootDir, "Cargo.toml"), "utf8");
  const tauriConfig = JSON.parse(await readFile(path.join(rootDir, tauriConfigPath), "utf8"));
  return {
    packageJson: packageJson.version,
    cargoWorkspace: readCargoWorkspaceVersion(cargoToml),
    tauriConfig: tauriConfig.version,
  };
}

export function assertVersionsMatch(versions) {
  const values = Object.values(versions);
  const unique = new Set(values);
  if (unique.size !== 1) {
    throw new Error(`Release versions do not match: ${JSON.stringify(versions)}`);
  }
  return values[0];
}

export function repoRootFromScript(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}
