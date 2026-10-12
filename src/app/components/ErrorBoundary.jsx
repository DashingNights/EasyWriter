import { Component } from 'react';
import { Button } from '@/components/ui/button';

/** Around <App/> (main.jsx): an error while rendering shows its message, its stack and the component stack, with Copy and
 * Reload, instead of an empty window. The stacks are what a bug report needs, so no crash has to be reproduced to be read.
 * Reload saves first as the GitHub backup's reload does (actions.js window.__sync.flush), so no unload handler holds it up. */
export class ErrorBoundary extends Component {
  state = { error: null, stack: '' };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ stack: `${error?.stack ?? error}\n\nComponent stack:${info?.componentStack ?? ''}` });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-sm text-foreground">
        <p className="font-medium">The app stopped after an error.</p>
        <pre className="max-w-2xl overflow-auto whitespace-pre-wrap rounded-md border bg-card p-3 text-xs text-muted-foreground">{String(error?.message ?? error)}</pre>
        <pre className="max-h-64 max-w-2xl overflow-auto whitespace-pre-wrap rounded-md border bg-card p-3 text-xs text-muted-foreground">{stack}</pre>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => navigator.clipboard?.writeText(stack).catch(() => {})}>Copy</Button>
          <Button onClick={() => Promise.resolve(window.__sync?.flush()).catch(() => {}).finally(() => location.reload())}>Reload</Button>
        </div>
      </div>
    );
  }
}
