# DrawingML preset shape definitions

`presetShapeDefinitions.xml`: the 187 preset shapes of ECMA-376 Part 1 (Office Open XML, DrawingML), each with its adjust values
(avLst), guides (gdLst), adjust handles (ahLst), connection sites (cxnSiteLst), text rectangle (rect) and paths (pathLst).

Copied unchanged on 2026-10-30 from Apache POI (trunk, poi/src/main/resources/org/apache/poi/sl/draw/geom/presetShapeDefinitions.xml),
under the Apache License 2.0 (`LICENSE`, with POI's `NOTICE`). The shared shape library reads it as data
(docs/plans/word/briefs/shape-pool.md).

`scripts/build-presets.mjs` turns it into `src/flow/preset-data.mjs`, which `src/flow/presets.mjs` evaluates; run it again only when this
file changes. The data takes `50000` for the `maxY="ssd2"` of `star24`'s and `star32`'s handles, as their guides pin that value.
