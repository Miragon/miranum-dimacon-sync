import type { SourceValues } from "./field-mapping.js"
import type { MappingEntity, MappingRule } from "./field-mapping-schema.js"
import { splitZipCity } from "./time.js"

/**
 * Statischer Feld-Katalog für die Feld-Zuordnung: Dimacon-Quellfelder,
 * Clockin-Zielfelder, fixierte Paare (Match-Keys, nie umkonfigurierbar)
 * und die Default-Regeln, die exakt das bisher hartkodierte Verhalten
 * abbilden. Custom-Attribute/-Felder kommen zur Laufzeit per Discovery dazu.
 */

export interface StandardSourceDef {
  /** Schlüssel im SourceValues-Record (z. B. "name", "zipCity.zip") */
  field: string
  label: string
}

export interface StandardTargetDef {
  /** Feldname im Clockin-Write-Body */
  field: string
  label: string
  dataType: "text" | "number" | "date"
}

export interface LockedPairDef {
  sourceLabel: string
  targetField: string
  note: string
}

export interface EntityCatalog {
  standardSources: StandardSourceDef[]
  standardTargets: StandardTargetDef[]
  lockedPairs: LockedPairDef[]
  /** Ziel-Felder, die von den locked pairs belegt sind — nie als Regel-Ziel erlaubt */
  lockedTargetFields: string[]
  /** Ziele, die mindestens eine Regel haben müssen */
  requiredTargets: string[]
  /** overwrite: leere Quelle → null; fillIfNonEmpty: leere Quelle → Feld weglassen */
  writeSemantics: "overwrite" | "fillIfNonEmpty"
  defaultRules: MappingRule[]
}

const std = (field: string): { kind: "standard"; field: string } => ({ kind: "standard", field })

