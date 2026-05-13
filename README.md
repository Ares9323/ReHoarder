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
- **Hide & exclude** _(planned)_ — mark bloat, deprecated, or unwanted assets to keep them out of the active library view and skip them during bulk downloads.
- **Download manager** _(planned)_ — fetches asset manifests and installs them into a chosen UE project or a shared library folder.
- **Duplicate / overlap detection** _(planned)_ — flags assets you own multiple times across Humble Bundle, Fab, and the legacy Marketplace.

## Status

**Pre-alpha — under active development.** Star/watch the repo to follow along.

### What works today

- ✅ **Epic OAuth login** — `authorization_code` flow with refresh token, same scheme used by Legendary/Heroic.
- ✅ **Vault sync** — `/launcher/api/public/assets/Windows?label=Live` + parallel bulk catalog fetch (6 concurrent batches).
- ✅ **Fab UE library sync** — `/e/accounts/{id}/ue/library`, paginated, incremental (early-stop on already-known IDs → seconds for repeat syncs).
- ✅ **Fab Other library sync** — `/i/library/search?source=acquired&asset_formats=…` for non-UE assets (Blender, Maya, FBX, MetaHuman, Unity, etc.).
- ✅ **Cloudflare-aware Fab handshake** — explicit 5-step OAuth dance over Fab + Epic, with `useSessionCookies: true` for Chromium-native cookie management.
- ✅ **SQLite catalog** — assets, tags, sync_state. Hide flag (UI toggle only; download skip pending the downloader).
- ✅ **Search + source filter** in the asset grid.
- ✅ **Epic Chunked Manifest parser** (v0a) — full binary parser for Epic's `0x44BEC00C` format. Pure TypeScript, no new deps. 35 unit tests.
- ✅ **Fab manifest client** (v0b) — POST `/e/artifacts/{artifactId}/manifest`, CDN blob download with SHA1 verify across distribution points, hands off to the parser. 17 unit tests.
- ✅ **Chunk download + file assembly** (v0c) — fetch each `.chunk` from the CDN, verify Poly64 + SHA1, decompress (zlib), assemble files atomically on disk with file-level SHA1 verification. Persistent chunk cache + in-flight URL dedup. 29 unit tests. Real downloads work end-to-end via the debug IPC; the per-asset "Download" button in the UI lands in v0d.

### What's next

- 🚧 **Download UI** (v0d) — "Download" button per asset + Downloads tab with progress per item. The orchestrator is ready; just needs the wiring.
- 📋 **Plugin install + UBT compile** (v0d-e) — copy plugin into engine, optionally `RunUAT BuildPlugin`.
- 📋 **Auto-update detection** — flag assets when `modifiedDate` changes server-side.
- 📋 **Selective engine components** — per-component checkboxes (Source / Android / iOS / etc.) at download time.
- 📋 **Multi-source dedup** — same asset can appear in both the Epic Vault and Fab; ReHoarder will link them via the `legacyItemId` Fab exposes and show a single unified card.
- 📋 See project boards for the full roadmap.

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
- **Svelte** _(tentative)_ for the renderer UI.
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
│   ├── db/          SQLite schema + repos
│   ├── download/    Manifest parser (v0a), manifest client (v0b)
│   ├── fab/         Fab session handshake + library client
│   ├── http/        cookie jar, electron-fetch adapter, user-agents
│   ├── sync/        Orchestrator + normalize
│   └── vault/       Epic Launcher Vault client
├── preload/     Bridge: exposes safe APIs to renderer via contextBridge
└── renderer/    Svelte 5 UI (sandboxed Chromium)
```

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
