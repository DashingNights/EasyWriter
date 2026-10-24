import * as React from "react"
import { cn } from "cn"
import { Tabs as TabsPrimitive } from "radix-ui"

// Compact h-6 triggers; hover at accent/60, the active tab at full accent (app.css).
function Tabs({ className, ...props }) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col", className)} {...props} />;
}

function TabsList({ className, ...props }) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("inline-flex w-fit items-center gap-0.5", className)} {...props} />;
}

function TabsTrigger({ className, ...props }) {
  return (
    <TabsPrimitive.Trigger data-slot="tabs-trigger"
      className={cn("inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:hover:bg-accent [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3", className)}
      {...props} />
  );
}

/** tabIndex -1: the panel is no extra Tab stop. */
function TabsContent({ className, ...props }) {
  return <TabsPrimitive.Content data-slot="tabs-content" tabIndex={-1} className={cn("min-h-0 flex-1 outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
