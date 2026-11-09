//! Charts EasyWriter makes ([`ChartSpec`]) as chart parts (ECMA-376 Part 1 §21.2) and back.
//!
//! [`chart_xml`] writes a `c:chartSpace` with the data as literals in the part itself
//! (`c:strLit`, `c:numLit`): no embedded workbook (`c:externalData`) and no external references.
//! [`chart_items`] draws a chart through the same code that draws chart parts read from files.
//! [`spec_of`] turns a chart part back into the model only when writing that model again gives
//! the same markup, so a chart with anything the model leaves out stays as it was read.

use ew_doc::chart::{ChartSeries, ChartSpec, ChartType, LegendPos, MAX_POINTS, MAX_SERIES};
use ew_doc::graphic::GraphicItem;
use ew_doc::props::Rgb;
use serde_json::Value;

use crate::xml::{self, El, MAX_DEPTH, Node, W};

const NS_C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const NS_A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/// Content type of a chart part.
pub(crate) const CHART_CT: &str = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
/// `a:graphicData` URI of a chart.
pub(crate) const CHART_URI: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
/// Axis ids (any pair of distinct numbers will do; Word keeps them).
const CAT_AX: &str = "500000001";
const VAL_AX: &str = "500000002";

/// The chart part for `spec`: a complete XML document, written as [`ChartSpec::sanitize`] leaves
/// it (a value that isn't finite is a gap).
pub fn chart_xml(spec: &ChartSpec) -> String {
    chart_part(spec).0
}

/// [`chart_xml`], and whether the chart limits left series or points of `spec` out of it.
pub(crate) fn chart_part(spec: &ChartSpec) -> (String, bool) {
    let kept = bounded(spec);
    let points = spec.series.iter().map(|s| s.values.len()).max().unwrap_or(0).max(spec.categories.len());
    let cut = kept.series.len() < spec.series.len() || kept.points() < points;
    (write_chart(&kept), cut)
}

fn write_chart(spec: &ChartSpec) -> String {
    let look = look_of(spec);
    let mut w = W::new();
    w.open("c:chartSpace", &[("xmlns:c", NS_C), ("xmlns:a", NS_A), ("xmlns:r", NS_R)]);
    w.empty("c:roundedCorners", &[("val", "0")]);
    w.open("c:chart", &[]);
    if let Some(t) = &spec.title {
        title_el(&mut w, t, look["titleOverlay"] == true);
    }
    w.empty("c:autoTitleDeleted", &[("val", if spec.title.is_some() { "0" } else { "1" })]);
    w.open("c:plotArea", &[]);
    w.empty("c:layout", &[]);
    plot(&mut w, spec, &look);
    if look["plot"].is_object() {
        sp_pr(&mut w, &look["plot"]);
    }
    w.close("c:plotArea");
    if let Some(pos) = spec.legend {
        w.open("c:legend", &[]);
        let p = match pos {
            LegendPos::Right => "r",
            LegendPos::Left => "l",
            LegendPos::Top => "t",
            LegendPos::Bottom => "b",
        };
        w.empty("c:legendPos", &[("val", p)]);
        w.empty("c:overlay", &[("val", if look["legendOverlay"] == true { "1" } else { "0" })]);
        w.close("c:legend");
    }
    w.empty("c:plotVisOnly", &[("val", "1")]);
    w.empty("c:dispBlanksAs", &[("val", "gap")]);
    w.close("c:chart");
    if look["area"].is_object() {
        sp_pr(&mut w, &look["area"]);
    } else {
        // A white chart area without a border, in the document's own background colour.
        w.open("c:spPr", &[]);
        w.open("a:solidFill", &[]);
        w.empty("a:schemeClr", &[("val", "bg1")]);
        w.close("a:solidFill");
        w.open("a:ln", &[]);
        w.empty("a:noFill", &[]);
        w.close("a:ln");
        w.close("c:spPr");
    }
    if let Some(t) = look["text"].as_str().filter(|t| *t != "none" && valid(t)) {
        w.open("c:txPr", &[]);
        w.empty("a:bodyPr", &[]);
        w.empty("a:lstStyle", &[]);
        w.open("a:p", &[]);
        w.open("a:pPr", &[]);
        w.open("a:defRPr", &[]);
        w.open("a:solidFill", &[]);
        colour(&mut w, t);
        w.close("a:solidFill");
        w.close("a:defRPr");
        w.close("a:pPr");
        w.empty("a:endParaRPr", &[("lang", "en-US")]);
        w.close("a:p");
        w.close("c:txPr");
    }
    if !spec.look.is_empty() {
        w.open("c:extLst", &[]);
        w.open("c:ext", &[("uri", "{6F2D9A4C-1B7E-4C2A-9E57-3D8B1F0A6C21}")]);
        w.leaf("ew:look", &[("xmlns:ew", "urn:easywriter:chart")], &spec.look);
        w.close("c:ext");
        w.close("c:extLst");
    }
    w.close("c:chartSpace");
    w.s
}

