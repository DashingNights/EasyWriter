import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Tooltip around one trigger element (icon buttons: the action and its shortcut). The trigger is a wrapper span: as
 * asChild trigger the tooltip's data-state would replace the child's own (a pressed Toggle's "on"), and a disabled
 * button gets no pointer events. Other props go to the content. */
export function Tip({ title, side, children, ...props }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className="inline-flex">{children}</span></TooltipTrigger>
      <TooltipContent side={side} {...props}>{title}</TooltipContent>
    </Tooltip>
  );
}
