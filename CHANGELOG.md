# Changelog

All notable changes to ReHoarder are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] — 2026-05-16

Quick-action set lifted from AMS, scoped to Projects and Engines tabs.
Project right-click menu gains Fix redirectors / Delete binaries & caches /
Deep clean (with a per-`Saved/` preserve modal) / Create desktop shortcut.
Engines tab gains Set as default engine, Create desktop shortcut, and a
guarded Uninstall engine flow with HKCU registry de-registration.

### Added

#### Projects — Quick Actions context menu
- **Fix redirectors** — spawns
  `UnrealEditor-Cmd.exe <uproject> -run=ResavePackages -fixupredirects
   -autocheckout -projectonly -unattended`
  against the project's resolved engine (same `EngineAssociation` →
  `enginePaths` lookup `projects:run-game` already uses), buffers the
  tail of stdout/stderr and surfaces it in the failure case via a
  "Show output" modal next to the toast.
- **Delete binaries & caches** — silent wipe of `Binaries/`,
  `Intermediate/`, `DerivedDataCache/`, `.vs/` plus the transient parts
  of `Saved/` (`Crashes/`, `Logs/`, `Autosaves/`, `Backup/`, `Cooked/`,
  `SourceControl/`, top-level `*.tmp`, `StagedBuilds/`, `LocalBuilds/`).
  Always preserves `Saved/Config/` (folder colors + layout +
  per-project user settings), `Saved/Collections/` (named `.collection`
  files), `Saved/SaveGames/`, and `Saved/AutoScreenshot.png` (used by
  ReHoarder's project card thumbnail).
- **Deep clean…** — same wipe as above, but driven by a confirm dialog
  with 5 preserve checkboxes (Editor preferences / Asset collections /
  Save games / Project thumbnail / Local packaged builds; first four
  default ON, last default OFF). A `Keep none` button deselects all
  five for the "literally wipe everything I know about" case.
  Genuinely-unknown `Saved/` entries (plugin caches like
  `BlueprintAssist/`, build-tool state like `UnrealBuildTool/` and
  `ShaderDebugInfo/`, etc.) are always preserved as a safety net —
  better than silently nuking persistent plugin data.
- **Create desktop shortcut** — writes a `.lnk` to the user's Desktop
  pointing at the `.uproject`, with the project's directory as
  working dir.

#### Engines — actions
- **Set as default engine** — new `settings.defaultEngineVersion`
  (short slug like `5.5` / `4.27`). The matching engine row gets a
  pink `Default` badge in the Engines table. Default-engine context-menu
  toggles between `Set as default engine` and `Clear default engine`
  depending on the current state.
- **Create desktop shortcut** — writes a `.lnk` pointing at the
  engine's `UnrealEditor.exe` with the editor exe as both target and
  icon source.
- **Uninstall engine…** — confirm modal naming the path + the
  registry de-reg side effect, then recursively removes the engine
  directory, deletes its `HKCU\Software\Epic Games\Unreal Engine\Builds\{GUID}`
  entry (GUID derived from the install path the same way the install
  flow registered it), and prunes the parent from `settings.enginePaths`
  when it was the only engine living there. Reports freed bytes +
  registry/path side effects in the toast.

#### Renderer plumbing
- Per-tab quick-action banner *stack* (Projects + Engines): every
  action gets its own row with its own dismiss `×`, so kicking off a
  second action while the first is still running doesn't overwrite
  the first banner — both stay visible. Fix-redirectors output is
  routed through a separate `Show output` modal with Copy/Close.
- Engine + Project context menus now clamp themselves to the viewport
  on render — right-clicking a row near the window edge no longer
  crops the menu. Position is measured after mount via `bind:this`
  + `$effect`; if `right > innerWidth - 8` or
  `bottom > innerHeight - 8` the menu shifts left/up to fit.

### Main-process modules

- `src/main/projects-actions.ts` — `cleanupRedirectors`,
  `cleanBuildArtifacts`, `deepCleanProject`. All three operate on a
  single project, guarded against `projectPaths`; the `Saved/` walker
  has an explicit `SAVED_MANAGED_BY_TOGGLE` allow-list so unchecking
  a preserve toggle in Deep clean actually deletes that subfolder
  (the previous fallback "unknown → preserve" branch was bypassing
  user intent for `Config/` and `Collections/`).
- `src/main/engine-actions.ts` — `uninstallEngine` +
  `createWindowsShortcut`. The shortcut path uses a temp VBS through
  `wscript.exe` (the same canonical Windows pattern the elevation
  relaunch uses since 0.1.3) — no PowerShell execution policy concerns,
  no native bindings.

### Known gap

- **Install missing toolchain** (AMS counterpart: download + run
  Visual Studio Build Tools / Windows SDK / .NET) is deferred to a
  later release. The flow needs `vswhere`-based detection of already-
  present components, a UAC-elevated installer spawn, and a progress UI
  for a multi-GB Microsoft bootstrapper — enough surface area to deserve
  its own focused turn rather than getting bundled in here.

[0.1.5]: https://github.com/Ares9323/ReHoarder/releases/tag/v0.1.5

## [0.1.4] — 2026-05-15

Creator / seller name surfaced on every asset card and now part of the
library search. No new sync round-trip required: the data was already
in the cached `assets.raw` JSON, this release lifts it into a dedicated
column and renders it on the card.

### Added

- New `seller` column on `assets` (`raw.seller` for Fab UE,
  `raw.publisher.sellerName` for Fab Other, `raw.catalog.developer` for
  Epic Vault). Backfilled on first launch via `PRAGMA user_version = 3`
  with three single-pass SQL UPDATEs (`json_extract` against the existing
  `raw` blobs — no re-parse on the JS side, no network round-trip).
- Asset cards now render a `by <Seller Name>` line below the title.
  Clicking it opens a Fab search filtered by that name
  (`https://www.fab.com/search?q=<encoded>`) — Fab doesn't expose a
  stable seller-profile URL in the library payload, so the search route
  is the safe fallback that surfaces "everything else by this creator".
  Hidden when the upstream payload didn't carry a seller value.
- Library search (`library:list` IPC) now matches the search query
  against `seller` in addition to `title` and `description`. Typing
  "infinity pbr" surfaces every asset by that publisher, not only the
  ones with the phrase in the title.

### Fixed

- `applySchema` was running migrations *before* the `CREATE TABLE`
  statements, so on a truly-fresh database `tryAddColumn` no-op'd
  against a not-yet-existing `assets` table and the columns that came
  in as migrations (`bookmarked`, `sub_source`, `listing_type`, and now
  `seller`) never got added on that first launch. Reordered to create
  tables first then migrate — idempotent for existing installs, makes
  the test suite's `:memory:` fixtures converge in a single pass, and
  unbreaks 17 vitest cases that had been failing on `master` against
  the `WHERE assets has no column named sub_source` SQL error.

[0.1.4]: https://github.com/Ares9323/ReHoarder/releases/tag/v0.1.4

## [0.1.3] — 2026-05-15

Patch release that unsticks two pain points reported against 0.1.2: the
`Relaunch as administrator` button doing nothing on Velopack-installed
copies, and the Vault tab stalling 10+ s on "Loading vault…" every first
open. Also covers the persistent download-folder open glitch that fired
the "Path is outside the configured vault roots" toast on running engine
rows.

### Fixed

- `Relaunch as administrator` now actually re-launches ReHoarder under
  UAC on Velopack installs. The old path spawned `powershell.exe -Verb RunAs`
  detached + window-hidden, then quit 200 ms later — on installed copies
  the parent's job-object teardown reliably killed the PowerShell child
  before `Start-Process -Verb RunAs` had pushed the elevation request to
  `consent.exe`. Switched to a temporary VBScript driven through
  `wscript.exe` calling `Shell.Application.ShellExecute("ReHoarder.exe", "", "", "runas", 1)`
  (same pattern used by `sudo-prompt` and legacy Squirrel updaters):
  wscript finishes within a few hundred ms, after which the UAC chain is
  owned by `consent.exe` + the elevated session and is fully decoupled
  from ReHoarder's process tree. Bumped the parent-quit delay to 800 ms
  so wscript has time to load the script + fire `ShellExecute` before
  we exit.
- `Open` button on a running engine download no longer surfaces
  "Path is outside the configured vault roots". The `downloads:open-in-explorer`
  IPC now trusts any path that matches the `destDir` of an existing
  `downloads` row in addition to the configured vault / engine / project
  roots — ReHoarder wrote that path itself at enqueue time after the
  user went through the elevation pre-flight + picker, so it's
  implicitly authorised even before `finalizeEngineInstall` appends the
  parent dir to `settings.enginePaths` (which only happens at `status='done'`).

### Changed

- Vault tab opens instantly on app launches where it has been visited
  before, and only stalls on the very first session boot. Two changes:
  1. `App.svelte.onMount` warms `vaultStore.ensureLoaded()` in the
     background right after auth lands, so by the time the user clicks
     the tab the scan is already complete (singleton store survives tab
     switches). The "Only Downloaded" filter on Assets benefits too.
  2. `listLocalVault` parallelised at two levels: the per-asset walks
     now run via `Promise.all` (wall time drops from
     `sum(perAsset)` to `~max(perAsset)`), and inside each `walk` the
     `stat` calls on files + recursive descent into subdirectories fire
     concurrently against the libuv thread pool. On a 50-asset vault
     with ~thousands of files each, the "Loading vault…" delay collapses
     from 10+ s on NVMe to ~1–2 s.

[0.1.3]: https://github.com/Ares9323/ReHoarder/releases/tag/v0.1.3

## [0.1.2] — 2026-05-15

Engine downloads ship end-to-end: the Engines tab can now pull a UE binary
straight from the Epic launcher manifest with a components picker (Core /
Templates / Engine Source / MetaHuman / Editor Symbols / Target Platforms),
queue it through the same parallel chunk downloader Fab assets use, and
register the install with the OS once it lands. The auto-update flow gains
a system-toast restart notice, and the Install-engine picker now keeps the
owned-versions list cached on disk so reopening the dropdown after a
restart is instant.

### Added

#### Engines — install from the Epic library
- New `Install engine…` button on the Engines tab opens a popover listing
  every engine SKU the signed-in account owns and doesn't already have on
  disk (dedup by `major.minor` against the local scan).
- Components picker dialog: required Core (greyed, "Required" label),
  Templates / Engine Source / Starter Content / MetaHuman / Editor Symbols
  as optional rows (sensible defaults: Templates + Engine Source on),
  Target Platforms collapsed by default with a live "N selected" badge,
  live dependency propagation (tvOS implies iOS) and a live
  "Selection size" footer.
- Older Unreal versions (UE 4.x / 5.0) ship without per-file `InstallTags`,
  so everything rolls up under Core — the dialog detects that shape and
  surfaces a blue info banner explaining the engine doesn't expose
  components instead of looking like a bare bug.
- Confirm hands off to the same `DownloadsManager` queue Fab uses: shared
  parallelism budget, abort handles, persistent recovery, Downloads-tab
  progress UI, chunk cache, Poly64 + SHA1 verification on every chunk.
- Suggested install dir defaults to `<enginePaths[0]>/<appName>` when at
  least one engine path is configured, falling back to `<home>/Epic Games/<appName>`
  on a fresh user — both reliably writable from a non-elevated process.

#### Engines — UAC elevation prompt
- Install confirm runs a pre-flight `engine-downloads:check-install-dir`
  IPC that flags Windows-protected roots (Program Files, Program Files
  (x86), Windows) and detects whether ReHoarder is currently admin-elevated
  (via the `net session` exit-code trick, with stdio suppressed).
- When the chosen dir needs admin and we don't have it, a modal halts the
  flow before queueing a doomed download: <em>"This install location
  needs admin — relaunch ReHoarder elevated to install here, or pick a
  user-writable folder"</em> with `Pick another folder` /
  `Relaunch as administrator` buttons.
- The Relaunch button spawns `powershell.exe -Verb RunAs` against the
  same `process.execPath`, triggering Windows' UAC prompt, then quits
  after a 200 ms beat so the elevated child reliably claims the prompt
  on 22H2 fast-launch installs. Downloads queue + library + settings
  persist across the relaunch.
- In dev (`npm run dev`) the relaunch refuses early with a clear error,
  since `process.execPath` points at the bundled
  `node_modules/electron/dist/electron.exe` rather than a packaged
  ReHoarder.exe — running `npm run dev` from a terminal you started with
  "Run as administrator" is the working alternative.

#### Engines — post-install bookkeeping
- When the chunk runner finishes successfully, the install location's
  parent directory is appended to `settings.enginePaths` (case-folded on
  Windows to avoid duplicate equivalent entries).
- On Windows, the new engine is registered under
  `HKCU\Software\Epic Games\Unreal Engine\Builds\{GUID}` via `reg.exe`,
  so `.uproject` files opened with the OS file association resolve
  through `UnrealVersionSelector`. The GUID is derived deterministically
  from the SHA1 of the normalised install path — re-installing into the
  same location reuses the existing registration instead of accumulating
  duplicates.
- A `engine-downloads:installed` IPC broadcast wakes the Engines tab,
  invalidates the picker's owned cache, retriggers the local scan and
  flashes a toast (<em>"UE_X.Y installed at &lt;dir&gt;. Added &lt;parentDir&gt;
  to engine paths. Registered with UnrealVersionSelector."</em>).
- Non-Windows hosts skip the registry step (UVS doesn't exist there and
  `.uproject` `EngineAssociation` resolves by path), only the
  `enginePaths` append runs.

#### Engines — persistent owned-engines cache
- The `Install engine…` picker now reads its list from a disk-backed
  cache (`KvStore` key `owned_engines_cache_v1`) instead of the
  in-memory warm-up from 0.1.1 — first click after any app restart is
  instant.
- New setting `Owned engines cache` (Settings → Downloads), 0–30 days,
  default 7: controls how long the cache stays valid before the next
  refresh. `0` disables the cache and always hits the network.
- Background refresh runs 4 s after launch (once `session.init` has had
  time to land a token), bypassing the TTL only when the cache is
  already stale, so the next user click is instant even on a cold boot.
- Picker footer shows "Cached / Fetched &lt;relative-time&gt;" plus an
  explicit `Refresh` button that bypasses the TTL — useful right after
  claiming a new UE on the Epic launcher in parallel.
- When not authenticated, the picker now serves the stale cache with a
  "Log in to refresh" hint instead of erroring out.

#### Updates — restart notification
- When `autoDownloadAndInstallUpdates` is enabled and the startup check
  installs a new build, ReHoarder fires a native Windows toast
  (<em>"ReHoarder is updating — Restarting to install version X.Y.Z…"</em>)
  via `electron.Notification` before handing off to the Velopack updater
  and quitting. The toast is queued via the configured `AppUserModelId`,
  so Windows preserves it in Action Center even after the app exits —
  no more "did it crash?" moment during a silent auto-update restart.

### Changed

- `downloads:open-in-explorer` IPC now trusts any path that matches the
  `destDir` of an existing `downloads` row, in addition to the
  vault / engine / project root allow-list. Fixes the "Path is outside
  the configured vault roots" error that fired when clicking Open on a
  running engine download (the install dir isn't appended to
  `enginePaths` until the row reaches `done`).
- Default suggested install dir changed from `C:\Program Files\Epic Games\<appName>`
  to a user-writable path. The legacy default silently required admin
  elevation, so the chunk runner's first `mkdir` always failed with EPERM
  before the first byte landed — the new default routes through the
  `engine-downloads:suggest-install-dir` IPC and prefers the first
  configured engine path with `<home>/Epic Games/<appName>` as the fallback.

### Fixed

- Elevation confirm modal painted underneath the EngineDownloadDialog
  because both shared `z-index: 290` and `EnginesView.svelte` had no
  scoped CSS for `.confirm-backdrop` / `.confirm-popup` / `.confirm-actions`
  (Svelte scopes styles per file). Added the missing styles and bumped
  the elevation backdrop to `z-index: 320` via a new
  `.elevation-prompt-backdrop` modifier.
- First click on `Install engine…` no longer stalls 5–10 s on
  `listOwnedAssets` + bulk catalog metadata: `EnginesView.onMount`
  warms the owned-engines list in the background alongside the local
  scan, and the new persistent cache (see above) survives restarts so
  the latency is hidden behind whatever else the user is doing.

[0.1.2]: https://github.com/Ares9323/ReHoarder/releases/tag/v0.1.2

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
