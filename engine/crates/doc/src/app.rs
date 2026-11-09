//! EasyWriter: the app the engine runs in, as the files it writes name it (the generator, producer and application fields of
//! .docx, .pdf, .odt, .rtf, .html and .tex). The wasm host passes the app's version (src/engine/worker.js reads package.json).
use std::sync::OnceLock;

/// The app's name in the files the engine writes.
pub const NAME: &str = "EasyWriter";

static VERSION: OnceLock<String> = OnceLock::new();

/// Sets the app's version for the files written from now on. The first call wins: a worker runs one app.
pub fn set_version(version: &str) {
    let _ = VERSION.set(version.trim().to_string());
}

/// The name with the version after `sep` ("EasyWriter 1.3.0" with " "), or the name alone when no version was set
/// (native tests and tools).
pub fn name_version(sep: &str) -> String {
    match VERSION.get().filter(|v| !v.is_empty()) {
        Some(v) => format!("{NAME}{sep}{v}"),
        None => NAME.to_string(),
    }
}
