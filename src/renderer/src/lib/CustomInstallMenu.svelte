<script lang="ts">
  import CreateProjectDialog from './CreateProjectDialog.svelte'

  interface EngineLite {
    name: string
    path: string
    version: string
    majorVersion: number
    editorExePath: string | null
    hasEditor: boolean
  }

  interface ProjectLite {
    name: string
    uprojectPath: string
    projectDir: string
    engineAssociation: string
  }

  type AssetSource = 'vault' | 'fab' | 'legacy'

  interface Props {
    assetTitle: string
    assetSource: AssetSource
    assetSourceId: string
    /** When set, the user reached this menu by clicking a specific version chip — we pre-prioritise it in the list. */
    requestedVersion: string | undefined
    /** Every engine version the asset declares it supports (`["5.3","5.4"]`). */
    availableVersions: string[]
    /** Versions already present in the local vault (downloaded). Drives "install vs download" routing. */
    downloadedVersions?: string[]
    installedEngines: EngineLite[]
    knownProjects: ProjectLite[]
    /** What Fab thinks this is. Drives whether install-in-engine/project is offered or whether we suggest project-pack / project-creation workflows. */
    assetKind?: 'plugin' | 'project' | 'pack' | 'other'
    /** Configured project root folders (Settings → Project paths). Drives the Create-project parent-dir selector. */
    projectPaths?: string[]
    /** @deprecated kept for backward-compat; same info is encoded in assetKind === 'plugin'. */
    isPlugin: boolean
    onClose: () => void
  }

  let {
    assetTitle,
    assetSource,
    assetSourceId,
    requestedVersion,
    availableVersions,
    downloadedVersions = [],
    installedEngines,
    knownProjects,
    assetKind,
    projectPaths = [],
    isPlugin,
    onClose
  }: Props = $props()

  let createDialogOpen = $state(false)

  /** Effective kind, with the legacy `isPlugin` boolean as fallback for older callers. */
  const kind = $derived<'plugin' | 'project' | 'pack' | 'other'>(
    assetKind ?? (isPlugin ? 'plugin' : 'other')
  )

  /**
   * "Is the requested version (or any version of the asset, when no specific
   * one is requested) already in the local vault?" — drives whether we offer
   * an instant "Install from vault" copy or a fresh download.
   */
  function isAlreadyInVault(version?: string): boolean {
    if (version) return downloadedVersions.includes(version)
    return downloadedVersions.length > 0
  }

  /**
   * For a given engine entry, its "asset" version is the major.minor pair the
   * Fab manifest indexes engineVersions by (`5.4`). We use this to filter
   * the engine list down to those that match a requested version, and to show
   * compatibility hints.
   */
  function shortVersion(engine: EngineLite): string {
    return engine.version.split('.').slice(0, 2).join('.')
  }

  // Compatibility is decided inline in the template now (so we can render
  // incompatible rows greyed-out instead of hiding them). Kept the helper above
  // (`shortVersion`) so the loops can call it directly.

  let actionError = $state<string | null>(null)
  let actionBusy = $state(false)
  let actionDone = $state<string | null>(null)

  async function installToEngine(engine: EngineLite, version: string): Promise<void> {
    actionBusy = true
    actionError = null
    try {
      // When the asset is already in the vault, copy from there instead of
      // re-downloading. The target is the engine's Marketplace plugin folder.
      if (isAlreadyInVault(version)) {
        const r = await window.api.projects.installFromVault({
          source: assetSource,
          sourceId: assetSourceId,
          engineVersion: version,
          targetPath: engine.path + '\\Engine\\Plugins\\Marketplace',
          kind: 'engine'
        })
        if (r.ok) {
          actionDone = `Installed in ${engine.name} (${r.filesCopied} files)`
          window.setTimeout(onClose, 1100)
        } else {
          actionError = r.error ?? 'Install failed'
        }
        return
      }
      const targetPath = engine.path + '\\Engine\\Plugins\\Marketplace'
      const r = await window.api.downloads.enqueue(
        assetSource,
        assetSourceId,
        assetTitle,
        { engineVersion: version, installTargetPath: targetPath }
      )
      if (r.ok) {
        actionDone = `Queued for ${engine.name}`
        window.setTimeout(onClose, 900)
      } else {
        actionError = r.error ?? 'Enqueue failed'
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    } finally {
      actionBusy = false
    }
  }

  async function installToProject(project: ProjectLite): Promise<void> {
    actionBusy = true
    actionError = null
    try {
      const targetPath = project.projectDir + '\\Plugins'
      // Plugins under a project live in `<projectDir>/Plugins/`; UE creates the
      // folder on demand so we don't need to pre-create it here.
      if (isAlreadyInVault(project.engineAssociation)) {
        const r = await window.api.projects.installFromVault({
          source: assetSource,
          sourceId: assetSourceId,
          engineVersion: project.engineAssociation || null,
          targetPath,
          kind: 'project'
        })
        if (r.ok) {
          actionDone = `Installed in ${project.name} (${r.filesCopied} files)`
          window.setTimeout(onClose, 1100)
        } else {
          actionError = r.error ?? 'Install failed'
        }
        return
      }
      const r = await window.api.downloads.enqueue(
        assetSource,
        assetSourceId,
        assetTitle,
        { engineVersion: project.engineAssociation, installTargetPath: targetPath }
      )
      if (r.ok) {
        actionDone = `Queued for ${project.name}`
        window.setTimeout(onClose, 900)
      } else {
        actionError = r.error ?? 'Enqueue failed'
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    } finally {
      actionBusy = false
    }
  }

  async function openVaultFolder(): Promise<void> {
    actionBusy = true
    actionError = null
    try {
      const rows = await window.api.downloads.list()
      const row = rows.rows
        .filter(
          (r) =>
            r.status === 'done' &&
            r.source === assetSource &&
            r.sourceId === assetSourceId &&
            r.destDir !== null
        )
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
      if (!row || !row.destDir) {
        actionError = 'No completed download found for this asset.'
        return
      }
      const r = await window.api.downloads.openInExplorer(row.destDir)
      if (!r.ok) actionError = r.error ?? 'Open failed'
      else onClose()
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    } finally {
      actionBusy = false
    }
  }

  async function downloadOnly(version: string | undefined): Promise<void> {
    actionBusy = true
    actionError = null
    try {
      const r = await window.api.downloads.enqueue(
        assetSource,
        assetSourceId,
        assetTitle,
        version ? { engineVersion: version } : {}
      )
      if (r.ok) {
        actionDone = 'Queued for download'
        window.setTimeout(onClose, 900)
      } else {
        actionError = r.error ?? 'Enqueue failed'
      }
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err)
    } finally {
      actionBusy = false
    }
  }

  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !actionBusy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => {
    if ((e.target as HTMLElement).classList.contains('backdrop') && !actionBusy) onClose()
  }}
