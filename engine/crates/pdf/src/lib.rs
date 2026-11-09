//! EasyWriter PDF export through the shared `craft-pdf` writer and Krilla drawing primitives.
//!
//! [`export`] lays the document out and draws each page's display list
//! ([`ew_doc_layout::display::page_display`]) into a PDF page:
//!
//! - **Text as real text:** glyph runs are written with embedded, subsetted fonts and a Unicode
//!   mapping taken from the paragraph text, so text is selectable, searchable and extractable.
//!   Synthetic bold (fill + stroke) and italic (skew) follow the renderer.
//! - **Graphics:** fills (highlight, shading, cell fills), rules and underlines (solid, dotted,
//!   dashed, double, wave), shapes, pictures (decoded with `image`; JPEG passed through, the rest
//!   embedded losslessly; WMF and EMF drawn as vector paths and embedded bitmaps) with cropping and
//!   opacity, the page colour and the watermark.
//! - **Interactive:** link annotations for hyperlinked runs (URLs and internal `#bookmark`
//!   links) and a document outline built from the headings (outline levels).
//! - **Metadata:** title, author, subject, keywords, language, creation date.
//! - **Tagged PDF (best effort):** one structure element per paragraph (`H1`–`H6` for headings,
//!   `P` otherwise), `Figure` for pictures with their alt text; headers, footers, decorations and
//!   the watermark are artifacts.
//!
//! Nothing here panics on hostile documents: sizes are clamped, unknown fonts or undecodable
//! pictures are skipped (a grey box stands in for a picture).
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]
#![forbid(unsafe_code)]

use std::collections::{BTreeSet, HashMap, HashSet};
use std::num::NonZeroU16;
use std::sync::Arc;

use craft_pdf::write::{self, Metadata, WriteError, Writer, backend as krilla};
use krilla::annotation::{Annotation, LinkAnnotation, Target};
use krilla::color::rgb;
use krilla::destination::XyzDestination;
use krilla::error::KrillaError;
use krilla::geom::{Path, PathBuilder, Point, Size, Transform};
use krilla::image::Image;
use krilla::metadata::DateTime;
use krilla::num::NormalizedF32;
use krilla::outline::{Outline, OutlineNode};
use krilla::page::PageSettings;
use krilla::paint::{Fill, FillRule, LineCap, LineJoin, Stroke, StrokeDash};
use krilla::surface::Surface;
use krilla::tagging::{Artifact, ArtifactType, ContentTag, Identifier, Node, SpanTag, Tag, TagGroup, TagKind, TagTree};
use krilla::text::{Font, GlyphId, KrillaGlyph};
use ew_doc::graphic::GraphicKind;
use ew_doc::para::{InlineObject, ShapeKind};
use ew_doc::{Document, Path as DocPath, Rgb, StoryRef};
use ew_fonts::FaceRef;
use ew_geom::Rect;
use ew_doc_layout::display::Paint;
use ew_doc_layout::display::{DisplayOptions, Draw, ItemDisplay, Stroke as LineStyle};
use ew_doc_layout::para::{ClKind, LineEnd};
use ew_doc_layout::{DocLayout, LayoutCache, LayoutOptions, NumeralMode, Page, Placed, layout};
use ew_metafile::{Picture, PlacedItem};
use ew_scene::{DisplayList, Media};

mod export;
mod exporter;
mod glyphs;
mod licence;
mod metadata;
mod options;
mod paint;
mod picture;
mod tags;

pub use export::{Exported, export, export_layout, export_layout_named, export_lists};
#[cfg(test)]
use exporter::Exporter;
#[cfg(test)]
use glyphs::{baseline, cluster_ends, left_to_right, split_clusters, visual_order};
#[cfg(test)]
use metadata::{civil, parse_iso};
pub use options::{PdfError, PdfOptions};
#[cfg(test)]
use paint::shape_path;
#[cfg(test)]
use picture::{load_image, load_image_within};

#[cfg(test)]
mod tests;