export const FIELD_CATALOG: Record<MappingEntity, EntityCatalog> = {
  project: {
    standardSources: [
      { field: "name", label: "Name" },
      { field: "street", label: "Straße" },
      { field: "zipCity", label: "PLZ + Ort (kombiniert)" },
      { field: "zipCity.zip", label: "PLZ (aus PLZ+Ort)" },
      { field: "zipCity.city", label: "Ort (aus PLZ+Ort)" },
    ],
    standardTargets: [
      { field: "name", label: "Name", dataType: "text" },
      { field: "destination_name", label: "Einsatzort Name", dataType: "text" },
      { field: "destination_street", label: "Einsatzort Straße", dataType: "text" },
      { field: "destination_zip", label: "Einsatzort PLZ", dataType: "text" },
      { field: "destination_city", label: "Einsatzort Ort", dataType: "text" },
      { field: "contact_name", label: "Kontakt Name", dataType: "text" },
      { field: "contact_phone", label: "Kontakt Telefon", dataType: "text" },
      { field: "department", label: "Abteilung", dataType: "text" },
      { field: "cost_center", label: "Kostenstelle", dataType: "text" },
      { field: "description", label: "Beschreibung", dataType: "text" },
      { field: "color", label: "Farbe", dataType: "text" },
    ],
    lockedPairs: [
      { sourceLabel: "Dimacon-Projekt-ID", targetField: "number", note: "match-key" },
      { sourceLabel: "aufgelöster Kunde", targetField: "customer_id", note: "system" },
      { sourceLabel: "Laufdatum 07:30", targetField: "start_date", note: "system" },
      { sourceLabel: "immer aktiv", targetField: "archived", note: "system" },
    ],
    lockedTargetFields: ["number", "customer_id", "start_date", "archived"],
    requiredTargets: ["name"],
    writeSemantics: "overwrite",
    defaultRules: [
      { source: std("name"), target: std("name") },
      { source: std("street"), target: std("destination_street") },
      { source: std("zipCity.zip"), target: std("destination_zip") },
      { source: std("zipCity.city"), target: std("destination_city") },
    ],
  },
  customer: {
    standardSources: [
      { field: "name", label: "Name" },
      { field: "street", label: "Straße" },
      { field: "zipCity", label: "PLZ + Ort (kombiniert)" },
      { field: "zipCity.zip", label: "PLZ (aus PLZ+Ort)" },
      { field: "zipCity.city", label: "Ort (aus PLZ+Ort)" },
      { field: "phoneNumber", label: "Telefon" },
      { field: "email", label: "E-Mail" },
      { field: "description", label: "Beschreibung" },
    ],
    standardTargets: [
      { field: "company", label: "Firma", dataType: "text" },
      { field: "street", label: "Straße", dataType: "text" },
      { field: "zip", label: "PLZ", dataType: "text" },
      { field: "city", label: "Ort", dataType: "text" },
      { field: "phone", label: "Telefon", dataType: "text" },
      { field: "general_email", label: "E-Mail (allgemein)", dataType: "text" },
      { field: "invoice_email", label: "E-Mail (Rechnung)", dataType: "text" },
      { field: "description", label: "Beschreibung", dataType: "text" },
      { field: "contact_name", label: "Kontakt Name", dataType: "text" },
      { field: "website", label: "Website", dataType: "text" },
      { field: "fax", label: "Fax", dataType: "text" },
    ],
    lockedPairs: [
      { sourceLabel: "Kundennummer | Dimacon-ID", targetField: "identifier", note: "match-key" },
      { sourceLabel: 'immer "DE"', targetField: "country", note: "system" },
    ],
    lockedTargetFields: ["identifier", "country"],
    requiredTargets: ["company"],
    writeSemantics: "overwrite",
    defaultRules: [
      { source: std("name"), target: std("company") },
      { source: std("street"), target: std("street") },
      { source: std("zipCity.zip"), target: std("zip") },
      { source: std("zipCity.city"), target: std("city") },
    ],
  },
  lexofficeContact: {
    // Quellen wie beim Clockin-Kunden; Ziele sind gepunktete Pfade in den
    // verschachtelten Lexware-Kontakt-Body (Assembler: contact-body.ts).
    // Lexware Office kennt keine Custom-Felder — Ziele sind rein Standard.
    standardSources: [
      { field: "name", label: "Name" },
      { field: "street", label: "Straße" },
      { field: "zipCity", label: "PLZ + Ort (kombiniert)" },
      { field: "zipCity.zip", label: "PLZ (aus PLZ+Ort)" },
      { field: "zipCity.city", label: "Ort (aus PLZ+Ort)" },
      { field: "phoneNumber", label: "Telefon" },
      { field: "email", label: "E-Mail" },
      { field: "description", label: "Beschreibung" },
    ],
    standardTargets: [
      { field: "addresses.billing.supplement", label: "Adresszusatz", dataType: "text" },
      { field: "addresses.billing.street", label: "Straße", dataType: "text" },
      { field: "addresses.billing.zip", label: "PLZ", dataType: "text" },
      { field: "addresses.billing.city", label: "Ort", dataType: "text" },
      { field: "emailAddresses.business", label: "E-Mail (geschäftlich)", dataType: "text" },
      { field: "phoneNumbers.business", label: "Telefon (geschäftlich)", dataType: "text" },
      { field: "note", label: "Notiz", dataType: "text" },
    ],
    lockedPairs: [
      // company.name ist der De-facto-Match-Key des Find-or-Create per Name —
      // remappbar würde jeder Lauf unauffindbare Duplikate erzeugen.
      { sourceLabel: "Name", targetField: "company.name", note: "match-key" },
      { sourceLabel: "immer Kundenrolle", targetField: "roles.customer", note: "system" },
      { sourceLabel: 'immer "DE"', targetField: "addresses.billing.countryCode", note: "system" },
      { sourceLabel: "Lexware vergibt", targetField: "roles.customer.number", note: "match-key" },
    ],
    lockedTargetFields: [
      "company.name",
      "roles.customer",
      "roles.customer.number",
      "addresses.billing.countryCode",
    ],
    requiredTargets: [],
    writeSemantics: "overwrite",
    defaultRules: [
      { source: std("street"), target: std("addresses.billing.street") },
      { source: std("zipCity.zip"), target: std("addresses.billing.zip") },
      { source: std("zipCity.city"), target: std("addresses.billing.city") },
      { source: std("email"), target: std("emailAddresses.business") },
      { source: std("phoneNumber"), target: std("phoneNumbers.business") },
    ],
  },
  employee: {
    // Dimacon kennt keine Mitarbeiter-Attribute — nur Standardfelder als Quellen.
    standardSources: [
      { field: "phoneNumber", label: "Telefon" },
      { field: "email", label: "E-Mail (User-Konto)" },
      { field: "team", label: "Team" },
      { field: "additionalInformation", label: "Zusatzinfo" },
    ],
    standardTargets: [
      { field: "phone_work", label: "Telefon (Arbeit)", dataType: "text" },
      { field: "mobile_work", label: "Mobil (Arbeit)", dataType: "text" },
      { field: "position", label: "Position", dataType: "text" },
      { field: "department_name", label: "Abteilung", dataType: "text" },
      { field: "street", label: "Straße", dataType: "text" },
      { field: "zip", label: "PLZ", dataType: "text" },
      { field: "city", label: "Ort", dataType: "text" },
      { field: "comments", label: "Kommentar", dataType: "text" },
    ],
    lockedPairs: [
      { sourceLabel: "Vorname", targetField: "first_name", note: "match-key" },
      { sourceLabel: "Nachname", targetField: "last_name", note: "match-key" },
      { sourceLabel: "Personalnummer", targetField: "personnel_number", note: "match-key" },
      {
        sourceLabel: "E-Mail (Clockin-Wert bleibt erhalten)",
        targetField: "email",
        note: "system",
      },
    ],
    lockedTargetFields: ["first_name", "last_name", "personnel_number", "email"],
    requiredTargets: [],
    writeSemantics: "fillIfNonEmpty",
    defaultRules: [{ source: std("phoneNumber"), target: std("phone_work") }],
  },
}

