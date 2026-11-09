//! The one reader of an OLE compound file ([MS-CFB], engine-size-4). `.doc`, `.xls` and encrypted Office packages open the
//! file and read its streams through here, so `cfb`'s reader is compiled into the .wasm once instead of once per crate that
//! called it. Call [`cfb_guard::check`](crate::cfb_guard::check) on the bytes first.

use std::io::{Cursor, Read};

/// An open compound file over the bytes it was opened from.
pub struct Compound<'a>(cfb::CompoundFile<Cursor<&'a [u8]>>);

impl<'a> Compound<'a> {
    /// Open the compound file in `bytes`; the error is `cfb`'s own message.
    pub fn open(bytes: &'a [u8]) -> Result<Compound<'a>, String> {
        cfb::CompoundFile::open(Cursor::new(bytes)).map(Compound).map_err(|e| e.to_string())
    }

    /// Is there a stream at `path` (`/Workbook`)?
    pub fn is_stream(&self, path: &str) -> bool {
        self.0.is_stream(path)
    }

    /// The whole stream at `path`, read to at most `cap + 1` bytes (the caller refuses anything over its own cap, so it can
    /// say how much it read). The error says why the stream is absent or unreadable.
    pub fn read(&mut self, path: &str, cap: u64) -> Result<Vec<u8>, String> {
        let s = self.0.open_stream(path).map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        s.take(cap.saturating_add(1)).read_to_end(&mut v).map_err(|e| e.to_string())?;
        Ok(v)
    }
}
