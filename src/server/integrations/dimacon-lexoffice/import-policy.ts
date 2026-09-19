import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { normalizeName } from "../shared/matching.js"
import { contactName, contactNumber } from "./contact-lookup.js"
import type { LexContact } from "./contact-lookup.js"

/**
 * Entscheidet je Beleg-Kontakt, ob die Übernahme Lexware → Dimacon ihn als
 * Kunden anlegt. Rein funktional: keine SDK-, DB- oder Env-Zugriffe. Die
 * Übernahme ist der einzige Schritt, der aus einem Lexware-Kontakt einen
 * neuen Dimacon-Kunden macht — jeder Zweifel führt zu einer gemeldeten Zeile
 * statt zu einer stillen Anlage (gleiche Haltung wie
 * `dimacon-clockin/employee-sync/creation-policy.ts`).
 *
 * Schlüssel ist die Lexware-Kundennummer: Lexware ist schon heute der Master
 * der Nummer (der Vorwärts-Abgleich schreibt sie nach Dimacon zurück). Ein
 * angelegter Kunde trägt sie deshalb von Anfang an — zusammen mit exakt
 * `contactName()` als Namen trifft ihn der nächste Vorwärts-Lauf direkt in
 * der Nummernstufe, ohne Hin und Her zwischen den Systemen.
 */

export type ImportDecision =
  /** Kontakt ist in Dimacon schon vorhanden — keine Ergebniszeile */
  | { kind: "linked" }
  | { kind: "skip"; reason: string }
  /** Die Match-Keys des neuen Kunden; den Rest liefert die Feld-Zuordnung */
  | { kind: "create"; name: string; customerNumber: string }

export interface DimaconCustomerKeys {
  byNumber: ReadonlyMap<string, readonly DimaconCustomerInfo[]>
  byName: ReadonlyMap<string, DimaconCustomerInfo>
  byLooseName: ReadonlyMap<string, DimaconCustomerInfo>
}

export interface ImportPolicyInput {
  /**
   * Lexware-Kontakt-IDs, die der Vorwärts-Abgleich DIESES Laufs einem
   * Dimacon-Kunden zugeordnet hat. Im dry-run (und bei der Namensstufe vor
   * dem Rückschreiben) trägt der Dimacon-Kunde die Lexware-Nummer noch nicht
   * — ohne diese Menge sähe die Übernahme ihn als fehlend an.
   */
  claimed: ReadonlySet<string>
  dimacon: DimaconCustomerKeys
  /** Normalisierte Namen, die unter den Kandidaten dieses Laufs mehrfach vorkommen */
  duplicateCandidateNames: ReadonlySet<string>
}

/**
 * Rechtsformen und Füllwörter, die zwei Schreibweisen desselben Kunden
 * unterscheiden, ohne etwas über die Identität zu sagen („Müller GmbH" vs.
 * „Müller GmbH & Co. KG").
 */
const LEGAL_FORM_TOKENS = new Set([
  "gmbh",
  "mbh",
  "co",
  "kg",
  "kgaa",
  "ag",
  "ug",
  "haftungsbeschrankt",
  "ohg",
  "gbr",
  "ek",
  "ev",
  "se",
  "und",
  "u",
])

/**
 * Loser Firmenschlüssel für die Ähnlichkeits-BREMSE (nie zum Verknüpfen):
 * Umlaut-Schreibweisen vereinheitlicht, Diakritika und Satzzeichen entfernt,
 * Rechtsformen gestrichen. Besteht ein Name NUR aus Rechtsform-Tokens, gibt
 * es keinen Schlüssel ("").
 */
export function looseCompanyKey(name: string | null | undefined): string {
  const folded = (name ?? "")
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // „e.K." / „Co." → ein Token, erst danach Satzzeichen zu Trennern
    .replace(/\./g, "")
    .replace(/[^a-z0-9]+/g, " ")
  return folded
    .split(" ")
    .filter((token) => token && !LEGAL_FORM_TOKENS.has(token))
    .join(" ")
}

/** Schlüssel des Dimacon-Bestands — einmal je Lauf gebaut. */
export function indexDimaconCustomers(
  customers: readonly DimaconCustomerInfo[],
): DimaconCustomerKeys {
  const byNumber = new Map<string, DimaconCustomerInfo[]>()
  const byName = new Map<string, DimaconCustomerInfo>()
  const byLooseName = new Map<string, DimaconCustomerInfo>()
  for (const customer of customers) {
    const number = customer.customerNumber?.trim()
    if (number) byNumber.set(number, [...(byNumber.get(number) ?? []), customer])
    const name = normalizeName(customer.name)
    if (name && !byName.has(name)) byName.set(name, customer)
    const loose = looseCompanyKey(customer.name)
    if (loose && !byLooseName.has(loose)) byLooseName.set(loose, customer)
  }
  return { byNumber, byName, byLooseName }
}

export function decideImport(
  contact: LexContact | undefined,
  input: ImportPolicyInput,
): ImportDecision {
  if (!contact) {
    return { kind: "skip", reason: "Lexware-Kontakt nicht gefunden — nicht angelegt" }
  }
  if (contact.archived === true) {
    return { kind: "skip", reason: "Lexware-Kontakt ist archiviert — nicht angelegt" }
  }
  if (contact.roles?.customer === undefined) {
    return { kind: "skip", reason: "Lexware-Kontakt hat keine Kundenrolle — nicht angelegt" }
  }
  if (input.claimed.has(contact.id)) return { kind: "linked" }

  const number = contactNumber(contact)
  if (!number) {
    return { kind: "skip", reason: "Lexware-Kontakt ohne Kundennummer — nicht angelegt" }
  }
  const name = contactName(contact)

  const sameNumber = input.dimacon.byNumber.get(number) ?? []
  if (sameNumber.some((c) => normalizeName(c.name) === normalizeName(name))) {
    return { kind: "linked" }
  }
  if (sameNumber.length > 0) {
    return {
      kind: "skip",
      reason: `Kundennummer ${number} ist in Dimacon schon an „${sameNumber[0].name}" vergeben — nicht angelegt`,
    }
  }

  if (!name) {
    return { kind: "skip", reason: "Lexware-Kontakt ohne Namen — nicht angelegt" }
  }
  if (input.duplicateCandidateNames.has(normalizeName(name))) {
    return {
      kind: "skip",
      reason:
        "Mehrere Lexware-Kontakte mit diesem Namen haben einen Beleg im Zeitraum — nicht eindeutig, nicht angelegt",
    }
  }

  const loose = looseCompanyKey(name)
  const similar =
    input.dimacon.byName.get(normalizeName(name)) ??
    (loose ? input.dimacon.byLooseName.get(loose) : undefined)
  if (similar) {
    const similarNumber = similar.customerNumber?.trim()
    return {
      kind: "skip",
      reason:
        `In Dimacon gibt es schon „${similar.name}" (${similarNumber ? `Kundennummer ${similarNumber}` : "ohne Kundennummer"}) — nicht angelegt. ` +
        `Ist es derselbe Kunde: in Dimacon die Kundennummer ${number} eintragen, dann verknüpft der nächste Lauf ihn.`,
    }
  }

  return { kind: "create", name, customerNumber: number }
}
