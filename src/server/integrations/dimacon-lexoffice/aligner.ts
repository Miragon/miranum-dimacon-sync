import { sdk as dimacon } from "@miragon/client-dimacon"
import type { Client as DimaconClient } from "@miragon/client-dimacon"
import type { Client as LexofficeClient } from "@miragon/client-lexoffice"
import { withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { splitZipCity } from "../shared/time.js"
import type { CustomerAlignRow } from "./types.js"

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
  ) {}

  async align(customer: DimaconCustomerInfo): Promise<CustomerAlignRow> {
    const existing = await this.findInLexware(customer.name)

    if (!existing) {
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
      if (createdNumber && customer.customerNumber && createdNumber !== customer.customerNumber) {
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
    if (lexNumber && customer.customerNumber && lexNumber !== customer.customerNumber) {
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
    const byName = (await withRetry(() =>
      this.lexofficeClient.get<LexContactsResponse>("/v1/contacts", { name }),
    )) as LexContactsResponse
    const existing = byName.content?.find((c) => normalize(c.company?.name) === normalize(name))
    return existing ?? null
  }

  private async createInLexware(customer: DimaconCustomerInfo): Promise<LexContact> {
    const { zip, city } = splitZipCity(customer.zipCity)
    return (await withRetry(() =>
      this.lexofficeClient.post<LexContact>("/v1/contacts", {
        version: 0,
        roles: { customer: {} },
        company: { name: customer.name },
        addresses: customer.street
          ? {
              billing: [
                {
                  street: customer.street,
                  zip,
                  city,
                  countryCode: "DE",
                },
              ],
            }
          : undefined,
        emailAddresses: customer.email ? { business: [customer.email] } : undefined,
        phoneNumbers: customer.phoneNumber ? { business: [customer.phoneNumber] } : undefined,
      }),
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
          customAttributeValues: [],
        },
      }),
    )
  }
}

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase()
}
