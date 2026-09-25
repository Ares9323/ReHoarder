<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { isEngineCompatible } from '../../../shared/engine-version'
  import { enterSubmitsDialog } from './dialog-keys'
  import {
    isDefaultDestination,
    mountRoot,
    previewDestinations,
    validateDestination,
    type AddToProjectDestination
  } from '../../../shared/relocate-destination'

  interface ProjectLite {
    name: string
    uprojectPath: string
    projectDir: string
    engineAssociation: string
  }

  interface Props {
    assetTitle: string
    assetSource: 'vault' | 'fab' | 'legacy'
    assetSourceId: string
    /** Minimum engine version the target project must be >= to. From the Local
     *  Vault this is the downloaded `engineVersion`; from the Asset Library it's
     *  the picked chip or the minimum available version. */
    requiredVersion: string | null
    /** When true, this is a `project` payload added via Content/-only merge —
     *  show the "files outside Content/ are not copied" warning. */
    projectMode?: boolean
    /** Absolute path to an orphan vault asset folder (no matching downloads row) —
     *  when set, forwarded so the backend can use it directly and skip the DB lookup. */
    vaultAssetDir?: string
    knownProjects: ProjectLite[]
    onClose: () => void
    onAdded?: (info: { projectDir: string; filesCopied: number; filesSkipped: number }) => void
  }

  let {
    assetTitle,
    assetSource,
    assetSourceId,
    requiredVersion,
    projectMode = false,
    vaultAssetDir,
    knownProjects,
    onClose,
    onAdded
  }: Props = $props()

  /** No requiredVersion means we can't check compatibility at all — every
   *  project is selectable and the UI warns instead of blocking. */
  const versionUnknown = $derived(!requiredVersion)

  // Use `untrack` so $state's initialiser captures the prop snapshot once
  // (Svelte's reactivity rule otherwise warns; the prop is stable for the
  // lifetime of this modal anyway).
  let selectedProjectPath = $state<string>(
    untrack(() => {
      const compatible = knownProjects.filter((p) =>
        isEngineCompatible(requiredVersion, p.engineAssociation)
      )
      return (
        compatible[0]?.uprojectPath ??
        (requiredVersion ? undefined : knownProjects[0]?.uprojectPath) ??
        ''
      )
    })
  )
  let conflict = $state<'skip' | 'overwrite'>('skip')
  let busy = $state(false)
  let mouseDownOnBackdrop = $state(false)
  let error = $state<string | null>(null)
  let done = $state<{
    projectDir: string
    filesCopied: number
    filesSkipped: number
    /** Unreal path the pack landed under, set only for relocations. */
    destinationPath: string | null
  } | null>(null)
  /** Success with a caveat (left-over redirectors, odd editor exit code). */
  let warning = $state<string | null>(null)
  /** Tail of the Unreal output after a failed relocation. */
  let failureOutput = $state<string | null>(null)

  // Destination: "" = the project's Content (/Game), otherwise a plugin name.
  let where = $state('')
  let subfolder = $state('')
  let rename = $state('')
  /** `null` while loading. */
  let topFolders = $state<string[] | null>(null)
  let looseAssets = $state<string[]>([])
  let plugins = $state<Array<{ name: string; dir: string }>>([])

  // Running relocation job.
  let jobId = $state<string | null>(null)
  let stage = $state<string | null>(null)
  let startedAt = $state(0)
  let now = $state(0)
  let cancelling = $state(false)

  const STAGE_LABELS: Record<string, string> = {
    prepare: 'Preparing a scratch project',
    'copy-in': 'Copying the pack into the scratch project',
    editor: 'Unreal is moving the assets and fixing references',
    'copy-out': 'Copying the result into your project',
    cleanup: 'Cleaning up'
  }

  /** The rename field only makes sense for a single top-level folder. */
  const canRename = $derived(topFolders?.length === 1 && looseAssets.length === 0)
  const destination = $derived<AddToProjectDestination>({
    mount: where === '' ? 'game' : { plugin: where },
    subfolder: subfolder.trim(),
    rename: canRename ? rename.trim() : ''
  })
  const needsEditor = $derived(
    topFolders !== null && !isDefaultDestination(destination, topFolders)
  )
  const validationError = $derived(
    topFolders === null ? null : validateDestination(destination, topFolders, looseAssets)
  )
  const preview = $derived.by<string[]>(() => {
    if (!topFolders) return []
    const out = previewDestinations(destination, topFolders)
    if (looseAssets.length > 0) {
      const base = [mountRoot(destination.mount), destination.subfolder]
        .filter((x) => !!x)
        .join('/')
      out.push(
        `${base}/ (${looseAssets.length} loose asset${looseAssets.length === 1 ? '' : 's'})`
      )
    }
    return out
  })
  const elapsed = $derived.by(() => {
    const s = Math.max(0, Math.floor((now - startedAt) / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  })

  function makeJobId(): string {
    return `rh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  onMount(() => {
    void window.api.projects
      .packTopFolders({
        source: assetSource,
        sourceId: assetSourceId,
        engineVersion: requiredVersion,
        vaultAssetDir
      })
      .then((r) => {
        if (!r.ok) {
          // Not fatal: the default copy still works, relocation just can't be planned.
          topFolders = []
          return
        }
        topFolders = r.folders ?? []
        looseAssets = r.looseAssets ?? []
        if (topFolders.length === 1 && looseAssets.length === 0) rename = topFolders[0]
      })
      .catch(() => {
        topFolders = []
      })
  })

  // Content plugins of the selected project, reloaded when the project changes.
  $effect(() => {
    const dir = allProjects.find((p) => p.uprojectPath === selectedProjectPath)?.projectDir
    where = ''
    plugins = []
    if (!dir) return
    let stale = false
    void window.api.projects
      .contentPlugins(dir)
      .then((r) => {
        if (!stale && r.ok) plugins = r.plugins ?? []
      })
      .catch(() => {
        // No plugin list: only Content is offered.
      })
    return () => {
      stale = true
    }
  })

  // Existing folders under the selected mount, offered as Subfolder suggestions
  // (a new name can still be typed).
  let existingFolders = $state<string[]>([])
  $effect(() => {
    const dir = allProjects.find((p) => p.uprojectPath === selectedProjectPath)?.projectDir
    const plugin = where === '' ? null : where
    existingFolders = []
    if (!dir) return
    let stale = false
    void window.api.projects
      .contentSubfolders(dir, plugin)
      .then((r) => {
        if (!stale && r.ok) existingFolders = r.folders ?? []
      })
      .catch(() => {
        // No suggestions: free typing still works.
      })
    return () => {
      stale = true
    }
  })

  $effect(() =>
    window.api.projects.onAddToProgress((ev) => {
      if (ev.jobId === jobId) stage = ev.stage
    })
  )

  $effect(() => {
    if (!busy || !jobId) return
    const t = window.setInterval(() => (now = Date.now()), 1000)
    return () => window.clearInterval(t)
  })

  async function cancelJob(): Promise<void> {
    if (!jobId || cancelling) return
    cancelling = true
    try {
      await window.api.projects.cancelAddTo(jobId)
    } catch {
      // The job result still arrives through addToProject.
    }
  }
  /** Projects picked via "Browse for another project…": outside the configured project
   *  roots, inspected on the fly and appended to the selectable list. */
  let customProjects = $state<ProjectLite[]>([])

  /** Union of the known (scanned) projects and any custom ones picked this
   *  session — everything else (compatibility checks, submit) reads from this. */
  const allProjects = $derived<ProjectLite[]>([...knownProjects, ...customProjects])

  function isCompatible(p: ProjectLite): boolean {
    if (versionUnknown) return true
    return isEngineCompatible(requiredVersion, p.engineAssociation)
  }

  function selectedProject(): ProjectLite | undefined {
    return allProjects.find((p) => p.uprojectPath === selectedProjectPath)
  }

  async function pickCustomProject(): Promise<void> {
    if (busy) return
    const r = await window.api.projects.pickDirectory()
    if (!r.ok || !r.path) return
    const insp = await window.api.projects.inspectProjectFolder(r.path)
    if (!insp.ok) {
      error = insp.error ?? 'Could not inspect the folder'
      return
    }
    if (!insp.project) {
      error = 'That folder is not an Unreal project (no .uproject found).'
      return
    }
    const project = insp.project
    error = null
    if (!customProjects.some((p) => p.uprojectPath === project.uprojectPath)) {
      customProjects = [...customProjects, project]
    }
    selectedProjectPath = project.uprojectPath
  }

  async function submit(): Promise<void> {
    const project = selectedProject()
    if (!project || busy || topFolders === null) return
    if (validationError) {
      error = validationError
      return
    }
    const relocating = needsEditor
    busy = true
    error = null
    warning = null
    failureOutput = null
    cancelling = false
    jobId = relocating ? makeJobId() : null
    stage = null
    startedAt = Date.now()
    now = startedAt
    try {
      const r = await window.api.projects.addToProject({
        source: assetSource,
        sourceId: assetSourceId,
        engineVersion: requiredVersion,
        targetEngineVersion: project.engineAssociation,
        projectDir: project.projectDir,
        conflict,
        vaultAssetDir,
        destination: relocating ? $state.snapshot(destination) : undefined,
        jobId: jobId ?? undefined
      })
      if (!r.ok) {
        error = r.cancelled
          ? 'Cancelled. The project was not changed.'
          : (r.error ?? 'Add failed')
        failureOutput = r.cancelled ? null : (r.output ?? null)
        return
      }
      done = {
        projectDir: project.projectDir,
        filesCopied: r.filesCopied ?? 0,
        filesSkipped: r.filesSkipped ?? 0,
        destinationPath: r.destinationPath ?? null
      }
      warning = r.warning ?? null
      // Reveal the destination folder so the user can verify and
      // hop into UE to see the new assets in the Content Browser.
      if (r.destContentDir) {
        void window.api.projects.openInExplorer(r.destContentDir).catch(() => {
          // non-fatal
        })
      }
      onAdded?.(done)
      // Keep the dialog open when there is a warning to read.
      if (!r.warning) window.setTimeout(onClose, 1300)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
      jobId = null
      stage = null
      cancelling = false
    }
  }

  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (busy) return
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && enterSubmitsDialog(e.target as HTMLElement | null)) void submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div
  class="backdrop"
  role="presentation"
  onmousedown={(e) => {
    mouseDownOnBackdrop = (e.target as HTMLElement).classList.contains('backdrop')
  }}
  onclick={(e) => {
    // A text-selection drag that starts inside the popup and ends outside it
    // fires its click on the backdrop: close only when the press began there.
    const onBackdrop = (e.target as HTMLElement).classList.contains('backdrop')
    if (onBackdrop && mouseDownOnBackdrop && !busy) onClose()
    mouseDownOnBackdrop = false
  }}
>
  <div class="popup" role="dialog" aria-modal="true" aria-label="Add to project">
    <header>
      <div class="head-lead">
        <h2>Add to project</h2>
        <p class="subtitle" title={assetTitle}>{assetTitle}</p>
      </div>
      <button type="button" class="close" onclick={onClose} title="Close (Esc)">×</button>
    </header>

    {#if done}
      <div class="banner-ok">
        Added {done.filesCopied} file{done.filesCopied === 1 ? '' : 's'} into
        {#if done.destinationPath}<code>{done.destinationPath}</code>{:else}<code
            >{done.projectDir}\Content</code
          >{/if}{#if done.filesSkipped > 0}, skipped {done.filesSkipped}
          existing file{done.filesSkipped === 1 ? '' : 's'}{/if}.
      </div>
    {/if}
    {#if warning}
      <div class="banner-warn">{warning}</div>
    {/if}
    {#if error}
      <div class="banner-error">
        {error}
        {#if failureOutput}
          <details>
            <summary>Unreal output</summary>
            <pre>{failureOutput}</pre>
          </details>
        {/if}
      </div>
    {/if}

    <section>
      {#if versionUnknown}
        <div class="banner-warn">
          Engine version unknown for this asset. Check compatibility yourself before
          opening the project.
        </div>
      {/if}
      {#if projectMode}
        <div class="banner-warn">
          This copies only <code>Content/</code>. The project's own files (Config,
          Blueprints outside Content/, the <code>.uproject</code>, and source) are
          <strong>not</strong> copied, so gameplay or systems that live outside
          <code>Content/</code> may not work. Use <em>Create project</em> for a full copy.
        </div>
      {/if}
      <label class="field">
        <span class="lbl">Target project</span>
        {#if allProjects.length === 0}
          <span class="hint">
            No projects detected. Add Project paths under Settings → Project paths first, or pick
            a custom folder below.
          </span>
        {:else}
          <select bind:value={selectedProjectPath} disabled={busy}>
            {#each allProjects as p (p.uprojectPath)}
              {@const compatible = isCompatible(p)}
              {@const isCustom = customProjects.some((c) => c.uprojectPath === p.uprojectPath)}
              <option value={p.uprojectPath} disabled={!compatible}>
                {p.name} ({p.engineAssociation || '?'}){isCustom ? ' (browsed)' : ''}{compatible
                  ? ''
                  : ' — incompatible'}
              </option>
            {/each}
          </select>
        {/if}
        <button
          type="button"
          class="secondary"
          disabled={busy}
          onclick={pickCustomProject}
          title="Pick a project folder that is not under the Projects paths configured in Settings"
        >
          Browse for another project…
        </button>
      </label>

      <label class="field">
        <span class="lbl">If a file already exists</span>
        <select bind:value={conflict} disabled={busy}>
          <option value="skip">Skip (keep the existing file)</option>
          <option value="overwrite">Overwrite (replace with the asset's copy)</option>
        </select>
        <span class="hint">
          Applies per file — anything the asset adds that doesn't conflict is copied either way.
        </span>
      </label>

      <label class="field">
        <span class="lbl">Where</span>
        <select bind:value={where} disabled={busy}>
          <option value="">Content (default)</option>
          {#each plugins as p (p.name)}
            <option value={p.name}>Plugin: {p.name}</option>
          {/each}
        </select>
      </label>

      <label class="field">
        <span class="lbl">Subfolder (optional)</span>
        <input
          type="text"
          list="add-to-subfolders"
          bind:value={subfolder}
          disabled={busy}
          placeholder={existingFolders.length > 0
            ? 'Pick an existing folder or type a new one'
            : 'e.g. ThirdParty/Environment'}
          spellcheck="false"
        />
        <datalist id="add-to-subfolders">
          {#each existingFolders as f (f)}
            <option value={f}></option>
          {/each}
        </datalist>
      </label>

      {#if canRename}
        <label class="field">
          <span class="lbl">Rename to</span>
          <input type="text" bind:value={rename} disabled={busy} spellcheck="false" />
        </label>
      {/if}

      {#if topFolders === null}
        <p class="hint">Reading the pack's folders…</p>
      {:else if validationError}
        <p class="field-error">{validationError}</p>
      {:else if preview.length > 0}
        <div class="preview">
          {#each preview.slice(0, 3) as p (p)}
            <code>→ {p}</code>
          {/each}
          {#if preview.length > 3}
            <span class="hint">and {preview.length - 3} more</span>
          {/if}
        </div>
      {/if}

      {#if needsEditor && !validationError}
        <p class="hint">
          Moving the pack runs the project's Unreal Engine in the background (no window) to
          rewrite references, then copies the result in. This can take several minutes. Paths
          written as plain text (C++, .ini files) are not updated.
        </p>
      {:else if selectedProject() && !needsEditor}
        <p class="hint">
          Files will land under <code>{selectedProject()!.projectDir}\Content</code>.
        </p>
      {/if}

      {#if busy && jobId}
        <p class="progress">
          {stage ? STAGE_LABELS[stage] ?? stage : 'Starting'}… <span class="elapsed">{elapsed}</span>
        </p>
      {/if}
    </section>

    <footer>
      {#if busy && jobId}
        <button type="button" class="ghost" onclick={cancelJob} disabled={cancelling}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      {:else}
        <button type="button" class="ghost" onclick={onClose} disabled={busy}>
          {done && warning ? 'Close' : 'Cancel'}
        </button>
      {/if}
      <button
        type="button"
        class="primary"
        onclick={submit}
        disabled={busy ||
          !!done ||
          topFolders === null ||
          !!validationError ||
          !selectedProject() ||
          !isCompatible(selectedProject() as ProjectLite)}
      >
        {busy ? (jobId ? 'Relocating…' : 'Copying…') : 'Add to project'}
      </button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 250;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .popup {
    width: 480px;
    max-width: 92vw;
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
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .lbl {
    color: #b0b0b0;
    font-size: 0.78rem;
  }
  select {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.4rem 0.6rem;
    font-family: inherit;
    font-size: 0.85rem;
  }
  input[type='text'] {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.4rem 0.6rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.8rem;
  }
  input[type='text']:focus {
    outline: none;
    border-color: #c084fc;
  }
  .hint {
    margin: 0;
    color: #888;
    font-size: 0.75rem;
  }
  .field-error {
    margin: 0;
    color: #fca5a5;
    font-size: 0.75rem;
  }
  .preview {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .preview code {
    color: #c4b5fd;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.75rem;
    word-break: break-all;
  }
  .progress {
    margin: 0;
    color: #d0d0d0;
    font-size: 0.8rem;
  }
  .elapsed {
    color: #888;
    font-variant-numeric: tabular-nums;
    margin-left: 0.4rem;
  }
  .banner-error details {
    margin-top: 0.4rem;
  }
  .banner-error summary {
    cursor: pointer;
    color: #fecaca;
  }
  .banner-error pre {
    max-height: 180px;
    overflow: auto;
    margin: 0.35rem 0 0;
    padding: 0.4rem;
    background: #1a1010;
    border-radius: 4px;
    font-size: 0.68rem;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .secondary {
    align-self: flex-start;
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 5px;
    padding: 0.3rem 0.7rem;
    font-family: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .secondary:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .hint code {
    color: #c0c0c0;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.72rem;
    word-break: break-all;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.7rem 1.1rem;
    border-top: 1px solid #2a2a2a;
    background: #1f1f1f;
  }
  footer button {
    border: none;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  footer .ghost {
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
  }
  footer .ghost:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  footer .primary {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: white;
    font-weight: 500;
  }
  footer .primary:disabled,
  footer .ghost:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
  .banner-ok code {
    color: #bbf7d0;
    word-break: break-all;
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
  .banner-warn {
    background: #3a2f1f;
    border: 1px solid #5a4a27;
    color: #fbbf24;
    border-radius: 6px;
    padding: 0.5rem 0.85rem;
    margin: 0.85rem 1.1rem 0;
    font-size: 0.8rem;
  }
  .banner-warn code {
    color: #fde68a;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.72rem;
  }
</style>
