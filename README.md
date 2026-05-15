# ReHoarder

> **Reorder your hoard. Then re-hoard.**
> An open-source desktop manager for your ever-growing pile of Unreal Engine assets.

ReHoarder is a cross-platform companion app for Unreal Engine creators who can't stop claiming every "Free for the Month" on Fab, every Epic vault giveaway, and every legacy Marketplace bundle — and then have no idea what they actually own.

It connects to your Epic Games account, indexes everything you've ever acquired across **Fab**, the **Epic Vault**, and the legacy **Unreal Engine Marketplace**, and gives you a single searchable, taggable, filterable library to make sense of it all.

---

## What it does

- **One library, three sources** — unifies Fab, the Epic Vault (UE5+), and the legacy Unreal Engine Marketplace into a single view.
- **Bulk metadata sync** — pulls titles, descriptions, screenshots, categories, supported engine versions, and pricing history for everything you own.
- **Local catalog** — keeps an offline cache so you can browse your library without an internet connection or sign-in round-trips.
- **Auto-claim Fab freebies** _(planned)_ — never miss a monthly free drop again.
- **Tagging and filtering** — organize by your own taxonomy: "used", "for current project", "wishlist", "never going to touch", etc.
- **Hide & exclude** — mark bloat, deprecated, or unwanted assets to keep them out of the active library view (bulk-download skip coming once bulk actions land).
- **Download manager** _(planned)_ — fetches asset manifests and installs them into a chosen UE project or a shared library folder.
- **Duplicate / overlap detection** _(planned)_ — flags assets you own multiple times across Humble Bundle, Fab, and the legacy Marketplace.

## Status

**Public alpha — under active development.** Star/watch the repo to follow along.

### What works today

