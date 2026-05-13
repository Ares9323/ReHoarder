<script lang="ts">
  interface Props {
    busy: boolean
    onStartLogin: () => void
    onSubmitCode: (
      code: string
    ) => Promise<{ ok: boolean; error?: { code: string; message: string } }>
  }
  let { busy, onStartLogin, onSubmitCode }: Props = $props()

  let code = $state('')
  let errorMessage = $state<string | null>(null)

  async function submit(): Promise<void> {
    errorMessage = null
    const result = await onSubmitCode(code)
    if (!result.ok) {
      errorMessage = friendlyError(result.error?.code, result.error?.message)
    }
  }

  function friendlyError(code: string | undefined, message: string | undefined): string {
    if (!code) return message ?? 'Sign-in failed.'
    if (code.includes('exchange_code_not_found'))
      return 'That code is invalid or already used. Click "Open Epic Login" to get a new one.'
    if (code.includes('invalid_grant'))
      return 'That code has expired (Epic codes last only a few minutes). Click "Open Epic Login" to get a new one.'
    return message ?? `Sign-in failed (${code}).`
  }
</script>

<main>
  <div class="card">
    <h1>Sign in to Epic</h1>
    <p class="hint">
      ReHoarder uses your Epic Games account to read your asset library. Your password never leaves
      Epic — we only receive an access token.
    </p>

    <button type="button" class="primary" disabled={busy} onclick={() => onStartLogin()}>
      Open Epic Login in browser
    </button>

    <ol>
      <li>Sign in (or confirm if already signed in).</li>
      <li>Copy the <strong>authorizationCode</strong> value from the page Epic shows you.</li>
      <li>Paste it below.</li>
    </ol>

    <label for="code">Authorization code</label>
    <textarea
      id="code"
      bind:value={code}
      placeholder="Paste the 32-character authorizationCode here"
      rows="3"
      disabled={busy}
    ></textarea>

    <button
      type="button"
      class="primary"
      disabled={busy || code.trim().length === 0}
      onclick={submit}
    >
      {busy ? 'Signing in…' : 'Sign in'}
    </button>

    {#if errorMessage}
      <p class="error" role="alert">{errorMessage}</p>
    {/if}
  </div>
</main>

<style>
  main {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
  }

  .card {
    width: 100%;
    max-width: 480px;
    background: #242424;
    border: 1px solid #333;
    border-radius: 8px;
    padding: 2rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  h1 {
    margin: 0 0 0.5rem;
    font-size: 1.5rem;
  }

  .hint {
    color: #a0a0a0;
    margin: 0 0 1.25rem;
    font-size: 0.9rem;
  }

  ol {
    color: #c0c0c0;
    font-size: 0.85rem;
    padding-left: 1.25rem;
    margin: 1rem 0;
  }

  ol li + li {
    margin-top: 0.25rem;
  }

  label {
    display: block;
    font-size: 0.85rem;
    color: #c0c0c0;
    margin: 0.75rem 0 0.25rem;
  }

  textarea {
    width: 100%;
    background: #1a1a1a;
    color: #e0e0e0;
    border: 1px solid #444;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    font-family: inherit;
    font-size: 0.9rem;
    resize: vertical;
  }

  textarea:focus {
    outline: none;
    border-color: #c084fc;
  }

  .primary {
    display: block;
    width: 100%;
    background: linear-gradient(135deg, #c084fc 0%, #f472b6 100%);
    color: white;
    border: none;
    border-radius: 4px;
    padding: 0.6rem 1rem;
    font-size: 0.95rem;
    font-weight: 500;
    cursor: pointer;
    margin-top: 0.75rem;
  }

  .primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    color: #f87171;
    font-size: 0.85rem;
    margin: 0.75rem 0 0;
  }
</style>
