/**
 * Public OAuth credentials of the official Epic Games Launcher.
 *
 * These are the same credentials used by every third-party Epic launcher
 * (Legendary, Heroic, Rare, etc.). They are extracted from the official
 * Epic Games Launcher binary and have been public for years. Epic has
 * tolerated this approach for the entire history of these projects.
 */
export const EPIC_LAUNCHER_CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a'
export const EPIC_LAUNCHER_CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf'

/** `Authorization: basic <b64>` for `/oauth/token`. */
export const EPIC_LAUNCHER_BASIC_AUTH =
  'basic ' +
  Buffer.from(`${EPIC_LAUNCHER_CLIENT_ID}:${EPIC_LAUNCHER_CLIENT_SECRET}`).toString('base64')

/** Epic public OAuth host that serves `/account/api/oauth/token` and `/exchange`. */
export const EPIC_OAUTH_HOST_PROD03 = 'https://account-public-service-prod03.ol.epicgames.com'

/** Epic public OAuth host that serves `/account/api/oauth/verify`. (Different host from prod03 — `/verify` lives on the prod hostname.) */
export const EPIC_OAUTH_HOST_PROD = 'https://account-public-service-prod.ol.epicgames.com'

export const EPIC_TOKEN_ENDPOINT = `${EPIC_OAUTH_HOST_PROD03}/account/api/oauth/token`
export const EPIC_VERIFY_ENDPOINT = `${EPIC_OAUTH_HOST_PROD}/account/api/oauth/verify`

/**
 * Build the URL the user should open in their system browser to start the
 * Exchange Code flow. After the user authenticates (or is already SSO-logged
 * in on epicgames.com), Epic redirects to its own `/id/api/redirect` endpoint,
 * which renders a page containing an `authorizationCode` field. The user
 * copies that code and pastes it back into the app.
 */
export function buildEpicLoginUrl(): string {
  const redirectTarget =
    `https://www.epicgames.com/id/api/redirect` +
    `?clientId=${EPIC_LAUNCHER_CLIENT_ID}` +
    `&responseType=code`
  return `https://www.epicgames.com/id/login?redirectUrl=${encodeURIComponent(redirectTarget)}`
}
