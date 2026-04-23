#!/usr/bin/env node
import { parseArgs } from "node:util";

import { buildReleaseFiles } from "./release-utils.mjs";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    channel: { type: "string" },
    version: { type: "string" },
    commit: { type: "string" },
    "created-at": { type: "string" },
    "base-url": { type: "string" },
  },
});

const required = ["input", "output", "channel", "version", "commit", "base-url"];
for (const key of required) {
  if (!values[key]) {
    throw new Error(`Missing required --${key}`);
  }
}

const result = await buildReleaseFiles({
  inputDir: values.input,
  outputDir: values.output,
  channel: values.channel,
  version: values.version,
  commit: values.commit,
  createdAt: values["created-at"] ?? new Date().toISOString(),
  baseUrl: values["base-url"],
});

console.log(`Prepared ${result.manifest.artifacts.length} artifacts for ${result.manifest.version}`);
