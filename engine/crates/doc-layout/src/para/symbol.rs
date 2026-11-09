//! EasyWriter: Word's SYMBOL field (ECMA-376 Part 1 §17.16.5.68): one character, in the font of `\f` (else the field's) at
//! the size of `\s` (else the field's). The code from WordCraft drew nothing for one without a saved result, which is how Word saves them.
//! The Word fixture's SYMBOL lines (docs/plans/engine/fidelity.md): `\s 1638` draws a 1638 pt character on a line of its own,
//! `\h` leaves the line as tall as its text, and a character code under 256 is the ANSI (Windows-1252) character.

/// What a SYMBOL field draws.
pub(super) struct Symbol {
    pub(super) text: String,
    pub(super) font: Option<String>,
    pub(super) size: Option<f32>,
    /// `\h`: the character does not make the line taller.
    pub(super) flat: bool,
}

/// The character of a SYMBOL field code; `None` for any other field, and for a code Word shows nothing for.
pub(super) fn symbol(instr: &str) -> Option<Symbol> {
    let (args, sw) = super::barcode::field_args(instr, "SYMBOL", "fs")?;
    let get = |c: char| sw.iter().find(|(l, _)| *l == c).map(|(_, v)| v.as_str());
    let code = args.first()?.trim();
    let n = match code.get(..2) {
        Some("0x" | "0X") => u32::from_str_radix(code.get(2..)?, 16).ok()?,
        _ => code.parse::<u32>().ok()?,
    };
    let ch = if get('j').is_some() {
        shift_jis(n)?
    } else if n < 256 && get('u').is_none() {
        ew_doc::encoding::cp1252(n as u8)
    } else {
        char::from_u32(n)?
    };
    Some(Symbol {
        text: ch.to_string(),
        font: get('f').map(str::trim).filter(|f| !f.is_empty()).map(str::to_string),
        size: get('s').and_then(|v| v.trim().parse::<f32>().ok()).filter(|v| v.is_finite()).map(|v| v.clamp(1.0, 1638.0)),
        flat: get('h').is_some(),
    })
}

/// EasyWriter: the character of a Shift-JIS code (SYMBOL `\j`: Word draws あ for the fixture's 0x82A0, Word page 92). A one-byte
/// code is ASCII or a half-width katakana; a two-byte one goes through the WHATWG Shift_JIS table (JIS X 0208 with Microsoft's
/// extensions, as Windows' code page 932), kanji included (engine-fidelity-4). A code with no character draws nothing.
fn shift_jis(n: u32) -> Option<char> {
    let bytes: Vec<u8> = if n <= 0xFF { vec![n as u8] } else { vec![(n >> 8) as u8, n as u8] };
    if n > 0xFFFF {
        return None;
    }
    let (text, _, bad) = encoding_rs::SHIFT_JIS.decode(&bytes);
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if !bad && !c.is_control() => Some(c),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::symbol;

    #[test]
    fn symbol_fields_take_their_character_font_and_size() {
        let s = symbol(" SYMBOL 74 \\f Wingdings \\s 1638 ").unwrap();
        assert_eq!((s.text.as_str(), s.font.as_deref(), s.size, s.flat), ("J", Some("Wingdings"), Some(1638.0), false));
        assert_eq!(symbol(" SYMBOL 169 ").unwrap().text, "©");
        assert_eq!(symbol(" SYMBOL 0x2713 \\u ").unwrap().text, "✓");
        assert_eq!(symbol(" SYMBOL 0x80 ").unwrap().text, "€", "ANSI, not Latin-1");
        let h = symbol(" SYMBOL 65 \\f \"Symbol\" \\h \\s 30 ").unwrap();
        assert_eq!((h.font.as_deref(), h.size, h.flat), (Some("Symbol"), Some(30.0), true));
        assert_eq!(symbol(" SYMBOL 0x82A0 \\j ").unwrap().text, "あ");
        assert_eq!(symbol(" SYMBOL 0x8394 \\j ").unwrap().text, "ヴ");
        assert_eq!(symbol(" SYMBOL 0x889F \\j ").unwrap().text, "亜", "kanji, engine-fidelity-4");
        assert_eq!(symbol(" SYMBOL 0x93FA \\j ").unwrap().text, "日");
        assert!(symbol(" SYMBOL 0x81 \\j ").is_none(), "a lead byte alone");
        assert!(symbol(" PAGE ").is_none());
    }
}
