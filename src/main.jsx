import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.jsx';
import { PALETTE_KEY, start } from './app/actions.js';
import { setState } from './app/store.js';
import { ErrorBoundary } from './app/components/ErrorBoundary.jsx';

// The first frame in the app's theme and palette: main sets prefers-color-scheme from settings.uiTheme (applyNativeTheme)
// before the window loads, and the palette's last CSS is in localStorage; applyUiTheme and applyPalette take over once the
// settings are in.
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', dark);
setState({ uiDark: dark });
const palette = document.head.appendChild(document.createElement('style'));
palette.id = 'palette';
try { palette.textContent = localStorage.getItem(PALETTE_KEY) ?? ''; } catch {}
const root = createRoot(document.getElementById('root'));
flushSync(() => root.render(<ErrorBoundary><App /></ErrorBoundary>)); // the editor mounts into #editor, so the shell must be in the DOM before start()
start();
