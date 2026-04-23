# Disk Usage Analyzer

Cross-platform disk usage explorer built with Tauri 2, Rust, React, and TypeScript.

> Release status: installable builds are produced by GitHub Actions and hosted
> through a Cloudflare Worker backed by private R2 storage.

## What It Does

- Scans a selected folder or mounted volume with a Rust backend.
- Keeps scan results in a compact in-memory arena and pages visible data to the UI.
- Shows logical size, allocated size, file/folder counts, largest files, largest folders, and extension breakdowns.
- Supports reveal/open actions and move-to-trash with confirmation.
- Persists recent and favorite scan roots, but does not persist full scan snapshots.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm dev
pnpm tauri:dev
pnpm test --run
pnpm build
pnpm cf:typecheck
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

Run the complete local gate with:

```bash
pnpm verify
```

## Releases

Nightly prereleases are generated from the default branch. Stable releases are
created from `v*` tags.

Release artifacts are uploaded to the private Cloudflare R2 bucket
`disk-usage-analyzer-releases` and served by the Worker
`disk-usage-analyzer-downloads`. The first deployment uses the generated
`workers.dev` URL; a custom domain can be added later without changing the
artifact layout.

Expected R2 layout:

```text
artifacts/nightly/<version>/<platform>/<filename>
artifacts/stable/<version>/<platform>/<filename>
manifests/nightly/latest.json
manifests/stable/latest.json
manifests/<channel>/<version>.json
```

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Optional signing secrets are documented in `.github/workflows/release.yml`.

## Notes

- Symlinks are not followed by default.
- Hard links are counted per path in this first version.
- Native filesystem index fast paths, such as NTFS MFT or APFS-specific scanning, are deferred.

## License

MIT
