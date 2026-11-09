// The open fonts the app ships or downloads (docs/plans/word/briefs/font-provider.md): where each comes from, its licence and
// version, and the Word fonts it matches. The engine's open font source (sources.mjs) and the DOM editor's font provider
// (src/document/fonts/provider.mjs, which re-exports these) share it. Plain data, no imports.

const OFL = 'SIL Open Font License 1.1';
const APACHE = 'Apache License 2.0';
// google/fonts at a fixed commit, so a download is always the file this catalogue describes.
const GF = 'https://raw.githubusercontent.com/google/fonts/3be1884c48c3e45b52ecc725676a08f87776373e/ofl/';

/** The bundled fonts' folder from the app's root (index.html). package.json ships src/** in the app, and a web build serves the
 * same tree, so no build step copies them. */
export const BUNDLED = 'src/vendor/fonts/';

const four = (dir, stem) => [['400', 'normal', 'Regular'], ['700', 'normal', 'Bold'], ['400', 'italic', 'Italic'], ['700', 'italic', 'BoldItalic']]
  .map(([weight, style, name]) => ({ weight, style, file: `${dir}/${stem}-${name}.ttf` }));

const LIBERATION = { kind: 'bundled', licence: OFL, licenceFile: 'liberation/LICENSE', version: '2.1.5',
  copyright: 'Digitized data copyright (c) 2010 Google Corporation; copyright (c) 2012 Red Hat, Inc.',
  source: 'https://github.com/liberationfonts/liberation-fonts' };

/** The open fonts, each unmodified from its official source. kind 'bundled' ships in src/vendor/fonts; 'download' is fetched on first
 * need (fetchFamily), as a 12 to 17 MB CJK family would double the app. matches: the Word fonts whose metrics it matches. */
export const CATALOGUE = [
  { family: 'Carlito', kind: 'bundled', matches: ['Calibri'], faces: four('carlito', 'Carlito'), licence: OFL, licenceFile: 'carlito/OFL.txt',
    version: '1.104', copyright: 'Copyright 2013 The Carlito Project Authors', source: 'https://github.com/googlefonts/carlito' },
  // The original Chrome OS release, Apache 2.0. Google Fonts' later OFL Caladea (1.001) has other advance widths: 236 of 332
  // characters differ from Cambria's, against none here.
  { family: 'Caladea', kind: 'bundled', matches: ['Cambria'], faces: four('caladea', 'Caladea'), licence: APACHE, licenceFile: 'caladea/LICENSE',
    version: '1.002', copyright: 'Copyright (c) 2012 Huerta Tipografia',
    source: 'https://commondatastorage.googleapis.com/chromeos-localmirror/distfiles/crosextrafonts-20130214.tar.gz' },
  { family: 'Liberation Sans', matches: ['Arial'], faces: four('liberation', 'LiberationSans'), ...LIBERATION },
  { family: 'Liberation Serif', matches: ['Times New Roman'], faces: four('liberation', 'LiberationSerif'), ...LIBERATION },
  { family: 'Liberation Mono', matches: ['Courier New'], faces: four('liberation', 'LiberationMono'), ...LIBERATION },
  // Regular and Bold match Segoe UI's; Selawik has no italic, so an italic run draws slanted Regular, wider than Segoe UI Italic.
  { family: 'Selawik', kind: 'bundled', matches: ['Segoe UI'], faces: [{ weight: '400', style: 'normal', file: 'selawik/selawk.ttf' },
    { weight: '700', style: 'normal', file: 'selawik/selawkb.ttf' }], licence: OFL, licenceFile: 'selawik/LICENSE.txt', version: '1.01',
  copyright: 'Copyright 2015 Microsoft Corporation, with Reserved Font Name Selawik', source: 'https://github.com/microsoft/Selawik' },
  // Traditional Chinese for a document that names Microsoft's CJK fonts on a computer without them (a Mac, the web app). Their Han
  // characters are a full em as in Microsoft's, but Latin text and line heights differ: they stand in, they do not match.
  { family: 'Noto Sans TC', kind: 'download', matches: [], faces: [{ weight: '100 900', style: 'normal', url: `${GF}notosanstc/NotoSansTC%5Bwght%5D.ttf`, bytes: 11941968 }],
    licence: OFL, licenceUrl: `${GF}notosanstc/OFL.txt`, version: '2.004', copyright: 'Copyright 2014-2021 Adobe, with Reserved Font Name Source',
    source: 'https://github.com/notofonts/noto-cjk' },
  { family: 'Noto Serif TC', kind: 'download', matches: [], faces: [{ weight: '200 900', style: 'normal', url: `${GF}notoseriftc/NotoSerifTC%5Bwght%5D.ttf`, bytes: 16851596 }],
    licence: OFL, licenceUrl: `${GF}notoseriftc/OFL.txt`, version: '2.003', copyright: 'Copyright 2017-2024 Adobe',
    source: 'https://github.com/notofonts/noto-cjk' },
];
