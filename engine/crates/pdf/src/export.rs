use super::exporter::Exporter;
use super::metadata::metadata;
use super::options::{PdfError, PdfOptions};
use super::paint::{clamp_side, ok};
use super::{
    DisplayList, DocLayout, Document, HashSet, KrillaError, Media, LayoutCache, LayoutOptions, Page, PageSettings, Size, Transform, WriteError, Writer, krilla,
    layout, write,
};

/// Lay out `doc` and write it as PDF. Without markup the layout is the final text: tracked
/// deletions are left out, as in Word's "No Markup" view. With `comments` each page carries the
/// markup area with the comment balloons.
pub fn export(doc: &Document, opts: &PdfOptions) -> Result<Vec<u8>, PdfError> {
    write::guard(|| {
        // EasyWriter engine-fidelity-4: what is under a heading collapsed by default stays out, as in Word's PDF and its page count.
        let lo = LayoutOptions { hide_deleted: !opts.include_markup, comment_balloons: opts.comments, numeral: opts.numeral, expanded: Some(Default::default()), ..Default::default() };
        let lay = layout(doc, &mut LayoutCache::new(), &lo);
        export_layout_inner(doc, &lay, opts).map(|e| e.bytes)
    })
}

/// Write an existing layout of `doc` as PDF.
pub fn export_layout(doc: &Document, lay: &DocLayout, opts: &PdfOptions) -> Result<Vec<u8>, PdfError> {
    export_layout_named(doc, lay, opts).map(|e| e.bytes)
}

/// A PDF with the font families whose text it draws as outlines (not selectable), so the app can say so.
#[derive(Clone, Debug, Default)]
pub struct Exported {
    pub bytes: Vec<u8>,
    /// Sorted, each once: faces krilla could not subset and faces whose licence (fsType) forbids embedding them here.
    pub outlined: Vec<String>,
    /// One line for each face drawn as outlines: the face (family, style, id, file size, revision, fsType) and why.
    pub why: Vec<String>,
}

/// [`export_layout`], naming the families drawn as outlines.
pub fn export_layout_named(doc: &Document, lay: &DocLayout, opts: &PdfOptions) -> Result<Exported, PdfError> {
    write::guard(|| export_layout_inner(doc, lay, opts))
}

fn export_layout_inner(doc: &Document, lay: &DocLayout, opts: &PdfOptions) -> Result<Exported, PdfError> {
    let pages: Vec<usize> = match &opts.pages {
        Some(v) => {
            if let Some(bad) = v.iter().find(|p| **p >= lay.pages.len()) {
                return Err(PdfError::BadPage(bad.saturating_add(1)));
            }
            v.clone()
        }
        None => (0..lay.pages.len()).collect(),
    };
    if pages.is_empty() {
        return Err(PdfError::NoPages);
    }
    // krilla subsets fonts only when the document is finished, so one font it can't subset fails
    // the whole export. Draw that font's glyphs as outlines instead and write the document again.
    let mut outlined = HashSet::new();
    let mut why = Vec::new();
    loop {
        match write_attempt(doc, lay, opts, &pages, &outlined)? {
            Attempt::Done(bytes, families, licence) => {
                why.extend(licence);
                return Ok(Exported { bytes, outlined: families, why });
            }
            Attempt::BadFont(id, msg) if outlined.len() < MAX_OUTLINED_FONTS && outlined.insert(id) => {
                log::warn!("PDF: {msg}; its text is drawn as outlines");
                why.push(msg);
            }
            Attempt::BadFont(_, msg) => return Err(PdfError::Write(msg)),
        }
    }
}

/// How many unsubsettable fonts we fall back to outlines for before giving up.
const MAX_OUTLINED_FONTS: usize = 32;

/// One try at writing the PDF.
enum Attempt {
    /// The PDF, the families it draws as outlines, and the faces its licence rule drew as outlines (why).
    Done(Vec<u8>, Vec<String>, Vec<String>),
    /// The face with this id could not be embedded (and why).
    BadFont(u32, String),
}

