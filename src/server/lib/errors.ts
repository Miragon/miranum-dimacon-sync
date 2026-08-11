const MAX_LEN = 500

export function formatError(err: unknown): string {
  if (err == null) return "unknown error"
  if (typeof err === "string") return cap(err)
  if (err instanceof Error) {
    const base = err.message || err.name || "Error"
    // Network wrappers (undici's "fetch failed", etc.) hide the real reason in `cause`.
    const cause = causeSummary(err.cause)
    return cap(cause && !base.includes(cause) ? `${base} (${cause})` : base)
  }
  if (typeof err !== "object") return cap(String(err))

  const e = err as Record<string, unknown>

  for (const key of ["message", "error_description", "detail", "title"] as const) {
    const v = e[key]
    if (typeof v === "string" && v.length > 0) return cap(v)
  }

  const errVal = e.error
  if (typeof errVal === "string" && errVal.length > 0) return cap(errVal)
  if (errVal && typeof errVal === "object") {
    const inner = errVal as Record<string, unknown>
    if (typeof inner.message === "string") return cap(inner.message)
  }

  if (Array.isArray(e.IssueList) && e.IssueList.length > 0) {
    const first = e.IssueList[0] as Record<string, unknown>
    const t = typeof first.type === "string" ? first.type : undefined
    const a = typeof first.argument === "string" ? first.argument : undefined
    if (t || a) return cap([t, a].filter(Boolean).join(": "))
  }

  if (typeof e.status === "number") {
    const text = typeof e.statusText === "string" ? e.statusText : ""
    return cap(`HTTP ${e.status}${text ? ` ${text}` : ""}`)
  }

  try {
    return cap(JSON.stringify(err))
  } catch {
    return "[unserializable error]"
  }
}

function causeSummary(cause: unknown): string | undefined {
  let c = cause
  for (let depth = 0; c != null && depth < 5; depth++) {
    if (typeof c === "string") return c
    if (typeof c !== "object") return undefined
    const o = c as Record<string, unknown>
    const code = typeof o.code === "string" && o.code.length > 0 ? o.code : undefined
    const message = typeof o.message === "string" && o.message.length > 0 ? o.message : undefined
    if (code ?? message) return code ?? message
    c = o.cause
  }
  return undefined
}

function cap(s: string): string {
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1) + "…" : s
}
