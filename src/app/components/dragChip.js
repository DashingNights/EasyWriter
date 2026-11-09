// The chip a drag carries beside the pointer (the sidebar's draft rows, the board's text drag): one look for every drag in the app.
// The caller adds how it is placed (`fixed` over the window, `absolute` in an overlay) and sets `borderColor` to the accent over a
// place that takes the drop.
export const CHIP_CLASS = 'pointer-events-none z-[1000] flex max-w-56 items-center gap-1.5 rounded-md border bg-popover px-2 py-1 '
  + 'text-sm text-popover-foreground shadow-md [&_svg]:size-4 [&_svg]:shrink-0';
