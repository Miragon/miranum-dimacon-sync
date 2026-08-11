import { sdk as clockin } from "@miragon/client-clockin"
import type { Client as ClockInClient } from "@miragon/client-clockin"
import { withRetry } from "../../lib/concurrency.js"
import type { Logger } from "../../lib/log.js"
import type { DimaconCustomerInfo } from "../shared/dimacon.js"
import { splitZipCity } from "../shared/time.js"
import type { CustomerMapping } from "./types.js"

interface ClockinCustomerRow {
  id?: number
  company?: string
  identifier?: string | null
}

/**
 * Kunden-Sync Dimacon → Clockin. Bewusst ohne Lexware: als Identifier dient
 * die Dimacon-Kundennummer (Fallback: Dimacon-ID). Das Alignment der
 * Kundennummern mit Lexware ist eine eigene Integration
 * (`dimacon-lexoffice`) — läuft sie vorher, sind die Nummern hier bereits
 * konsistent.
 */
export class CustomerSyncer {
  private inflight = new Map<string, Promise<CustomerMapping>>()

  constructor(
    private readonly clockinClient: ClockInClient,
    private readonly log: Logger,
    private readonly dryRun: boolean,
  ) {}

  async resolve(customer: DimaconCustomerInfo): Promise<CustomerMapping> {
    const cached = this.inflight.get(customer.id)
    if (cached) return cached

    const promise = this.doResolve(customer)
    this.inflight.set(customer.id, promise)
    promise.catch(() => this.inflight.delete(customer.id))
    return promise
  }

  private async doResolve(customer: DimaconCustomerInfo): Promise<CustomerMapping> {
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

    const { zip, city } = splitZipCity(customer.zipCity)
    const result = (await withRetry(() =>
      clockin.createCustomer({
        client: this.clockinClient,
        body: {
          company: customer.name,
          identifier: number,
          street: customer.street ?? null,
          zip: zip || null,
          city: city || null,
          country: "DE",
        },
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
}
