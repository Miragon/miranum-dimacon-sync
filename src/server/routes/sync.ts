import { Hono } from "hono"
import { timingSafeEqual } from "node:crypto"
import { env } from "../lib/env.js"
import { log } from "../lib/log.js"
import { runSync } from "../sync/index.js"
import { isRunning, SyncBusyError } from "../sync/mutex.js"
import { getNextRun, isCronActive } from "../sync/scheduler.js"
import { SyncRunInputSchema } from "../sync/types.js"

const app = new Hono()

app.get("/healthz", (c) =>
  c.json({
    ok: true,
    cronActive: isCronActive(),
    nextRun: getNextRun(),
    running: isRunning(),
  }),
)

app.post("/run", async (c) => {
  const secret = env.sync.webhookSecret()
  if (secret) {
    const provided = extractToken(c.req.header("authorization"), c.req.header("x-sync-token"))
    if (!provided || !constantTimeEqual(provided, secret)) {
      log.warn("sync run unauthorized")
      return c.json({ error: "unauthorized" }, 401)
    }
  }

  const raw = await safeJson(c.req.raw)
  const parsed = SyncRunInputSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json({ error: "invalid input", details: parsed.error.flatten() }, 400)
  }

  try {
    const result = await runSync(parsed.data)
    return c.json(result)
  } catch (err) {
    if (err instanceof SyncBusyError) {
      return c.json({ error: err.message }, 409)
    }
    throw err
  }
})

export default app

async function safeJson(req: Request): Promise<unknown> {
  if (req.headers.get("content-length") === "0") return {}
  try {
    return await req.json()
  } catch {
    return {}
  }
}

function extractToken(auth?: string, xToken?: string): string | undefined {
  if (xToken) return xToken
  if (!auth) return undefined
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m?.[1]
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}
