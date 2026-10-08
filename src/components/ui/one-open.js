import { useEffect, useId, useSyncExternalStore } from "react"

// One select or dropdown menu open at a time, app-wide: opening one closes the open one. With the click-through rule in
// app.css, a click on another trigger while one is open opens that one at once (Radix would otherwise keep the first
// open: the new modal layer stops the old one from seeing the outside click).
let current = null
const subs = new Set()
const subscribe = (fn) => (subs.add(fn), () => subs.delete(fn))
const set = (v) => {
  current = v
  subs.forEach((fn) => fn())
}

/** [open, onOpenChange] for a Radix Root; `open` / `onOpenChange` are the caller's (controlled callers are closed
 * through their onOpenChange when another one opens). */
export function useOneOpen(open, onOpenChange) {
  const id = useId()
  const active = useSyncExternalStore(subscribe, () => current)
  useEffect(() => {
    if (open && active !== null && active !== id) onOpenChange?.(false)
  }, [active])
  const change = (o) => {
    if (o) set(id)
    else if (current === id) set(null)
    onOpenChange?.(o)
  }
  return [open ?? active === id, change]
}
