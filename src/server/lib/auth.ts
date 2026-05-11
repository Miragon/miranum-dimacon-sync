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

const WORKOS_ISSUER = "https://api.workos.com"

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

function getJWKS(clientId: string) {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${WORKOS_ISSUER}/sso/jwks/${clientId}`))
  }
  return jwks
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
      issuer: WORKOS_ISSUER,
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