/** Welche Integration bildet welche Entitäten ab */
export const MAPPABLE_ENTITIES: Record<string, MappingEntity[]> = {
  "dimacon-clockin": ["project", "customer"],
  "dimacon-clockin-employees": ["employee"],
  "dimacon-lexoffice": ["lexofficeContact"],
}

interface AttributeValueRow {
  attributeId: string
  value?: string
}

function attributeMap(values: AttributeValueRow[] | undefined): Map<string, string | undefined> {
  return new Map((values ?? []).map((v) => [v.attributeId, v.value]))
}

export function projectSourceValues(p: {
  name: string
  street?: string
  zipCity?: string
  customAttributeValues?: AttributeValueRow[]
}): SourceValues {
  const { zip, city } = splitZipCity(p.zipCity)
  return {
    standard: {
      name: p.name,
      street: p.street,
      zipCity: p.zipCity,
      "zipCity.zip": zip,
      "zipCity.city": city,
    },
    attributes: attributeMap(p.customAttributeValues),
  }
}

export function customerSourceValues(c: {
  name: string
  street?: string
  zipCity?: string
  phoneNumber?: string
  email?: string
  description?: string
  customAttributeValues?: AttributeValueRow[]
}): SourceValues {
  const { zip, city } = splitZipCity(c.zipCity)
  return {
    standard: {
      name: c.name,
      street: c.street,
      zipCity: c.zipCity,
      "zipCity.zip": zip,
      "zipCity.city": city,
      phoneNumber: c.phoneNumber,
      email: c.email,
      description: c.description,
    },
    attributes: attributeMap(c.customAttributeValues),
  }
}

export function employeeSourceValues(e: {
  phoneNumber?: string
  email?: string
  team?: string
  additionalInformation?: string
}): SourceValues {
  return {
    standard: {
      phoneNumber: e.phoneNumber,
      email: e.email,
      team: e.team,
      additionalInformation: e.additionalInformation,
    },
    attributes: new Map(),
  }
}
