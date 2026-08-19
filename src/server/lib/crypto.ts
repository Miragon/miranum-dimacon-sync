import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

/**
 * Verschlüsselung der Mandanten-Credentials: AES-256-GCM mit Key-Ring aus
 * `CREDENTIAL_KEYS` (Komma-Liste `<keyId>=<base64-32-Byte>`; linkester
 * Eintrag verschlüsselt, alle Einträge entschlüsseln). AAD bindet jeden
 * Ciphertext an (Tenant-UUID, System) — ein in eine andere Zeile kopierter
 * Envelope schlägt bei GCM-Authentifizierung fehl.
 *
 * Envelope-Format v1: "v1:<keyId>:<ivB64>:<tagB64>:<ctB64>"
 * (12-Byte-IV, 16-Byte-Tag; ein zukünftiger Algorithmuswechsel wird "v2").
 */

const KEY_ID_PATTERN = /^[a-z0-9_-]{1,16}$/
const IV_BYTES = 12
const TAG_BYTES = 16

export type CryptoErrorKind = "not_configured" | "unknown_key" | "auth_failed" | "malformed"

export class CredentialCryptoError extends Error {
  readonly kind: CryptoErrorKind
  readonly keyId?: string

  constructor(kind: CryptoErrorKind, message: string, keyId?: string) {
    super(message)
    this.name = "CredentialCryptoError"
    this.kind = kind
    this.keyId = keyId
  }
}

interface KeyRing {
  currentId: string
  keys: Map<string, Buffer>
}

let _ring: KeyRing | undefined

function parseKeyRing(): KeyRing {
  const raw = process.env.CREDENTIAL_KEYS
  if (!raw || raw.trim().length === 0) {
    throw new CredentialCryptoError(
      "not_configured",
      "CREDENTIAL_KEYS ist nicht gesetzt — Credentials können nicht ver-/entschlüsselt werden",
    )
  }
  const keys = new Map<string, Buffer>()
  let currentId: string | undefined
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf("=")
    // Fehlermeldungen nennen nur die keyId, nie das Material.
    if (eq <= 0) {
      throw new CredentialCryptoError("malformed", "CREDENTIAL_KEYS: Eintrag ohne '='-Trenner")
    }
    const keyId = trimmed.slice(0, eq)
    if (!KEY_ID_PATTERN.test(keyId)) {
      // Den Slice NIE in Message oder err.keyId ausgeben: fehlt einem
      // Eintrag das "<id>="-Prefix, wäre der Slice das Key-Material selbst
      // (base64 von 32 Byte endet auf genau ein '='-Padding) — und Messages
      // fließen in Logs und sync_runs.error.
      throw new CredentialCryptoError(
        "malformed",
        'CREDENTIAL_KEYS: Eintrag mit ungültiger keyId — fehlt das "<id>="-Prefix?',
      )
    }
    const material = Buffer.from(trimmed.slice(eq + 1), "base64")
    if (material.length !== 32) {
      throw new CredentialCryptoError(
        "malformed",
        `CREDENTIAL_KEYS: Key "${keyId}" ist nicht 32 Byte (base64-dekodiert)`,
        keyId,
      )
    }
    if (keys.has(keyId)) {
      throw new CredentialCryptoError(
        "malformed",
        `CREDENTIAL_KEYS: keyId "${keyId}" doppelt`,
        keyId,
      )
    }
    keys.set(keyId, material)
    currentId ??= keyId
  }
  if (!currentId) {
    throw new CredentialCryptoError("not_configured", "CREDENTIAL_KEYS enthält keinen Key")
  }
  return { currentId, keys }
}

function ring(): KeyRing {
  _ring ??= parseKeyRing()
  return _ring
}

export function isEncryptionConfigured(): boolean {
  const raw = process.env.CREDENTIAL_KEYS
  return Boolean(raw && raw.trim().length > 0)
}

export function currentKeyId(): string {
  return ring().currentId
}

export function credentialAad(tenantId: string, system: string): string {
  return `miranum-credentials|tenant:${tenantId}|system:${system}`
}

export function encryptSecret(plaintext: string, aad: string): string {
  const { currentId, keys } = ring()
  const key = keys.get(currentId)!
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(aad, "utf8"))
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${currentId}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`
}

interface ParsedEnvelope {
  keyId: string
  iv: Buffer
  tag: Buffer
  ciphertext: Buffer
}

function parseEnvelope(payload: string): ParsedEnvelope {
  const parts = payload.split(":")
  if (parts.length !== 5 || parts[0] !== "v1") {
    throw new CredentialCryptoError("malformed", "Envelope hat kein bekanntes v1-Format")
  }
  const [, keyId, ivB64, tagB64, ctB64] = parts
  const iv = Buffer.from(ivB64, "base64")
  const tag = Buffer.from(tagB64, "base64")
  const ciphertext = Buffer.from(ctB64, "base64")
  if (iv.length !== IV_BYTES) {
    throw new CredentialCryptoError("malformed", "Envelope-IV hat falsche Länge", keyId)
  }
  // Tag-Länge VOR final() prüfen — verkürzte Tags schwächen GCM.
  if (tag.length !== TAG_BYTES) {
    throw new CredentialCryptoError("malformed", "Envelope-Tag hat falsche Länge", keyId)
  }
  return { keyId, iv, tag, ciphertext }
}

export function decryptSecret(payload: string, aad: string): string {
  const { keyId, iv, tag, ciphertext } = parseEnvelope(payload)
  const key = ring().keys.get(keyId)
  if (!key) {
    throw new CredentialCryptoError(
      "unknown_key",
      `Key "${keyId}" ist nicht (mehr) im CREDENTIAL_KEYS-Ring — zu früh rotiert?`,
      keyId,
    )
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAAD(Buffer.from(aad, "utf8"))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
  } catch {
    throw new CredentialCryptoError(
      "auth_failed",
      "GCM-Authentifizierung fehlgeschlagen (falscher Key, fremde AAD oder korrupte Daten)",
      keyId,
    )
  }
}

/** true, wenn der Envelope nicht mit dem aktuellen Key verschlüsselt ist. */
export function needsReencrypt(payload: string): boolean {
  return parseEnvelope(payload).keyId !== currentKeyId()
}

/** Nur für Tests: geparsten Key-Ring verwerfen (Env-Änderung wirksam machen). */
export function _resetCryptoForTests(): void {
  _ring = undefined
}
