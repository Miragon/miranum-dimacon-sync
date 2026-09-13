import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * Toaster in Miranum-Optik: 1px-Border, eckig, kein Schatten, Mono-Text.
 * Bewusst OHNE `next-themes` — der Style-Guide ist light-only, ein
 * Theme-Provider wäre toter Code (siehe miranum-design/SKILL.md).
 */
const Toaster = (props: ToasterProps) => (
  <Sonner
    theme="light"
    className="toaster group"
    icons={{
      success: <CircleCheckIcon className="size-4" />,
      info: <InfoIcon className="size-4" />,
      warning: <TriangleAlertIcon className="size-4" />,
      error: <OctagonXIcon className="size-4" />,
      loading: <Loader2Icon className="size-4 animate-spin" />,
    }}
    style={
      {
        "--normal-bg": "var(--mn-paper)",
        "--normal-text": "var(--mn-ink)",
        "--normal-border": "var(--mn-ink)",
        "--border-radius": "0",
      } as React.CSSProperties
    }
    toastOptions={{
      classNames: {
        toast: "border-ink bg-paper text-ink border font-sans text-sm",
        description: "text-ink-2",
      },
    }}
    {...props}
  />
)

export { Toaster }
