# Open fonts that stand in for Word's

EasyWriter draws a font a document names with the installed font when there is one. Where a computer lacks it, one of these open
fonts draws it instead, so lines and pages break as they do in Word (`src/document/fonts/provider.mjs`, which lists them with the
same details). Each file is unmodified from its official source, and each folder holds its licence. No Microsoft font is included:
Aptos is free from Microsoft (Download Center 106087) but may not be redistributed, so the app opens Microsoft's page for the user.

| Font | Stands in for | Version | Licence | Source |
|---|---|---|---|---|
| Carlito | Calibri | 1.104 | SIL OFL 1.1 (`carlito/OFL.txt`) | https://github.com/googlefonts/carlito, as published in https://github.com/google/fonts/tree/main/ofl/carlito |
| Caladea | Cambria | 1.002 | Apache License 2.0 (`caladea/LICENSE`) | Google's Chrome OS release, https://commondatastorage.googleapis.com/chromeos-localmirror/distfiles/crosextrafonts-20130214.tar.gz |
| Liberation Sans, Serif, Mono | Arial, Times New Roman, Courier New | 2.1.5 | SIL OFL 1.1 (`liberation/LICENSE`) | https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5 (liberation-fonts-ttf-2.1.5.tar.gz) |
| Selawik (Regular, Bold) | Segoe UI | 1.01 | SIL OFL 1.1 (`selawik/LICENSE.txt`) | https://github.com/microsoft/Selawik/releases/tag/1.01 (Selawik_Release.zip) |

Copyright notices, as the fonts carry them: Carlito, Copyright 2013 The Carlito Project Authors, with Reserved Font Name "Carlito".
Caladea, Copyright (c) 2012 Huerta Tipografia. Liberation, Digitized data copyright (c) 2010 Google Corporation, with Reserved Font
Arimo, Tinos and Cousine; Copyright (c) 2012 Red Hat, Inc., with Reserved Font Name Liberation. Selawik, Copyright 2015 Microsoft
Corporation, with Reserved Font Name Selawik.

Caladea is the 2013 Apache 2.0 release on purpose: the later OFL Caladea in Google Fonts (1.001) has other advance widths (236 of
332 characters differ from Cambria's), while this one matches Cambria's.

How the matches were checked (2026-10-30, against the fonts installed on Windows 11 with Office): the advance width of every character
both fonts have in Basic Latin, Latin-1, Latin Extended-A, General Punctuation, Greek and Cyrillic, and the single line Word takes
(`src/document/fonts/metrics.mjs`). Carlito, Liberation Sans and Liberation Mono match in all four styles; Liberation Serif differs only
on the five bidirectional control characters; Caladea's single line is 1.1720 em against Cambria's 1.1724; Selawik Regular and Bold
match Segoe UI's, its Light, Semilight and Semibold do not, and it has no italic, so only Regular and Bold are included.

Not included: Gelasio (Georgia) has Georgia's widths but a single line of 1.2695 em against Georgia's 1.1362, so its pages would run
longer. Akasia (Aptos) was announced at codeberg.org/bloudraad/akasia, which no longer exists (2026-10-30). Large CJK families (Noto
Sans TC and Noto Serif TC, SIL OFL 1.1) are downloaded from github.com/google/fonts when a document first needs them, into the app's
Cache Storage.

The files keep their original names and format (TrueType), as the OFL FAQ advises for a font shipped inside an application.
