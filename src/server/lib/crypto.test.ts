import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _resetCryptoForTests,
  CredentialCryptoError,
  credentialAad,
  currentKeyId,
  decryptSecret,
  encryptSecret,
  isEncryptionConfigured,
  needsReencrypt,
} from "./crypto.js"

const ORIGINAL = { ...process.env }

const KEY_1 = randomBytes(32).toString("base64")
const KEY_2 = randomBytes(32).toString("base64")

beforeEach(() => {
  process.env.CREDENTIAL_KEYS = `1=${KEY_1}`
  _resetCryptoForTests()
})

afterEach(() => {
  process.env = { ...ORIGINAL }
  _resetCryptoForTests()
})

const AAD = credentialAad("11111111-1111-1111-1111-111111111111", "dimacon")

describe("encrypt/decrypt roundtrip", () => {
  it("roundtrips a JSON secret payload", () => {
    const plaintext = JSON.stringify({ apiToken: "geheim", baseUrl: "https://x" })
    const envelope = encryptSecret(plaintext, AAD)
    expect(envelope).toMatch(/^v1:1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
    expect(decryptSecret(envelope, AAD)).toBe(plaintext)
  })

  it("produces distinct envelopes per call (random IV)", () => {
    expect(encryptSecret("x", AAD)).not.toBe(encryptSecret("x", AAD))
  })
})

describe("AAD binding", () => {
  it("fails when the ciphertext is moved to another tenant", () => {
    const envelope = encryptSecret("secret", AAD)
    const otherAad = credentialAad("22222222-2222-2222-2222-222222222222", "dimacon")
    expect(() => decryptSecret(envelope, otherAad)).toThrowError(CredentialCryptoError)
    try {
      decryptSecret(envelope, otherAad)
    } catch (err) {
      expect((err as CredentialCryptoError).kind).toBe("auth_failed")
    }
  })

  it("fails when the ciphertext is moved to another system", () => {
    const envelope = encryptSecret("secret", AAD)
    const otherAad = credentialAad("11111111-1111-1111-1111-111111111111", "clockin")
    expect(() => decryptSecret(envelope, otherAad)).toThrowError(CredentialCryptoError)
  })
})

describe("key ring rotation", () => {
  it("decrypts old-key envelopes while encrypting with the new leftmost key", () => {
    const oldEnvelope = encryptSecret("alt", AAD)

    process.env.CREDENTIAL_KEYS = `2=${KEY_2},1=${KEY_1}`
    _resetCryptoForTests()

    expect(currentKeyId()).toBe("2")
    expect(decryptSecret(oldEnvelope, AAD)).toBe("alt")
    expect(needsReencrypt(oldEnvelope)).toBe(true)

    const newEnvelope = encryptSecret("neu", AAD)
    expect(newEnvelope.startsWith("v1:2:")).toBe(true)
    expect(needsReencrypt(newEnvelope)).toBe(false)
  })

  it("reports unknown_key when the key was removed too early", () => {
    const envelope = encryptSecret("alt", AAD)
    process.env.CREDENTIAL_KEYS = `2=${KEY_2}`
    _resetCryptoForTests()
    try {
      decryptSecret(envelope, AAD)
      expect.unreachable()
    } catch (err) {
      expect((err as CredentialCryptoError).kind).toBe("unknown_key")
      expect((err as CredentialCryptoError).keyId).toBe("1")
    }
  })
})

describe("malformed input", () => {
  it("rejects an envelope with wrong format", () => {
    expect(() => decryptSecret("v2:1:a:b:c", AAD)).toThrowError(/v1-Format/)
  })

  it("rejects a truncated auth tag", () => {
    const envelope = encryptSecret("x", AAD)
    const parts = envelope.split(":")
    parts[3] = Buffer.alloc(8).toString("base64")
    try {
      decryptSecret(parts.join(":"), AAD)
      expect.unreachable()
    } catch (err) {
      expect((err as CredentialCryptoError).kind).toBe("malformed")
    }
  })

  it("rejects a ring entry with non-32-byte key material", () => {
    process.env.CREDENTIAL_KEYS = `1=${Buffer.alloc(16).toString("base64")}`
    _resetCryptoForTests()
    expect(() => encryptSecret("x", AAD)).toThrowError(/nicht 32 Byte/)
  })

  it("never includes key material in error messages", () => {
    process.env.CREDENTIAL_KEYS = `1=${Buffer.alloc(16).toString("base64")}`
    _resetCryptoForTests()
    try {
      encryptSecret("x", AAD)
      expect.unreachable()
    } catch (err) {
      expect((err as Error).message).not.toContain(Buffer.alloc(16).toString("base64"))
    }
  })

  it("never leaks the material of a prefix-less entry via message or keyId", () => {
    // Ohne "<id>="-Prefix ist alles vor dem base64-Padding-'=' der Key selbst.
    const material = KEY_1
    process.env.CREDENTIAL_KEYS = material
    _resetCryptoForTests()
    try {
      encryptSecret("x", AAD)
      expect.unreachable()
    } catch (err) {
      const e = err as CredentialCryptoError
      expect(e.kind).toBe("malformed")
      expect(e.message).not.toContain(material.slice(0, 20))
      expect(e.keyId ?? "").not.toContain(material.slice(0, 20))
    }
  })
})

describe("configuration state", () => {
  it("isEncryptionConfigured reflects the env var", () => {
    expect(isEncryptionConfigured()).toBe(true)
    delete process.env.CREDENTIAL_KEYS
    expect(isEncryptionConfigured()).toBe(false)
  })

  it("throws not_configured without CREDENTIAL_KEYS", () => {
    delete process.env.CREDENTIAL_KEYS
    _resetCryptoForTests()
    try {
      encryptSecret("x", AAD)
      expect.unreachable()
    } catch (err) {
      expect((err as CredentialCryptoError).kind).toBe("not_configured")
    }
  })
})