/// The chart's look, `Value::Null` when it has none (indexing Null gives Null).
fn look_of(spec: &ChartSpec) -> Value {
    ew_doc::chart::look_value(&spec.look)
}

const SCHEME: [&str; 10] = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "tx1", "tx2", "bg1", "bg2"];

/// A colour token: 6 hex digits, or a scheme name with an optional luminance change and offset (percent).
enum Colour<'a> {
    Srgb(&'a str),
    Scheme(&'a str, Option<u32>, Option<u32>),
}

fn colour_of(token: &str) -> Option<Colour<'_>> {
    let parts: Vec<&str> = token.split(':').collect();
    let hex = |s: &str| s.len() == 6 && s.chars().all(|c| c.is_ascii_hexdigit());
    if parts.len() == 1 {
        return match hex(parts[0]) {
            true => Some(Colour::Srgb(parts[0])),
            false => SCHEME.contains(&parts[0]).then_some(Colour::Scheme(parts[0], None, None)),
        };
    }
    if !SCHEME.contains(&parts[0]) || parts.len() > 3 {
        return None;
    }
    let pct = |s: &str| s.parse::<u32>().ok().filter(|v| *v <= 100);
    let m = pct(parts[1])?;
    let o = if parts.len() == 3 { Some(pct(parts[2])?) } else { None };
    Some(Colour::Scheme(parts[0], Some(m), o))
}

/// Writes `token` as a colour. False when it is not a token, and nothing is written.
fn colour(w: &mut W, token: &str) -> bool {
    match colour_of(token) {
        Some(Colour::Srgb(v)) => {
            w.empty("a:srgbClr", &[("val", v)]);
            true
        }
        Some(Colour::Scheme(name, m, o)) => {
            w.open("a:schemeClr", &[("val", name)]);
            if let Some(m) = m {
                w.empty("a:lumMod", &[("val", &(m * 1000).to_string())]);
            }
            if let Some(o) = o {
                w.empty("a:lumOff", &[("val", &(o * 1000).to_string())]);
            }
            w.close("a:schemeClr");
            true
        }
        None => false,
    }
}

/// Whether `token` is a colour token [`colour`] writes, or `none`.
fn valid(token: &str) -> bool {
    token == "none" || colour_of(token).is_some()
}

/// A fill: `a:noFill` for `none`, else `a:solidFill` around [`colour`].
fn paint(w: &mut W, token: &str) {
    if token == "none" {
        w.empty("a:noFill", &[]);
    } else if valid(token) {
        w.open("a:solidFill", &[]);
        colour(w, token);
        w.close("a:solidFill");
    }
}

/// `c:spPr` for a fill, a line and the line's width in points.
fn sp_pr_of(w: &mut W, fill: Option<&str>, line: Option<&str>, width: Option<f64>) {
    w.open("c:spPr", &[]);
    if let Some(t) = fill.filter(|t| valid(t)) {
        paint(w, t);
    }
    if let Some(t) = line.filter(|t| valid(t)) {
        let pt = width.unwrap_or(0.75).clamp(0.0, 20.0);
        w.open("a:ln", &[("w", &((pt * 12700.0).round() as i64).to_string())]);
        paint(w, t);
        w.close("a:ln");
    }
    w.close("c:spPr");
}

/// `c:spPr` for a `{fill, line, w}` object.
fn sp_pr(w: &mut W, b: &Value) {
    sp_pr_of(w, b["fill"].as_str(), b["line"].as_str(), b["w"].as_f64().filter(|v| v.is_finite()));
}

/// The `c:title` block, for the chart and for an axis.
fn title_el(w: &mut W, text: &str, overlay: bool) {
    w.open("c:title", &[]);
    w.open("c:tx", &[]);
    w.open("c:rich", &[]);
    w.empty("a:bodyPr", &[]);
    w.empty("a:lstStyle", &[]);
    w.open("a:p", &[]);
    w.open("a:r", &[]);
    w.leaf("a:t", &[], text);
    w.close("a:r");
    w.close("a:p");
    w.close("c:rich");
    w.close("c:tx");
    w.empty("c:overlay", &[("val", if overlay { "1" } else { "0" })]);
    w.close("c:title");
}

/// Where a data label goes, when the chart type takes it: Word refuses a file with `c:dLblPos` on an area or doughnut chart,
/// or `outEnd` on a stacked one.
fn label_pos(k: ChartType, look: &Value) -> Option<&str> {
    let p = look["labelPos"].as_str()?;
    let ok = match k {
        ChartType::Column | ChartType::Bar => matches!(p, "ctr" | "inEnd" | "inBase" | "outEnd"),
        ChartType::ColumnStacked | ChartType::BarStacked => matches!(p, "ctr" | "inEnd" | "inBase"),
        ChartType::Line | ChartType::Scatter | ChartType::Pie => p == "ctr",
        ChartType::Area | ChartType::Doughnut => false,
    };
    ok.then_some(p)
}

