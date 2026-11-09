'use strict';
// The providers' own web search (assistant-web, the user 2026-11-01): settings.assistant.providerSearch, off by default (Settings >
// Assistant). The provider bills it and the user cannot watch it, unlike the app's own web.search (commands/web.mjs). Read at each
// run by assistant-main.js (cli.js arguments, the request body) and by the Settings dialog, which names the providers without one.
// Claude Code: its WebSearch and WebFetch tools; Codex: web_search "live" (`codex` 0.154.0 takes disabled, cached, indexed and
// live); Qwen Cloud: enable_search on its OpenAI-compatible chat (docs.qwencloud.com web search, read 2026-11-01). DeepSeek's chat
// API takes functions only (api-docs.deepseek.com, read 2026-11-01) and Google AI's OpenAI-compatible chat documents no search
// grounding (ai.google.dev/gemini-api/docs/openai, read 2026-11-01), so neither has one here.

/** The providers with a search of their own, by settings.assistant.provider id → the name the Settings help uses. */
const PROVIDER_SEARCH = { claude: 'Claude Code', codex: 'Codex', qwen: 'Qwen Cloud' };

/** Whether settings.assistant `a` turns on its provider's own search. */
const providerSearch = (a) => a?.providerSearch === true && Object.hasOwn(PROVIDER_SEARCH, a.provider);

/** The fields an API provider's chat request adds for its own search while `a` turns it on. */
const searchFields = (a) => (providerSearch(a) && a.provider === 'qwen' ? { enable_search: true } : {});

module.exports = { PROVIDER_SEARCH, providerSearch, searchFields };
