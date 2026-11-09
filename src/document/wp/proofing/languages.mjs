// Proofing languages (docs/plans/word briefs/proofing.md): the BCP 47 tags the Language dialog offers, their names as Word writes
// them ("English (United States)", from Intl.DisplayNames), and which tags a spell checker dictionary serves. Pure.

export const TAGS = [
  'af-ZA', 'sq-AL', 'am-ET', 'ar-SA', 'ar-EG', 'hy-AM', 'az-Latn-AZ', 'eu-ES', 'be-BY', 'bn-IN', 'bs-Latn-BA', 'bg-BG', 'ca-ES', 'zh-CN', 'zh-HK',
  'zh-TW', 'zh-SG', 'hr-HR', 'cs-CZ', 'da-DK', 'nl-NL', 'nl-BE', 'en-AU', 'en-CA', 'en-HK', 'en-IN', 'en-IE', 'en-NZ', 'en-SG', 'en-ZA',
  'en-GB', 'en-US', 'et-EE', 'fo-FO', 'fil-PH', 'fi-FI', 'fr-BE', 'fr-CA', 'fr-FR', 'fr-CH', 'gl-ES', 'ka-GE', 'de-AT', 'de-DE', 'de-CH',
  'el-GR', 'gu-IN', 'he-IL', 'hi-IN', 'hu-HU', 'is-IS', 'id-ID', 'ga-IE', 'it-IT', 'it-CH', 'ja-JP', 'kn-IN', 'kk-KZ', 'km-KH', 'ko-KR',
  'lo-LA', 'lv-LV', 'lt-LT', 'mk-MK', 'ms-MY', 'ml-IN', 'mt-MT', 'mr-IN', 'mn-MN', 'ne-NP', 'nb-NO', 'nn-NO', 'fa-IR', 'pl-PL', 'pt-BR',
  'pt-PT', 'pa-IN', 'ro-RO', 'ru-RU', 'sr-Cyrl-RS', 'sr-Latn-RS', 'si-LK', 'sk-SK', 'sl-SI', 'es-AR', 'es-MX', 'es-ES', 'es-US', 'sw-KE',
  'sv-SE', 'sv-FI', 'ta-IN', 'te-IN', 'th-TH', 'tr-TR', 'uk-UA', 'ur-PK', 'uz-Latn-UZ', 'vi-VN', 'cy-GB', 'yo-NG', 'zu-ZA',
];

let names = null;
/** The display name of tag `tag` in English, Word's way: "English (United States)"; the tag itself when unknown. */
export function langName(tag) {
  if (!tag) return '';
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' });
    return names.of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** Whether a dictionary of `dicts` (tags such as 'en-US' or 'en') serves tag `tag`: the same tag, or the same primary language. */
export function served(tag, dicts) {
  if (!tag || !dicts) return true;
  const t = String(tag).toLowerCase();
  const base = t.split('-')[0];
  return dicts.some((d) => {
    const x = String(d).toLowerCase();
    return x === t || x.split('-')[0] === base;
  });
}

/** The Language dialog's list for dictionary tags `dicts` → [[tag, name, hasDictionary]]: the tags a dictionary serves first, then
 * the rest, each part by name. `extra` tags (the selection's, the document's) join the list when missing. */
export function languageList(dicts = [], extra = []) {
  const all = [...new Set([...TAGS, ...dicts, ...extra.filter(Boolean)])];
  const rows = all.map((tag) => [tag, langName(tag), (dicts ?? []).some((d) => String(d).toLowerCase() === tag.toLowerCase())]);
  const by = (a, b) => a[1].localeCompare(b[1]);
  return [...rows.filter((r) => r[2]).sort(by), ...rows.filter((r) => !r[2]).sort(by)];
}

/** Whether tag `tag` is an East Asian language (Chinese, Japanese, Korean), for Word Count's Asian rows. */
export const isEastAsian = (tag) => /^(zh|ja|ko)\b/i.test(String(tag ?? ''));
