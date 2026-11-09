//! Picture Format, Shape Format and Arrange: commands on the selected inline object.
//!
//! The selected object is the first picture/shape inside the selection (or right before the
//! caret). Picture adjustments re-encode the bitmap (originals are kept for Reset Picture).

use serde_json::{Value, json};
use ew_doc::graphic::GraphicKind;
use ew_doc::para::{Float, InlineObject, Wrap, WrapText};
use ew_doc::props::{Rgb, TextVert, VAlign};
use ew_doc::{Pos, StoryRef, TextBody};
use ew_geom::Spin;

use super::sel_result;
use crate::{CmdError, CmdResult, CommandSpec, Selection, Session, p};

mod arrange;
// EasyWriter engine-gaps-pictures: Compress Pictures by resolution.
mod compress;
mod group;
mod layout;
mod picture;
// EasyWriter engine-gaps-pictures: outlines, effects and Crop to Shape.
mod picture_look;
mod select;
mod shape;
mod tools;

pub use arrange::moves_with_text;
pub(crate) use arrange::{anchor_paragraph, nearest_line};
#[cfg(test)]
use group::ungroup;
pub use picture::{OriginalSize, PictureLook, cropped_original_size, drawings_as_pictures, fit_size, original_size, shown_pictures, svg_fallback};
#[cfg(test)]
use picture::{clear_background, grown, picture_style};
#[cfg(test)]
pub(crate) use select::all_objects;
pub(crate) use select::{edit_obj, has_shape_or_canvas};
#[cfg(test)]
use select::{has_group, holds_ink, obj_size};
pub use select::{min_size, object_selection, picked_objects, selected, selected_all};
#[cfg(test)]
use shape::can_link;
pub(crate) use layout::text_wrapping_break;
pub(crate) use shape::set_text_body;
pub use shape::text_box_target;
/// The objects' commands: each file of this folder has its own (one owner per file, docs/plans/engine/stage2.md).
pub fn specs() -> Vec<CommandSpec> {
    [picture::specs(), picture_look::specs(), arrange::specs(), select::specs(), shape::specs(), tools::specs(), layout::specs()].concat()
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod gaps_tests;
