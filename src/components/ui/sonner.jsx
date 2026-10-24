import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner } from "sonner";

import { Spinner } from "@/components/ui/spinner"

const Toaster = ({
  ...props
}) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Spinner />,
      }}
      style={
        {
          "--normal-bg": "color-mix(in oklab, var(--card) 85%, transparent)", // bg-island (app.css): sonner's rule sets the fill
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-island)"
        }
      }
      toastOptions={{ className: "backdrop-blur-[2px] shadow-xl!" }} // sonner's unlayered box-shadow beats a plain utility
      {...props} />
  );
}

export { Toaster }
