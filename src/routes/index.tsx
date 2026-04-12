import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/')({ component: App })

function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-5xl font-bold tracking-tight">Hello World</h1>
      <p className="text-muted-foreground">
        React + TanStack Router + shadcn/ui
      </p>
      <Button onClick={() => alert('Hi from shadcn Button!')}>Click me</Button>
    </main>
  )
}
