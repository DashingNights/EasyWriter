//! The preset shape definitions (src/vendor/ooxml-presets) as compiled in: one tag per line with the line ends and indentation
//! cut, which the reader ignores. Those were 138 KB of the .wasm, and a CRLF checkout (core.autocrlf) added 19,898 more under
//! the same source hash as an LF one.
use std::path::Path;

const XML: &str = "../../../src/vendor/ooxml-presets/presetShapeDefinitions.xml";

fn main() {
    println!("cargo::rerun-if-changed={XML}");
    let xml = std::fs::read_to_string(XML).expect(XML);
    let compact: String = xml.lines().map(str::trim).collect();
    let out = std::env::var_os("OUT_DIR").expect("OUT_DIR");
    std::fs::write(Path::new(&out).join("presetShapeDefinitions.xml"), compact).expect("OUT_DIR is writable");
}