/// `spec` held to the chart limits. A model deserialised as is (a `.json` document) never went
/// through [`ChartSpec::sanitize`], and every series repeats every category, so its size would
/// multiply (#3648). Only what the limits keep is copied before sanitizing.
fn bounded(spec: &ChartSpec) -> ChartSpec {
    ChartSpec {
        kind: spec.kind,
        categories: spec.categories.iter().take(MAX_POINTS).cloned().collect(),
        series: spec
            .series
            .iter()
            .take(MAX_SERIES)
            .map(|s| ChartSeries { name: s.name.clone(), values: s.values.iter().take(MAX_POINTS).copied().collect() })
            .collect(),
        title: spec.title.clone(),
        legend: spec.legend,
        data_labels: spec.data_labels,
        look: spec.look.clone(),
    }
    .sanitized()
}

/// What `spec` draws as, `w` × `h` points, in the colours of `theme` (series take the accents in
/// turn). Empty when the chart has no series.
pub fn chart_items(spec: &ChartSpec, theme: &[Rgb], w: f32, h: f32) -> Vec<GraphicItem> {
    match xml::parse(chart_xml(spec).as_bytes()) {
        Ok(space) => crate::read::chart::chart_items(&space, theme, w, h),
        Err(_) => Vec::new(),
    }
}

/// The chart type element and the series in it, then the axes.
fn plot(w: &mut W, spec: &ChartSpec, look: &Value) {
    let k = spec.kind;
    let el = match k {
        ChartType::Column | ChartType::ColumnStacked | ChartType::Bar | ChartType::BarStacked => "c:barChart",
        ChartType::Line => "c:lineChart",
        ChartType::Area => "c:areaChart",
        ChartType::Pie => "c:pieChart",
        ChartType::Doughnut => "c:doughnutChart",
        ChartType::Scatter => "c:scatterChart",
    };
    let stacked = matches!(k, ChartType::ColumnStacked | ChartType::BarStacked);
    let horizontal = matches!(k, ChartType::Bar | ChartType::BarStacked);
    w.open(el, &[]);
    match k {
        ChartType::Column | ChartType::ColumnStacked | ChartType::Bar | ChartType::BarStacked => {
            w.empty("c:barDir", &[("val", if horizontal { "bar" } else { "col" })]);
            w.empty("c:grouping", &[("val", if stacked { "stacked" } else { "clustered" })]);
        }
        ChartType::Line | ChartType::Area => w.empty("c:grouping", &[("val", "standard")]),
        ChartType::Scatter => w.empty("c:scatterStyle", &[("val", "lineMarker")]),
        ChartType::Pie | ChartType::Doughnut => {}
    }
    w.empty("c:varyColors", &[("val", if k.is_round() { "1" } else { "0" })]);
    // Pie and doughnut charts show the first series; the others are kept for other types.
    for (i, s) in spec.series.iter().enumerate() {
        series(w, spec, i, s, look);
    }
    if spec.data_labels {
        w.open("c:dLbls", &[]);
        if let Some(p) = label_pos(k, look) {
            w.empty("c:dLblPos", &[("val", p)]);
        }
        for (name, on) in [
            ("c:showLegendKey", false),
            ("c:showVal", true),
            ("c:showCatName", false),
            ("c:showSerName", false),
            ("c:showPercent", false),
            ("c:showBubbleSize", false),
        ] {
            w.empty(name, &[("val", if on { "1" } else { "0" })]);
        }
        w.close("c:dLbls");
    }
    match k {
        ChartType::Column | ChartType::ColumnStacked | ChartType::Bar | ChartType::BarStacked => {
            w.empty("c:gapWidth", &[("val", "150")]);
            if stacked {
                w.empty("c:overlap", &[("val", "100")]);
            }
        }
        ChartType::Line => w.empty("c:marker", &[("val", "1")]),
        ChartType::Pie => w.empty("c:firstSliceAng", &[("val", "0")]),
        ChartType::Doughnut => {
            w.empty("c:firstSliceAng", &[("val", "0")]);
            w.empty("c:holeSize", &[("val", "50")]);
        }
        ChartType::Area | ChartType::Scatter => {}
    }
    if !k.is_round() {
        w.empty("c:axId", &[("val", CAT_AX)]);
        w.empty("c:axId", &[("val", VAL_AX)]);
    }
    w.close(el);
    // The value axis keeps its gridlines unless the look turns them off; the category axis gains them when the look asks.
    let val = AxisOut {
        id: VAL_AX,
        cross: CAT_AX,
        pos: if horizontal { "b" } else { "l" },
        grid: look["noValGrid"] != true,
        no_line: true,
        deleted: look["noValAxis"] == true,
        title: look["valTitle"].as_str(),
    };
    let cat = AxisOut {
        id: CAT_AX,
        cross: VAL_AX,
        pos: if horizontal { "l" } else { "b" },
        grid: look["catGrid"] == true,
        no_line: false,
        deleted: look["noCatAxis"] == true,
        title: look["catTitle"].as_str(),
    };
    match k {
        ChartType::Pie | ChartType::Doughnut => {}
        // A scatter chart's category axis is a value axis on the bottom, with the y values on the left.
        ChartType::Scatter => {
            value_axis(w, cat, "midCat");
            value_axis(w, val, "midCat");
        }
        _ => {
            category_axis(w, cat);
            value_axis(w, val, "between");
        }
    }
}

