type Level = "debug" | "info" | "warn" | "error"

type LogFields = Record<string, unknown>

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void
  info: (msg: string, fields?: LogFields) => void
  warn: (msg: string, fields?: LogFields) => void
  error: (msg: string, fields?: LogFields) => void
  child: (base: LogFields) => Logger
}

function emit(level: Level, msg: string, fields?: LogFields) {
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...fields,
    }) + "\n"
  if (level === "error" || level === "warn") process.stderr.write(line)
  else process.stdout.write(line)
}

function make(base: LogFields = {}): Logger {
  const merge = (extra?: LogFields) => (extra ? { ...base, ...extra } : base)
  return {
    debug: (msg, fields) => emit("debug", msg, merge(fields)),
    info: (msg, fields) => emit("info", msg, merge(fields)),
    warn: (msg, fields) => emit("warn", msg, merge(fields)),
    error: (msg, fields) => emit("error", msg, merge(fields)),
    child: (extra) => make({ ...base, ...extra }),
  }
}

export const log = make()
