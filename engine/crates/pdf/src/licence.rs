//! Font licences in a PDF (viewport-design.md section 8): a face is embedded only as its OS/2
//! `fsType` allows, and drawn as outlines otherwise. Installable (0) and editable (8) faces embed.
//! Preview-and-print faces (4) embed only in a PDF made for a print job, which is never saved.
//! Restricted faces (2), faces that allow only bitmap embedding (0x0200) and faces that forbid
//! subsetting (0x0100, since the writer always subsets) are drawn as outlines.

use skrifa::raw::TableProvider;

use super::FaceRef;

const RESTRICTED: u16 = 0x0002;
const PREVIEW_PRINT: u16 = 0x0004;
const EDITABLE: u16 = 0x0008;
const NO_SUBSETTING: u16 = 0x0100;
const BITMAP_ONLY: u16 = 0x0200;

/// Whether a face with OS/2 `fs_type` may be embedded in this PDF.
pub(crate) fn may_embed(fs_type: u16, print_job: bool) -> bool {
    if fs_type & (NO_SUBSETTING | BITMAP_ONLY) != 0 {
        return false;
    }
    // Old fonts can set more than one usage bit; the OpenType spec lets the least restrictive one win.
    if fs_type & EDITABLE != 0 {
        return true;
    }
    if fs_type & PREVIEW_PRINT != 0 {
        return print_job;
    }
    fs_type & RESTRICTED == 0
}

/// `face`'s OS/2 fsType; a face without an OS/2 table states no restriction (0).
pub(crate) fn fs_type(face: &FaceRef) -> u16 {
    face.skrifa().and_then(|f| f.os2().ok()).map_or(0, |o| o.fs_type())
}

/// `face` named well enough to find its file: family, style, the engine's face id, the file's size and font revision.
pub(crate) fn describe(face: &FaceRef) -> String {
    let revision = face.skrifa().and_then(|f| f.head().ok()).map_or(0.0, |h| h.font_revision().to_f64());
    format!("{} {} (face {}, {} bytes, revision {revision:.3}, fsType {:#06x})", face.family, face.style, face.id(), face.data().len(), fs_type(face))
}