/// One axis: its id and the axis it crosses, where it sits, its gridlines and line, whether it is hidden, and its title.
struct AxisOut<'a> {
    id: &'a str,
    cross: &'a str,
    pos: &'a str,
    grid: bool,
    no_line: bool,
    deleted: bool,
    title: Option<&'a str>,
}

/// One `c:ser` (ECMA-376 element order: idx, order, tx, spPr, marker, dPt, cat/xVal, val/yVal, smooth).
fn series(w: &mut W, spec: &ChartSpec, index: usize, s: &ChartSeries, look: &Value) {
    let k = spec.kind;
    let i = index.to_string();
    let own = &look["sers"][i.as_str()];
    // The palette takes series in turn; fewer colours than series repeat.
    let colours = look["colors"].as_array().filter(|a| !a.is_empty());
    let token = colours.and_then(|a| a[index % a.len()].as_str());
    let fill = own["fill"].as_str().or(token);
    let line = own["line"].as_str();
    let width = own["w"].as_f64().filter(|v| v.is_finite());
    w.open("c:ser", &[]);
    w.empty("c:idx", &[("val", &i)]);
    w.empty("c:order", &[("val", &i)]);
    if !s.name.is_empty() {
        w.open("c:tx", &[]);
        w.leaf("c:v", &[], &s.name);
        w.close("c:tx");
    }
    match k {
        // Markers only: the series has no line.
        ChartType::Scatter => {
            w.open("c:spPr", &[]);
            if let Some(t) = fill.filter(|t| valid(t)) {
                paint(w, t);
            }
            w.open("a:ln", &[("w", "19050")]);
            w.empty("a:noFill", &[]);
            w.close("a:ln");
            w.close("c:spPr");
        }
        ChartType::Column | ChartType::ColumnStacked | ChartType::Bar | ChartType::BarStacked => {
            if fill.is_some() || line.is_some() {
                sp_pr_of(w, fill, line, width);
            }
            w.empty("c:invertIfNegative", &[("val", "0")]);
        }
        ChartType::Area => {
            if fill.is_some() || line.is_some() {
                sp_pr_of(w, fill, line, width);
            }
        }
        ChartType::Line => {
            if let Some(t) = line.or(fill).filter(|t| valid(t)) {
                let pt = width.unwrap_or(2.25).clamp(0.0, 20.0);
                w.open("c:spPr", &[]);
                w.open("a:ln", &[("w", &((pt * 12700.0).round() as i64).to_string())]);
                paint(w, t);
                w.close("a:ln");
                w.close("c:spPr");
            }
            w.open("c:marker", &[]);
            w.empty("c:symbol", &[("val", "none")]);
            w.close("c:marker");
        }
        ChartType::Pie | ChartType::Doughnut => {}
    }
    // Pie and doughnut slices take the palette in turn: a point's own fill is its `c:dPt` after `c:tx`. Only the first
    // series is drawn, so only it carries the slices.
    if k.is_round() && index == 0 {
        let n = spec.series.iter().map(|s| s.values.len()).max().unwrap_or(0).max(spec.categories.len());
        for j in 0..n {
            let jt = j.to_string();
            let own = &look["sers"][jt.as_str()];
            let token = colours.and_then(|a| a[j % a.len()].as_str());
            if let Some(t) = own["fill"].as_str().or(token).filter(|t| valid(t)) {
                w.open("c:dPt", &[]);
                w.empty("c:idx", &[("val", &jt)]);
                sp_pr_of(w, Some(t), own["line"].as_str(), own["w"].as_f64().filter(|v| v.is_finite()));
                w.close("c:dPt");
            }
        }
    }
    if k == ChartType::Scatter {
        let xs: Option<Vec<Option<f64>>> = spec
            .categories
            .iter()
            .map(|c| if c.is_empty() { Some(None) } else { c.parse::<f64>().ok().filter(|v| v.is_finite()).map(Some) })
            .collect();
        w.open("c:xVal", &[]);
        match xs {
            Some(xs) => num_lit(w, &xs),
            None => str_lit(w, &spec.categories),
        }
        w.close("c:xVal");
        w.open("c:yVal", &[]);
        num_lit(w, &s.values);
        w.close("c:yVal");
    } else {
        w.open("c:cat", &[]);
        str_lit(w, &spec.categories);
        w.close("c:cat");
        w.open("c:val", &[]);
        num_lit(w, &s.values);
        w.close("c:val");
    }
    if matches!(k, ChartType::Line | ChartType::Scatter) {
        w.empty("c:smooth", &[("val", "0")]);
    }
    w.close("c:ser");
}

