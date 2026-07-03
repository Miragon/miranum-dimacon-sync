import { DimaconClockinResult } from "./DimaconClockinResult.js"
import type { SyncResult } from "./DimaconClockinResult.js"
import { DimaconLexofficeResult } from "./DimaconLexofficeResult.js"
import type { CustomerSyncResult } from "./DimaconLexofficeResult.js"

/**
 * Rendert das Run-Ergebnis passend zur Integration — unbekannte
 * Integrationen bekommen einen generischen JSON-Fallback, damit neue
 * Integrationen ohne UI-Arbeit sofort nutzbar sind.
 */
export function RunResultView({
  integrationId,
  result,
}: {
  integrationId: string
  result: unknown
}) {
  if (integrationId === "dimacon-clockin") {
    return <DimaconClockinResult result={result as SyncResult} />
  }
  if (integrationId === "dimacon-lexoffice") {
    return <DimaconLexofficeResult result={result as CustomerSyncResult} />
  }
  return (
    <section>
      <pre className="border-rule text-ink overflow-x-auto border p-6 font-mono text-[0.8rem] leading-relaxed">
        {JSON.stringify(result, null, 2)}
      </pre>
    </section>
  )
}
