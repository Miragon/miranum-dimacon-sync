import { createMiddleware } from "hono/factory"
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import { env } from "./env.js"
import { formatError } from "./errors.js"
import { log } from "./log.js"

export interface WorkOSClaims extends JWTPayload {
  sub: string
  org_id?: string
  role?: string
  permissions?: string[]
  sid?: string
}

interface AuthEnv {
  Variables: {
    user: WorkOSClaims
  }
}

const WORKOS_JWKS_BASE = "https://api.workos.com/sso/jwks"

// AuthKit-Access-Tokens tragen diesen Issuer (User-Management-API).
// Bei einem Issuer-Mismatch loggt jose die Details — siehe "auth token
// invalid"-Warnung mit ERR_JWT_CLAIM_VALIDATION_FAILED.
function expectedIssuer(clientId: string): string {
  return `https://api.workos.com/user_management/${clientId}`
}

// Pro Client-ID gecacht (nicht global): ein geänderter WORKOS_CLIENT_ID darf
// nie stillschweigend das alte Key-Set weiterverwenden.
const jwksByClientId = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getJWKS(clientId: string) {
  let jwks = jwksByClientId.get(clientId)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${WORKOS_JWKS_BASE}/${clientId}`), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
    })
    jwksByClientId.set(clientId, jwks)
  }
  return jwks
}

/** Nur für Tests: JWKS-Cache leeren. */
export function resetJwksCache(): void {
  jwksByClientId.clear()
}

export function isAuthConfigured(): boolean {
  return Boolean(env.workos.clientId())
}

/**
 * Ergebnis der Token-Prüfung. `unavailable` trennt transiente Fehler
 * (JWKS-Timeout, Netz) von „Token ungültig" — sonst wirft ein
 * JWKS-Ausfall den Nutzer per 401 in einen sinnlosen Re-Login.
 */
export type AccessTokenCheck =
  | { status: "valid"; claims: WorkOSClaims }
  | { status: "invalid"; code: "TOKEN_EXPIRED" | "TOKEN_INVALID" }
  | { status: "unavailable" }

/** Deutsche Meldung für den 503-Pfad — Client und Run-Route teilen sie sich. */
export const AUTH_UNAVAILABLE_MESSAGE =
  "Anmeldedienst nicht erreichbar — bitte in einer Minute erneut versuchen"

// Allowlist: nur diese jose-Codes bedeuten „das Token taugt nicht".
const TOKEN_INVALID_CODES = new Set([
  "ERR_JWS_INVALID",
  "ERR_JWT_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
])

/**
 * Bewusst defensiv: alles außerhalb der Allowlist (ERR_JWKS_TIMEOUT,
 * ERR_JWKS_NO_MATCHING_KEY, ERR_JOSE_GENERIC beim JWKS-Fetch, rohe
 * fetch-TypeErrors ohne `code`) gilt als transient. Der Zugriff wird in
 * beiden Fällen verweigert — nur startet der Client bei 503 keinen Re-Login.
 */
function classifyVerifyError(err: unknown): AccessTokenCheck {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === "string") {
    if (code === "ERR_JWT_EXPIRED") return { status: "invalid", code: "TOKEN_EXPIRED" }
    if (TOKEN_INVALID_CODES.has(code)) return { status: "invalid", code: "TOKEN_INVALID" }
  }
  return { status: "unavailable" }
}

/**
 * Verifiziert ein AuthKit-Access-Token. Auch vom Dual-Auth-Webhook-Handler
 * genutzt, der Bearer-JWTs akzeptiert. Die Mandanten-Zuordnung
 * (org_id → tenants-Zeile) passiert NICHT hier, sondern in lib/tenant.ts —
 * Auth bleibt reine Token-Prüfung.
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenCheck> {
  const clientId = env.workos.clientId()
  if (!clientId) return { status: "invalid", code: "TOKEN_INVALID" }
  try {
    const { payload } = await jwtVerify(token, getJWKS(clientId), {
      algorithms: ["RS256"],
      issuer: expectedIssuer(clientId),
      // Uhr-Drift (Laptop nach Standby) erzeugt sonst serverseitig
      // ERR_JWT_EXPIRED, während der Client den Token für gültig hält.
      clockTolerance: 30,
    })
    return { status: "valid", claims: payload as WorkOSClaims }
  } catch (err) {
    const result = classifyVerifyError(err)
    if (result.status === "invalid") {
      log.warn("auth token invalid", { code: result.code })
    } else {
      log.error("auth backend unavailable", { error: formatError(err) })
    }
    return result
  }
}

/**
 * Code-Set aller 401-Antworten — Pendant zu `TenantErrorCode` (403) in
 * lib/tenant.ts. README und CLAUDE.md nennen genau diese drei.
 */
export type AuthErrorCode = "TOKEN_MISSING" | "TOKEN_EXPIRED" | "TOKEN_INVALID"

/**
 * Challenge-Wert für JEDES 401. RFC 9110 verlangt bei einem 401 ein
 * `WWW-Authenticate`; RFC 6750 §3.1 verlangt umgekehrt, dass eine Anfrage ganz
 * OHNE Anmeldeinformation KEINEN `error`-Parameter zurückbekommt —
 * `invalid_token` beschreibt nur ein vorgelegtes, aber untaugliches Token.
 * Einzige Quelle des Strings, damit kein 401-Pfad ihn wieder vergisst.
 */
export function bearerChallenge(code: AuthErrorCode): string {
  return code === "TOKEN_MISSING" ? "Bearer" : 'Bearer error="invalid_token"'
}

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  if (!isAuthConfigured()) return next()

  const auth = c.req.header("authorization")
  const match = auth?.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    c.header("WWW-Authenticate", bearerChallenge("TOKEN_MISSING"))
    return c.json({ error: "missing bearer token", code: "TOKEN_MISSING" }, 401)
  }

  const result = await verifyAccessToken(match[1])
  if (result.status === "unavailable") {
    return c.json({ error: AUTH_UNAVAILABLE_MESSAGE, code: "AUTH_UNAVAILABLE" }, 503)
  }
  if (result.status === "invalid") {
    c.header("WWW-Authenticate", bearerChallenge(result.code))
    return c.json({ error: "invalid token", code: result.code }, 401)
  }
  c.set("user", result.claims)
  return next()
})
