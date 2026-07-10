import { createClockInClient, type Client as ClockInClient } from "@miragon/client-clockin"
import { createDimaconClient, type Client as DimaconClient } from "@miragon/client-dimacon"
import { createLexofficeClient, type Client as LexofficeClient } from "@miragon/client-lexoffice"
import { env } from "./env.js"

let _clockin: ClockInClient | undefined
let _dimacon: DimaconClient | undefined
let _lexoffice: LexofficeClient | undefined

export function getClockInClient(): ClockInClient {
  if (!_clockin) {
    _clockin = createClockInClient({
      apiToken: env.clockin.apiToken(),
      baseUrl: env.clockin.baseUrl(),
    })
  }
  return _clockin
}

export function getDimaconClient(): DimaconClient {
  if (!_dimacon) {
    _dimacon = createDimaconClient({
      apiToken: env.dimacon.apiToken(),
      baseUrl: env.dimacon.baseUrl(),
      tenant: env.dimacon.tenant(),
    })
  }
  return _dimacon
}

export function getLexofficeClient(): LexofficeClient {
  if (!_lexoffice) {
    _lexoffice = createLexofficeClient({
      apiKey: env.lexoffice.apiKey(),
      baseUrl: env.lexoffice.baseUrl(),
    })
  }
  return _lexoffice
}
