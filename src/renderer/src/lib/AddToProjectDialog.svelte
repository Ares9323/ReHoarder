<script lang="ts">
  import { untrack } from 'svelte'

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
    /** When set, the user came in by clicking a specific version chip — we prioritise compatible projects in the list. */
    requestedVersion: string | undefined
    /** Engine versions the asset declares it supports (`["4.27","5.4"]`). Drives the compatibility check on every project row. */
    availableVersions: string[]
    knownProjects: ProjectLite[]
    onClose: () => void
    onAdded?: (info: { projectDir: string; filesCopied: number; filesSkipped: number }) => void
  }

  let {
    assetTitle,
    assetSource,
    assetSourceId,
    requestedVersion,
    availableVersions,
    knownProjects,
    onClose,
    onAdded
  }: Props = $props()

  // Use `untrack` so $state's initialiser captures the prop snapshot once
  // (Svelte's reactivity rule otherwise warns; the prop is stable for the
  // lifetime of this modal anyway).
  let selectedProjectPath = $state<string>(
    untrack(() => {
      // Default to the first compatible project that matches the requested version,
      // falling back to the first compatible project overall, then the first project.
      const compatible = knownProjects.filter(
        (p) => p.engineAssociation && availableVersions.includes(p.engineAssociation)
      )
      const preferred = requestedVersion
        ? compatible.find((p) => p.engineAssociation === requestedVersion)
        : null
      return (
        preferred?.uprojectPath ??
        compatible[0]?.uprojectPath ??
        knownProjects[0]?.uprojectPath ??
        ''
      )
    })
  )
  let conflict = $state<'skip' | 'overwrite'>('skip')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let done = $state<{
    projectDir: string
    filesCopied: number
    filesSkipped: number
  } | null>(null)

  function isCompatible(p: ProjectLite): boolean {
    return !!p.engineAssociation && availableVersions.includes(p.engineAssociation)
  }

  function selectedProject(): ProjectLite | undefined {
    return knownProjects.find((p) => p.uprojectPath === selectedProjectPath)
  }

  async function submit(): Promise<void> {
    const project = selectedProject()
    if (!project || busy) return
    busy = true
    error = null
    try {
      const r = await window.api.projects.addToProject({
        source: assetSource,
        sourceId: assetSourceId,
        engineVersion: requestedVersion ?? null,
        projectDir: project.projectDir,
        conflict
      })
      if (!r.ok) {
        error = r.error ?? 'Add failed'
        return
      }
      done = {
        projectDir: project.projectDir,
        filesCopied: r.filesCopied ?? 0,
        filesSkipped: r.filesSkipped ?? 0
      }
      // Reveal the project's Content/ folder so the user can verify and
      // hop into UE to see the new assets in the Content Browser.
      if (r.destContentDir) {
        void window.api.projects.openInExplorer(r.destContentDir).catch(() => {
          // non-fatal
        })
      }
      onAdded?.(done)
      window.setTimeout(onClose, 1300)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (busy) return
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter') void submit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div
  class="backdrop"
  role="presentation"
  onclick={(e) => {
    if ((e.target as HTMLElement).classList.contains('backdrop') && !busy) onClose()
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
        <code>{done.projectDir}\Content</code>{#if done.filesSkipped > 0}, skipped {done.filesSkipped}
          existing file{done.filesSkipped === 1 ? '' : 's'}{/if}.
      </div>
    {/if}
    {#if error}
      <div class="banner-error">{error}</div>
    {/if}

    <section>
      <label class="field">
        <span class="lbl">Target project</span>
        {#if knownProjects.length === 0}
          <span class="hint">
            No projects detected. Add Project paths under Settings → Project paths first.
          </span>
        {:else}
          <select bind:value={selectedProjectPath} disabled={busy}>
            {#each knownProjects as p (p.uprojectPath)}
              {@const compatible = isCompatible(p)}
              <option value={p.uprojectPath} disabled={!compatible}>
                {p.name} ({p.engineAssociation || '?'}){compatible ? '' : ' — incompatible'}
              </option>
            {/each}
          </select>
        {/if}
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

      {#if selectedProject()}
        <p class="hint">
          Files will land under <code>{selectedProject()!.projectDir}\Content</code>.
        </p>
      {/if}
    </section>

    <footer>
      <button type="button" class="ghost" onclick={onClose} disabled={busy}>Cancel</button>
      <button
        type="button"
        class="primary"
        onclick={submit}
        disabled={busy || !selectedProject() || !isCompatible(selectedProject() as ProjectLite)}
      >
        {busy ? 'Copying…' : 'Add to project'}
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
  .hint {
    margin: 0;
    color: #888;
    font-size: 0.75rem;
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
</style>
