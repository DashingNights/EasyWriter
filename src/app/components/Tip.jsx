import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Tooltip around one trigger element (icon buttons: the action and its shortcut). The trigger is a wrapper span: as
 * asChild trigger the tooltip's data-state would replace the child's own (a pressed Toggle's "on"), and a disabled
 * button gets no pointer events. `wrap`: more classes for that span (`flex-1` to let a button fill a row). Other props go
 * to the content. */
export function Tip({ title, side, wrap, children, ...props }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={wrap ? `inline-flex ${wrap}` : 'inline-flex'}>{children}</span></TooltipTrigger>
      <TooltipContent side={side} {...props}>{title}</TooltipContent>
    </Tooltip>
  );
}
