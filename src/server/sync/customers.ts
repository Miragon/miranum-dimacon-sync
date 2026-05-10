import { sdk as clockin } from "@miranum/client-clockin"
import { sdk as dimacon } from "@miranum/client-dimacon"
import type { Client as ClockInClient } from "@miranum/client-clockin"
import type { Client as DimaconClient } from "@miranum/client-dimacon"
import type { Client as LexofficeClient } from "@miranum/client-lexoffice"
import { withRetry } from "../lib/concurrency.js"
import type { Logger } from "../lib/log.js"
import type { DimaconCustomerInfo } from "./enrichment.js"
import { splitZipCity } from "./time.js"
import type { CustomerMapping } from "./types.js"

interface ClockinCustomerRow {
  id?: number
  company?: string
  identifier?: string | null
}

interface LexContact {
  id: string
  version: number
  roles?: { customer?: { number?: string } }
  company?: { name?: string }
}

interface LexContactsResponse {
  content?: LexContact[]
}

export class CustomerSyncer {
  private inflight = new Map<string, Promise<CustomerMapping>>()

  constructor(
    private readonly clockinClient: ClockInClient,
    private readonly dimaconClient: DimaconClient,
    private readonly lexofficeClient: LexofficeClient,
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

    const found = await this.findInClockin(lookupNumber)
    if (found) {
      return {
        dimaconId: customer.id,
        clockinId: found.id!,
        number: found.identifier ?? lookupNumber,
        name: found.company ?? customer.name,
      }
    }

    const lexContact = await this.findOrCreateInLexware(customer)
    const finalNumber = lexContact.roles?.customer?.number ?? customer.customerNumber

    if (
      finalNumber &&
      customer.customerNumber &&
      finalNumber !== customer.customerNumber &&
      !this.dryRun
    ) {
      this.log.info("aligning dimacon customer number to lexware", {
        dimaconCustomerId: customer.id,
        from: customer.customerNumber,
        to: finalNumber,
      })
      await withRetry(() =>
        dimacon.updateCustomer({
          client: this.dimaconClient,
          path: { customerId: customer.id },
          body: {
            name: customer.name,
            customerNumber: finalNumber,
            street: customer.street,
            zipCity: customer.zipCity,
            phoneNumber: customer.phoneNumber,
            email: customer.email,
            customAttributeValues: [],
          },
        }),
      )
    }

    const number = finalNumber ?? customer.customerNumber ?? customer.id
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

  private async findOrCreateInLexware(customer: DimaconCustomerInfo): Promise<LexContact> {
    const byName = (await withRetry(() =>
      this.lexofficeClient.get<LexContactsResponse>("/v1/contacts", {
        name: customer.name,
      }),
    )) as LexContactsResponse
    const existing = byName.content?.find(
      (c) => normalize(c.company?.name) === normalize(customer.name),
    )
    if (existing) return existing

    if (this.dryRun) {
      this.log.info("[dryRun] would create lexware contact", { name: customer.name })
      return {
        id: "dry-run",
        version: 0,
        roles: { customer: { number: customer.customerNumber } },
        company: { name: customer.name },
      }
    }

    const { zip, city } = splitZipCity(customer.zipCity)
    const created = (await withRetry(() =>
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

    return created
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

function normalize(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase()
}
