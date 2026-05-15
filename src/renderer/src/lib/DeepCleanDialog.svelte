<script lang="ts">
  interface Preserve {
    editorPreferences: boolean
    assetCollections: boolean
    saveGames: boolean
    projectThumbnail: boolean
    localPackagedBuilds: boolean
  }

  interface Props {
    projectName: string
    onCancel: () => void
    onConfirm: (preserve: Preserve) => void
  }

  let { projectName, onCancel, onConfirm }: Props = $props()

  // Defaults: keep everything users typically care about (folder colors via
  // EditorPerProjectUserSettings, named collections, save games, the card
  // thumbnail). Local packaged builds default OFF — they're the heaviest
  // thing in Saved/ and usually disposable.
  let editorPreferences = $state(true)
  let assetCollections = $state(true)
  let saveGames = $state(true)
  let projectThumbnail = $state(true)
  let localPackagedBuilds = $state(false)

  function confirm(): void {
    onConfirm({
      editorPreferences,
      assetCollections,
      saveGames,
      projectThumbnail,
      localPackagedBuilds
    })
  }

  function keepNone(): void {
    editorPreferences = false
    assetCollections = false
    saveGames = false
    projectThumbnail = false
    localPackagedBuilds = false
  }

  // Escape cancels the modal. mousedown on the backdrop closes too.
  $effect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
</script>

<div
  class="backdrop"
  role="dialog"
  aria-modal="true"
  aria-labelledby="deep-clean-title"
  onmousedown={onCancel}
>
  <div class="popup" onmousedown={(e) => e.stopPropagation()} role="document">
    <h3 id="deep-clean-title">Deep clean <code>{projectName}</code></h3>
    <p class="explain">
      Wipes <code>Binaries/</code>, <code>Intermediate/</code>,
      <code>DerivedDataCache/</code>, <code>.vs/</code> and the transient parts of
      <code>Saved/</code> (crashes, logs, autosaves, backup, cooked, source-control cache).
    </p>

    <h4 class="section-title">
      Pick what <span class="emphasis">TO KEEP</span> inside <code>Saved/</code>
    </h4>

    <label class="row">
      <input type="checkbox" bind:checked={editorPreferences} />
      <span class="lbl">
        <strong>Editor preferences</strong>
        <span class="hint">
          Folder colors, window layout, <code>EditorPerProjectUserSettings.ini</code>,
          plugin local INIs (BlueprintAssist comments, DarkerNodes overrides, …).
        </span>
      </span>
    </label>

    <label class="row">
      <input type="checkbox" bind:checked={assetCollections} />
      <span class="lbl">
        <strong>Asset collections</strong>
        <span class="hint">Named <code>.collection</code> files under <code>Saved/Collections/</code>.</span>
      </span>
    </label>

    <label class="row">
      <input type="checkbox" bind:checked={saveGames} />
      <span class="lbl">
        <strong>Save games</strong>
        <span class="hint">Runtime <code>.sav</code> files under <code>Saved/SaveGames/</code>.</span>
      </span>
    </label>

    <label class="row">
      <input type="checkbox" bind:checked={projectThumbnail} />
      <span class="lbl">
        <strong>Project thumbnail</strong>
        <span class="hint">
          <code>Saved/AutoScreenshot.png</code> — used by ReHoarder to render the
          project card. Without it the card falls back to a placeholder until you
          re-open the editor.
        </span>
      </span>
    </label>

    <label class="row">
      <input type="checkbox" bind:checked={localPackagedBuilds} />
      <span class="lbl">
        <strong>Local packaged builds</strong>
        <span class="hint">
          <code>Saved/StagedBuilds/</code> + <code>Saved/LocalBuilds/</code>. Output of
          the Package Project flow — can balloon to GBs. Off by default.
        </span>
      </span>
    </label>

    <div class="actions">
      <button type="button" class="ghost" onclick={onCancel}>Cancel</button>
      <button type="button" class="ghost" onclick={keepNone}>Keep none</button>
      <button type="button" class="danger" onclick={confirm}>Deep clean</button>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 290;
  }
  .popup {
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
    padding: 1.25rem 1.4rem 1rem;
    min-width: 480px;
    max-width: 560px;
    color: #e0e0e0;
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 1.05rem;
  }
  h3 code {
    color: #c084fc;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.95rem;
  }
  .explain {
    margin: 0 0 0.9rem;
    color: #b0b0b0;
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .section-title {
    margin: 0.2rem 0 0.45rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: #e0e0e0;
    letter-spacing: 0.01em;
  }
  .section-title code {
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.82rem;
    color: #d0d0d0;
    background: #2a2a2a;
    padding: 0 0.25rem;
    border-radius: 3px;
  }
  .emphasis {
    color: #c084fc;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .explain code,
  .hint code {
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.75rem;
    color: #d0d0d0;
    background: #2a2a2a;
    padding: 0 0.25rem;
    border-radius: 3px;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.45rem 0;
    cursor: pointer;
    border-top: 1px solid #2a2a2a;
  }
  .row:first-of-type {
    border-top: none;
  }
  .row input[type='checkbox'] {
    margin-top: 0.2rem;
    accent-color: #c084fc;
  }
  .lbl {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    flex: 1;
  }
  .lbl strong {
    font-size: 0.85rem;
    color: #fff;
    font-weight: 500;
  }
  .hint {
    font-size: 0.72rem;
    color: #888;
    line-height: 1.35;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.9rem;
  }
  .actions button {
    background: transparent;
    color: #c0c0c0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.35rem 0.85rem;
    font-size: 0.82rem;
    font-family: inherit;
    cursor: pointer;
  }
  .actions button.ghost:hover {
    color: #fff;
    border-color: #666;
  }
  .actions button.danger {
    color: #fca5a5;
    border-color: #5a2727;
  }
  .actions button.danger:hover {
    color: #fff;
    background: #5a2727;
    border-color: #7a3737;
  }
</style>
