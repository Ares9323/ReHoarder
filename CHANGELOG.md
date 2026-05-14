# Changelog

All notable changes to ReHoarder are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-14

First public alpha. Cross-platform desktop manager for Unreal Engine assets,
unifying the Fab library, the Epic Vault and the legacy Marketplace into a
single searchable catalog with download + project workflows.

### Added

#### Authentication & sync
- Epic OAuth login via the `authorization_code` flow with refresh tokens
  (same scheme used by Legendary / Heroic).
- Fab UE library sync (`/e/accounts/{id}/ue/library`), paginated and
  incremental — repeat syncs early-stop on already-known IDs.
- Fab Other library sync (`/i/library/search`) for non-UE assets
  (Blender, Maya, FBX, MetaHuman, Unity, …).
- Epic Vault sync (`/launcher/api/public/assets/Windows?label=Live`) with
  parallel bulk catalog fetch (6 concurrent batches).
- Cloudflare-aware Fab handshake: explicit 5-step OAuth dance over Fab +
  Epic, with `useSessionCookies: true` for Chromium-native cookie
  management.
- Multi-source dedup: assets that appear under both Vault and Fab are
  reconciled via `legacyItemId` so the library shows a single card per
  asset.

#### Asset library UI
- Search box plus 5 combinable filters: source, listing type, category,
  "only downloaded", "only updatable", "only bookmarked".
- Per-card bookmark toggle and context menu (open on Fab, copy ID, hide).
- Per-version chip state in the asset grid (idle / queued / busy /
  error / downloaded / updatable).
- Configurable image size (small / medium / large) controlling the grid
  density.

#### Downloads
- Persistent download queue surviving app restarts.
- Live per-row progress bar with byte/file counters in the Downloads tab.
- Per-asset Download button with a custom-install menu (target engine /
  project / vault, conflict mode, requested-version exact match).
- Full Epic Chunked Manifest parser (binary `0x44BEC00C` format) plus a
  Fab manifest client, chunk downloader with Poly64 + SHA1 verification,
  zlib decompression and atomic file assembly. Persistent chunk cache.

#### Vault management
- List of locally cached assets with friendly names, size, last-modified
  and sortable headers.
- Optional thumbnails column.
- Delete-with-confirm that cascades to clear the chip on the Assets tab.

#### Projects
- Recursive scan of configured project roots for `*.uproject`, reading
  descriptor metadata (engine association, description, category,
  code-vs-blueprint flag).
- `Saved/AutoScreenshot.png` thumbnail per project, with the Fab
  thumbnail as a fallback when a `.rehoarder.json` marker links the
  project to its source asset.
- Custom `rh-file://` protocol so the renderer can show on-disk
  thumbnails (project auto-screenshots, engine icons) without weakening
  the CSP. Restricted to the configured project / engine / vault roots.
- "Open in Explorer", "Launch editor" (via `UnrealVersionSelector`) and
  "Run game" with configurable CLI params.
- Create-project flow: copies a Fab project template into a new folder
  under a chosen root and stamps a `.rehoarder.json` marker for
  traceability.
- Add-to-project flow: merges an asset pack's `Content/` into an
  existing project with skip / overwrite conflict modes.
- Install-from-vault: if the artefact already lives in a vault path,
  plugin install into engine or project copies straight from disk
  without re-downloading.
- Side-panel `.uproject` editor with atomic write + automatic
  `.uproject.bak` backup.

#### Engines
- Engines tab scanning for `UE_*/Engine/Build/Build.version`, exposing
  Editor / Run / open-in-Explorer per row.
- Branch-name cleanup (`++UE5+Release-5.5` → `UE5 Release 5.5`).

#### Settings
- Configurable project / engine / vault paths with multi-line input.
- Per-tab "separate by path" and "show thumbnails" toggles.
- Download threads, compile-plugins-on-install, skip-non-current-
  platform-binaries flags.
- `Ctrl+S` / `Cmd+S` save shortcut.

#### Storage
- Local SQLite catalog for assets, tags, sync state, downloads, bookmarks.
- Idempotent schema migrations via `ALTER TABLE ADD COLUMN` plus
  `PRAGMA user_version` for one-shot data fixes (category re-tagging,
  listing-type backfill).

#### Release pipeline
- Velopack-based installer + in-app auto-updater (`Settings → About &
  updates`) pulling releases from this GitHub repository.
- `npm run build:win` produces `Releases/ReHoarder-Setup.exe` plus the
  matching `.nupkg` and `RELEASES` index via `vpk pack`.
- GitHub Actions workflow (`.github/workflows/release.yml`) builds and
  publishes a Release on every `v*` tag.

### Known limitations

- Vault asset download is disabled by default since Epic removed the
  public `launcher:download:Live-Windows:<appName>` scope in 2026 —
  vault listings are hidden from the Assets tab default until a fallback
  arrives.
- `downloadThreads` is wired through Settings but the worker pool runs
  serially for now.
- Engine downloads (with components picker) and source-build engine
  detection via the Windows registry are not yet implemented.
- Plugin compile (`RunUAT BuildPlugin`) and engine-launch flows still
  assume Windows path conventions in spots; Linux / macOS pass is on the
  roadmap.

[0.1.0]: https://github.com/Ares9323/ReHoarder/releases/tag/v0.1.0
