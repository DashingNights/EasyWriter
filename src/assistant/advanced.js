// settings.assistant.advanced (SPEC §3, Settings > Assistant > Advanced): the tool loop's limits, read at each turn by loop.js,
// assistant-main.js (max_tokens) and agent-server.js (the CLI providers' call limit). Only the keys the user changed are stored.

// Each number's default and its [min, max]; the defaults are the constants these replaced.
const NUMBERS = {
  maxCalls: [40, 1, 500], // tool calls per request (the cloud models' and the CLIs'; the small local models keep 20, loop.js MAX_CALLS)
  maxResult: [8000, 1000, 200000], // characters of one tool answer sent back
  shots: [3, 1, 20], // computer use: screenshots kept with their image
  cloudKeep: [4, 1, 50], // the cloud models: tool results kept in full per request
  cloudLive: [3, 1, 20], // the cloud models: pictures kept with their image per request
  maxTokens: [8192, 1024, 65536], // max_tokens of a cloud request
};
// The call limit (off by default since 2026-10-26, docs/plans/onboarding.md); the stops for repeated and failing calls.
const SWITCHES = { limitCalls: false, repeatStop: true };

/** The default of every knob: {limitCalls, repeatStop, maxCalls, ...}. */
const ADVANCED = { ...SWITCHES, ...Object.fromEntries(Object.entries(NUMBERS).map(([k, [d]]) => [k, d])) };

/** settings.assistant `a` → every knob: a stored value when it is valid (a number rounded and clamped to its range, a boolean),
 * else the default. */
function advanced(a) {
  const own = a?.advanced && typeof a.advanced === 'object' ? a.advanced : {};
  const out = { ...ADVANCED };
  for (const k of Object.keys(SWITCHES)) if (typeof own[k] === 'boolean') out[k] = own[k];
  for (const [k, [, min, max]] of Object.entries(NUMBERS)) {
    const n = typeof own[k] === 'string' && own[k].trim() ? Number(own[k]) : own[k];
    if (typeof n === 'number' && Number.isFinite(n)) out[k] = Math.min(max, Math.max(min, Math.round(n)));
  }
  return out;
}

module.exports = { ADVANCED, NUMBERS, advanced };
