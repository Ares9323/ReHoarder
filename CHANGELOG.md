# Changelog

All notable changes to ReHoarder are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-05-15

Engines tab grows real teeth: a `.uplugin` toggler, per-engine plugin presets
with rollback, and side-by-side master-INI patchers for both
`BaseEditorPerProjectUserSettings.ini` and the per-user
`EditorKeyBindings.ini`. The previous in-source "Ares recommended" template
strings move out to a bundled preset library users can extend.

### Added

#### Engines — plugin toggler
- Engine Plugins panel under the Engines tab: scans
  `<engine>/Engine/Plugins/` for `.uplugin` descriptors with a JSON5-tolerant
  parser (line/block comments, trailing commas), surfaces FriendlyName /
  Description / Category / Version / `EnabledByDefault` / `Installed` plus
  the plugin's `Resources/Icon128.png` over `rh-file://`.
- Flag writes preserve the original formatting via regex-based field
  replacement (insert-before-`Modules` fallback when the field is missing,
  per-file `.bak` safety net).
- Debounced searchbar plus All / Enabled / Installed / Modified filters,
  per-row Reset, batched Apply, "Reset all" for pending edits.
- Right-click an engine row → Open in Explorer / Open plugin folder /
  Toggle "plugins enabled by default".

#### Engines — plugin presets
- JSON preset format (`{ plugins: [{ name, enabledByDefault, installed }] }`)
  with one global fallback path plus per-engine overrides. Drop-in compatible
  with the legacy UnrealPluginToggler shape.
- Right-click on a plugin row → Add to config / Remove from config (only when
  already present) / Uninstall plugin (gated to
  `/Engine/Plugins/Marketplace/<plugin>/` with a confirm dialog).
- Zero-config bootstrap: the first "Add to config" without a configured
  preset plants a default JSON under `userData` and stamps it as the global
  path, so the first right-click click just works.
- "Apply preset to all engines" runs through the same baseline + `.bak`
  safety net the single-plugin IPC uses, and now sits behind a confirm
  modal that names the global path and engine count.
- Per-engine plugin baseline: the first `setPluginState` against an engine
  snapshots every plugin's flags to
  `userData/plugin-baselines/<sha1(engine)>.json` and never overwrites it.
  The Engine Plugins panel shows a "Restore baseline" banner when on-disk
  state diverges, with a confirm dialog reporting the diverging count.

#### Engines — editor settings master patcher
- Port of the `IniPatchService` (parse, serialize, sentinel header,
  scalar / array-add / `CommentAll` merge) wired to the Apply / Restore
  flow against each engine's
  `<engine>/Engine/Config/BaseEditorPerProjectUserSettings.ini`.
- First clean Apply captures the original as `.bak`; the right-click
  context menu opens a side-by-side LCS line-diff preview before the
  actual write, and "Restore editor settings from baseline" appears once
  the `.bak` exists.

#### Engines — keybindings master patcher
- Same patcher pipeline against the per-user, per-engine-version
  `EditorKeyBindings.ini` resolved cross-platform
  (`%LOCALAPPDATA%\UnrealEngine\<ver>\Saved\Config\WindowsEditor\…`,
  macOS Application Support, `$XDG_CONFIG_HOME` on Linux).
- Apply-to-all deduplicates by `major.minor`: multiple installs of the same
  engine version share a single keybindings file, so the per-version file
  is patched once. The confirm modal names the unique-version count.
- Side-by-side diff preview and Restore from baseline reachable from the
  same Engines right-click menu.

#### Engines — preset library
- New `resources/presets/{plugins,keybindings,editor-settings}/` shipped
  via `electron-builder.yml` `extraResources`, the source of truth for
  starter templates. Users (and contributors) can drop `.json` / `.ini`
  files there and they show up in the chooser without code changes.
- INI presets carry their metadata in leading
  `; @label <text>` / `; @description <text>` directives, stripped on
  copy so the on-disk master stays clean.
