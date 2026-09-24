import type { EpicWebSession } from '../auth/epic-web-session'
import type { CookieJar } from '../http/cookie-jar'
import type { FabWebSession } from './fab-web-session'

export interface FabSession {
  cookieHeader: string
}

/** Cookie access on the shared Fab partition (Electron implementation in `fab-web-page.ts`). */
export interface FabPartitionCookies {
  /** `Cookie:` header for www.fab.com built from the partition store. */
  fabCookieHeader(): Promise<string>
  /** Copies the Epic side of the jar (not fab.com) into the partition; returns the count. */
  importEpicCookies(jar: CookieJar): Promise<number>
}

/**
 * Entry point used by sync, freebies and downloads before any Fab call.
 *
 * The login itself happens in a real browser window ({@link FabWebSession}):
 * the old fetch-driven OAuth dance ended on Fab's "Authentication error" page
 * and only ever produced an anonymous session. This never opens a visible
 * window: an unauthenticated session is logged and the caller carries on
 * (the UE library and downloads do not need it).
 */
export class FabSessionClient {
  constructor(
    private readonly web: Pick<FabWebSession, 'ensureLoggedIn'>,
    private readonly cookies: FabPartitionCookies
  ) {}

  async establishSession(
    accessToken: string,
    epicSession: EpicWebSession,
    onLog: (msg: string) => void = () => {}
  ): Promise<FabSession> {
    // The browser login is cookie-driven; the bearer token is not used here.
    // Kept on the signature for the existing callers.
    void accessToken
    const status = await this.web.ensureLoggedIn({
      interactive: false,
      onLog,
      // The Epic web cookies bootstrapped by EpicWebSessionFactory are what
      // lets Epic approve the silent login without showing the chooser.
      prepare: async () => {
        const n = await this.cookies.importEpicCookies(epicSession.jar)
        onLog(`Fab: copied ${n} Epic web cookies into the browser partition`)
      }
    })
    onLog(`Fab: web session ${status}`)
    return { cookieHeader: await this.cookies.fabCookieHeader() }
  }
}
