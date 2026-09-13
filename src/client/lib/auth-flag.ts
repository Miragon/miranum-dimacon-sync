const rawClientId = import.meta.env.VITE_WORKOS_CLIENT_ID

export const WORKOS_CLIENT_ID: string | undefined =
  typeof rawClientId === "string" && rawClientId.length > 0 ? rawClientId : undefined

export const AUTH_ENABLED = Boolean(WORKOS_CLIENT_ID)

const rawApiHostname = import.meta.env.VITE_WORKOS_API_HOSTNAME

/**
 * Optionale AuthKit-Domain auf der EIGENEN Site (z. B. `auth.example.com`,
 * während die App unter `example.com` läuft). Nur dann werden Session- und
 * Refresh-Cookie First-Party.
 *
 * Eine WorkOS-eigene Domain (`*.authkit.app`) reicht dafür NICHT: sie ist
 * gegenüber der App-Domain genauso Cross-Site wie `api.workos.com`. Und auf
 * `*.fly.dev` ist die Konstellation gar nicht herstellbar — `fly.dev` steht
 * auf der Public Suffix List, jede Subdomain gilt als eigene Site.
 */
export const WORKOS_API_HOSTNAME: string | undefined =
  typeof rawApiHostname === "string" && rawApiHostname.length > 0 ? rawApiHostname : undefined

/**
 * Refresh-Token lokal halten statt im WorkOS-Cookie (authkit-Option `devMode`
 * — der Name ist irreführend, es geht ausschließlich um die Token-Ablage:
 * `localStorage` + Token im Request-Body statt Cookie, siehe
 * `session-data.ts` und `http-client.ts` in authkit-js).
 *
 * LOAD-BEARING, solange die App nicht unter derselben Site wie AuthKit läuft:
 * ohne First-Party-Cookie schickt authkit den Refresh-Token WEDER im Body noch
 * als Cookie, WorkOS antwortet mit `Missing refresh token`, und es gibt
 * überhaupt keinen Refresh mehr — die Sitzung stirbt, sobald das Access-Token
 * abläuft, und überlebt auch keinen Reload (der Token liegt sonst nur im RAM).
 *
 * Preis: Ein Refresh-Token im `localStorage` ist per XSS auslesbar. Das ist
 * der verbreitete Kompromiss für SPAs ohne eigenes Auth-Backend; die sichere
 * Alternative wäre, den Token serverseitig zu halten (BFF) — das ist ein
 * eigener Umbau, kein Schalter.
 *
 * Sobald eine echte First-Party-Domain gesetzt ist, schaltet das hier
 * automatisch auf den Cookie-Modus zurück.
 */
export const WORKOS_KEEP_REFRESH_TOKEN_LOCALLY = !WORKOS_API_HOSTNAME
