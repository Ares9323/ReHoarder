# Changelog

All notable changes to ReHoarder are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-09-17

Asset grid density is now adjustable on the fly with Ctrl+wheel, the whole card thumbnail opens the marketplace listing, and the Settings panel stops looking like it auto-saves: the Save button rides along in a sticky header and changing a path list refreshes the tab that scans it.

### Added

- **Grid zoom on the Assets tab** — `Ctrl` + wheel resizes the card grid, with `Ctrl` + `+` / `Ctrl` + `-` for anyone without a wheel and `Ctrl` + `0` to fall back to the Settings preset. One step is exactly one column more or less rather than an arbitrary pixel bump: the grid keeps its `auto-fill` / `minmax` layout and zoom solves for the minimum card width that yields the target column count, so a zoomed grid still reflows on window resize. The chosen width persists in `localStorage` and survives tab switches and restarts; changing **Image size** in Settings clears it. An ephemeral readout reports the resulting column count and the available shortcuts. Column math lives in `grid-zoom.ts` behind 13 unit tests, covering reversibility, the clamp boundaries and the flooring rule that keeps `auto-fill` from dropping a column.
- **"Unsaved changes" indicator in Settings** — pending edits get an amber label plus a pulsing ring on the Save button (suppressed under `prefers-reduced-motion`), so a greyed-out button no longer reads as "already saved".

### Changed

- **Asset thumbnails are the link** — clicking a card's image opens its marketplace listing, with a pointer cursor, a hover zoom and an "Open on Fab" tooltip. This replaces the clickable source badge, which is now a plain label and is rendered only when the library actually mixes sources (a Fab-only library would otherwise stamp the same badge on every card). Cards with no product URL keep a non-interactive image.
- **Settings' Save button moved into a sticky header** — it stays in the top-right corner while the panel scrolls, so long sections no longer mean scrolling back up to save. Sticky rather than floating, so it can never overlap a settings group on a narrow window. Save feedback and error text moved with it.
- **Electron's default application menu is no longer installed on Windows and Linux** — its `zoomIn` / `zoomOut` / `resetZoom` roles swallowed `Ctrl` + `+` / `-` / `0` before the renderer could see them. The window already ran with `autoHideMenuBar`, DevTools and reload come from `optimizer.watchWindowShortcuts`, and text-editing shortcuts are handled natively by Chromium. macOS keeps its menu bar, which is the app's only route to Quit / Hide.

### Fixed

- **Changing a path list in Settings now refreshes the tab that scans it** — editing **Project paths**, **Unreal Engine paths** or **Vault paths** rescans Projects, Engines or Vault respectively. The tab views are destroyed while the user is in Settings, so their own settings-save listeners never fired and their singleton stores kept serving the pre-save cache until a manual Rescan. Only the lists that actually changed are rescanned, comparison is order-sensitive (vault roots follow a "first writable path wins" rule, so a reordering is a real change), and the work starts in the background while the user is still in Settings so the data is ready by the time they switch tabs.

## [0.3.0] — 2026-08-22

Local Vault gains project-kind handling, persistent per-asset metadata, and engine-version inference, so downloaded projects and orphan asset packs get first-class Create / Add-to-project actions. Freebies moves to a manual per-account claim model with a change-only weekly notification.

### Added

- **Project kind in the Vault**: `detectKind` recognises a `data/*.uproject` as a `project` (checked before plugin / asset), surfaced as a pill. Project rows offer **Create project** (default name taken from the `.uproject` basename) and **Add to project** (copies only `Content/`, with a warning that files outside `Content/` are not copied).
- **Metadata sidecar**: a per-asset `.rehoarder.json` (`type: vault-asset`) persists source / sourceId / engineVersion / kind independent of the downloads DB. Written on download completion and backfilled during the scan, so hand-copied and orphaned assets keep working.
- **Engine-version inference for orphans**: assets with no DB row get a version from the `.uproject` `EngineAssociation` (projects) or the `.uasset` / `.umap` header `FileVersionUE5` (asset packs), so the version guard runs even without library metadata.
- **Custom-folder pickers**: both dialogs get a "Custom folder…" button (native picker) so the parent (Create) or the target project (Add) can live outside the configured roots. Add-to-project inspects the chosen folder for a `.uproject` and reads its `EngineAssociation`.
- **Manual freebie claims**: per-card "Mark as claimed" toggle and a "Mark all as claimed" action, stored per account. Marking clears the tab badge and the startup toast.

