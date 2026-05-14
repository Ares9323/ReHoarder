<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { enginesStore } from '../stores/engines.svelte'
  import { projectsStore } from '../stores/projects.svelte'

  interface EngineInfo {
    name: string
    path: string
    version: string
    majorVersion: number
    changelist: number
    branchName: string
    editorExePath: string | null
    hasEditor: boolean
  }

  interface Props {
    projectName: string
    uprojectPath: string
    /** EngineAssociation from the source .uproject (e.g. `5.4`). Used to
     *  preselect the matching engine in the dropdown when one is available. */
    engineAssociation: string | null
    /** True for projects that ship a `Source/` folder with C++ modules.
     *  Blueprint-only projects get a `BP` suffix on the default template name
     *  so Unreal's launcher pairs them as the BP variant of an existing
     *  C++ template (`TP_ThirdPerson` ↔ `TP_ThirdPersonBP`). */
    hasCode: boolean
    onClose: () => void
    /** Fires after a successful create — caller can refresh state / show a toast. */
    onCreated?: (info: { templateDir: string; uprojectPath: string }) => void
  }

  let { projectName, uprojectPath, engineAssociation, hasCode, onClose, onCreated }: Props = $props()

  /**
   * Reduce the source project name to the alphanumeric subset (no spaces,
   * brackets, etc.) and prepend `TP_` if the user hasn't already. Mirrors
   * the Unreal-convention naming the new-project wizard expects to find.
   * Blueprint-only projects also get a trailing `BP` so the launcher
   * recognises them as the BP variant of a C++ template with the same
   * display name (e.g. `TP_ThirdPerson` + `TP_ThirdPersonBP` show up as
   * one template with C++ / Blueprint toggle).
   */
  function suggestedTemplateName(name: string, blueprintOnly: boolean): string {
    const stripped = name.replace(/[^A-Za-z0-9_]/g, '').replace(/^_+/, '')
    if (!stripped) return blueprintOnly ? 'TP_NewTemplateBP' : 'TP_NewTemplate'
    const head = /^tp_/i.test(stripped)
      ? stripped
      : `TP_${/^[A-Za-z]/.test(stripped) ? stripped : `T${stripped}`}`
    return blueprintOnly && !/bp$/i.test(head) ? `${head}BP` : head
  }

  let templateName = $state(untrack(() => suggestedTemplateName(projectName, !hasCode)))
  let displayName = $state(untrack(() => projectName))
  let description = $state('')
  let categoryText = $state('Games')
  let selectedEnginePath = $state<string>('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let done = $state<{ templateDir: string; uprojectPath: string; mediaCopied?: boolean } | null>(null)
  /**
   * Tracks where a mouse drag started. Clicking-and-dragging a text selection
   * inside the popup and releasing the mouse on the backdrop fires a click on
   * the backdrop — without this flag, that misfires as "close dialog" and the
   * user loses their inputs. We only close on backdrop click when the press
   * also started on the backdrop.
   */
  let mouseDownOnBackdrop = $state(false)

  const engines = $derived(enginesStore.engines)
  const enginesLoading = $derived(enginesStore.loading)

  onMount(() => {
    void enginesStore.ensureLoaded().then(() => {
      // Preselect the engine whose major.minor matches the source project's
      // EngineAssociation. Falls back to the first installed engine when
      // there's no match (e.g. when EngineAssociation is a GUID for a
      // source-build install we can't resolve).
      const assoc = (engineAssociation ?? '').trim()
      const matching = assoc
        ? enginesStore.engines.find(
            (e) => e.version.split('.').slice(0, 2).join('.') === assoc
          )
        : null
      selectedEnginePath = matching?.path ?? enginesStore.engines[0]?.path ?? ''
    })
  })

  const nameValid = $derived(/^[A-Za-z][A-Za-z0-9_]*$/.test(templateName.trim()))
  const nameInvalidReason = $derived<string | null>(
    templateName.trim().length === 0
      ? 'Required.'
      : !nameValid
        ? 'Letters, digits and underscores only; must start with a letter.'
        : null
  )

  const destPreview = $derived(
    selectedEnginePath && templateName
      ? joinPath(selectedEnginePath, `Templates/${templateName}`)
      : ''
  )

  function joinPath(parent: string, child: string): string {
    const sep = parent.includes('\\') ? '\\' : '/'
    return parent.replace(/[\\/]+$/, '') + sep + child.replace(/\//g, sep)
  }

  function parseCategories(raw: string): string[] {
    return raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  async function submit(): Promise<void> {
    if (busy || !nameValid || !selectedEnginePath) return
    busy = true
    error = null
    try {
      const r = await window.api.projects.setAsTemplate({
        uprojectPath,
        engineRoot: selectedEnginePath,
        templateName: templateName.trim(),
        displayName: displayName.trim() || projectName,
        description: description.trim(),
        categories: parseCategories(categoryText)
      })
      if (!r.ok) {
        error = r.error ?? 'Set-as-template failed'
        return
      }
      done = {
        templateDir: r.templateDir ?? '',
        uprojectPath: r.uprojectPath ?? '',
        mediaCopied: r.mediaCopied
      }
      // Refresh the engines list — a new Templates/<name> folder doesn't
      // affect engine scan results today, but reveals the install in case
      // the caller wants to surface it.
      void projectsStore.rescan().catch(() => {})
      if (done.templateDir) {
        void window.api.engines.openInExplorer(done.templateDir).catch(() => {})
      }
      onCreated?.({ templateDir: done.templateDir, uprojectPath: done.uprojectPath })
      window.setTimeout(onClose, 1400)
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
  onmousedown={(e) => {
    mouseDownOnBackdrop = (e.target as HTMLElement).classList.contains('backdrop')
  }}
  onclick={(e) => {
    const onBackdrop = (e.target as HTMLElement).classList.contains('backdrop')
    if (onBackdrop && mouseDownOnBackdrop && !busy) onClose()
    mouseDownOnBackdrop = false
  }}
>
  <div class="popup" role="dialog" aria-modal="true" aria-label="Set as template">
    <header>
      <div class="head-lead">
        <h2>Set as template</h2>
        <p class="subtitle" title={uprojectPath}>{projectName}</p>
      </div>
      <button type="button" class="close" onclick={onClose} title="Close (Esc)">×</button>
    </header>

    {#if done}
      <div class="banner-ok">
        Template created at <code>{done.templateDir}</code>
        {#if done.mediaCopied === false}
          <span class="hint"> (no AutoScreenshot found — Media/ left empty)</span>
        {/if}
      </div>
    {/if}
    {#if error}
      <div class="banner-error">{error}</div>
    {/if}

    <section>
      <label class="field">
        <span class="lbl">Template name</span>
        <input
          type="text"
          bind:value={templateName}
          disabled={busy}
          spellcheck="false"
          placeholder="TP_MyTemplate"
          class:invalid={!!nameInvalidReason}
        />
        {#if nameInvalidReason}
          <span class="hint hint-error">{nameInvalidReason}</span>
        {:else}
          <span class="hint">Convention: <code>TP_*</code> — used as folder, .uproject name, and C++ identifier.</span>
        {/if}
      </label>

      <label class="field">
        <span class="lbl">Engine</span>
        {#if enginesLoading && engines.length === 0}
          <span class="hint">Scanning engines…</span>
        {:else if engines.length === 0}
          <span class="hint">No engines detected. Configure engine paths in Settings first.</span>
        {:else}
          <select bind:value={selectedEnginePath} disabled={busy}>
            {#each engines as e (e.path)}
              <option value={e.path}>{e.name} ({e.version}) — {e.path}</option>
            {/each}
          </select>
        {/if}
      </label>

      <label class="field">
        <span class="lbl">Display name</span>
        <input
          type="text"
          bind:value={displayName}
          disabled={busy}
          placeholder="The name shown in Unreal's new-project picker"
        />
      </label>

      <label class="field">
        <span class="lbl">Description</span>
        <textarea
          bind:value={description}
          disabled={busy}
          rows="3"
          placeholder="Long description shown under the template name"
        ></textarea>
      </label>

      <label class="field">
        <span class="lbl">Category</span>
        <input
          type="text"
          bind:value={categoryText}
          disabled={busy}
          placeholder="Games"
        />
        <span class="hint">Empty defaults to <code>Games</code>. Comma-separate for multiple.</span>
      </label>

      {#if destPreview}
        <p class="hint">Will create: <code>{destPreview}</code></p>
      {/if}
    </section>

    <footer>
      <button type="button" class="ghost" disabled={busy} onclick={onClose}>Cancel</button>
      <button
        type="button"
        class="primary"
        disabled={busy || !nameValid || !selectedEnginePath}
        onclick={submit}
      >
        {busy ? 'Creating template…' : 'Create template'}
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
    width: 540px;
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
    max-width: 420px;
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
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  input[type='text'],
  select,
  textarea {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.4rem 0.6rem;
    font-family: inherit;
    font-size: 0.85rem;
  }
  textarea {
    resize: vertical;
    font-family: inherit;
  }
  input:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: #c084fc;
  }
  .invalid {
    border-color: #c97070;
  }
  .hint {
    color: #777;
    font-size: 0.75rem;
  }
  .hint-error {
    color: #fbbf24;
  }
  .hint code,
  .banner-ok code {
    color: #c0c0c0;
    background: #1a1a1a;
    padding: 0 0.25em;
    border-radius: 3px;
    overflow-wrap: anywhere;
  }
  .banner-ok {
    background: #15391f;
    color: #c6f5d6;
    border-bottom: 1px solid #1f5430;
    padding: 0.55rem 1.1rem;
    font-size: 0.82rem;
  }
  .banner-error {
    background: #3a1818;
    color: #fca5a5;
    border-bottom: 1px solid #5a2020;
    padding: 0.55rem 1.1rem;
    font-size: 0.82rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.85rem 1.1rem;
    border-top: 1px solid #2a2a2a;
    background: #1f1f1f;
  }
  .ghost {
    background: transparent;
    border: 1px solid #444;
    color: #c0c0c0;
    border-radius: 5px;
    padding: 0.45rem 1rem;
    font-family: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .ghost:hover:not(:disabled) {
    color: #fff;
    border-color: #666;
  }
  .ghost:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .primary {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    font-weight: 500;
  }
  .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