- Generic `PresetChooserDialog.svelte` (radio list, Enter / double-click
  to confirm, count column tagged "plugin" / "chord rule" / "override")
  replaces the previous pair of "Create sample…" / "Ares recommended…"
  buttons in every section.
- 0.1.1 only ships the `empty` starter in each subdir — the
  Ares-recommended set will land in a follow-up after a manual review pass.

#### Projects — set-as-template
- Copies a project tree into `<Engine>/Templates/<TP_Name>/` skipping
  build / cache folders, renames the `.uproject`, generates an
  English-only `Config/TemplateDefs.ini` and reuses
  `Saved/AutoScreenshot.png` as the launcher icon.
- The dialog suggests `TP_<Name>BP` for Blueprint-only projects so Unreal
  pairs them with an existing C++ template variant.
- Edit and Template actions moved off the per-row button strip into a
  right-click context menu with row-hover highlight and a context-menu
  cursor hint.

#### Library — Fab Giveaway tab
- Monthly freebies fetched from Fab's `free_content_blade` endpoint via
  the same authenticated session library sync uses.
- Listings-states server check enriched with a local cross-reference
  against owned assets (`productUrl` + `customAttributes.ListingIdentifier`)
  so the Claimed flag stays accurate even when the `/me/` endpoint 401s.
- Card grid with 16:9 thumbnails, per-card Claim-on-Fab deep link,
  unclaimed-count badge on the tab, optional
  `focusFreebiesTabAtStartup` setting that opens the tab on launch when
  unclaimed items are waiting.

#### Library — cruft filter
- Glob-based skip-at-download list (built-in defaults + user extras
  configurable from Settings → Downloads), so docs / vendor PDFs / DCC
  source files are dropped before they ever land in the vault.
- Per-asset Clean cruft action in the Vault tab with a scan-preview
  dialog.

#### Vault polish
- Debounced Vault search.
- Optimistic row removal on delete (rescan no longer blocks the UI).
- Hover tooltip with the full glob syntax on the cruft pattern field.

#### Updates — auto-update wiring
- `checkVersionAtStartup` is now actually wired: 1.5 s after the main
  window is created, ReHoarder runs a Velopack check and emits an
  `updates:available` event the Settings panel listens for.
- New `autoDownloadAndInstallUpdates` setting (gated visually + via
  `disabled` on the input when `checkVersionAtStartup` is off): when a
  startup check finds an update, ReHoarder silently downloads and
  installs it, then restarts into the new build.
- New `updates:get-pending-state` IPC + cached `lastCheckSnapshot` so a
  Settings panel mounted after the auto-check still picks up the result
  without firing a duplicate network round-trip.

### Changed

- Settings page reorganised: About & Updates is folded into "Startup &
  behavior" under a subtle divider, "Image size" moved from a standalone
  Appearance panel into the Downloads panel, and the Engines panel is now
  full-width with each "Apply to all" button sitting inline with Clear
  (compact `.primary-inline` variant) instead of the old apply-all-row
  block.
- Every "Apply to all" (plugin preset, editor settings master, keybindings
  master) now opens a confirm modal that names the master path and the
  engine (or unique-version) count, mirroring the look used by the
  Uninstall plugin / Restore baseline confirms in the Engine Plugins panel.
- The "Editor settings preview" Svelte dialog was generalised to
  `IniMasterPreviewDialog` so editor-settings and keybindings share the
  side-by-side LCS diff.

### Removed

- In-source template constants `MASTER_TEMPLATE`,
  `ARES_RECOMMENDED_MASTER`, `KEYBINDINGS_BASIC_TEMPLATE`,
  `ARES_RECOMMENDED_KEYBINDINGS` plus the `pickMasterTemplate` /
  `pickKeyBindingsTemplate` helpers and the
  `engines:create-master-template` / `engines:create-keybindings-template`
  IPCs that consumed them — superseded by the resources-driven preset
  library.

[0.1.1]: https://github.com/Ares9323/ReHoarder/releases/tag/v0.1.1

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
