use super::{
    Block, Blocks, CmdError, CmdResult, Document, InlineObject, MailMerge, Paragraph, Part, PartKind, SectionProps, SectionStart, Session,
    StoryRef, Value, json, mm, mm_mut, p, para_block,
};

pub(super) fn step(s: &mut Session, d: i64) -> CmdResult {
    go_to(s, i64::from(mm(s).record).saturating_add(d))
}

/// Preview record `idx` (0-based), clamped to the list.
pub(super) fn go_to(s: &mut Session, idx: i64) -> CmdResult {
    let m = mm_mut(s);
    let n = m.active.len().max(1) as i64;
    m.record = idx.clamp(0, n - 1) as u32;
    m.preview = true;
    let record = m.record + 1;
    refresh(s);
    Ok(json!({"record": record, "of": n}))
}

/// Find Recipient: the first record of the merge holding `text` (any case) in any column or in `field`, from the first or
/// (`next`) after the record shown, wrapping round; it is shown with Preview Results on.
pub(super) fn find_recipient(s: &mut Session, v: &Value) -> CmdResult {
    let q = p::req_str(v, "text")?.to_lowercase();
    let m = mm(s);
    let col = match p::str(v, "field").filter(|f| !f.trim().is_empty()) {
        Some(f) => Some(m.column(f).ok_or_else(|| CmdError::Params(format!("no field named `{f}` in the recipient list")))?),
        None => None,
    };
    let n = m.active.len();
    let from = if p::bool(v, "next") == Some(true) { m.record as usize + 1 } else { 0 };
    let hit = |r: &Vec<String>| match col {
        Some(c) => r.get(c).is_some_and(|x| x.to_lowercase().contains(&q)),
        None => r.iter().any(|x| x.to_lowercase().contains(&q)),
    };
    let at = (0..n).map(|k| (from + k) % n).find(|i| m.row(*i).is_some_and(hit)).ok_or_else(|| CmdError::Failed("no matching recipient".into()))?;
    let m = mm_mut(s);
    m.record = at as u32;
    m.preview = true;
    refresh(s);
    Ok(json!({"record": at + 1}))
}

/// Field names used by MERGEFIELD fields in the document (body, headers and footers).
pub(super) fn merge_fields(doc: &Document) -> Vec<String> {
    let mut v = Vec::new();
    for (story, path) in merge_stories(doc).into_iter().flat_map(|st| doc.para_paths(st).into_iter().map(move |p| (st, p))) {
        if let Some(p) = doc.para(story, &path) {
            for o in &p.objects {
                if let InlineObject::Field { instr, .. } = o
                    && let Some(name) = mergefield_name(instr)
                    && !v.contains(&name)
                {
                    v.push(name);
                }
            }
        }
    }
    v
}

pub(super) fn mergefield_name(instr: &str) -> Option<String> {
    // The field type ignores case and ends at a space or a quote, so `MERGEFIELDX` is another field.
    let t = instr.trim();
    let (kind, rest) = t.split_at_checked(t.find(|c: char| c.is_whitespace() || c == '"').unwrap_or(t.len()))?;
    if !kind.eq_ignore_ascii_case("MERGEFIELD") {
        return None;
    }
    let rest = rest.trim();
    let name = if let Some(r) = rest.strip_prefix('"') { r.split('"').next().unwrap_or("") } else { rest.split_whitespace().next().unwrap_or("") };
    Some(name.to_string())
}

/// Word's address fields (Match Fields) by the app's key (src/document/wp/mailings/data.mjs ADDRESS_FIELDS), with the column
/// names, letters and digits only, that match each without a pick.
const ADDRESS_FIELDS: [(&str, &[&str]); 21] = [
    ("uniqueId", &["uniqueidentifier", "id"]),
    ("courtesyTitle", &["courtesytitle", "title"]),
    ("first", &["firstname", "first", "givenname", "forename"]),
    ("middle", &["middlename"]),
    ("last", &["lastname", "last", "surname", "familyname"]),
    ("suffix", &["suffix"]),
    ("nickname", &["nickname"]),
    ("jobTitle", &["jobtitle"]),
    ("company", &["company", "companyname", "organisation", "organization"]),
    ("address1", &["address1", "addressline1", "address", "street", "streetaddress"]),
    ("address2", &["address2", "addressline2"]),
    ("city", &["city", "town"]),
    ("state", &["state", "province", "county", "region"]),
    ("postal", &["postalcode", "zipcode", "zip", "postcode"]),
    ("country", &["countryorregion", "country", "countryregion"]),
    ("businessPhone", &["businessphone", "workphone", "phone"]),
    ("businessFax", &["businessfax", "fax"]),
    ("homePhone", &["homephone"]),
    ("homeFax", &["homefax"]),
    ("email", &["emailaddress", "email"]),
    ("webPage", &["webpage", "website"]),
];

