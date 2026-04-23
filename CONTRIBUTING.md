# Contributing

Thanks for helping improve Disk Usage Analyzer.

## Development Setup

Install the JavaScript and Rust toolchains, then run:

```bash
pnpm install --frozen-lockfile
pnpm tauri:dev
```

## Checks

Run the full local gate before opening a pull request:

```bash
pnpm verify
```

This runs frontend tests, the web build, Cloudflare Worker type checks, Rust tests,
and Rust clippy with warnings denied.

## Pull Requests

- Keep changes focused on one behavior or maintenance task.
- Add or update tests for behavior changes.
- Do not commit local build output such as `dist/`, `target/`, `release-artifacts/`,
  or `release-upload/`.
- For release or hosting changes, include the expected GitHub Actions or
  Cloudflare impact in the PR description.

## Releases

Stable releases are tag-driven with `v*` tags. Nightly prereleases are generated
from the default branch by GitHub Actions and uploaded to Cloudflare R2.
