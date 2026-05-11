import ReactDOM from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { AuthKitProvider } from "@workos-inc/authkit-react"
import { AUTH_ENABLED, WORKOS_CLIENT_ID } from "./lib/auth-flag"
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

const rootElement = document.getElementById("app")!

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement)
  const tree = <RouterProvider router={router} />
  root.render(
    AUTH_ENABLED && WORKOS_CLIENT_ID ? (
      <AuthKitProvider clientId={WORKOS_CLIENT_ID}>{tree}</AuthKitProvider>
    ) : (
      tree
    ),
  )
}
