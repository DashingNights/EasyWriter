import * as React from "react"
import { cn } from "cn"
import { LoaderCircle } from "lucide-react"

/** The busy spinner. It stops under data-still~="status" (app.css). Decorative: the text beside it says what is busy. */
function Spinner({ className, ...props }) {
  return <LoaderCircle aria-hidden data-slot="spinner" className={cn("size-4 shrink-0 animate-spin", className)} {...props} />;
}

export { Spinner }
