<script lang="ts">
  import { untrack } from 'svelte'
  import { projectsStore } from '../stores/projects.svelte'

  interface Props {
    assetTitle: string
    assetSource: 'vault' | 'fab' | 'legacy'
    assetSourceId: string
    engineVersion: string | null
    /** Configured project roots (Settings → Project paths) — the user picks one as the parent for the new folder. */
    projectPaths: string[]
    onClose: () => void
    /** Called after a successful create — the caller can refresh the Projects tab listing. */
    onCreated?: (info: { projectDir: string; uprojectPath: string }) => void
  }

  let { assetTitle, assetSource, assetSourceId, engineVersion, projectPaths, onClose, onCreated }: Props = $props()

  /** Unreal Editor warns past 20 chars ("longer name may cause save/modify issues"). */
  const MAX_PROJECT_NAME = 20

  /**
   * Strip filesystem-unsafe characters and collapse whitespace runs. The
   * backend re-sanitises (defence in depth), but we do it up front so the
   * preview in the dialog reflects the actual folder name that will end up
   * on disk. Also clamped to UE's recommended 20-char limit so the input
   * doesn't start out already over-budget.
   */
  function suggestedName(title: string): string {
    return title
      .replace(/^["'\s]+|["'\s]+$/g, '')
      .replace(/[/\\:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PROJECT_NAME)
  }

  // `$state` initialisers only run once. We deliberately want a snapshot of
  // the props at mount time — the dialog is a per-asset modal, the inputs
  // shouldn't snap back to the prop value if the parent re-renders. Wrap the
  // initial reads in `untrack` so Svelte stops warning about it.
  let name = $state(untrack(() => suggestedName(assetTitle)))
  let parentDir = $state<string>(untrack(() => projectPaths[0] ?? ''))
  let busy = $state(false)
  let error = $state<string | null>(null)
  let done = $state<{ projectDir: string; uprojectPath: string } | null>(null)

  /** Live preview of the folder the dialog will create — informational only. */
  const previewPath = $derived(
    parentDir && name ? joinPath(parentDir, name) : ''
  )

  /**
   * Unreal projects' C++ class generator emits identifiers from the project
   * name, and C++ identifiers can't start with a digit (`7Sins` becomes an
   * illegal class name). The Editor refuses to create such projects and the
   * error happens too late for the user to recover gracefully — block it here.
   */
  const startsWithDigit = $derived(/^\d/.test(name.trim()))
  const nameTooLong = $derived(name.length > MAX_PROJECT_NAME)
  const nameEmpty = $derived(name.trim().length === 0)
  const nameInvalidReason = $derived<string | null>(
    nameEmpty
      ? null
      : startsWithDigit
        ? 'Name cannot start with a digit (Unreal generates C++ identifiers from it).'
        : nameTooLong
          ? `Name longer than ${MAX_PROJECT_NAME} characters — Unreal Editor will reject it.`
          : null
  )
  const nameValid = $derived(!nameEmpty && !startsWithDigit && !nameTooLong)

  function joinPath(parent: string, child: string): string {
    if (!parent) return child
    const sep = parent.includes('\\') ? '\\' : '/'
    const cleanedParent = parent.replace(/[\\/]+$/, '')
    return cleanedParent + sep + child
  }

  async function submit(): Promise<void> {
    if (busy || !nameValid || !parentDir) return
    busy = true
    error = null
    try {
      const r = await window.api.projects.createFromVault({
        source: assetSource,
        sourceId: assetSourceId,
        engineVersion,
        name: name.trim(),
        parentDir
      })
      if (!r.ok) {
        error = r.error ?? 'Create failed'
        return
      }
      done = {
        projectDir: r.projectDir ?? '',
        uprojectPath: r.uprojectPath ?? ''
      }
      // Reveal the freshly-created project in Explorer so the user sees the
      // result immediately. Non-fatal if it fails — the dialog still reports
      // success above. Guarded by the projectPaths roots in main.
      if (done.projectDir) {
        void window.api.projects.openInExplorer(done.projectDir).catch(() => {
          // swallow: not blocking the success flow
        })
      }
      // The Projects-tab cache hasn't seen the new folder yet (and even an
      // already-listed folder gains a .rehoarder.json marker that resolves to
      // a thumbnail), so force a rescan now.
      void projectsStore.rescan()
      onCreated?.(done)
      window.setTimeout(onClose, 1100)
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
      if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName !== 'TEXTAREA') {
        void submit()
      }
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
  <div class="popup" role="dialog" aria-modal="true" aria-label="Create project">
    <header>
      <div class="head-lead">
        <h2>Create project</h2>
        <p class="subtitle" title={assetTitle}>{assetTitle}</p>
      </div>
      <button type="button" class="close" onclick={onClose} title="Close (Esc)">×</button>
    </header>

    {#if done}
      <div class="banner-ok">
        Project created at <code>{done.projectDir}</code>
      </div>
    {/if}
    {#if error}
      <div class="banner-error">{error}</div>
    {/if}

    <section>
      <label class="field">
        <span class="lbl">
          Project name
          <span class="char-count" class:over={name.length > MAX_PROJECT_NAME}>
            {name.length}/{MAX_PROJECT_NAME}
          </span>
        </span>
        <input
          type="text"
          bind:value={name}
          disabled={busy}
          maxlength={MAX_PROJECT_NAME}
          placeholder="MyProject"
          spellcheck="false"
          class:invalid={!!nameInvalidReason}
        />
        {#if nameInvalidReason}
          <span class="hint hint-error">{nameInvalidReason}</span>
        {:else}
          <span class="hint">
            Unreal Editor warns past {MAX_PROJECT_NAME} characters and rejects names
            starting with a digit.
          </span>
        {/if}
      </label>

      <label class="field">
        <span class="lbl">Parent folder</span>
        {#if projectPaths.length === 0}
          <span class="hint">
            Configure at least one project path under Settings → Project paths first.
          </span>
        {:else}
          <select bind:value={parentDir} disabled={busy}>
            {#each projectPaths as p (p)}
              <option value={p}>{p}</option>
            {/each}
          </select>
        {/if}
      </label>

      {#if previewPath}
        <p class="hint">Will create: <code>{previewPath}</code></p>
      {/if}
    </section>

    <footer>
      <button type="button" class="ghost" disabled={busy} onclick={onClose}>Cancel</button>
      <button
        type="button"
        class="primary"
        disabled={busy || !nameValid || !parentDir}
        onclick={submit}
      >
        {busy ? 'Creating…' : 'Create project'}
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
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .char-count {
    color: #888;
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .char-count.over {
    color: #fbbf24;
  }
  input[type='text'],
  select {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.4rem 0.6rem;
    font-family: inherit;
    font-size: 0.85rem;
  }
  input[type='text'].invalid {
    border-color: #fbbf24;
  }
  .hint {
    margin: 0;
    color: #888;
    font-size: 0.75rem;
  }
  .hint-error {
    color: #fbbf24;
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
