#!/usr/bin/env node
import { assertVersionsMatch, readProjectVersions, repoRootFromScript } from "./release-utils.mjs";

const rootDir = repoRootFromScript(import.meta.url);
const versions = await readProjectVersions(rootDir);
const version = assertVersionsMatch(versions);
console.log(`Release versions match: ${version}`);
