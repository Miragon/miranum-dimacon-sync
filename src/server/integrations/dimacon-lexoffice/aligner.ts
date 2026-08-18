import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import type { Client as LexofficeClient } from "@miragon/client-lexoffice"
import { withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { customerSourceValues, FIELD_CATALOG } from "../shared/field-catalog.js"
import { applyMapping, EMPTY_DISCOVERY } from "../shared/field-mapping.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import { buildLexofficeContactBody } from "./contact-body.js"
import type { CustomerAlignRow, LexofficeSyncSteps } from "./types.js"

interface LexContact {
  id: string
  version: number
  roles?: { customer?: { number?: string } }
  company?: { name?: string }
}

interface LexContactsResponse {
  content?: LexContact[]
}

/**
 * Lexware-Kontakt find-or-create + Kundennummern-Alignment (extrahiert aus
 * dem früheren kombinierten Clockin-Sync, Semantik unverändert):
 *
 * - Kontakt wird per Name gesucht (exakter Match, normalisiert) und bei
 *   Bedarf angelegt.
 * - Die Dimacon-Kundennummer wird nur dann auf die Lexware-Nummer gesetzt,
 *   wenn beide vorhanden sind und sich unterscheiden.
 * - Die Lexware-Create-Response enthält i. d. R. keine `roles` (und damit
 *   keine Nummer) — frisch angelegte Kontakte werden deshalb erst beim
 *   nächsten Lauf aligned, wenn der Kontakt per Name gefunden wird.
 */
export class CustomerAligner {
  constructor(
    private readonly dimaconClient: DimaconClient,
    private readonly lexofficeClient: LexofficeClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
    private readonly steps: LexofficeSyncSteps = { createContacts: true, alignNumbers: true },
    /** Feld-Zuordnung für den Create-Body (Kontakte werden nie aktualisiert) */
    private readonly mapping?: EntityMappingContext,
    private readonly onMappingWarning: (message: string) => void = () => undefined,
  ) {}

  async align(customer: DimaconCustomerInfo): Promise<CustomerAlignRow> {
    const existing = await this.findInLexware(customer.name)

    if (!existing) {
      if (!this.steps.createContacts) {
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          status: "skipped",
          reason: "Kontakt-Schritt deaktiviert — Kontakt existiert nicht in Lexware",
        }
      }
      if (this.dryRun) {
        this.log.info("[dryRun] would create lexware contact", { name: customer.name })
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          status: "created",
          reason: "[dryRun] Lexware-Kontakt würde angelegt",
        }
      }

      const created = await this.createInLexware(customer)
      const createdNumber = created.roles?.customer?.number
      if (
        this.steps.alignNumbers &&
        createdNumber &&
        customer.customerNumber &&
        createdNumber !== customer.customerNumber
      ) {
        await this.alignDimaconNumber(customer, createdNumber)
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          lexwareContactId: created.id,
          lexwareNumber: createdNumber,
          status: "created",
          reason: `Dimacon-Kundennummer ${customer.customerNumber} → ${createdNumber}`,
        }
      }
      return {
        dimaconCustomerId: customer.id,
        name: customer.name,
        lexwareContactId: created.id,
        lexwareNumber: createdNumber,
        status: "created",
      }
    }

    const lexNumber = existing.roles?.customer?.number
    if (
      this.steps.alignNumbers &&
      lexNumber &&
      customer.customerNumber &&
      lexNumber !== customer.customerNumber
    ) {
      if (this.dryRun) {
        this.log.info("[dryRun] would align dimacon customer number to lexware", {
          dimaconCustomerId: customer.id,
          from: customer.customerNumber,
          to: lexNumber,
        })
        return {
          dimaconCustomerId: customer.id,
          name: customer.name,
          lexwareContactId: existing.id,
          lexwareNumber: lexNumber,
          status: "aligned",
          reason: `[dryRun] ${customer.customerNumber} → ${lexNumber}`,
        }
      }

      this.log.info("aligning dimacon customer number to lexware", {
        dimaconCustomerId: customer.id,
        from: customer.customerNumber,
        to: lexNumber,
      })
      await this.alignDimaconNumber(customer, lexNumber)
      return {
        dimaconCustomerId: customer.id,
        name: customer.name,
        lexwareContactId: existing.id,
        lexwareNumber: lexNumber,
        status: "aligned",
        reason: `${customer.customerNumber} → ${lexNumber}`,
      }
    }

    return {
      dimaconCustomerId: customer.id,
      name: customer.name,
      lexwareContactId: existing.id,
      lexwareNumber: lexNumber,
      status: "unchanged",
    }
  }

  private async findInLexware(name: string): Promise<LexContact | null> {
    // size=250 (Lexware-Maximum): der Name-Filter matcht Substrings — bei
    // der Default-Seitengröße 25 könnte der exakte Treffer auf Seite 2 liegen
    // und das Find-or-Create würde Duplikate anlegen.
    const byName = (await withRetry(() =>
      this.lexofficeClient.get<LexContactsResponse>("/v1/contacts", { name, size: "250" }),
    )) as LexContactsResponse
    const existing = byName.content?.find((c) => normalize(c.company?.name) === normalize(name))
    return existing ?? null
  }

  private async createInLexware(customer: DimaconCustomerInfo): Promise<LexContact> {
    // Feld-Zuordnung anwenden — ohne Kontext gelten die Default-Regeln,
    // die exakt den bisherigen hartkodierten Body reproduzieren.
    const ctx = this.mapping
    const applied = applyMapping(
      ctx?.rules ?? FIELD_CATALOG.lexofficeContact.defaultRules,
      ctx?.catalog ?? FIELD_CATALOG.lexofficeContact,
      ctx?.discovery ?? EMPTY_DISCOVERY,
      customerSourceValues(customer),
    )
    for (const warning of applied.warnings) {
      this.onMappingWarning(`Kunde ${customer.name}: ${warning.message}`)
    }

    // Bewusst OHNE Retry: der POST ist nicht idempotent — ein serverseitig
    // erfolgreicher, aber verloren gegangener Response würde beim Retry ein
    // Duplikat anlegen. Ein Fehlschlag heilt sich im nächsten Lauf über das
    // Find-or-Create selbst. (429 retryt der Lexoffice-Client intern.)
    return (await this.lexofficeClient.post<LexContact>(
      "/v1/contacts",
      buildLexofficeContactBody(applied, customer.name),
    )) as LexContact
  }

  private async alignDimaconNumber(
    customer: DimaconCustomerInfo,
    customerNumber: string,
  ): Promise<void> {
    await withRetry(() =>
      dimacon.updateCustomer({
        client: this.dimaconClient,
        path: { customerId: customer.id },
        body: {
          name: customer.name,
          customerNumber,
          street: customer.street,
          zipCity: customer.zipCity,
          phoneNumber: customer.phoneNumber,
          email: customer.email,
          description: customer.description,
          // Dimacon-PUT ist ein Voll-Replace: bestehende Attributwerte
          // MÜSSEN zurückgespiegelt werden, sonst werden sie gelöscht.
          customAttributeValues: customer.customAttributeValues ?? [],
        },
      }),
    )
  }
}

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase()
}
