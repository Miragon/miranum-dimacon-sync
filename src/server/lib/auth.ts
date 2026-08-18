import { createMiddleware } from "hono/factory"
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import { env } from "./env.js"
import { formatError } from "./errors.js"
import { log } from "./log.js"

interface WorkOSClaims extends JWTPayload {
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

export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const clientId = env.workos.clientId()
  if (!clientId) return next()

  const auth = c.req.header("authorization")
  const match = auth?.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return c.json({ error: "missing bearer token" }, 401)
  }

  try {
    const { payload } = await jwtVerify(match[1], getJWKS(clientId), {
      algorithms: ["RS256"],
      issuer: expectedIssuer(clientId),
    })
    const claims = payload as WorkOSClaims
    const requiredOrg = env.workos.requiredOrgId()
    if (requiredOrg && claims.org_id !== requiredOrg) {
      log.warn("auth org mismatch", { got: claims.org_id, want: requiredOrg, sub: claims.sub })
      return c.json({ error: "forbidden: wrong organization" }, 403)
    }
    c.set("user", claims)
    return next()
  } catch (err) {
    log.warn("auth token invalid", { error: formatError(err) })
    return c.json({ error: "invalid token" }, 401)
  }
})
