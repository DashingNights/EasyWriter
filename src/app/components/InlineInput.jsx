import { useRef } from 'react';
import { cn } from 'cn';
import { Input } from '@/components/ui/input';

/** In-place edit box: opens focused with its text selected; Enter or blur calls onDone(text), Escape calls onDone(null). */
export function InlineInput({ value, onDone, className, ...props }) {
  const cancelled = useRef(false);
  return (
    <Input autoFocus size="xs" defaultValue={value} className={cn('px-1', className)} {...props}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancelled.current = true;
        if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
      }}
      onBlur={(e) => onDone(cancelled.current ? null : e.target.value)} />
  );
}