/// `s` in lower case, letters and digits only: "First Name", "FirstName" and "first_name" agree.
fn squash(s: &str) -> String {
    s.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

/// The column address field `key` reads: Match Fields' pick (an empty pick: none), else the first column named like it.
fn mapped(m: &MailMerge, key: &str) -> Option<String> {
    if let Some(col) = m.map.get(key) {
        if col.is_empty() {
            return None;
        }
        if let Some(i) = m.column(col) {
            return m.fields.get(i).cloned();
        }
    }
    let names = ADDRESS_FIELDS.iter().find(|(k, _)| *k == key)?.1;
    names.iter().find_map(|n| m.fields.iter().find(|f| squash(f) == *n)).cloned()
}

/// Every address field's column (null: none), as Match Fields shows them.
pub(super) fn map_json(m: &MailMerge) -> Value {
    Value::Object(ADDRESS_FIELDS.iter().map(|(k, _)| (k.to_string(), json!(mapped(m, k)))).collect())
}

/// Which columns hold address parts.
pub(super) fn address_map(m: &MailMerge) -> Value {
    json!({
        "firstName": mapped(m, "first"),
        "lastName": mapped(m, "last"),
        "company": mapped(m, "company"),
        "address": mapped(m, "address1"),
        "city": mapped(m, "city"),
        "state": mapped(m, "state"),
        "postal": mapped(m, "postal"),
        "country": mapped(m, "country"),
        "title": mapped(m, "courtesyTitle"),
    })
}

pub(super) fn address_block(m: &MailMerge, row: usize) -> String {
    let g = |k: &str| mapped(m, k).map(|f| m.value(row, &f)).unwrap_or_default();
    let name = [g("courtesyTitle"), g("first"), g("last")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
    let city_line = [g("city"), [g("state"), g("postal")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ")]
        .into_iter()
        .filter(|x| !x.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    [name, g("company"), g("address1"), g("address2"), city_line, g("country")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join("\n")
}

fn greeting(m: &MailMerge, row: usize) -> String {
    let g = |k: &str| mapped(m, k).map(|f| m.value(row, &f)).unwrap_or_default();
    let name = [g("first"), g("last")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
    if name.is_empty() { "Dear Sir or Madam,".into() } else { format!("Dear {name},") }
}

/// What a merge-related field does for the current record.
enum Act {
    /// Show this text.
    Text(String),
    /// NEXT / a true NEXTIF: later fields in this merged document use the next record.
    Next,
    /// A true SKIPIF: drop this merged document and go on with the next record.
    Skip,
}

/// The merge field a rule tests: the name in its first nested field, if that is a MERGEFIELD.
fn rule_field(t: &str) -> Option<String> {
    mergefield_name(t.split_once('{').and_then(|(_, r)| r.split('}').next())?)
}

/// Comparison of a rule condition `{ MERGEFIELD X } op "value" …` (IF, SKIPIF, NEXTIF) for
/// `row`: whether it holds, and the quoted texts after the value (IF's true / false text).
fn condition<'a>(m: &MailMerge, t: &'a str, row: usize) -> (bool, Vec<&'a str>) {
    let field = rule_field(t).unwrap_or_default();
    let rest = t.split_once('}').map(|(_, r)| r).unwrap_or("");
    let op: String = rest.trim_start().chars().take_while(|c| matches!(c, '<'..='>')).collect();
    let mut quoted = rest.split('"').skip(1).step_by(2);
    let cmp = quoted.next().unwrap_or("");
    let v = m.value(row, &field);
    // Numbers compare as numbers (Word: "7" = "7.0"), everything else as text.
    let ord = match (v.trim().parse::<f64>(), cmp.trim().parse::<f64>()) {
        (Ok(a), Ok(b)) => a.partial_cmp(&b),
        _ => Some(v.as_str().cmp(cmp)),
    };
    use std::cmp::Ordering::{Equal, Greater, Less};
    let holds = match op.as_str() {
        "<>" => ord != Some(Equal),
        "<" => ord == Some(Less),
        ">" => ord == Some(Greater),
        "<=" => matches!(ord, Some(Less | Equal)),
        ">=" => matches!(ord, Some(Greater | Equal)),
        _ => ord == Some(Equal),
    };
    (holds, quoted.collect())
}

/// The first word of a field instruction, upper-cased.
fn keyword(instr: &str) -> String {
    instr.split_whitespace().next().unwrap_or("").to_ascii_uppercase()
}

/// Evaluate a merge-related field for a record (None = not a merge field).
fn act(m: &MailMerge, instr: &str, row: usize) -> Option<Act> {
    let t = instr.trim();
    if let Some(n) = mergefield_name(t) {
        return Some(Act::Text(m.value(row, &n)));
    }
    Some(match keyword(t).as_str() {
        "ADDRESSBLOCK" => Act::Text(address_block(m, row)),
        "GREETINGLINE" => Act::Text(greeting(m, row)),
        "MERGEREC" => Act::Text(row.saturating_add(1).to_string()),
        "NEXT" => Act::Next,
        "NEXTIF" if condition(m, t, row).0 => Act::Next,
        "SKIPIF" if condition(m, t, row).0 => Act::Skip,
        "NEXTIF" | "SKIPIF" => Act::Text(String::new()),
        // IF { MERGEFIELD X } = "v" "then" "else" (an IF on other fields isn't ours to touch).
        "IF" if rule_field(t).is_some() => {
            let (holds, texts) = condition(m, t, row);
            Act::Text(texts.get(if holds { 0 } else { 1 }).copied().unwrap_or("").to_string())
        }
        _ => return None,
    })
}

/// What a merge field shows outside Preview Results (None = not a merge field).
pub(super) fn placeholder(instr: &str) -> Option<String> {
    if let Some(n) = mergefield_name(instr) {
        return Some(format!("«{n}»"));
    }
    match keyword(instr).as_str() {
        "ADDRESSBLOCK" => Some("«AddressBlock»".into()),
        "GREETINGLINE" => Some("«GreetingLine»".into()),
        "NEXT" | "NEXTIF" | "SKIPIF" | "MERGEREC" => Some(String::new()),
        "IF" if rule_field(instr).is_some() => Some(String::new()),
        _ => None,
    }
}

/// The stories a merge resolves: the body, then every header and footer.
fn merge_stories(doc: &Document) -> Vec<StoryRef> {
    std::iter::once(StoryRef::Body).chain(header_footer_ids(doc).into_iter().map(StoryRef::Part)).collect()
}

fn header_footer_ids(doc: &Document) -> Vec<u32> {
    doc.parts.iter().filter(|(_, p)| matches!(p.kind, PartKind::Header | PartKind::Footer)).map(|(id, _)| *id).collect()
}

/// Update merge field results: record values when previewing, «Field» placeholders otherwise.
/// NEXT moves later fields of the previewed document to the next record, as Finish & Merge does.
pub fn refresh(s: &mut Session) {
    let (preview, last, record) = {
        let m = mm(s);
        (m.preview && !m.active.is_empty(), m.active.len(), m.record as usize)
    };
    for story in merge_stories(&s.doc) {
        let mut cur = record;
        for path in s.doc.para_paths(story) {
            let m = mm(s);
            let updates: Vec<(usize, String)> = match s.doc.para(story, &path) {
                Some(p) => p
                    .objects
                    .iter()
                    .enumerate()
                    .filter_map(|(k, o)| {
                        let InlineObject::Field { instr, .. } = o else { return None };
                        let shown = placeholder(instr)?;
                        if !preview {
                            return Some((k, shown));
                        }
                        Some((
                            k,
                            match act(m, instr, cur) {
                                Some(Act::Text(t)) => t,
                                Some(Act::Next) => {
                                    cur = cur.saturating_add(1).min(last);
                                    String::new()
                                }
                                Some(Act::Skip) | None => String::new(),
                            },
                        ))
                    })
                    .collect(),
                None => continue,
            };
            if updates.is_empty() {
                continue;
            }
            if let Ok(p) = s.doc.para_mut(story, &path) {
                for (k, r) in updates {
                    if let Some(InlineObject::Field { result, .. }) = p.objects.get_mut(k) {
                        *result = r;
                    }
                }
                p.touch();
            }
        }
    }
    s.touch();
}

/// The records Finish & Merge and Print Documents take (0-based, end exclusive): `records`
/// all or current, or `from` and `to` by record number. A range with none is an error.
pub fn merge_range(s: &Session, v: &Value) -> Result<(usize, usize), CmdError> {
    let n = mm(s).active.len();
    let record = mm(s).record as usize;
    let (from, to) = match p::str(v, "records").map(str::trim) {
        Some("current") => (record.min(n.saturating_sub(1)), record.saturating_add(1).min(n)),
        None | Some("all") => {
            ((p::u64(v, "from").unwrap_or(1).max(1) as usize).saturating_sub(1), (p::u64(v, "to").unwrap_or(n as u64).min(n as u64)) as usize)
        }
        Some(_) => return Err(CmdError::Params("`records` must be all or current".into())),
    };
    if from >= to {
        return Err(CmdError::Failed(format!("no records from {} to {to} (the list has {n})", from.saturating_add(1))));
    }
    Ok((from, to))
}

/// Most merged documents' worth of body blocks Finish & Merge builds.
const MAX_MERGED_BLOCKS: usize = 200_000;

/// Build one merged copy per record: fields become plain text; records separated by page breaks
/// (letters) or new paragraphs (directory). A true SKIPIF drops the record's copy; NEXT moves the
/// rest of a copy to the next record, and the following copy starts after it. Headers and footers
/// are merged too: with merge fields in them, each letter becomes its own section with its own
/// header/footer copies.
pub(super) fn finish(s: &mut Session, v: &Value) -> CmdResult {
    let (out, count) = merged(s, v)?;
    if let Some(path) = p::str(v, "path") {
        crate::io::save_path(std::path::Path::new(path), &out).map_err(CmdError::Failed)?;
        return Ok(json!({"records": count, "path": path}));
    }
    s.add_document(out);
    s.dirty = true;
    Ok(json!({"records": count}))
}

/// The merged document Finish & Merge makes for the records `v` names, and how many copies it holds. It is no main document
/// itself: it keeps no merge.
pub(super) fn merged(s: &Session, v: &Value) -> Result<(Document, usize), CmdError> {
    let (from, to) = merge_range(s, v)?;
    let m = mm(s);
    let directory = m.kind == "directory";
    let hf: Vec<u32> =
        header_footer_ids(&s.doc).into_iter().filter(|id| s.doc.story(StoryRef::Part(*id)).is_some_and(|b| has_merge_fields(b, 0))).collect();
    let per_record = !directory && !hf.is_empty();
    let mut out = s.doc.clone();
    out.settings.mail_merge = None;
    out.body.clear();
    let mut next_id = s.doc.parts.keys().next_back().map_or(1, |k| k.saturating_add(1));
    let mut start = from;
    let mut count = 0usize;
    let mut first_record = None;
    // The section that ends the previous letter (per-record sections only).
    let mut prev_section: Option<SectionProps> = None;
    while start < to {
        let mut body = s.doc.body.clone();
        let record = start;
        let mut cur = start;
        let keep = merge_blocks(m, &mut body, &mut cur, to, 0);
        start = cur.saturating_add(1);
        if !keep {
            continue;
        }
        first_record.get_or_insert(record);
        if per_record {
            // This letter's own header/footer copies, merged with its record.
            let mut map = Vec::new();
            for id in &hf {
                let Some(part) = s.doc.parts.get(id) else { continue };
                if next_id == u32::MAX {
                    return Err(CmdError::Failed("too many headers and footers to merge".into()));
                }
                let mut blocks = part.blocks.clone();
                let mut c = record;
                merge_blocks(m, &mut blocks, &mut c, to, 0);
                out.parts.insert(next_id, Part { kind: part.kind, blocks, body: part.body });
                map.push((*id, next_id));
                next_id += 1;
            }
            let mut first = true;
            for b in &mut body {
                if let Block::Para(p) = std::sync::Arc::make_mut(b)
                    && let Some(sp) = p.section.as_deref_mut()
                {
                    remap_headers(sp, &map, first);
                    first = false;
                }
            }
            let mut last = s.doc.last_section.clone();
            remap_headers(&mut last, &map, first);
            if let Some(prev) = prev_section.replace(last) {
                if !matches!(out.body.last().map(|b| &**b), Some(Block::Para(_))) {
                    out.body.push(para_block(Paragraph::new()));
                }
                if let Some(Block::Para(p)) = out.body.last_mut().map(std::sync::Arc::make_mut) {
                    p.section = Some(Box::new(prev));
                }
            }
        } else if count > 0
            && !directory
            && let Some(Block::Para(p)) = out.body.last_mut().map(std::sync::Arc::make_mut)
        {
            let end = p.len();
            let props = p.props_at(end).clone();
            let _ = p.insert_text(end, "\u{000C}", &props);
        }
        out.body.extend(body);
        count += 1;
        if out.body.len() > MAX_MERGED_BLOCKS {
            break;
        }
    }
    if let Some(last) = prev_section {
        // The template's own header/footer stories are replaced by the letters' copies.
        for id in &hf {
            out.parts.remove(id);
        }
        out.last_section = last;
    } else {
        // One shared header/footer (directory, or no letters): merged with the first record.
        let row = first_record.unwrap_or(from);
        for id in &hf {
            if let Some(part) = out.parts.get_mut(id) {
                let mut c = row;
                merge_blocks(m, &mut part.blocks, &mut c, to, 0);
            }
        }
    }
    out.ensure_nonempty();
    Ok((out, count))
}

/// Point a letter's section at its own header/footer copies; the letter's first section starts
/// on a new page.
fn remap_headers(sp: &mut SectionProps, map: &[(u32, u32)], first: bool) {
    for slot in
        [&mut sp.headers.default, &mut sp.headers.first, &mut sp.headers.even, &mut sp.footers.default, &mut sp.footers.first, &mut sp.footers.even]
    {
        if let Some(id) = slot
            && let Some((_, new)) = map.iter().find(|(old, _)| old == id)
        {
            *id = *new;
        }
    }
    if first {
        sp.start = SectionStart::NextPage;
    }
}

/// Nesting depth of tables the merge descends into.
const MAX_DEPTH: usize = 32;

fn has_merge_fields(blocks: &Blocks, depth: usize) -> bool {
    depth <= MAX_DEPTH
        && blocks.iter().any(|b| match &**b {
            Block::Para(p) => p.objects.iter().any(|o| matches!(o, InlineObject::Field { instr, .. } if placeholder(instr).is_some())),
            _ => b.lists().iter().any(|(_, _, list)| has_merge_fields(list, depth + 1)),
        })
}

/// Replace the merge fields in `blocks` by their text, in document order, starting with record
/// `*cur`. NEXT moves `*cur` on (records from `end` on are blank). Returns false when a SKIPIF
/// drops this merged document.
fn merge_blocks(m: &MailMerge, blocks: &mut Blocks, cur: &mut usize, end: usize, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return true;
    }
    for b in blocks.iter_mut() {
        match std::sync::Arc::make_mut(b) {
            Block::Para(p) => {
                let mut repl = Vec::new();
                for off in p.object_offsets() {
                    let Some(InlineObject::Field { instr, .. }) = p.object_at(off) else { continue };
                    let row = if *cur < end { *cur } else { m.active.len() };
                    match act(m, instr, row) {
                        Some(Act::Text(t)) => repl.push((off, t)),
                        Some(Act::Next) => {
                            *cur = cur.saturating_add(1).min(end);
                            repl.push((off, String::new()));
                        }
                        Some(Act::Skip) => return false,
                        None => {}
                    }
                }
                for (off, val) in repl.into_iter().rev() {
                    let props = p.props_of_char(off).clone();
                    let _ = p.delete(off, off + ew_doc::para::OBJ.len_utf8());
                    let _ = p.insert_text(off, &val, &props);
                }
            }
            // A table's cells or a container's regions.
            blk => {
                for list in blk.lists_mut() {
                    if !merge_blocks(m, list, cur, end, depth + 1) {
                        return false;
                    }
                }
            }
        }
    }
    true
}