fn write_attempt(doc: &Document, lay: &DocLayout, opts: &PdfOptions, pages: &[usize], outlined: &HashSet<u32>) -> Result<Attempt, PdfError> {
    let settings = krilla::SerializeSettings { compress_content_streams: opts.compress, enable_tagging: opts.tagged, ..Default::default() };
    let language = doc.styles.default_chr.lang.clone().filter(|l| !l.is_empty() && l.is_ascii());
    let mut writer = Writer::new_with_language(settings, metadata(doc, opts), language);
    let pdf = writer.document_mut();

    let mut ex = Exporter::new(doc, &doc.media, lay, opts, pages, outlined);
    if let Some(o) = ex.outline(pages) {
        pdf.set_outline(o);
    }
    for &pi in pages {
        let Some(page) = lay.pages.get(pi) else { return Err(PdfError::BadPage(pi.saturating_add(1))) };
        let fit = Fit::of(page, opts.paper);
        let size = Size::from_wh(clamp_side(fit.paper_w), clamp_side(fit.paper_h)).ok_or(PdfError::NoPages)?;
        let mut kp = pdf.start_page_with(PageSettings::new(size));
        let mut s = kp.surface();
        ex.links.clear();
        // A page with a markup area is scaled down to fit its paper with the area beside it; a
        // print on other paper is scaled to it and centred.
        let scaled = fit.k != 1.0 || fit.dx != 0.0 || fit.dy != 0.0;
        if scaled {
            s.push_transform(&Transform::from_row(fit.k, 0.0, 0.0, fit.k, fit.dx, fit.dy));
        }
        // `page_w` is the document page's width: the page colour and watermark stay off the markup area.
        ex.page(&mut s, page, clamp_side(fit.page_w), clamp_side(page.h));
        if scaled {
            s.pop();
        }
        s.finish();
        for a in ex.annotations(fit) {
            kp.add_annotation(a);
        }
        kp.finish();
    }
    if opts.tagged {
        pdf.set_tag_tree(ex.tag_tree());
    }
    if let Some(error) = ex.font_error {
        return Err(error);
    }
    match writer.finish() {
        Ok(bytes) => Ok(Attempt::Done(bytes, ex.outlined_families.into_iter().collect(), ex.why)),
        Err(WriteError::Serialization(error)) => match *error {
            KrillaError::Font(font, msg) => {
                let bad = ex.fonts.iter().find(|(_, (_, f))| f.as_ref() == Some(&font));
                match bad {
                    Some((id, (face, _))) => Ok(Attempt::BadFont(*id, format!("{}: krilla could not embed it ({msg})", super::licence::describe(face)))),
                    None => Err(PdfError::Write(format!("a font could not be embedded ({msg})"))),
                }
            }
            error => Err(PdfError::Write(format!("{error:?}"))),
        },
        Err(error) => Err(error.into()),
    }
}

/// How a layout page maps onto its PDF page: a page with a markup area (Print Markup) is scaled
/// by `k` to its paper width and centred vertically (`dy`). With [`PdfOptions::paper`] that
/// sheet is then scaled to the chosen paper and centred on it (`dx`, `dy`). Any other page is
/// drawn as it is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Fit {
    /// The PDF page.
    paper_w: f32,
    paper_h: f32,
    /// The document page's width in layout points (without the markup area).
    page_w: f32,
    k: f32,
    dx: f32,
    dy: f32,
}

impl Fit {
    pub(crate) fn of(page: &Page, paper: Option<(f32, f32)>) -> Fit {
        let paper_w = page.w - page.markup;
        let own = if page.markup > 0.0 && ok(page.markup) && ok(page.w) && paper_w > 1.0 {
            let k = paper_w / page.w;
            Fit { paper_w, paper_h: page.h, page_w: paper_w, k, dx: 0.0, dy: page.h * (1.0 - k) / 2.0 }
        } else {
            Fit { paper_w: page.w, paper_h: page.h, page_w: page.w, k: 1.0, dx: 0.0, dy: 0.0 }
        };
        let Some((w, h)) = paper else { return own };
        let f = ew_geom::fit_to_paper(own.paper_w, own.paper_h, w, h);
        Fit { paper_w: f.paper_w, paper_h: f.paper_h, page_w: own.page_w, k: own.k * f.k, dx: f.dx, dy: own.dy * f.k + f.dy }
    }

    /// A layout point on the PDF page.
    pub(crate) fn point(self, x: f32, y: f32) -> (f32, f32) {
        (x * self.k + self.dx, y * self.k + self.dy)
    }
}

/// Display lists (slides, a designer's frames: any product's surfaces) as PDF pages, one a list, each its list's size, with
/// pictures from `media`. Untagged: a list carries no reading order. A face that cannot be embedded fails the export.
// ponytail: no outline fallback for faces krilla cannot subset, as `export` has; add it when a product exports lists.
pub fn export_lists(lists: &[DisplayList], media: &dyn Media) -> Result<Vec<u8>, PdfError> {
    if lists.is_empty() {
        return Err(PdfError::NoPages);
    }
    write::guard(|| {
        let (doc, lay) = (Document::default(), DocLayout::default());
        let opts = PdfOptions { tagged: false, ..Default::default() };
        let outlined = HashSet::new();
        let settings = krilla::SerializeSettings { compress_content_streams: true, enable_tagging: false, ..Default::default() };
        let mut writer = Writer::new_with_language(settings, metadata(&doc, &opts), None);
        let pdf = writer.document_mut();
        let mut ex = Exporter::new(&doc, media, &lay, &opts, &[], &outlined);
        for list in lists {
            let size = Size::from_wh(clamp_side(list.w), clamp_side(list.h)).ok_or(PdfError::NoPages)?;
            let mut kp = pdf.start_page_with(PageSettings::new(size));
            let mut s = kp.surface();
            ex.list(&mut s, list);
            s.finish();
            kp.finish();
        }
        if let Some(error) = ex.font_error {
            return Err(error);
        }
        writer.finish().map_err(PdfError::from)
    })
}
