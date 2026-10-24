import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.jsx';
import { start } from './app/actions.js';
import { setState } from './app/store.js';
import { ErrorBoundary } from './app/components/ErrorBoundary.jsx';

// The first frame in the app's theme: main sets prefers-color-scheme from settings.uiTheme (applyNativeTheme) before the window
// loads; applyUiTheme takes over once the settings are in.
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', dark);
setState({ uiDark: dark });
const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<ErrorBoundary><App /></ErrorBoundary>)); // the editor mounts into #editor, so the shell must be in the DOM before start()
start();
