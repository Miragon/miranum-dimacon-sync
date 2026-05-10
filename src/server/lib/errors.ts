const MAX_LEN = 500

export function formatError(err: unknown): string {
  if (err == null) return "unknown error"
  if (typeof err === "string") return cap(err)
  if (err instanceof Error) return cap(err.message || err.name || "Error")
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

function cap(s: string): string {
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1) + "…" : s
}
