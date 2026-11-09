import * as React from "react"
import { cn } from "cn"
import { CheckIcon, MinusIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

function Checkbox({
  className,
  ...props
}) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:data-[state=checked]:bg-primary",
        className
      )}
      {...props}>
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none">
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

/** Checkbox's look on a real <input type="checkbox">: for the dialog kit, whose labels, access keys and harness drivers read a form
 * control. `indeterminate` draws the mixed state. */
function CheckboxInput({ className, indeterminate = false, ...props }) {
  const ref = React.useRef(null);
  React.useEffect(() => { ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <span data-slot="checkbox" className={cn("relative inline-grid size-4 shrink-0 place-content-center", className)}>
      <input ref={ref} type="checkbox"
        className="peer absolute inset-0 m-0 size-full appearance-none rounded-[4px] border border-input shadow-xs transition-shadow outline-none checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:checked:bg-primary dark:indeterminate:bg-primary"
        {...props} />
      <CheckIcon className="pointer-events-none relative hidden size-3.5 text-primary-foreground peer-checked:block" />
      <MinusIcon className="pointer-events-none relative hidden size-3.5 text-primary-foreground peer-indeterminate:block" />
    </span>
  );
}

export { Checkbox, CheckboxInput }
