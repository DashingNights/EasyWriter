"use client"

import * as React from "react"
import { cn } from "cn"
import { CheckIcon, ChevronDownIcon } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"

/** A typed value with a list of presets, one look for every such field: the Input, an optional `unit`, the select chevron
 * at its right end. A primary press in the field or on the chevron opens the list under it and leaves the focus where it was; a
 * second press in the field while the list is open focuses it for typing and selects its text (Tab focuses it at once). A right
 * press focuses the field at once, so the context menu's Paste lands in it. `onOpen()` runs each time the list opens. Typing calls `onType(text)`; Enter or leaving the field calls `onCommit(text)` once something was typed; Escape
 * drops it. A picked option calls `onPick(value)`. Enter, Escape and a pick end with `onDone()` (required), which hands the
 * focus on. `text`: what the field shows while nothing is typed. `options`: [value, label], the one equal to `value`
 * checked. `size` "sm" or "xs" as Input. Other props go to the Input, `contentProps` to the list. The field is a combobox controlling a listbox of options, so the agent's ui.invoke select picks one by its text (ui-control.js). */
function Combobox({ value, text, options, onType, onCommit, onPick, onDone, onOpen, size = "sm", unit, className, contentProps, ...props }) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(null)
  const drop = React.useRef(false)
  const anchor = React.useRef(null)
  const list = React.useId()
  const xs = size === "xs"
  const show = (o) => { if (o && !open) onOpen?.(); setOpen(o) }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div ref={anchor} data-slot="combobox" className={cn("relative", className)}>
          <Input size={size} role="combobox" aria-expanded={open} aria-controls={open ? list : undefined} {...props} value={draft ?? text}
            className={cn("w-full", unit ? (xs ? "pr-10" : "pr-11") : (xs ? "pr-6" : "pr-7"))}
            onMouseDown={(e) => { if (e.button === 0 && !open) { e.preventDefault(); show(true) } }}
            onFocus={(e) => { const el = e.target; requestAnimationFrame(() => el.select()) }}
            onChange={(e) => { drop.current = false; setDraft(e.target.value); onType?.(e.target.value) }}
            onBlur={() => { if (!drop.current && draft !== null) onCommit?.(draft); drop.current = false; setDraft(null); setOpen(false) }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== "Escape") return
              e.preventDefault(); drop.current = e.key === "Escape"; e.currentTarget.blur(); onDone()
            }} />
          {unit && <span className={cn("pointer-events-none absolute inset-y-0 flex items-center text-muted-foreground", xs ? "right-6 text-xs" : "right-7 text-sm")}>{unit}</span>}
          <button type="button" tabIndex={-1} aria-label={`${props["aria-label"]} list`} onMouseDown={(e) => e.preventDefault()}
            onClick={() => show(!open)} className={cn("absolute inset-y-0 right-0 grid place-items-center", xs ? "w-6" : "w-7")}>
            <ChevronDownIcon className="size-4 opacity-50" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent id={list} role="listbox" align="start" {...contentProps}
        className={cn("max-h-72 w-auto min-w-(--radix-popover-trigger-width) p-1", contentProps?.className)}
        onMouseDown={(e) => e.preventDefault()} onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => anchor.current?.contains(e.target) && e.preventDefault()}>
        {options.map(([v, label]) => (
          <button key={v} type="button" role="option" aria-selected={v === value} onClick={() => { drop.current = true; setDraft(null); setOpen(false); onPick(v); onDone() }}
            className={cn("relative flex w-full cursor-default items-center rounded-sm py-1.5 pr-8 pl-2 text-left outline-hidden select-none hover:bg-accent/60", xs ? "text-xs" : "text-sm")}>
            {label}
            {v === value && <CheckIcon className="absolute right-2 size-4" />}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export { Combobox }
