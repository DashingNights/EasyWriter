import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.jsx';
import { start } from './app/actions.js';
import { ErrorBoundary } from './app/components/ErrorBoundary.jsx';

const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<ErrorBoundary><App /></ErrorBoundary>)); // the editor mounts into #editor, so the shell must be in the DOM before start()
start();
