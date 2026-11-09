# The engine

EasyWriter's WebAssembly engine (docs/plans/engine/plan.md, viewport-design.md). Its code started from WordCraft (MIT OR
Apache-2.0: LICENSE-MIT, LICENSE-APACHE, NOTICE, ATTRIBUTION.md); ORIGIN.md records the commit and every change since.
docs/plans/word/wordcraft-eval.md measured it.

- `crates/`: the crates (viewport-design.md section 9.1 lists them). `crates/wasm` is the wasm-bindgen host: `Engine` exposes
  plan.md section 3 to src/engine/worker.js; the main thread uses src/engine/client.js.
- `assets/`: the fonts, hyphenation patterns and word lists the crates compile in.
- `rust-toolchain.toml`: the pinned compiler and the wasm32 target.

## Building

```
node scripts/build-engine-wasm.mjs [--force]
```

`npm run build` runs it first. It needs cargo with the `wasm32-unknown-unknown` target and wasm-bindgen-cli 0.2.129, the version
crates/wasm/Cargo.toml pins, and writes src/engine/wasm/ew.js and ew_bg.wasm. It builds only when src/engine/wasm/STAMP does not
hold the hash of this folder (every file but the .md notes), so a checkout builds nothing until something here changes. Cargo's
output and the build cache go to `%TEMP%\easywriter-engine`: a cold build takes about 2 minutes.

Git does not carry ew.js, ew_bg.wasm or STAMP, so a fresh checkout or a new worktree needs `npm run build` before its first
`npm test`. That build needs the Rust tools above unless the build cache already holds these sources.

To run a crate's tests, keep the target folder outside the repository too:
`cargo test --manifest-path engine/Cargo.toml -p ew-doc-layout` with `CARGO_TARGET_DIR` set.
