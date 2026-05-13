<script lang="ts">
  import { onMount } from 'svelte'
  import { bumpSettingsVersion } from '../stores/settings-events.svelte'

  type ImageSize = 'small' | 'medium' | 'large'
  interface AppSettings {
    loginAtStartup: boolean
    checkVersionAtStartup: boolean
    exitOnLaunchUnreal: boolean
    compilePluginsOnInstall: boolean
    deleteExtraVaultPlatforms: boolean
    downloadThreads: number
    imageSize: ImageSize
    projectPaths: string[]
    enginePaths: string[]
    vaultPaths: string[]
    separateProjectsByPath: boolean
    separateVaultsByPath: boolean
    gameLaunchParams: string[]
  }

  let settings = $state<AppSettings | null>(null)
  // Path arrays are edited as multiline text in the UI, kept as text strings
  // so the user can type intermediate states (blank lines, partial paths).
  let projectPathsText = $state('')
  let enginePathsText = $state('')
  let vaultPathsText = $state('')
  let gameLaunchParamsText = $state('')

  let loading = $state(true)
  let saving = $state(false)
  let error = $state<string | null>(null)
  let savedFlash = $state(false)
  let dirty = $state(false)

  function fromArray(arr: string[]): string {
    return arr.join('\n')
  }
  function toArray(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }
  function fromArgs(arr: string[]): string {
    return arr.join(' ')
  }
  function toArgs(text: string): string[] {
    return text
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  async function load(): Promise<void> {
    loading = true
    error = null
    try {
      const s = await window.api.settings.get()
      settings = s
      projectPathsText = fromArray(s.projectPaths)
      enginePathsText = fromArray(s.enginePaths)
      vaultPathsText = fromArray(s.vaultPaths)
      gameLaunchParamsText = fromArgs(s.gameLaunchParams)
      dirty = false
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  }

  async function save(): Promise<void> {
    if (!settings) return
    saving = true
    error = null
    try {
      const payload: AppSettings = {
        ...settings,
        projectPaths: toArray(projectPathsText),
        enginePaths: toArray(enginePathsText),
        vaultPaths: toArray(vaultPathsText),
        gameLaunchParams: toArgs(gameLaunchParamsText)
      }
      const saved = await window.api.settings.set(payload)
      settings = saved
      projectPathsText = fromArray(saved.projectPaths)
      enginePathsText = fromArray(saved.enginePaths)
      vaultPathsText = fromArray(saved.vaultPaths)
      gameLaunchParamsText = fromArgs(saved.gameLaunchParams)
      dirty = false
      savedFlash = true
      window.setTimeout(() => (savedFlash = false), 1500)
      bumpSettingsVersion()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      saving = false
    }
  }

  function markDirty(): void {
    dirty = true
  }

  onMount(load)
</script>

<section>
  <header class="bar">
    <h2>Settings</h2>
    <div class="status">
      {#if savedFlash}<span class="ok">Saved ✓</span>{/if}
      {#if error}<span class="err">{error}</span>{/if}
      <button type="button" class="primary" onclick={save} disabled={!dirty || saving || loading}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </header>

  {#if loading || !settings}
    <p class="loading">Loading settings…</p>
  {:else}
    <div class="grid">
      <div class="group">
        <h3>Startup &amp; behavior</h3>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.loginAtStartup}
            onchange={markDirty}
          />
          Login to Epic at startup
        </label>
        <label class="disabled-soft">
          <input
            type="checkbox"
            bind:checked={settings.checkVersionAtStartup}
            onchange={markDirty}
          />
          Check version at startup
          <span class="hint">(requires Velopack auto-updater — not wired yet)</span>
        </label>
        <label class="disabled-soft">
          <input
            type="checkbox"
            bind:checked={settings.exitOnLaunchUnreal}
            onchange={markDirty}
          />
          Exit ReHoarder when launching Unreal
          <span class="hint">(active once engine/project launch lands)</span>
        </label>
      </div>

      <div class="group">
        <h3>Downloads</h3>
        <label class="row">
          <span class="lbl">Download threads</span>
          <input
            type="number"
            min="1"
            max="64"
            step="1"
            class="num-input"
            bind:value={settings.downloadThreads}
            onchange={markDirty}
          />
          <span class="hint">(1–64, file-level worker pool)</span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.compilePluginsOnInstall}
            onchange={markDirty}
          />
          Compile plugins when installing
          <span class="hint">(invokes <code>RunUAT BuildPlugin</code>; default ON on Linux)</span>
        </label>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.deleteExtraVaultPlatforms}
            onchange={markDirty}
          />
          Skip non-current-platform binaries
          <span class="hint">(don't download <code>Binaries/Mac</code>, <code>Binaries/Linux</code>, etc.)</span>
        </label>
      </div>

      <div class="group">
        <h3>Appearance</h3>
        <label class="row">
          <span class="lbl">Image size</span>
          <select bind:value={settings.imageSize} onchange={markDirty}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
      </div>

      <div class="group full">
        <h3>Project paths</h3>
        <p class="explain">
          Folders scanned recursively for <code>*.uproject</code>. One path per line.
        </p>
        <textarea
          rows="3"
          bind:value={projectPathsText}
          oninput={markDirty}
          spellcheck="false"
        ></textarea>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.separateProjectsByPath}
            onchange={markDirty}
          />
          Separate by path
          <span class="hint">(render one table per root path on the Projects tab)</span>
        </label>
        <label class="stack">
          <span class="lbl-block">Run params</span>
          <input
            type="text"
            class="text-input"
            placeholder="-log -windowed -ResX=1280 -ResY=720"
            bind:value={gameLaunchParamsText}
            oninput={markDirty}
            spellcheck="false"
          />
          <span class="hint">
            Extra args appended after <code>-game</code> when clicking <strong>Run</strong>.
            Space-separated. <code>-game</code> is added automatically.
          </span>
        </label>
      </div>

      <div class="group full">
        <h3>Unreal Engine paths</h3>
        <p class="explain">
          Folders scanned for <code>UE_*/Engine/Build/Build.version</code>. One per line.
        </p>
        <textarea
          rows="3"
          bind:value={enginePathsText}
          oninput={markDirty}
          spellcheck="false"
        ></textarea>
      </div>

      <div class="group full">
        <h3>Vault paths</h3>
        <p class="explain">
          Where downloaded assets are written. The first writable path wins; the others are scanned read-only.
        </p>
        <textarea
          rows="3"
          bind:value={vaultPathsText}
          oninput={markDirty}
          spellcheck="false"
        ></textarea>
        <label>
          <input
            type="checkbox"
            bind:checked={settings.separateVaultsByPath}
            onchange={markDirty}
          />
          Separate by path
          <span class="hint">(render one table per root path on the Vault tab)</span>
        </label>
      </div>
    </div>
  {/if}
</section>

<style>
  section {
    padding: 1.5rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  .bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #fff;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.85rem;
  }
  .ok {
    color: #86efac;
  }
  .err {
    color: #fca5a5;
    max-width: 400px;
  }
  .primary {
    background: linear-gradient(135deg, #c084fc, #f472b6);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 0.45rem 1.1rem;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
    font-weight: 500;
  }
  .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .loading {
    color: #888;
    text-align: center;
    padding: 2rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
  }
  .group {
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .group.full {
    grid-column: 1 / -1;
  }
  h3 {
    margin: 0 0 0.3rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #c084fc;
    font-weight: 600;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: #d0d0d0;
    font-size: 0.85rem;
    cursor: pointer;
    flex-wrap: wrap;
  }
  label.row {
    display: flex;
  }
  .lbl {
    color: #b0b0b0;
    min-width: 140px;
  }
  .hint {
    color: #777;
    font-size: 0.74rem;
  }
  .hint code {
    color: #a0a0a0;
    font-size: 0.72rem;
  }
  .disabled-soft {
    opacity: 0.78;
  }
  input[type='checkbox'] {
    accent-color: #c084fc;
    width: 1rem;
    height: 1rem;
  }
  .num-input {
    width: 70px;
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.25rem 0.45rem;
    font-family: inherit;
    font-size: 0.85rem;
  }
  .text-input {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.3rem 0.55rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.8rem;
    box-sizing: border-box;
    width: 100%;
  }
  .text-input::placeholder {
    color: #555;
  }
  label.stack {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    align-items: stretch;
  }
  .lbl-block {
    color: #b0b0b0;
    font-size: 0.85rem;
  }
  select {
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.25rem 0.45rem;
    font-family: inherit;
    font-size: 0.85rem;
  }
  textarea {
    width: 100%;
    background: #1a1a1a;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    color: #e0e0e0;
    padding: 0.5rem 0.7rem;
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 0.8rem;
    resize: vertical;
    box-sizing: border-box;
  }
  .explain {
    color: #888;
    font-size: 0.75rem;
    margin: 0;
  }
</style>
