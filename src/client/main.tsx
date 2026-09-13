import ReactDOM from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { AuthKitProvider } from "@workos-inc/authkit-react"
import { AUTH_ENABLED, WORKOS_API_HOSTNAME, WORKOS_CLIENT_ID } from "./lib/auth-flag"
import { safeReturnTo } from "./lib/return-to"
import { notifySessionExpired } from "./lib/session-expiry"
import { routeTree } from "./routeTree.gen"

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

/**
 * Rücksprung nach dem PKCE-Roundtrip. `setTimeout(…, 0)` ist load-bearing:
 * authkit-js führt unmittelbar nach `onRedirectCallback` synchron ein
 * `history.replaceState` mit bereinigter URL aus und würde eine sofortige
 * Navigation überschreiben. `history.replace` statt `navigate({ to })`, weil
 * `to` gegen den generierten Route-Tree typisiert ist und ein Laufzeit-String
 * dort nicht typecheckt.
 */
function handleRedirect(params: { state: Record<string, unknown> | null }) {
  const to = safeReturnTo(params.state)
  if (to) setTimeout(() => router.history.replace(to), 0)
}

const rootElement = document.getElementById("app")!

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  const tree = <RouterProvider router={router} />
  root.render(
    AUTH_ENABLED && WORKOS_CLIENT_ID ? (
      <AuthKitProvider
        clientId={WORKOS_CLIENT_ID}
        // undefined = heutiges Verhalten (api.workos.com, Cross-Site-Cookie)
        apiHostname={WORKOS_API_HOSTNAME}
        onRefreshFailure={() => notifySessionExpired()}
        onRedirectCallback={handleRedirect}
      >
        {tree}
      </AuthKitProvider>
    ) : (
      tree
    ),
  )
}