fn str_lit(w: &mut W, items: &[String]) {
    w.open("c:strLit", &[]);
    w.empty("c:ptCount", &[("val", &items.len().to_string())]);
    for (i, s) in items.iter().enumerate().filter(|(_, s)| !s.is_empty()) {
        w.open("c:pt", &[("idx", &i.to_string())]);
        w.leaf("c:v", &[], s);
        w.close("c:pt");
    }
    w.close("c:strLit");
}

fn num_lit(w: &mut W, values: &[Option<f64>]) {
    w.open("c:numLit", &[]);
    w.leaf("c:formatCode", &[], "General");
    w.empty("c:ptCount", &[("val", &values.len().to_string())]);
    for (i, v) in values.iter().enumerate() {
        if let Some(v) = v.filter(|v| v.is_finite()) {
            w.open("c:pt", &[("idx", &i.to_string())]);
            w.leaf("c:v", &[], &num(v));
            w.close("c:pt");
        }
    }
    w.close("c:numLit");
}

/// A value as the shortest text that reads back as the same number.
fn num(v: f64) -> String {
    if v == 0.0 { "0".to_string() } else { format!("{v}") }
}

fn category_axis(w: &mut W, ax: AxisOut<'_>) {
    w.open("c:catAx", &[]);
    w.empty("c:axId", &[("val", ax.id)]);
    w.open("c:scaling", &[]);
    w.empty("c:orientation", &[("val", "minMax")]);
    w.close("c:scaling");
    w.empty("c:delete", &[("val", if ax.deleted { "1" } else { "0" })]);
    w.empty("c:axPos", &[("val", ax.pos)]);
    if ax.grid {
        w.empty("c:majorGridlines", &[]);
    }
    if let Some(t) = ax.title {
        title_el(w, t, false);
    }
    w.empty("c:majorTickMark", &[("val", "none")]);
    w.empty("c:minorTickMark", &[("val", "none")]);
    w.empty("c:tickLblPos", &[("val", "nextTo")]);
    w.empty("c:crossAx", &[("val", ax.cross)]);
    w.empty("c:crosses", &[("val", "autoZero")]);
    w.empty("c:auto", &[("val", "1")]);
    w.empty("c:lblAlgn", &[("val", "ctr")]);
    w.empty("c:lblOffset", &[("val", "100")]);
    w.empty("c:noMultiLvlLbl", &[("val", "0")]);
    w.close("c:catAx");
}

/// A value axis: its gridlines when `grid`, its line hidden when `no_line`.
fn value_axis(w: &mut W, ax: AxisOut<'_>, between: &str) {
    w.open("c:valAx", &[]);
    w.empty("c:axId", &[("val", ax.id)]);
    w.open("c:scaling", &[]);
    w.empty("c:orientation", &[("val", "minMax")]);
    w.close("c:scaling");
    w.empty("c:delete", &[("val", if ax.deleted { "1" } else { "0" })]);
    w.empty("c:axPos", &[("val", ax.pos)]);
    if ax.grid {
        w.empty("c:majorGridlines", &[]);
    }
    if let Some(t) = ax.title {
        title_el(w, t, false);
    }
    w.empty("c:majorTickMark", &[("val", "none")]);
    w.empty("c:minorTickMark", &[("val", "none")]);
    w.empty("c:tickLblPos", &[("val", "nextTo")]);
    if ax.no_line {
        w.open("c:spPr", &[]);
        w.open("a:ln", &[]);
        w.empty("a:noFill", &[]);
        w.close("a:ln");
        w.close("c:spPr");
    }
    w.empty("c:crossAx", &[("val", ax.cross)]);
    w.empty("c:crosses", &[("val", "autoZero")]);
    w.empty("c:crossBetween", &[("val", between)]);
    w.close("c:valAx");
}

