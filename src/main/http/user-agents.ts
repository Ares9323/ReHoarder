/**
 * User-Agent + helper headers for the Epic→Fab session handshake.
 *
 * **LAUNCHER_UA** — Launcher-style UA used for every Epic/Fab request in
 * the handshake (E1-E4 + F1-F5). Format mimics the Epic Games Launcher
 * fingerprint. Fab specifically requires this style — sending a generic
 * browser UA (Chrome) to `/social/login/epic/` returns HTTP 403.
 *
 * **BROWSER_UA** — Generic Chrome desktop UA. Kept for any future call
 * that genuinely needs a browser fingerprint.
 *
 * **EPIC_WEB_HEADERS** — The `x-epic-*` headers Epic's web stack expects
 * on every authenticated request. They identify the request as coming
 * from an "Epic ecosystem" client; without these, Fab's anti-bot returns
 * 403 on the OAuth start endpoint. Note: `x-epic-client-id: 'undefined'`
 * is the literal string "undefined" — match exactly.
 */

const REHOARDER_VERSION = '0.1.0-dev'
const OS_RELEASE = '10.0.22631.1.768.64bit' // Win11 23H2; harmless if mismatched

export const LAUNCHER_UA =
  `ReHoarder/${REHOARDER_VERSION}+++Portal+Release-Live Windows/${OS_RELEASE}`

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export const EPIC_WEB_HEADERS: Record<string, string> = {
  'x-epic-client-id': 'undefined',
  'x-epic-display-mode': 'web',
  'x-epic-platform': 'WEB'
}
