import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { credentialAad, decryptSecret, encryptSecret } from "../../lib/crypto.js"
import { isHttpUrl } from "../../lib/url.js"
import { getDb } from "../client.js"
import { tenantCredentials } from "../schema.js"

export type CredentialSystem = "dimacon" | "clockin" | "lexoffice" | "sevdesk"

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine(isHttpUrl, { message: "muss mit http:// oder https:// beginnen" })

/**
 * Vollständige (entschlüsselte) Credential-Gestalt je System. Geheim ist nur
 * `apiToken`/`apiKey` — die übrigen Felder liegen als Klartext-`config` in
 * der DB, damit Status-Reads ohne Decrypt auskommen.
 */
export const DimaconCredentialsSchema = z.object({
  apiToken: z.string().trim().min(1),
  baseUrl: httpUrl,
  tenant: z.string().trim().min(1),
})
export const ClockinCredentialsSchema = z.object({
  apiToken: z.string().trim().min(1),
  baseUrl: httpUrl.optional(),
})
export const LexofficeCredentialsSchema = z.object({
  apiKey: z.string().trim().min(1),
  baseUrl: httpUrl.optional(),
})
export const SevdeskCredentialsSchema = z.object({
  apiToken: z.string().trim().min(1),
  baseUrl: httpUrl.optional(),
})

export type DimaconCredentials = z.infer<typeof DimaconCredentialsSchema>
export type ClockinCredentials = z.infer<typeof ClockinCredentialsSchema>
export type LexofficeCredentials = z.infer<typeof LexofficeCredentialsSchema>
export type SevdeskCredentials = z.infer<typeof SevdeskCredentialsSchema>

export type SystemCredentials =
  | DimaconCredentials
  | ClockinCredentials
  | LexofficeCredentials
  | SevdeskCredentials

/** Welches Feld des Systems das Secret trägt (Rest ist Klartext-Config). */
export const SECRET_FIELD: Record<CredentialSystem, "apiToken" | "apiKey"> = {
  dimacon: "apiToken",
  clockin: "apiToken",
  lexoffice: "apiKey",
  sevdesk: "apiToken",
}

const FULL_SCHEMAS: Record<CredentialSystem, z.ZodTypeAny> = {
  dimacon: DimaconCredentialsSchema,
  clockin: ClockinCredentialsSchema,
  lexoffice: LexofficeCredentialsSchema,
  sevdesk: SevdeskCredentialsSchema,
}

export class CredentialsNotFoundError extends Error {
  readonly code = "CREDENTIALS_NOT_FOUND"
  constructor(
    readonly tenantId: string,
    readonly system: CredentialSystem,
  ) {
    super(`no credentials stored for system "${system}"`)
    this.name = "CredentialsNotFoundError"
  }
}

export async function getConfiguredSystems(tenantId: string): Promise<Set<CredentialSystem>> {
  const rows = await getDb()
    .select({ system: tenantCredentials.system })
    .from(tenantCredentials)
    .where(eq(tenantCredentials.tenantId, tenantId))
  return new Set(rows.map((r) => r.system))
}

export interface CredentialStatus {
  system: CredentialSystem
  configured: boolean
  updatedAt: Date | null
  /** keyId aus dem Envelope-Präfix — ohne Decrypt lesbar. */
  keyId: string | null
  config: Record<string, string>
}

const ALL_SYSTEMS: readonly CredentialSystem[] = ["dimacon", "clockin", "lexoffice", "sevdesk"]

export async function listCredentialStatus(tenantId: string): Promise<CredentialStatus[]> {
  const rows = await getDb()
    .select()
    .from(tenantCredentials)
    .where(eq(tenantCredentials.tenantId, tenantId))
  const bySystem = new Map(rows.map((r) => [r.system, r]))
  return ALL_SYSTEMS.map((system) => {
    const row = bySystem.get(system)
    return {
      system,
      configured: Boolean(row),
      updatedAt: row?.updatedAt ?? null,
      keyId: row ? (row.secret.split(":")[1] ?? null) : null,
      config: row?.config ?? {},
    }
  })
}

export async function getDecryptedCredentials(
  tenantId: string,
  system: CredentialSystem,
): Promise<{ payload: SystemCredentials; updatedAt: Date } | undefined> {
  const rows = await getDb()
    .select()
    .from(tenantCredentials)
    .where(and(eq(tenantCredentials.tenantId, tenantId), eq(tenantCredentials.system, system)))
    .limit(1)
  const row = rows[0]
  if (!row) return undefined

  const secretJson = decryptSecret(row.secret, credentialAad(tenantId, system))
  const merged = { ...row.config, ...(JSON.parse(secretJson) as Record<string, string>) }
  const payload = FULL_SCHEMAS[system].parse(merged) as SystemCredentials
  return { payload, updatedAt: row.updatedAt }
}

/**
 * Upsert mit Partial-Update-Semantik: ohne `secretValue` bleibt der bestehende
 * Envelope stehen und nur `config` ändert sich (UI-Kontrakt „Token leer lassen
 * = behalten"). Erst-Save ohne Secret wirft CredentialsNotFoundError.
 */
export async function putCredentials(
  tenantId: string,
  system: CredentialSystem,
  input: { secretValue?: string; config: Record<string, string>; updatedBy?: string },
): Promise<void> {
  const db = getDb()
  // Vollgestalt validieren: config + (neues oder bestehendes) Secret.
  const secretField = SECRET_FIELD[system]

  // Whitespace ist immer ein Paste-Artefakt: getrimmt validieren UND
  // getrimmt verschlüsseln; nur-Whitespace zählt als "kein neues Secret".
  const secretValue = input.secretValue?.trim()
  if (secretValue !== undefined && secretValue !== "") {
    FULL_SCHEMAS[system].parse({ ...input.config, [secretField]: secretValue })
    const secret = encryptSecret(
      JSON.stringify({ [secretField]: secretValue }),
      credentialAad(tenantId, system),
    )
    await db
      .insert(tenantCredentials)
      .values({ tenantId, system, secret, config: input.config, updatedBy: input.updatedBy })
      .onConflictDoUpdate({
        target: [tenantCredentials.tenantId, tenantCredentials.system],
        set: { secret, config: input.config, updatedBy: input.updatedBy, updatedAt: new Date() },
      })
    return
  }

  const existing = await db
    .select({ secret: tenantCredentials.secret })
    .from(tenantCredentials)
    .where(and(eq(tenantCredentials.tenantId, tenantId), eq(tenantCredentials.system, system)))
    .limit(1)
  if (existing.length === 0) throw new CredentialsNotFoundError(tenantId, system)

  FULL_SCHEMAS[system].parse({ ...input.config, [secretField]: "unchanged-placeholder" })
  await db
    .update(tenantCredentials)
    .set({ config: input.config, updatedBy: input.updatedBy, updatedAt: new Date() })
    .where(and(eq(tenantCredentials.tenantId, tenantId), eq(tenantCredentials.system, system)))
}

export async function deleteCredentials(tenantId: string, system: CredentialSystem): Promise<void> {
  await getDb()
    .delete(tenantCredentials)
    .where(and(eq(tenantCredentials.tenantId, tenantId), eq(tenantCredentials.system, system)))
}