/// The chart a chart part holds, when the part is exactly what [`chart_xml`] writes for it (so
/// editing and saving it loses nothing). `None` for any other chart.
pub(crate) fn spec_of(space: &El) -> Option<ChartSpec> {
    let chart = space.child("c:chart")?;
    let plot = chart.child("c:plotArea")?;
    let ty = plot.els().find(|e| e.name.ends_with("Chart"))?;
    let val = |e: &El, n: &str| e.child(n).and_then(|c| c.attr("val")).map(str::to_string);
    let bar = |stacked_kind, clustered_kind| if val(ty, "c:grouping").as_deref() == Some("stacked") { stacked_kind } else { clustered_kind };
    let kind = match ty.name.as_str() {
        "c:barChart" if val(ty, "c:barDir").as_deref() == Some("bar") => bar(ChartType::BarStacked, ChartType::Bar),
        "c:barChart" => bar(ChartType::ColumnStacked, ChartType::Column),
        "c:lineChart" => ChartType::Line,
        "c:areaChart" => ChartType::Area,
        "c:pieChart" => ChartType::Pie,
        "c:doughnutChart" => ChartType::Doughnut,
        "c:scatterChart" => ChartType::Scatter,
        _ => return None,
    };
    let scatter = kind == ChartType::Scatter;
    let sers: Vec<&El> = ty.children("c:ser").take(ew_doc::chart::MAX_SERIES + 1).collect();
    // More than the model holds can't be the same chart: don't build it to find out.
    let count = |s: &&El| s.find("c:ptCount").and_then(|c| c.attr("val")).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let longest = sers.iter().map(count).max().unwrap_or(0);
    if sers.len() > ew_doc::chart::MAX_SERIES
        || longest > ew_doc::chart::MAX_POINTS
        || sers.len().saturating_mul(longest) > ew_doc::chart::MAX_CELLS
    {
        return None;
    }
    let categories = sers.first().and_then(|s| s.child(if scatter { "c:xVal" } else { "c:cat" })).map(literal).unwrap_or_default();
    let series = sers
        .iter()
        .map(|s| ChartSeries {
            name: s.child("c:tx").and_then(|t| t.child("c:v")).map(|v| v.text()).unwrap_or_default(),
            values: s
                .child(if scatter { "c:yVal" } else { "c:val" })
                .map(literal)
                .unwrap_or_default()
                .iter()
                .map(|v| v.parse::<f64>().ok().filter(|v| v.is_finite()))
                .collect(),
        })
        .collect();
    let title = chart.child("c:title").and_then(|t| t.find("a:t")).map(|t| t.text());
    let legend = chart.child("c:legend").map(|l| match val(l, "c:legendPos").as_deref() {
        Some("l") => LegendPos::Left,
        Some("t") => LegendPos::Top,
        Some("b") => LegendPos::Bottom,
        _ => LegendPos::Right,
    });
    let data_labels = ty.child("c:dLbls").and_then(|d| d.child("c:showVal")).and_then(|v| v.attr("val")) == Some("1");
    let look = space.child("c:extLst").and_then(|x| x.find("ew:look")).map(|l| l.text()).unwrap_or_default();
    let spec = ChartSpec { kind, categories, series, title, legend, data_labels, look }.sanitized();
    // Editable only when nothing would be lost: writing the model again gives the same part.
    let again = xml::parse(chart_xml(&spec).as_bytes()).ok()?;
    same(space, &again, 0).then_some(spec)
}

/// The points of a `c:strLit` / `c:numLit` (or a cache) as texts by index, `ptCount` long.
fn literal(e: &El) -> Vec<String> {
    let Some(lit) = e.els().find(|c| matches!(c.name.as_str(), "c:strLit" | "c:numLit")) else { return Vec::new() };
    let n = lit
        .child("c:ptCount")
        .and_then(|c| c.attr("val"))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0)
        .min(ew_doc::chart::MAX_POINTS + 1);
    let mut out = vec![String::new(); n];
    for p in lit.children("c:pt") {
        if let Some(slot) = p.attr("idx").and_then(|i| i.parse::<usize>().ok()).and_then(|i| out.get_mut(i)) {
            *slot = p.child("c:v").map(|v| v.text()).unwrap_or_default();
        }
    }
    out
}

