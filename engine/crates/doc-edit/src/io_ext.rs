//! Format crates registered with the I/O dispatcher.

use ew_doc::Document;

/// Open a format other than plain text / JSON; files that give no page size (Markdown, HTML)
/// start on `page`.
pub fn open(ext: &str, bytes: &[u8], page: &ew_doc::SectionProps) -> Option<Result<Document, String>> {
    match ext {
        "docx" | "docm" | "dotx" | "dotm" => Some(ew_docx::read(bytes).map_err(|e| e.to_string())),
        "doc" | "dot" => Some(ew_docbin::read(bytes).map_err(|e| e.to_string())),
        // Word XML Document (Flat OPC) or Word 2003 XML, told apart by the root element.
        "xml" => Some(ew_docx::read_xml(bytes).map_err(|e| e.to_string())),
        // HTML, Markdown, ODT, RTF…: pictures fit the text width (see `io::fit_pictures`).
        other => ew_formats::import_on(other, bytes, page).map(|r| {
            r.map(|mut doc| {
                crate::io::fit_pictures(&mut doc);
                doc
            })
        }),
    }
}

/// Save to a format other than plain text / JSON.
pub fn save(ext: &str, doc: &Document, opts: &crate::io::ExportOptions) -> Option<Result<Vec<u8>, String>> {
    // .docx/.docm/.dotx/.dotm: the extension picks the package flavour Word expects.
    if let Some(flavor) = ew_docx::Flavor::from_ext(ext) {
        return Some(ew_docx::write_as(doc, flavor).map_err(|e| e.to_string()));
    }
    match ext {
        "xml" if opts.word2003 => Some(ew_docx::write_wordml2003(doc).map_err(|e| e.to_string())),
        "xml" => Some(ew_docx::write_flat(doc).map_err(|e| e.to_string())),
        "png" => Some(render_png(doc, 0, 2.0, opts)),
        "pdf" => {
            let pdf = ew_pdf::PdfOptions {
                include_markup: opts.markup,
                comments: opts.markup && opts.comments,
                numeral: opts.numeral,
                ..Default::default()
            };
            Some(ew_pdf::export(doc, &pdf).map_err(|e| e.to_string()))
        }
        // EasyWriter engine-pictures-2: HTML has pictures but no drawings, so shapes, groups and boxes go out as pictures of
        // themselves; HTML, ODT and RTF have no picture colour settings, so a picture goes out as it is shown.
        "html" | "htm" | "xhtml" | "odt" | "rtf" => {
            let pictured = matches!(ext, "html" | "htm" | "xhtml").then(|| crate::cmd::objects::drawings_as_pictures(doc)).flatten();
            let base = pictured.as_ref().unwrap_or(doc);
            let shown = crate::cmd::objects::shown_pictures(base);
            ew_formats::export_with(ext, shown.as_ref().unwrap_or(base), &ew_formats::ExportOptions { comments: opts.markup && opts.comments })
        }
        other => ew_formats::export_with(other, doc, &ew_formats::ExportOptions { comments: opts.markup && opts.comments }),
    }
}

/// Render page `page` as PNG at `scale` px/pt. With Print Markup's comments the page has its
/// markup area with the comments in balloons (page images always show tracked changes).
pub fn render_png(doc: &Document, page: usize, scale: f32, opts: &crate::io::ExportOptions) -> Result<Vec<u8>, String> {
    let lo = ew_doc_layout::LayoutOptions { comment_balloons: opts.markup && opts.comments, numeral: opts.numeral, ..Default::default() };
    let l = ew_doc_layout::layout(doc, &mut ew_doc_layout::LayoutCache::new(), &lo);
    let p = l.pages.get(page).ok_or_else(|| format!("no page {}", page + 1))?;
    let img = ew_doc_layout::display::render_page(doc, p, scale, &Default::default());
    Ok(img.to_png())
}