### Changed

- **Add-to-project version guard is now target-newer-or-equal**: a project is compatible when its engine is the same as or newer than the asset's version (UE is forward-compatible). An unknown asset version is allowed with a warning instead of being blocked, and the backend re-checks the same rule. Add / Create operate on the vault folder path, so they no longer require a downloads row.
- **Freebies claimed state is manual-only**: the flaky `/me/listings-states` auto-detection and the local ownership cross-reference were removed. A freebie is claimed only when the user marks it.
- **Freebies auto-check** is a per-account 7-day cap plus a UID change-diff. It no longer kicks a full library sync, and the startup notification re-shows only when the free set changes.
- **Vault auto-refresh** is app-lifetime: a download finishing while the Vault tab is closed still invalidates the cached scan, so reopening the tab shows the new asset without a manual Rescan.

### Fixed

- **Vault sidecar and the project marker no longer collide**: the vault sidecar carries a `type: vault-asset` discriminator, so a created-project `.rehoarder.json` marker inside a scanned folder is not misread as vault metadata.
- **On-disk kind wins over a stale sidecar**: the scan prefers the freshly detected kind unless the disk read is inconclusive.

## [0.2.2] — 2026-05-29

Re-patch hygiene for the INI master patcher: idempotent comment handling and removal of the legacy UnrealPluginToggler sentinel.

### Fixed

- **Comment blocks no longer duplicate when re-patching** — `removeKeyFromSection` now drops the contiguous comment / directive lines that precede a multi-value key alongside the value lines, mirroring how `extractValueBlocks` folds that leading block into the value block. Previously every re-patch re-inserted the master's comment block on top of the comments already present, so documentation lines above arrays like `UserDefinedChords` doubled on each apply.
- **Legacy `UnrealPluginToggler` sentinel is now stripped on patch** — `hasSentinel` recognises the predecessor tool's `; === Patched by UnrealPluginToggler … ===` header, so the strip path actually fires for files only the old tool had touched, and `stripSentinelHeader` removes *every* sentinel line rather than just the first. A stale legacy header can no longer survive buried below a fresh ReHoarder one.

## [0.2.1] — 2026-05-28

On-demand thumbnail refresh from Fab's listing-detail endpoint, surviving subsequent syncs.

### Added

