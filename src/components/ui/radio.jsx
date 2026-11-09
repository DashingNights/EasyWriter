import * as React from "react"
import { cn } from "cn"

/** A radio button in the framework's look on a real <input type="radio">, as CheckboxInput: `name` groups them. */
function RadioInput({ className, ...props }) {
  return (
    <span data-slot="radio" className={cn("relative inline-grid size-4 shrink-0 place-content-center", className)}>
      <input type="radio"
        className="peer absolute inset-0 m-0 size-full appearance-none rounded-full border border-input shadow-xs transition-shadow outline-none checked:border-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        {...props} />
      <span className="pointer-events-none relative hidden size-2 rounded-full bg-primary peer-checked:block peer-disabled:opacity-50" />
    </span>
  );
}

export { RadioInput }