- ✅ **Epic OAuth login** — `authorization_code` flow with refresh token, same scheme used by Legendary/Heroic.
- ✅ **Vault sync** — `/launcher/api/public/assets/Windows?label=Live` + parallel bulk catalog fetch (6 concurrent batches). Listing in the UI is hidden by default until Epic re-opens the download scope (`launcher:download:Live-Windows:<appName>`), which was removed for third-party clients in 2026.
- ✅ **Fab UE library sync** — `/e/accounts/{id}/ue/library`, paginated, incremental (early-stop on already-known IDs → seconds for repeat syncs).
- ✅ **Fab Other library sync** — `/i/library/search?source=acquired&asset_formats=…` for non-UE assets (Blender, Maya, FBX, MetaHuman, Unity, etc.).
- ✅ **Cloudflare-aware Fab handshake** — explicit 5-step OAuth dance over Fab + Epic, with `useSessionCookies: true` for Chromium-native cookie management.
- ✅ **Multi-source dedup** — assets that appear under both Epic Vault and Fab are reconciled via `legacyItemId` so the library shows a single card per asset.
- ✅ **Epic Chunked Manifest parser** (v0a) — full binary parser for Epic's `0x44BEC00C` format. Pure TypeScript, no new deps. 35 unit tests.
- ✅ **Fab manifest client** (v0b) — POST `/e/artifacts/{artifactId}/manifest`, CDN blob download with SHA1 verify across distribution points, hands off to the parser. 17 unit tests.
- ✅ **Chunk download + file assembly** (v0c) — fetch each `.chunk` from the CDN, verify Poly64 + SHA1, decompress (zlib), assemble files atomically on disk with file-level SHA1 verification. Persistent chunk cache + in-flight URL dedup. 29 unit tests.
- ✅ **Downloads tab** (v0d) — per-asset Download button, persistent queue, live progress bars, per-version chip state in the asset grid (idle / queued / busy / error / downloaded / updatable).
- ✅ **Parallel downloads** — `maxConcurrentDownloads` (1–8) runs that many assets from the queue at once, each with its own progress bar and abort handle. Slot count is hot-reloadable from Settings.
- ✅ **Assets browser** — search, source filter, listing-type filter, category filter, "only downloaded" / "only updatable" / "only bookmarked" toggles. Bookmarks + per-card context menu (open on Fab, copy id, hide, …). Image-size picker.
- ✅ **Vault tab** — list of locally cached assets with friendly names, size, last-modified, sortable headers, optional thumbnails, delete-with-confirm (cascades to clear the chip on the Assets tab).
- ✅ **Projects tab** — recursive scan of configured project roots for `*.uproject`, descriptor metadata (engine association, description, category, code-vs-blueprint), Saved/AutoScreenshot thumbnail (with Fab thumbnail fallback for ReHoarder-created projects), open in Explorer, Launch editor (via `UnrealVersionSelector`), Run game with custom CLI params.
- ✅ **Create project / Add to project** — copy a Fab project template into a new folder under a configured root, or merge an asset pack's `Content/` into an existing project (with skip/overwrite conflict mode). Stamps a `.rehoarder.json` marker so the project is traceable back to its source asset.
- ✅ **Install from vault** — if the artifact is already in a vault path, plugin install into engine/project copies straight from disk without re-downloading. Path-prefix stripping handles the `Engine/Plugins/Marketplace/` indirection cleanly.
- ✅ **Custom install menu** — modal with searchbar, three-tier compatibility (requested-version exact match / older-version dimmed / incompatible hidden), "show N older projects" toggle, and engine-version disambiguation.
- ✅ **Engines tab** — scan for `UE_*/Engine/Build/Build.version`, expose Editor / Run / shell-open per row, branch-name cleanup (`++UE5+Release-5.5` → `UE5 Release 5.5`).
- ✅ **Install engine from Epic library** — `Install engine…` picker on the Engines tab lists owned-but-not-installed UE versions (dedup by `major.minor` against the local scan), components dialog (Core / Templates / Engine Source / MetaHuman / Editor Symbols / Target Platforms with live dependency propagation and selection-size footer), queue through the existing parallel chunk downloader, UAC pre-flight + relaunch flow for protected install paths, post-install bookkeeping that appends to `enginePaths` and registers the engine under `HKCU\…\Builds\{GUID}` so the OS `.uproject` association works. Owned-engines list is persisted to disk with a user-configurable TTL (Settings → Downloads → Owned engines cache, default 7 days) plus a background refresh on launch so reopening the picker after a restart is instant.
- ✅ **Engine plugins toggler** — scans `<engine>/Engine/Plugins/` for `.uplugin` descriptors (JSON5-tolerant), surfaces `EnabledByDefault` / `Installed` flags with the plugin icon, writes flag changes back preserving original formatting (`.bak` safety net). Searchbar + All/Enabled/Installed/Modified filters, batched Apply, per-engine baseline snapshot with one-click "Restore baseline" rollback.
- ✅ **Plugin preset templates** — JSON preset (`{ plugins: [{ name, enabledByDefault, installed }] }`) with one global fallback + per-engine overrides. Right-click on a plugin row → Add to config / Remove from config / Uninstall plugin (Marketplace folder only, behind a confirm). Apply-to-all gated by a confirm modal naming the engine count.
- ✅ **Engine editor-settings master patcher** — applies a curated `BaseEditorPerProjectUserSettings.ini` to every engine's config (sentinel header, scalar/array-add/`CommentAll` merge, `.bak` on first apply, side-by-side LCS diff preview + Restore from baseline on right-click).
- ✅ **Engine keybindings master patcher** — same flow against the per-user `EditorKeyBindings.ini` (`%LOCALAPPDATA%\UnrealEngine\<ver>\…`), dedup-by-version when applying to all (multiple installs of one engine version share the file).
- ✅ **Bundled preset library** — `resources/presets/{plugins,keybindings,editor-settings}/` (shipped via `electron-builder.yml` `extraResources`). INI files carry their metadata in leading `; @label` / `; @description` directives. A generic chooser dialog replaces the previous Create-sample / Ares-recommended buttons in every section.
- ✅ **Set-as-template flow** — copy a project into `<Engine>/Templates/<TP_Name>/`, generate `Config/TemplateDefs.ini`, reuse `Saved/AutoScreenshot.png` as the launcher icon. Blueprint-only projects suggest `TP_<Name>BP` so Unreal pairs them with the C++ template variant.
- ✅ **Fab Giveaway tab** — monthly freebies from Fab's `free_content_blade` endpoint, listings-states server check cross-referenced against owned assets, optional auto-focus at startup when items are unclaimed, per-card Claim-on-Fab deep link.
- ✅ **Cruft filter at download** — glob-based skip list (defaults + user extras), per-asset "Clean cruft" action in the Vault tab with scan-preview dialog.
- ✅ **uproject editor** — JSON editor panel with atomic write + `.uproject.bak` backup; reads & writes `EngineAssociation`, `Description`, `Category`, `Modules`, `Plugins`, `AdditionalDependencies` etc.
- ✅ **Settings panel** — project / engine / vault paths, image size (in Downloads), downloads pane (threads, compile plugins on install, skip non-current-platform binaries, skip cruft at download + extra glob patterns), Engines pane with the three master fields (plugin preset, editor settings, keybindings), per-tab "separate by path" and "show thumbnails" toggles, `Ctrl+S` save shortcut.
- ✅ **On-disk thumbnails** — Projects show their `Saved/AutoScreenshot.png` (with Fab thumbnail fallback for ReHoarder-created projects), Engines show their splash icon, Vault rows can show their cached image. Served through a custom restricted `rh-file://` scheme so the renderer CSP stays tight; allow-list of roots = configured project / engine / vault paths.
- ✅ **Singleton renderer stores** — Vault, Projects, Engines and Downloads each live in a single Svelte store at module scope, so tab switches are free (no rescan unless the user asks for one).
- ✅ **SQLite catalog** — assets, tags, sync_state, downloads, bookmarks. Schema migrations via `PRAGMA user_version` for one-shot fixes (category re-tagging, listing-type backfill, …).
- ✅ **Velopack installer + in-app auto-update** — Windows installer, delta updates, `Settings → Startup & behavior` pane that checks GitHub Releases for the latest `vX.Y.Z` and applies it on next restart. Startup auto-check is now actually wired, and an optional `autoDownloadAndInstallUpdates` flag silently installs + restarts when a newer build is found at launch (with a native Windows toast announcing the restart so the silent quit doesn't look like a crash). No update server required.

### What's next

- 📋 **Intra-asset chunk parallelism** — `downloadThreads` is wired through Settings but the per-asset chunk pool still runs serially. Queue-level parallelism (`maxConcurrentDownloads`) already ships.
- 📋 **Curated `ares-recommended` preset bundle** — the preset library still ships only the `empty` starters as of 0.1.2; the curated baselines (BlueprintAssist, GraphEditor distribute, monitor presets, …) land after a manual review pass.
- 📋 **Source-build engines detection** — installing an engine through ReHoarder writes the `HKCU\…\Builds\{GUID}` entry already, but user-built engines registered outside ReHoarder are not yet surfaced in the Projects tab when an `.uproject` references them by GUID.
- 📋 **Mid-download engine manifest refresh** — Epic's signed CDN URLs are good for ~60 min; on slow internet a 100+ GB engine download may outlive its signatures and start 403-ing. Cancel + re-enqueue works today (it re-fetches and resumes from the persisted chunk cache), but seamless refresh-without-cancel is a follow-up.
- 📋 **Auto-claim Fab freebies** — the Freebies tab surfaces them today, but claiming still requires opening Fab in the browser.
- 📋 **Auto-update detection on assets** — flag library assets when their server-side `modifiedDate` changes (the data is already in the catalog).
- 📋 **Linux/macOS pass** — the download pipeline is platform-agnostic but plugin-compile and engine-launch flows still assume Windows path conventions in spots.

## Why another asset manager?

ReHoarder aims to be:

- **Fully open source** (MIT) — readable, auditable, forkable.
- **Cross-platform first-class** — Linux, Windows, and macOS treated as equals from day one.
- **Privacy-respectful** — your account credentials and library data stay on your machine.

## Platforms

- Windows 10/11
- Linux (any modern distro)
- macOS _(planned)_

## Tech stack

- **Electron** + **TypeScript** for the desktop shell and OAuth-via-embedded-browser flow.
- **Svelte 5** (runes) for the renderer UI.
- **SQLite** for the local library catalog.

## Disclaimer

ReHoarder is an unofficial third-party tool. It is **not affiliated with, endorsed by, or sponsored by Epic Games, Inc.** "Unreal Engine", "Fab", and "Epic Games" are trademarks of Epic Games, Inc. ReHoarder communicates with public Epic and Fab endpoints using the same conventions as the official Epic Games Launcher; you are responsible for ensuring your use complies with Epic's Terms of Service.

## Development

### Prerequisites

- Node.js 22+ (LTS recommended)
- A C++ toolchain (for `better-sqlite3` native compile):
  - **Windows:** Visual Studio Build Tools with "Desktop development with C++"
  - **Linux:** `build-essential python3`
  - **macOS:** Xcode Command Line Tools

### Setup

```bash
git clone https://github.com/Ares9323/ReHoarder.git
cd ReHoarder
npm install
```

### Common commands

```bash
npm run dev           # Start Electron with hot reload
npm run build         # Bundle for production (no installer)
npm run build:win     # Bundle + create Windows installer
npm run build:linux   # Bundle + create AppImage + .deb
npm run build:mac     # Bundle + create .dmg
npm run lint          # Lint all sources
npm run format        # Format all sources with Prettier
npm run typecheck     # Run TypeScript checks (no emit)
npm test              # Run unit tests once
npm run test:watch    # Run tests in watch mode
```

### Project layout

```
src/
├── main/        Node-side process: window, DB, IPC handlers
│   ├── auth/        OAuth + Epic web session
│   ├── cloudflare/  cf_clearance warmup
│   ├── db/          SQLite schema + repos (assets, downloads, kv)
│   ├── download/    Manifest parser (v0a), manifest client (v0b), chunk download + assembly (v0c)
│   ├── fab/         Fab session handshake + library client
│   ├── http/        cookie jar, electron-fetch adapter, user-agents
│   ├── sync/        Orchestrator + normalize (Fab UE + Other, Vault, dedup)
│   ├── vault/       Epic Launcher Vault client
│   ├── engines-*    Engine scan + IPC
│   ├── projects-*   Project scan, descriptor read/write, create/add-to, install-from-vault
│   ├── downloads-*  Persistent download queue, broadcasts, IPC
│   └── settings*    User settings (paths, toggles) via SQLite KV
├── preload/     Bridge: exposes safe APIs to renderer via contextBridge
└── renderer/    Svelte 5 UI (sandboxed Chromium)
    ├── lib/         Components: AssetCard, CustomInstallMenu, CreateProjectDialog, UProjectEditorPanel, ...
    ├── stores/      Singleton runes stores (vault, projects, engines, downloads, settings-events)
    └── views/       Top-level tab views (Assets, Vault, Projects, Engines, Downloads, Settings)
```

### Release with Velopack (Windows)

ReHoarder uses [Velopack](https://velopack.io) for installers + in-app auto-update. The flow is:

1. `electron-vite build` produces the JS bundles.
2. `electron-builder --dir --win` packs them into a real `ReHoarder.exe` under `release/win-unpacked/`.
3. `vpk pack` reads that directory and emits `Releases/ReHoarder-Setup.exe` plus the delta-package + `RELEASES` index that the in-app updater consumes.
4. `vpk upload github` attaches all of the above to a GitHub Release matching `vX.Y.Z`.

**Local prerequisites:**

```bash
# Once per machine — vpk is a dotnet 8 global tool
dotnet tool install -g vpk
```

**Cut a release locally:**

```bash
# 1. Bump version in package.json (e.g. 0.1.0)
# 2. Build + pack
npm run build:win
# Outputs land under ./Releases/ — verify by running ReHoarder-Setup.exe in a VM.
# 3. Upload to GitHub (needs $env:GITHUB_TOKEN with `repo` scope)
$env:GITHUB_TOKEN = "ghp_..."
npm run release:win
```

**Cut a release from CI:**

Push a tag — `.github/workflows/release.yml` triggers on `v*` tags. The workflow installs `vpk`, runs `build:win` and `release:win` using the built-in `GITHUB_TOKEN`. No secret setup required.

```bash
git tag v0.1.0
git push origin v0.1.0
```

In-app updates: the `Settings → About & updates` pane uses Velopack's `UpdateManager` to check `github.com/Ares9323/ReHoarder` for the latest release, downloads the delta when available, and applies it on the next restart. No update server / S3 bucket required.

### Dev exe rebrand (Windows)

By default `npm run dev` launches Electron's bundled `electron.exe`, so Windows' Task Manager shows the helper processes as "Electron". The `predev` hook runs `scripts/brand-dev-electron.cjs`, which uses [`rcedit`](https://www.npmjs.com/package/rcedit) to rewrite the Win32 version-info on the local `node_modules/electron/dist/electron.exe` so it shows up as "ReHoarder" instead. The script is idempotent (stamps a `.rehoarder-branded` marker next to the exe) and re-runs automatically whenever `npm install` replaces the binary. It's a no-op on Linux/macOS; on Windows you only need to make sure `npm install` has been run after the `rcedit` devDep was added.

For packaged builds (`npm run build:win` / `:linux` / `:mac`) the rebrand is unnecessary — `electron-builder.yml`'s `productName: ReHoarder` already names the distributed binary correctly.

### Debug commands (DevTools console)

The app exposes a `window.api.debug` namespace for testing internals while the UI for downloads is still in progress. Open ReHoarder, hit `Ctrl+Shift+I`, switch to the Console tab.

```js
// List the first 5 assets from a source (helpful to grab an assetId)
const list = await window.api.library.list({ source: 'fab' })
list.assets.slice(0, 5).map(a => ({ id: a.sourceId, title: a.title }))

// End-to-end test of the parser + manifest client against the real Fab CDN.
// Fetches /e/artifacts/{artifactId}/manifest, downloads the binary blob with
// SHA1 verify, parses it, and dumps both the raw blob and the parsed JSON to
// %APPDATA%/ReHoarder/debug/ on Windows (or the equivalent userData dir).
await window.api.debug.fetchSampleManifest('<assetId>')
// → { ok, fileCount, chunkCount, totalFileSize, baseUris, savedBlobPath, savedJsonPath, ... }

// Full end-to-end download of a real asset into
// <userData>/debug-downloads/<artifactId>/data/. Fetches the manifest,
// downloads every chunk from the CDN, verifies Poly64 + SHA1 on each
// chunk and on every assembled file, writes the files atomically. Pick a
// SMALL asset first (under ~50 MB) for the initial test.
await window.api.debug.downloadSampleAsset('<assetId>')
// → { ok, fileCount, bytesWritten, durationMs, dataDir, firstFiles, ... }

// Wipe the local library + sync_state so the next sync runs as a full sync.
// Useful when re-testing the sync pipeline end-to-end.
await window.api.debug.clearLibrary()
// → { ok, assetsRemoved, tagsRemoved, syncStateRowsReset }

// Wipe only one source (e.g. just Fab) — Vault stays intact.
await window.api.debug.clearLibrary({ sources: ['fab'] })

// Kick off a sync programmatically (same as pressing "Sync now" in the UI).
await window.api.library.sync()
```

These IPCs are dev-only and will be removed (or gated behind a setting) before the first stable release.

## License

[MIT](LICENSE) © 2026 Ares9323
