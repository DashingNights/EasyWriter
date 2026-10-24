import * as React from "react"
import { cn } from "cn"

/** A key or chord drawn as a key cap, in running text and in the keybind editor. Menus and lists show shortcuts as plain text. */
function Kbd({ className, ...props }) {
  return <kbd data-slot="kbd" className={cn("rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-xs", className)} {...props} />;
}

export { Kbd }