- **"Refresh from Fab" right-click on Fab asset cards** — pulls the live listing detail from `https://www.fab.com/i/listings/<uid>` (the same endpoint fab.com's listing page uses, public + Cloudflare-gated → routed through the existing `electron.net.fetch` adapter on the `cf-warmup` partition) and updates the asset's `image_url` in the DB. Picks the URL from the dedicated top-level `thumbnails[]` block (`type: "thumbnail"`) — Fab's canonical featured image, the same one their search list shows — falling back to the first `medias[]` gallery slot when no `thumbnails[]` is present. Always takes the widest sized variant (1280 px on a typical listing). Solves the "creator updated the asset image but the library endpoint is still serving the snapshot from acquisition time" case that no amount of HTTP-cache flushing could fix. Errors surface inline below the card (cleared on click).
- **`FabClient.fetchListingDetail(uid)` + `pickListingImageUrl(detail)`** — the new endpoint client and the image-picker heuristic.
- **`assets.last_precise_at` column + `AssetsRepo.updateImageUrlAndPreciseAt`** — new nullable INTEGER (ms timestamp), stamped whenever a row's `image_url` is set via the listing-detail flow. Drives the upsert preservation rule (see Changed below) so the user's per-asset refresh isn't clobbered by the next manual sync.

### Changed

- **Asset upsert preserves `image_url` for rows previously refreshed via listing-detail** — the `INSERT ... ON CONFLICT` clause now uses `CASE WHEN assets.last_precise_at IS NULL THEN excluded.image_url ELSE assets.image_url END`, so re-syncing the library doesn't undo a per-asset Refresh-from-Fab. Rows never touched by the listing-detail flow still receive the library endpoint's `image_url` as before.

## [0.2.0] — 2026-05-27

Preset system overhaul (provenance markers, per-entry user-override merge, renamed user files), curated `ares-recommended` bundle shipped for the three preset families, baseline policy for marketplace plugins with a custom hover popover that lists every plugin Restore would touch, an `Add to project` action on Local Vault asset entries, a startup-tab preference in Settings, account-switcher re-link affordance for accounts whose tokens have expired, and a temporary skip of the Fab Other-library sync (endpoint returns 401, root cause under investigation).

### Added

#### Preset system
- **Provenance markers on apply** — every template apply stamps `; @source <id>` / `; @applied <ISO>` on INI files and `_source` / `_applied` fields on the plugin JSON. They sit ignored by UE and survive subsequent user edits ("Add to config" / "Remove from config") so future flows can offer "reapply latest" or drift detection against the source template. INI directives are stripped on every fresh apply so they never accumulate.
- **`fromUser` flag for user overrides** — plugin entries added or modified via "Add to config" carry `"fromUser": true`. When the template is re-applied, `useBuiltInPlugin` keeps every `fromUser` entry verbatim and overwrites only the rest with fresh template state. The user's hand-picked overrides survive upstream template updates instead of being silently blown away.
- **Curated `ares-recommended` bundle** —
  - Plugins (`resources/presets/plugins/ares-recommended.json`, 16 entries): strips 7 alternative Source Code Access providers (N10X, CLion, CodeLite, KDevelop, Null, VSCode, XCode), Apple ImageUtils / MoviePlayer / SpeedTreeImporter, and enables BlueprintAssist plus five marketplace tools (OctaGraph, AdvancedEditorUtilities, AdvancedRestartEditor, LevelBookmarks, ComponentSorter — no-op on engines that don't have them installed).
  - Keybindings (`resources/presets/keybindings/ares-recommended.ini`, 92 entries / 184 chord lines): BlueprintAssist default cleanups (clear `X` / `Alt+S` / `Alt+G` / `Ctrl+Alt+S` / `Ctrl+Alt+G`), personal `Alt+L` Level Blueprint / `Alt+Shift+L` Find Actor / `Shift+Esc` Stop-PIE shortcuts, and a 79-entry Italian-keyboard alt-chord remap layer that pins `E_AccentGrave` / `+` / `ò` / `ù` as `ChordIndex:1` secondaries on every Epic command that uses `LeftBracket` / `RightBracket` / `SemiColon` / `Backslash` (brush size in 10 modeling contexts, sequencer navigation, editor viewport grid sizes, foliage / landscape / mesh-paint brushes, dataflow weight-map paint, curve editor selection, level viewport `EnablePreviewMesh` / `CyclePreviewMesh`, level editor `BuildLightingOnly`, landscape `IncreaseAlphaBrushRotation` / `DecreaseAlphaBrushRotation`). Each chord pair has an inline `;` comment documenting context + primary/secondary so the file stays readable in a diff.
  - Editor settings (`resources/presets/editor-settings/ares-recommended.ini`): monitor resolution presets (HD/Full HD/QHD/4K/5K in 16:9, 16:10, 21:9), Live Coding disabled, Visual Studio set as Source Code Access provider, Blueprint editor tuned (`SaveOnCompile=SoC_SuccessOnly`, hover bubble for zoomed-out comments, NodeTemplateCache 50 MB, …), BlueprintAssist auto-formatter set to manual.
- **`example` starter template** — replaces the old `empty` + `annotated` dual templates. INI variants ship inline format documentation plus commented-out example blocks (scalar override, `; @ReHoarder: CommentAll` section wipe, brand-new section) — applying as-is is a no-op so the user can uncomment the bits they want. Chooser sort pins `example` (and the still-present `empty` for plugins) above the curated entries.

#### Plugin baseline policy
- **Synthetic marketplace state** — when `toBaselineEntry` captures a `.uplugin` whose path sits under `Engine/Plugins/Marketplace/`, it records a stable `enabledByDefault=false, installed=true` posture regardless of the live state. Restoring against the baseline therefore brings marketplace plugins to that neutral "tracked but not auto-enabled" posture, leaving Engine-shipped plugins on Epic's per-version defaults. IDE-managed exceptions (currently `RiderLink`, dropped under the Marketplace folder by JetBrains Rider) are kept on the engine-plugin path so their `EnabledByDefault=true, Installed=false` IDE-side intent isn't clobbered.
- **`Add to config` preserves provenance** — `writePresetAtomically` now reads existing `_source` / `_applied` from the on-disk JSON and re-emits them on every write, so user-side plugin tweaks no longer nuke the template-origin markers.

#### Engine Plugins panel
- **Baseline divergence popover** — the "X plugins differ from the baseline captured …" banner now opens a custom hover popover (anchored as `position: fixed`, smart-flipped above/below the trigger based on viewport space, `max-height` clamped so it never overflows). It lists every diverging plugin grouped by Engine-shipped vs Marketplace, showing the target `EnabledByDefault` / `Installed` value Restore would set the plugin to — `On` in green, `Off` in red, with only the fields that actually change rendered per row. Marketplace plugins are excluded from the banner count itself (they're user-managed, the synthetic policy keeps the noise out) but surfaced in the popover so the user sees the full Restore scope.

#### Local Vault
- **Payload kind classification** — each vault entry's `data/` layout is inspected at scan time and labelled `asset` (`data/Content/…`), `plugin` (`data/Engine/Plugins/Marketplace/<name>/<name>.uplugin`) or `unknown`. The kind is surfaced as a coloured pill next to the name.
- **`Add to project` from Local Vault** — asset-kind rows expose a button that opens the existing `AddToProjectDialog` pre-filled with the source / sourceId / engineVersion captured in the `downloads` table. Lazy-loads the projects list on first click so the Vault tab works even before the Projects tab has been visited.

#### Startup behaviour
- **Open this tab on startup** — new Settings dropdown in the Startup & behavior pane: `Last opened` (default; remembers the tab the user closed the app on) or any of the six content tabs (`Assets`, `Projects`, `Engines`, `Vault`, `Freebies`, `Downloads`). `Settings` is intentionally excluded as a startup destination. App startup restores the chosen tab post-auth; tab changes are debounced and persisted as `lastActiveTab` for the `last-opened` mode. `SettingsStore.saveAll` now merges the partial payload onto the currently-stored settings instead of treating it as a full replace, so the narrow `{lastActiveTab: …}` writes from the renderer don't reset every other field to defaults.

#### Accounts
- **Account-switcher "re-link" affordance** — accounts whose refresh tokens are gone (decrypt failure on startup, manual clear, or refresh-grant rejection) are now flagged `signedOut: true` in `listAccounts` and surface in the switcher dropdown with a dimmed avatar/name plus a purple `re-link` pill. Clicking that row routes into the existing Add-account login flow (Epic OAuth code paste); the new tokens get re-bound to the same `accountId`, so the per-account library / bookmarks / downloads stay intact. Replaces the previous silent failure where the dropdown would error out with "Unknown or signed-out account: …" and no path to recovery.

#### Sync
- **Fab Other-library sync temporarily disabled** — `/i/library/search?source=acquired` started returning 401 across the board (suspected missing CSRF header on the request — same symptom as `/i/users/me/listings-states` in the freebies flow). Until that's confirmed and fixed, the Other-library pass is gated behind a `SKIP_FAB_OTHER_LIBRARY` const so users with mixed UE+Other libraries don't see the 401 on every manual sync. UE library sync is unaffected.
- **Defensive cache flushes around manual sync** — `library:sync` IPC clears the Chromium HTTP response cache on the `persist:cf-warmup` partition at the start of every manual sync, and `FabClient.listLibrary` / `listOtherLibrary` append a per-call `_=<timestamp>` cache-bust query to the request URL. Both are safety nets against intermediate cache layers (Chromium session cache, CDN edge cache). They do NOT address the case where Fab's library endpoint itself serves stale `images[0].url` for assets whose listing was recently edited by the creator — that's a server-side data freshness limitation that needs a per-listing detail-endpoint refresh (planned for 0.3.0).

#### Debug
- **`debug:clear-library` is now account-scoped** — the IPC handler previously wiped every account's rows from `assets` / `asset_tags` / `sync_state`, which made re-testing on one account also nuke any other authenticated account's library. Now scoped to `session.getState().accountId` when authenticated; falls back to the original "wipe everything" behaviour only when there's no active account (anonymous mode).

### Changed

- **User files renamed** for provenance clarity (no migration — these are fresh on the user's machine; pre-0.2 installs would need to re-apply the relevant preset):
  - `userData/plugin-preset.json` → `userData/ReHoarderPluginConfig.json`
  - `userData/EditorKeyBindings-master.ini` → `userData/ReHoarderEditorKeyBindings.ini`
  - `userData/BaseEditorPerProjectUserSettings-master.ini` → `userData/ReHoarderEditorSettings.ini`
- **`Restore baseline` semantics** — iterates the live on-disk plugin list (not just the captured baseline) so marketplace plugins are reset to the synthetic policy even when the user manually pruned them from the baseline JSON. Engine plugins still drop back to whatever the captured baseline recorded.
- **Engine plugins panel tooltip** — removed the native `title=` overlay in favour of the custom popover above so the displayed state is the *destination* of Restore (the post-Restore value), not a `was → is` arrow that read backwards relative to the user's intent.

## [0.1.7] — 2026-05-26

Quick-launch button on the Engines tab and a smarter Assets search that no
longer needs the user's query tokens to appear in the same field.

### Added

- **Launch button on Engines tab** — the `present` pill in the Editor
  column is now a green `Launch` action that spawns the engine's editor
  exe directly (`UnrealEditor.exe` on UE5, `UE4Editor.exe` on UE4), so the
  user can open the project browser of any installed engine in one click
  without going through `UnrealVersionSelector` or a desktop shortcut. The
  spawn is detached + `cwd`-pinned next to the exe, and the result lands
  in the existing engine-action toast stack so failures are surfaced.
  Engines with no editor binary on disk keep the `missing` pill.

### Changed

- **Assets search now matches across fields per-token** — typing
  `laya cry` finds `Crystal Cave` by `Laya Design` even though no single
  field contains both tokens. The library `WHERE` clause tokenises on
  whitespace and requires each token to match (`LIKE`) at least one of
  title / description / seller, AND-combined. LIKE wildcards (`%`, `_`)
  in the user input are now escaped with `ESCAPE '\'` so a literal
  `100%` searches for the percent sign instead of acting as a wildcard.

## [0.1.6] — 2026-05-19

Multi-account switcher (issue #1), Fab freebies UX overhaul, end-to-end Fab
session hardening, and a quiet automatic library refresh tied to the
unclaimed-freebies signal. Downloads that survived a previous shutdown now
actually resume after auth lands.

### Added

#### Multi-account
- **Per-account scoping across the catalog** — `assets`, `asset_tags`,
  `sync_state`, `downloads` gain an `account_id` column, with primary keys
  rebuilt so two Epic accounts on the same machine can each carry their
  own owned-asset set without collision. New `accounts` table tracks the
  authenticated identities and the active pointer (kv-backed). The v3 → v4
  migration stamps pre-existing rows with `account_id = 'legacy'` and
  rebinds them to the real Epic account id the first time `Session.init`
  decrypts the legacy token slot — verified end-to-end on a real 6010-row
  upgrade.
- **Per-account encrypted tokens** — `SecureTokenStorage` is now keyed by
  account id (`auth.tokens.<accountId>`), one safeStorage blob per
  identity. The pre-multi-account `auth.tokens` slot is migrated in place
  on first launch and then deleted.
- **Multi-account `Session`** — holds a `Map<accountId, Tokens>` in memory,
  resolves the active pointer on init, refreshes expired access tokens
  per-account, and exposes `switchTo`, `addAccount`, `removeAccount`
  alongside the legacy single-account API.
- **Account switcher in the top bar** — chip with the active user's name +
  avatar initials, dropdown listing every authenticated account with
  per-row sign-out, "Add account…" that opens the Epic login in the
  browser and bounces the app back to `LoginView` for the OAuth code, and
  a context-aware "Sign out current". Per-account renderer stores
  (library, freebies, downloads) reload on switch via the new
  `accounts:changed` broadcast.
- **Per-account data wipe on sign-out** — removing an account deletes its
  scoped rows from `assets`, `asset_tags`, `sync_state` and `downloads`
  in a single transaction, then clears the accounts row and falls back
  to the next authenticated account (or to LoginView if none remain).
- **CF partition reset on switch** — `persist:cf-warmup` cookies are
  cleared on every account switch and remove, so the previous identity's
  `fab_sessionid` / Epic state can't leak into the next sync's F1-F5
  dance. Engine downloads carry a synthetic `__engine__` account id so
  they remain visible regardless of which Epic account is active.

#### Freebies
- **Non-blocking startup toast** instead of the auto-focus tab switch.
  Bottom-right pill with "Go to Freebies" + dismiss; the unread badge on
  the Freebies tab is always on regardless of the setting, so users who
  opt out of the toast still see the count. Setting renamed to
  `notifyAboutUnclaimedFreebiesOnStartup` (with a one-shot read of the
  old `focusFreebiesTabAtStartup` value for upgrades).
- **Auto-refresh on startup, throttled** — new IPC
  `library:freebies-auto-check` fetches the monthly freebies (cheap
  blade endpoint) on every launch and kicks a full library sync in the
  background only when AT LEAST ONE of: ≥ 7 days since the last
  auto-sync, the UID set changed (new batch detected), or it's Tuesday
  14:00-22:00 UTC and ≥ 24 h elapsed. State persisted in kv as
  `freebies.lastAutoSyncAt` + `freebies.lastSeenUids`. Manual sync and
  the Refresh button are unaffected.

### Changed

- **Full UE + Other library sync, no early-stop** — Fab orders both
  libraries by listing `createdAt`, not acquisition time, so a freebie
  the user claimed today (originally listed years ago) lived past the
  early-stop and never reached the local DB. ReHoarder now paginates
  every page on every sync, matching Asset Manager Studio's behaviour.
  Costs ~20-30 s per sync on a 2 k+ library but makes the freebies
  cross-reference trustworthy.
- **Cloudflare warmup also covers `unrealengine.com`** — the
  Epic-Houdini `set-sid` endpoint runs there and was 403-ing under the
  CF challenge HTML without a per-domain `cf_clearance`. The hidden
  warmup BrowserWindow now visits all three CF zones (fab.com,
  epicgames.com, unrealengine.com) and retains the cookies for each.
- **`set-sid` + `cosmos/auth` use the Electron net stack** — Cloudflare
  on `unrealengine.com` validates JA3/JA4 alongside `cf_clearance`, so
  Node fetch with the right cookie still got the challenge page. These
  two calls go through the same `net.fetch` partition the Chromium
  warmup used to earn the clearance.
- **Stale `fab_sessionid` purge before F1** — the warmup window's first
  visit to fab.com left an anonymous Django sessionid in the partition;
  Fab's F5 OAuth callback declines to issue a fresh session when one is
  already present, so /me/* kept 401-ing across launches. The driver
  now drops the anonymous slot before the dance starts (cf_clearance,
  __cf_bm and fab_csrftoken are kept).
- **Freebies UA + Referer aligned to the dance** — the listings-states
  fetch now uses the same `LAUNCHER_UA` and a `/library` Referer so
  Fab's middleware sees the same client identity that earned the
  session cookies.

### Fixed

- **Recovered downloads no longer stall in `queued`** — `bootstrap()`
  used to pump the queue before `session.init()` had resolved the
  active account, so `nextQueued()` (which scopes by active id)
  silently found nothing. Bootstrap now only handles the running→queued
  recovery and a new `onAuthChanged()` hook drives the first pump after
  auth lands; the same hook re-fires on every account switch.
- **Legacy `auth.tokens` slot drains cleanly** —
  `SecureTokenStorage.migrateLegacySlot()` decrypts the
  pre-multi-account blob exactly once and re-saves it under
  `auth.tokens.<accountId>`, including the safeStorage-state flip when
  the original blob was written in plaintext.

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

[0.1.7]: https://github.com/Ares9323/ReHoarder/releases/tag/v0.1.7
[0.1.6]: https://github.com/Ares9323/ReHoarder/releases/tag/v0.1.6
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
