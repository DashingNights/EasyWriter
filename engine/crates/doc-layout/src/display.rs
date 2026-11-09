//! Page → draw items and display lists, which the scene crate paints (tiles, thumbnails) and the PDF exporter draws.

use std::collections::HashMap;

use ew_doc::graphic::{Graphic, GraphicItem, GraphicKind, PathSeg, TextAlign};
use ew_doc::para::{InlineObject, ShapeKind};
use ew_doc::props::{Border, BorderStyle, Rgb, TextColor, TextDirection, Underline};
use ew_doc::section::SectionStart;
use ew_doc::{Block, Document, Path, StoryRef};
use ew_fonts::BezPath;
use ew_geom::{Rect, Spin};

use crate::math::MItem;
use crate::para::{ClKind, LineEnd, ParaLayout};
use crate::{Page, Placed};

mod art;
mod glyphs;
mod lines;
mod objects;
mod options;
mod page;
mod paint;
mod scene;

pub(crate) use glyphs::author_order;
pub use glyphs::{CHECK_BOX_INSET, check_box, text_color, upright_in_vertical};
pub use lines::{mark_text_width, section_break_label};
pub(crate) use objects::inline_rect;
pub use options::{BalloonMode, ChangeBar, CommentDisplay, DeleteMark, DisplayOptions, FormattingMarks, InsertMark, MarkupOptions};
pub use page::{CHANGE_BAR, SIMPLE_BAR, ItemDisplay, MOVE_COLOR, object_display, page_display, page_layers, revision_color};
pub use paint::paint_for;
pub use scene::{RenderOptions, background_at, page_list, render_area, render_items, render_page};
// The display list's types live in the scene crate since P6 (docs/plans/engine/viewport-design.md section 3).
pub use ew_scene::{DisplayList, Draw, Layer, PaintOptions, Paint, Rendered, Stroke, seg_path};