>
  <div class="popup" role="dialog" aria-modal="true" aria-label="Custom install">
    <header>
      <div class="head-lead">
        <h2>Custom install</h2>
        <p class="subtitle" title={assetTitle}>{assetTitle}</p>
      </div>
      <button type="button" class="close" onclick={onClose} title="Close (Esc)">×</button>
    </header>

    {#if actionDone}
      <div class="banner-ok">{actionDone}</div>
    {/if}
    {#if actionError}
      <div class="banner-error">{actionError}</div>
    {/if}

    {#if isAlreadyInVault(requestedVersion)}
      <section class="in-vault">
        <h3>Already in vault</h3>
        <p class="hint">
          Reuse the existing download instead of re-fetching from the CDN.
        </p>
        <button
          type="button"
          class="row-btn"
          disabled={actionBusy}
          onclick={openVaultFolder}
        >
          <span class="row-main">Open downloaded folder</span>
        </button>
      </section>
    {/if}

    {#if kind === 'project'}
      <section>
        <h3>Create project</h3>
        <p class="hint">
          Copy this build into a fresh project folder under one of your
          <strong>Project paths</strong> and rename the <code>.uproject</code> to a name you choose.
          Requires the asset to be in the local vault.
        </p>
        <button
          type="button"
          class="row-btn"
          disabled={actionBusy || !isAlreadyInVault(requestedVersion) || projectPaths.length === 0}
          title={!isAlreadyInVault(requestedVersion)
            ? 'Asset is not in the local vault yet — download it first.'
            : projectPaths.length === 0
              ? 'No project paths configured.'
              : 'Pick name + parent and create a new project from this build'}
          onclick={() => (createDialogOpen = true)}
        >
          <span class="row-main">Create project from this build</span>
          {#if !isAlreadyInVault(requestedVersion)}
            <span class="row-meta">download first</span>
          {/if}
        </button>
      </section>
    {/if}

    {#if kind === 'pack'}
      <section>
        <h3>Add to project</h3>
        <p class="hint">
          Asset packs need to be merged into a project's <code>Content/</code> folder.
          Coming soon — for now use <em>Open downloaded folder</em> and drop the
          contents into your project's Content directory.
        </p>
        <button type="button" class="row-btn" disabled>
          <span class="row-main">Add to project</span>
          <span class="row-meta">soon</span>
        </button>
      </section>
    {/if}

    <section>
      <h3>Install into an engine</h3>
      {#if kind !== 'plugin'}
        <p class="hint">Engine install only applies to code plugins.</p>
      {:else if installedEngines.length === 0}
        <p class="hint">
          No engine installs detected. Configure paths under Settings → Unreal Engine paths.
        </p>
      {:else}
        <ul class="list">
          {#each installedEngines as e (e.path)}
            {@const v = shortVersion(e)}
            {@const compatible = availableVersions.includes(v)}
            {@const requested = !!requestedVersion && requestedVersion === v}
            <li>
              <button
                type="button"
                class="row-btn"
                class:requested
                class:dimmed={compatible && !requested && !!requestedVersion}
                class:incompatible={!compatible}
                disabled={actionBusy || !compatible}
                title={!compatible
                  ? `${e.name} (${e.version}) isn't compatible with this asset (offers ${availableVersions.join(', ') || '—'})`
                  : requested
                    ? `Install plugin into ${e.name} (${e.version}) — version you came in with`
                    : `Install plugin into ${e.name} (${e.version}) — alternative version`}
                onclick={() => installToEngine(e, v)}
              >
                <span class="row-main">{e.name}</span>
                <span class="row-meta">{e.version}</span>
                {#if requested}
                  <span class="row-pill">requested</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h3>Install into a project</h3>
      {#if !isPlugin}
        <p class="hint">Project install applies to plugins only.</p>
      {:else if knownProjects.length === 0}
        <p class="hint">
          No projects detected. Add Project paths under Settings → Project paths.
        </p>
      {:else}
        <ul class="list">
          {#each knownProjects as p (p.uprojectPath)}
            {@const compatible = !!p.engineAssociation && availableVersions.includes(p.engineAssociation)}
            {@const requested = !!requestedVersion && p.engineAssociation === requestedVersion}
            <li>
              <button
                type="button"
                class="row-btn"
                class:requested
                class:dimmed={compatible && !requested && !!requestedVersion}
                class:incompatible={!compatible}
                disabled={actionBusy || !compatible}
                title={!compatible
                  ? `${p.name} uses engine ${p.engineAssociation || '—'}; asset offers ${availableVersions.join(', ') || '—'}`
                  : requested
                    ? `Install plugin into ${p.name} (engine ${p.engineAssociation})`
                    : `Install plugin into ${p.name} — uses engine ${p.engineAssociation}, different from the version you came in with`}
                onclick={() => installToProject(p)}
              >
                <span class="row-main">{p.name}</span>
                <span class="row-meta">{p.engineAssociation || '—'}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section>
      <h3>Download only</h3>
      <p class="hint">
        Drop the asset into the configured vault path without copying it anywhere else.
      </p>
      <button
        type="button"
        class="primary-btn"
        disabled={actionBusy}
        onclick={() => downloadOnly(requestedVersion)}
      >
        Download {#if requestedVersion}({requestedVersion}){/if}
      </button>
    </section>
  </div>
</div>

{#if createDialogOpen}
  <CreateProjectDialog
    {assetTitle}
    {assetSource}
    {assetSourceId}
    engineVersion={requestedVersion ?? null}
    {projectPaths}
    onClose={() => (createDialogOpen = false)}
    onCreated={() => onClose()}
  />
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    z-index: 150;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .popup {
    width: 480px;
    max-width: 92vw;
    max-height: 86vh;
    overflow-y: auto;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 10px;
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid #2a2a2a;
    background: #1f1f1f;
  }
  header h2 {
    margin: 0;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #c084fc;
  }
  .subtitle {
    margin: 0.2rem 0 0;
    color: #d0d0d0;
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 360px;
  }
  .close {
    background: transparent;
    color: #999;
    border: 1px solid #3a3a3a;
    width: 32px;
    height: 32px;
    border-radius: 4px;
    font-size: 1.1rem;
    cursor: pointer;
    line-height: 1;
  }
  .close:hover {
    color: #fff;
    border-color: #666;
  }
  section {
    padding: 0.85rem 1.1rem;
    border-bottom: 1px solid #2a2a2a;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  section:last-of-type {
    border-bottom: none;
  }
  section h3 {
    margin: 0;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #c084fc;
  }
  .hint {
    margin: 0;
    color: #888;
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .row-btn {
    width: 100%;
    background: #242424;
    border: 1px solid #2e2e2e;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    color: #d0d0d0;
    font-family: inherit;
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 0.55rem;
    text-align: left;
  }
  .row-btn:hover:not(:disabled) {
    background: #2a1f3a;
    border-color: #4a3268;
    color: #fff;
  }
  .row-btn:disabled {
    cursor: progress;
  }
  /* Three states for rows when the user came in with a specific version:
       - .requested        → "this is the version you asked for"   (white + pink, full color)
       - .dimmed           → "this is a different but valid target" (grey text, still clickable)
       - .incompatible     → "asset doesn't offer this engine"      (greyer + disabled)
     When `requestedVersion` is unset, no row gets dimmed: every compatible row
     is equally prominent. */
  .row-btn.dimmed .row-main,
  .row-btn.dimmed .row-meta {
    color: #888;
  }
  .row-btn.dimmed:hover:not(:disabled) .row-main,
  .row-btn.dimmed:hover:not(:disabled) .row-meta {
    color: #d8b4fe;
  }
  .row-btn.incompatible {
    cursor: not-allowed;
    background: transparent;
    border-color: #2a2a2a;
  }
  .row-btn.incompatible:hover:not(:disabled) {
    background: transparent;
    border-color: #2a2a2a;
  }
  .row-btn.incompatible .row-main {
    color: #555;
  }
  .row-btn.incompatible .row-meta {
    color: #555;
  }
  .row-main {
    color: #e0e0e0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Compatible (non-incompatible) row meta gets the brand pink — easy to scan
     the list for "rows with a colored version = clickable target". */
  .row-meta {
    color: #f472b6;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .row-pill {
    font-size: 0.65rem;
    color: #c084fc;
    background: #2a1f3a;
    border: 1px solid #4a3268;
    border-radius: 3px;
    padding: 0.05rem 0.45rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .primary-btn {
    align-self: flex-start;
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: white;
    border: none;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
  }
  .primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .banner-error {
    background: #3a1f1f;
    border: 1px solid #5a2727;
    color: #fca5a5;
    border-radius: 6px;
    padding: 0.5rem 0.85rem;
    margin: 0.85rem 1.1rem 0;
    font-size: 0.8rem;
  }
  .banner-ok {
    background: #163524;
    border: 1px solid #28553a;
    color: #86efac;
    border-radius: 6px;
    padding: 0.5rem 0.85rem;
    margin: 0.85rem 1.1rem 0;
    font-size: 0.8rem;
  }
</style>
