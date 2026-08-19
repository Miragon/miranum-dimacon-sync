import { Hono } from "hono"
import { z } from "zod"
import {
  CredentialsNotFoundError,
  deleteCredentials,
  listCredentialStatus,
  putCredentials,
} from "../db/repos/credentials.js"
import type { CredentialSystem } from "../db/repos/credentials.js"
import { invalidateTenantClients } from "../lib/clients.js"
import { CredentialCryptoError } from "../lib/crypto.js"
import { isHttpUrl } from "../lib/url.js"
import { log } from "../lib/log.js"
import type { AppEnv } from "../lib/tenant.js"

/**
 * Zugangsdaten-Verwaltung je Mandant. Secret-Material verlässt den Server
 * NIE — GET liefert nur Status/Metadaten + Klartext-Config; PUT mit leerem
 * `token` behält das gespeicherte Secret (Metadaten-Update).
 * Schreibrechte: jedes Mitglied der freigeschalteten Org (dokumentierte
 * Entscheidung — internes Ops-Tool).
 */

const SYSTEMS = new Set<CredentialSystem>(["dimacon", "clockin", "lexoffice"])

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine(isHttpUrl, { message: "muss mit http:// oder https:// beginnen" })

// UI-Kontrakt: token optional (leer = behalten); Rest ist Klartext-Config.
const BODY_SCHEMAS: Record<
  CredentialSystem,
  z.ZodType<{ token?: string } & Record<string, unknown>>
> = {
  dimacon: z.object({
    token: z.string().optional(),
    baseUrl: httpUrl,
    tenant: z.string().trim().min(1),
  }),
  clockin: z.object({
    token: z.string().optional(),
    baseUrl: httpUrl.optional().or(z.literal("").transform(() => undefined)),
  }),
  lexoffice: z.object({
    token: z.string().optional(),
    baseUrl: httpUrl.optional().or(z.literal("").transform(() => undefined)),
  }),
}

function parseSystem(raw: string): CredentialSystem | undefined {
  return SYSTEMS.has(raw as CredentialSystem) ? (raw as CredentialSystem) : undefined
}

const app = new Hono<AppEnv>()

app.get("/", async (c) => {
  const tenant = c.get("tenant")
  const status = await listCredentialStatus(tenant.id)
  return c.json(
    status.map((s) => ({
      system: s.system,
      configured: s.configured,
      updatedAt: s.updatedAt?.toISOString() ?? null,
      keyVersion: s.keyId,
      config: s.config,
    })),
  )
})

app.put("/:system", async (c) => {
  const system = parseSystem(c.req.param("system"))
  if (!system) return c.json({ error: "unknown system" }, 404)
  const tenant = c.get("tenant")

  const parsed = BODY_SCHEMAS[system].safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) {
    return c.json({ error: "invalid input", details: parsed.error.flatten() }, 400)
  }
  const { token, ...config } = parsed.data
  const cleanConfig = Object.fromEntries(
    Object.entries(config).filter(([, v]) => typeof v === "string" && v.length > 0),
  ) as Record<string, string>

  try {
    await putCredentials(tenant.id, system, {
      // getrimmt: nur-Whitespace zählt als "Token behalten", nicht als Secret
      secretValue: token && token.trim().length > 0 ? token.trim() : undefined,
      config: cleanConfig,
      updatedBy: c.get("user")?.sub,
    })
  } catch (err) {
    if (err instanceof CredentialsNotFoundError) {
      // Erst-Save braucht ein Token — es gibt noch kein Secret zu behalten.
      return c.json({ error: "token_required" }, 400)
    }
    if (err instanceof CredentialCryptoError) {
      log.error("credential encryption failed", { tenant: tenant.id, system, kind: err.kind })
      return c.json(
        { error: "Verschlüsselung fehlgeschlagen — Schlüsselkonfiguration prüfen" },
        500,
      )
    }
    throw err
  }

  invalidateTenantClients(tenant.id, system)
  const status = (await listCredentialStatus(tenant.id)).find((s) => s.system === system)!
  return c.json({
    system: status.system,
    configured: status.configured,
    updatedAt: status.updatedAt?.toISOString() ?? null,
    keyVersion: status.keyId,
    config: status.config,
  })
})

app.delete("/:system", async (c) => {
  const system = parseSystem(c.req.param("system"))
  if (!system) return c.json({ error: "unknown system" }, 404)
  const tenant = c.get("tenant")
  await deleteCredentials(tenant.id, system)
  invalidateTenantClients(tenant.id, system)
  return c.body(null, 204)
})

export default app
