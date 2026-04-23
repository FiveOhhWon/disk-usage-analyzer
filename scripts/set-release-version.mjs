#!/usr/bin/env node
import { applyVersion, readProjectVersions, repoRootFromScript } from "./release-utils.mjs";

const version = process.argv[2];
if (!version) {
  throw new Error("Usage: node scripts/set-release-version.mjs <version>");
}

const rootDir = repoRootFromScript(import.meta.url);
await applyVersion(rootDir, version);
console.log(await readProjectVersions(rootDir));
