import * as React from "react"
import { cn } from "cn"

/** A colour dot (tag, label, column or status colour; `color` is any CSS colour). No colour: an empty ring. */
function Dot({ color, className, style, ...props }) {
  return (
    <span data-slot="dot" className={cn("size-2 shrink-0 rounded-full", color ? "ring-1 ring-foreground/25 ring-inset" : "border border-muted-foreground/60", className)}
      style={color ? { ...style, background: color } : style} {...props} />
  );
}

export { Dot }
