// Local mirror of the AuthState type from src/preload/index.d.ts.
// We can't import from preload because TS resolves to the .ts source which is
// outside this project's include scope. Keep this in sync with the preload definition.
type AuthState =
  | { status: 'anonymous' }
  | { status: 'authenticated'; accountId: string; displayName: string }

type AuthStore = {
  readonly state: AuthState
  readonly busy: boolean
  refresh(): Promise<void>
  startLogin(): Promise<void>
  submitCode(code: string): Promise<{ ok: boolean; error?: { code: string; message: string } }>
  logout(): Promise<void>
}

export function createAuthStore(): AuthStore {
  let state = $state<AuthState>({ status: 'anonymous' })
  let busy = $state(false)

  window.api.auth.onStateChanged((next) => {
    state = next
  })

  return {
    get state() {
      return state
    },
    get busy() {
      return busy
    },
    async refresh() {
      state = await window.api.auth.getState()
    },
    async startLogin() {
      busy = true
      try {
        await window.api.auth.startLogin()
      } finally {
        busy = false
      }
    },
    async submitCode(code: string) {
      busy = true
      try {
        return await window.api.auth.submitCode(code)
      } finally {
        busy = false
      }
    },
    async logout() {
      busy = true
      try {
        await window.api.auth.logout()
      } finally {
        busy = false
      }
    }
  }
}
