import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { customerSourceValues } from "../shared/field-catalog.js"
import { applyMapping } from "../shared/field-mapping.js"
import type { EntityMappingContext } from "../shared/mapping-context.js"
import type { CustomerMapping } from "./types.js"

interface ClockinCustomerRow {
  id?: number
  company?: string
  identifier?: string | null
}

// Body kommt aus der Feld-Zuordnung; Feldnamen sichert validateRules + Katalog.
type CustomerWriteBody = NonNullable<Parameters<typeof clockin.createCustomer>[0]>["body"]

/**
 * Kunden-Sync Dimacon → Clockin. Bewusst ohne Lexware: als Identifier dient
 * die Dimacon-Kundennummer (Fallback: Dimacon-ID). Das Alignment der
 * Kundennummern mit Lexware ist eine eigene Integration
 * (`dimacon-lexoffice`) — läuft sie vorher, sind die Nummern hier bereits
 * konsistent.
 */
export class CustomerSyncer {
  private inflight = new Map<string, Promise<CustomerMapping | null>>()

  constructor(
    private readonly clockinClient: ClockInClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
    /** false = Kunden-Schritt deaktiviert: nur nachschlagen, nie anlegen */
    private readonly createMissing = true,
    /** Feld-Zuordnung für den Create-Body (Kunden werden nie aktualisiert) */
    private readonly mapping?: EntityMappingContext,
    private readonly onMappingWarning: (message: string) => void = () => undefined,
  ) {}

  async resolve(customer: DimaconCustomerInfo): Promise<CustomerMapping | null> {
    const cached = this.inflight.get(customer.id)
    if (cached) return cached

    const promise = this.doResolve(customer)
    this.inflight.set(customer.id, promise)
    promise.catch(() => this.inflight.delete(customer.id))
    return promise
  }

  private async doResolve(customer: DimaconCustomerInfo): Promise<CustomerMapping | null> {
    const lookupNumber = customer.customerNumber ?? customer.name

    let found = await this.findInClockin(lookupNumber)

    // Fallback per Name: verhindert Duplikat-Kunden, wenn die
    // Dimacon-Kundennummer nachträglich geändert wurde (z. B. durch das
    // Lexware-Alignment der dimacon-lexoffice-Integration), der
    // Clockin-Kunde aber noch unter der alten Nummer angelegt ist.
    if (!found && customer.customerNumber) {
      found = await this.findInClockin(customer.name)
      if (found) {
        this.log.info("clockin customer found by name; identifier differs from dimacon number", {
          dimaconCustomerId: customer.id,
          clockinCustomerId: found.id,
          clockinIdentifier: found.identifier ?? null,
          dimaconNumber: customer.customerNumber,
        })
      }
    }

    if (found) {
      return {
        dimaconId: customer.id,
        clockinId: found.id!,
        number: found.identifier ?? lookupNumber,
        name: found.company ?? customer.name,
      }
    }

    if (!this.createMissing) {
      this.log.info("customer not found in clockin; create disabled by steps", {
        dimaconCustomerId: customer.id,
        name: customer.name,
      })
      return null
    }

    const number = customer.customerNumber ?? customer.id
    return this.createInClockin(customer, number)
  }

  private async findInClockin(needle: string): Promise<ClockinCustomerRow | null> {
    const result = (await withRetry(() =>
      clockin.searchForCustomers({
        client: this.clockinClient,
        body: { scopes: [{ name: "byNameOrNumber", parameters: [needle] }] },
      }),
    )) as unknown as { data?: ClockinCustomerRow[] }
    const row = result.data?.[0]
    return row?.id !== undefined ? row : null
  }

  private async createInClockin(
    customer: DimaconCustomerInfo,
    number: string,
  ): Promise<CustomerMapping> {
    if (this.dryRun) {
      this.log.info("[dryRun] would create clockin customer", { name: customer.name, number })
      return {
        dimaconId: customer.id,
        clockinId: -1,
        number,
        name: customer.name,
      }
    }

    const body = this.buildCreateBody(customer, number)
    const result = (await withRetry(() =>
      clockin.createCustomer({
        client: this.clockinClient,
        body,
      }),
    )) as unknown as { data?: { id?: number } }

    const id = result.data?.id
    if (id === undefined) {
      throw new Error(`clockin createCustomer returned no id for ${customer.name}`)
    }

    return {
      dimaconId: customer.id,
      clockinId: id,
      number,
      name: customer.name,
    }
  }

  private buildCreateBody(customer: DimaconCustomerInfo, number: string): CustomerWriteBody {
    if (!this.mapping) {
      // Ohne Kontext (Tests, direkte Nutzung): identisch zur Default-Zuordnung
      const values = customerSourceValues(customer)
      return {
        company: customer.name,
        identifier: number,
        street: values.standard.street ?? null,
        zip: values.standard["zipCity.zip"] || null,
        city: values.standard["zipCity.city"] || null,
        country: "DE",
      }
    }

    const applied = applyMapping(
      this.mapping.rules,
      this.mapping.catalog,
      this.mapping.discovery,
      customerSourceValues(customer),
    )
    for (const warning of applied.warnings) {
      this.onMappingWarning(`Kunde ${customer.name}: ${warning.message}`)
    }

    return {
      ...applied.standardFields,
      identifier: number,
      country: "DE",
      ...(applied.customFields.length > 0 ? { custom_fields: applied.customFields } : {}),
    } as CustomerWriteBody
  }
}
