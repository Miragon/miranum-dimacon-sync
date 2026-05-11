import { Outlet, createRootRoute } from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { AuthGate } from "../components/AuthGate.js"
import { PageChrome } from "../components/PageChrome.js"
import { AUTH_ENABLED } from "../lib/auth-flag.js"

import "../styles.css"

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  const app = (
    <>
      <PageChrome />
      <main className="mx-auto max-w-[1240px] px-12 pt-20 pb-24 max-md:px-6 max-md:pt-6 max-md:pb-12">
        <Outlet />
      </main>
      <TanStackDevtools
        config={{ position: "bottom-left" }}
        plugins={[{ name: "TanStack Router", render: <TanStackRouterDevtoolsPanel /> }]}
      />
    </>
  )
  return AUTH_ENABLED ? <AuthGate>{app}</AuthGate> : app
}