/// Whether two elements are the same markup: names, attributes (in any order), child elements in
/// order and text (whitespace-only text between elements ignored).
fn same(a: &El, b: &El, depth: usize) -> bool {
    if depth > MAX_DEPTH || a.name != b.name || a.attrs.len() != b.attrs.len() {
        return false;
    }
    if !a.attrs.iter().all(|(k, v)| b.attr(k) == Some(v.as_str()) && b.attrs.iter().any(|(bk, _)| bk == k)) {
        return false;
    }
    let text = |e: &El| -> String {
        e.kids
            .iter()
            .filter_map(|n| match n {
                Node::Text(t) if !t.trim().is_empty() => Some(t.as_str()),
                _ => None,
            })
            .collect()
    };
    if text(a) != text(b) {
        return false;
    }
    let (mut x, mut y) = (a.els(), b.els());
    loop {
        match (x.next(), y.next()) {
            (None, None) => return true,
            (Some(p), Some(q)) if same(p, q, depth + 1) => {}
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ew_doc::THEME_COLORS;

    fn parse(spec: &ChartSpec) -> El {
        xml::parse(chart_xml(spec).as_bytes()).unwrap()
    }

    /// Children of `e` by name, in order.
    fn names(e: &El) -> Vec<&str> {
        e.els().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn a_chart_past_the_limits_is_written_within_them() {
        // A model deserialised as is (a `.json` document) never went through `sanitize`, and every
        // series repeats every category: 300 series of 4,500 points wrote 2.7 million points (#3648).
        use ew_doc::chart::MAX_CELLS;
        let spec = ChartSpec {
            kind: ChartType::Column,
            categories: (0..4500).map(|i| i.to_string()).collect(),
            series: (0..300).map(|i| ChartSeries { name: format!("S{i}"), values: vec![Some(1.0); 4500] }).collect(),
            title: None,
            legend: None,
            data_labels: false,
            look: String::new(),
        };
        let x = chart_xml(&spec);
        let series = x.matches("<c:ser>").count();
        let points = x.matches("<c:pt ").count();
        assert!((1..=MAX_SERIES).contains(&series), "{series} series");
        assert!(points <= 2 * MAX_CELLS, "{points} points");
        assert!(!x.contains(&format!("<c:pt idx=\"{MAX_POINTS}\"")), "past the point limit");
    }

    /// A look holding every key the brief names.
    const EVERY_LOOK: &str = r#"{"titleOverlay":true,"legendOverlay":true,"noCatAxis":true,"noValAxis":true,"catTitle":"Axis Title","valTitle":"Axis Title","catGrid":true,"noValGrid":true,"labelPos":"ctr","colors":["accent1","accent1:75","accent1:60:40","156082"],"area":{"fill":"bg1:95","line":"tx1:15:85","w":0.75},"plot":{"fill":"none","line":"none","w":0.75},"sers":{"0":{"fill":"C00000","line":"none","w":1}},"text":"bg1"}"#;

    #[test]
    fn every_type_reads_back_as_itself() {
        for kind in ChartType::ALL {
            let mut spec = ChartSpec::sample(kind);
            spec.title = Some("Sales & <costs>".into());
            spec.data_labels = true;
            spec.legend = Some(LegendPos::Right);
            spec.series[0].values[1] = None;
            spec.categories[2] = String::new();
            let spec = spec.sanitized();
            assert_eq!(spec_of(&parse(&spec)).as_ref(), Some(&spec), "{kind:?}");
            assert!(!chart_items(&spec, &THEME_COLORS, 300.0, 200.0).is_empty(), "{kind:?} draws");
            let mut looked = spec;
            looked.look = EVERY_LOOK.into();
            let looked = looked.sanitized();
            assert_eq!(spec_of(&parse(&looked)).as_ref(), Some(&looked), "{kind:?} with a look");
        }
        let plain = ChartSpec { legend: None, ..ChartSpec::sample(ChartType::Line) };
        assert_eq!(spec_of(&parse(&plain)), Some(plain));
    }

    #[test]
    fn a_chart_without_a_look_writes_none_of_its_elements() {
        for kind in ChartType::ALL {
            let x = chart_xml(&ChartSpec::sample(kind));
            assert!(!x.contains("c:extLst"), "{kind:?} writes no extLst");
            assert!(!x.contains("c:txPr"), "{kind:?} writes no txPr");
            assert!(!x.contains("c:dLblPos"), "{kind:?} writes no dLblPos");
        }
    }

    #[test]
    fn data_label_positions_only_where_word_takes_them() {
        let x = |kind: ChartType, p: &str| {
            let mut s = ChartSpec::sample(kind);
            s.data_labels = true;
            s.look = format!(r#"{{"labelPos":"{p}"}}"#);
            chart_xml(&s.sanitized())
        };
        for (k, p) in [(ChartType::Area, "ctr"), (ChartType::Doughnut, "ctr"), (ChartType::ColumnStacked, "outEnd"), (ChartType::BarStacked, "outEnd")] {
            assert!(!x(k, p).contains("c:dLblPos"), "{k:?} takes no {p}");
        }
        for (k, p) in [(ChartType::Column, "outEnd"), (ChartType::Bar, "inBase"), (ChartType::ColumnStacked, "inEnd"), (ChartType::Pie, "ctr")] {
            assert!(x(k, p).contains(&format!(r#"<c:dLblPos val="{p}"/>"#)), "{k:?} takes {p}");
        }
    }

    #[test]
    fn a_bad_colour_token_writes_no_element_and_the_chart_still_parses() {
        let mut spec = ChartSpec::sample(ChartType::Column);
        spec.look = r#"{"colors":["accent7","nothex"],"area":{"fill":"bogus","line":"accent1:200"}}"#.into();
        let spec = spec.sanitized();
        let x = chart_xml(&spec);
        let colours = x.matches("<a:srgbClr").count() + x.matches("<a:schemeClr").count();
        assert_eq!(colours, 0, "no colour element for a bad token: {x}");
        assert!(xml::parse(x.as_bytes()).is_ok(), "{x}");
        assert_eq!(spec_of(&parse(&spec)).as_ref(), Some(&spec), "still editable");
    }

    #[test]
    fn a_chart_with_more_than_the_model_stays_read_only() {
        let spec = ChartSpec::sample(ChartType::Column);
        let x = chart_xml(&spec).replace("<c:roundedCorners val=\"0\"/>", "<c:roundedCorners val=\"0\"/><c:style val=\"2\"/>");
        assert_eq!(spec_of(&xml::parse(x.as_bytes()).unwrap()), None);
        let x = chart_xml(&spec).replace("<c:v>3.2</c:v>", "<c:v>3.20</c:v>");
        assert_eq!(spec_of(&xml::parse(x.as_bytes()).unwrap()), None);
    }

    #[test]
    fn elements_come_in_schema_order() {
        let mut spec = ChartSpec::sample(ChartType::ColumnStacked);
        spec.title = Some("T".into());
        spec.data_labels = true;
        let space = parse(&spec);
        assert_eq!(names(&space), ["c:roundedCorners", "c:chart", "c:spPr"]);
        let chart = space.child("c:chart").unwrap();
        assert_eq!(names(chart), ["c:title", "c:autoTitleDeleted", "c:plotArea", "c:legend", "c:plotVisOnly", "c:dispBlanksAs"]);
        let plot = chart.child("c:plotArea").unwrap();
        assert_eq!(names(plot), ["c:layout", "c:barChart", "c:catAx", "c:valAx"]);
        let bar = plot.child("c:barChart").unwrap();
        assert_eq!(
            names(bar),
            ["c:barDir", "c:grouping", "c:varyColors", "c:ser", "c:ser", "c:ser", "c:dLbls", "c:gapWidth", "c:overlap", "c:axId", "c:axId"]
        );
        assert_eq!(names(bar.child("c:ser").unwrap()), ["c:idx", "c:order", "c:tx", "c:invertIfNegative", "c:cat", "c:val"]);
        let val_ax = plot.child("c:valAx").unwrap();
        assert_eq!(
            names(val_ax),
            [
                "c:axId",
                "c:scaling",
                "c:delete",
                "c:axPos",
                "c:majorGridlines",
                "c:majorTickMark",
                "c:minorTickMark",
                "c:tickLblPos",
                "c:spPr",
                "c:crossAx",
                "c:crosses",
                "c:crossBetween"
            ]
        );
        let line = parse(&ChartSpec { data_labels: true, ..ChartSpec::sample(ChartType::Line) });
        let lc = line.child("c:chart").unwrap().child("c:plotArea").unwrap().child("c:lineChart").unwrap();
        assert_eq!(names(lc), ["c:grouping", "c:varyColors", "c:ser", "c:ser", "c:ser", "c:dLbls", "c:marker", "c:axId", "c:axId"]);
        assert_eq!(names(lc.child("c:ser").unwrap()), ["c:idx", "c:order", "c:tx", "c:marker", "c:cat", "c:val", "c:smooth"]);
        let sc = parse(&ChartSpec::sample(ChartType::Scatter));
        let sc = sc.child("c:chart").unwrap().child("c:plotArea").unwrap().child("c:scatterChart").unwrap();
        assert_eq!(names(sc.child("c:ser").unwrap()), ["c:idx", "c:order", "c:tx", "c:spPr", "c:xVal", "c:yVal", "c:smooth"]);
        let dn = parse(&ChartSpec::sample(ChartType::Doughnut));
        let dn = dn.child("c:chart").unwrap().child("c:plotArea").unwrap();
        assert_eq!(names(dn), ["c:layout", "c:doughnutChart"]);
        assert_eq!(names(dn.child("c:doughnutChart").unwrap()), ["c:varyColors", "c:ser", "c:firstSliceAng", "c:holeSize"]);

        // A full look keeps the schema order: grids before an axis title, and the text and the look close the chart space.
        let mut full = ChartSpec::sample(ChartType::ColumnStacked);
        full.title = Some("T".into());
        full.data_labels = true;
        full.look = EVERY_LOOK.into();
        let full = parse(&full.sanitized());
        assert_eq!(names(&full), ["c:roundedCorners", "c:chart", "c:spPr", "c:txPr", "c:extLst"]);
        let cat_ax = full.child("c:chart").unwrap().child("c:plotArea").unwrap().child("c:catAx").unwrap();
        let n = names(cat_ax);
        let grid = n.iter().position(|x| *x == "c:majorGridlines").expect("catGrid");
        assert_eq!(n.get(grid + 1), Some(&"c:title"), "{n:?}");
        let val_ax = full.child("c:chart").unwrap().child("c:plotArea").unwrap().child("c:valAx").unwrap();
        let n = names(val_ax);
        assert!(n.iter().position(|x| *x == "c:title").is_some_and(|t| t > n.iter().position(|x| *x == "c:axPos").unwrap()), "{n:?}");
        let mut pie = ChartSpec::sample(ChartType::Pie);
        pie.look = r#"{"colors":["accent1","accent2"]}"#.into();
        let pie = parse(&pie.sanitized());
        let ser = pie.child("c:chart").unwrap().child("c:plotArea").unwrap().child("c:pieChart").unwrap().child("c:ser").unwrap();
        assert_eq!(names(ser), ["c:idx", "c:order", "c:tx", "c:dPt", "c:dPt", "c:dPt", "c:dPt", "c:cat", "c:val"]);
    }
}

