/**
 * Winzige Modul-Bridge für `onRefreshFailure`: der `AuthKitProvider` hängt in
 * main.tsx AUSSERHALB von Router und AuthGate, und authkit-react friert die
 * Callbacks beim Bau des Clients ein (sie stehen nicht in den Effekt-Deps).
 * Der 401-Pfad braucht das nicht — der geht über den testbaren Callback im
 * Auth-Context.
 */
const listeners = new Set<() => void>()

export function notifySessionExpired(): void {
  for (const fn of listeners) fn()
}

export function subscribeSessionExpired(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
