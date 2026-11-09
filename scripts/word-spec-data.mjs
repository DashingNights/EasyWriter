// Hand data for the ribbon spec generator (docs/plans/word/plan.md §1.4): what the probe could not read or what EasyWriter
// decides on top of it. scripts/word-spec.mjs reads it with the probe, index.json and plan.json and writes
// src/document/ribbon/spec.mjs; change this file and run `node scripts/word-spec.mjs`, never the spec.

// Probe menus whose list items index.json lists as features (probe/scripts/merge-index.js EXPAND, copied so the item ids
// count duplicates exactly as the index does).
export const MERGE_EXPAND = ['home.change-case', 'home.line-and-paragraph-spacing', 'layout.breaks', 'layout.columns', 'layout.margins',
  'layout.orientation', 'layout.rotate', 'layout.wrap-text', 'layout.text-direction', 'references.add-text', 'review.display-for-review',
  'frame.editing', 'insert.drop-cap', 'design.paragraph-spacing', 'references.table-of-contents', 'references.bibliography',
  'draw.format-background', 'review.show-comments'];

// Controls whose fixed list items users search by name (§1.4 Derived items): each list item becomes a derived item
// `<control>.<camelCase label>` that runs the control's command with the last id segment as its arg.
export const DERIVED_LISTS = ['home.paragraph.borders', 'home.font.underline', 'layout.arrange.position', 'pictureFormat.adjust.transparency'];

// Tabs in Word's order: the main tabs, then the contextual ones (index.json ids).
export const TAB_ORDER = ['home', 'insert', 'draw', 'design', 'layout', 'references', 'mailings', 'review', 'view', 'developer', 'help',
  'tableDesign', 'tableLayout', 'pictureFormat', 'graphicsFormat', 'shapeFormat', 'textBox', 'smartArtDesign', 'smartArtFormat',
  'chartDesign', 'chartFormat', 'model3d', 'headerFooter', 'equation', 'outlining', 'immersiveReader'];

// Contextual tabs (§1.4 Contexts): tab → CONTEXTS key.
export const CONTEXT_OF = {
  tableDesign: 'table', tableLayout: 'table', pictureFormat: 'picture', graphicsFormat: 'graphics', shapeFormat: 'shape',
  textBox: 'textboxCompat', smartArtDesign: 'smartart', smartArtFormat: 'smartart', chartDesign: 'chart', chartFormat: 'chart',
  model3d: 'model3d', headerFooter: 'header', equation: 'equation', outlining: 'outline', immersiveReader: 'immersive',
};
export const CONTEXTS = {
  table: { label: 'Table' }, picture: { label: 'Picture' }, graphics: { label: 'Graphics' }, shape: { label: 'Shape' },
  textboxCompat: { label: 'Text Box' }, smartart: { label: 'Diagram' }, chart: { label: 'Chart' }, model3d: { label: '3D Model' },
  header: { label: 'Header & Footer' }, equation: { label: 'Equation' }, outline: { label: 'Outlining' }, immersive: { label: 'Reader' },
};
// Outlining shows left of Home while its context holds.
export const FIRST_TABS = ['outlining'];

// Tabs with no probe file, built from index.json `where` paths. keytip: Word's, where known (Developer is Alt, L); the
// others are unverified and left out.
export const WHERE_TABS = {
  developer: { label: 'Developer', keytip: 'L', hidden: true },
  graphicsFormat: { label: 'Graphics Format' },
  chartDesign: { label: 'Chart Design' },
  chartFormat: { label: 'Format' },
  model3d: { label: '3D Model' },
  immersiveReader: { label: 'Immersive Reader' },
};
// Word's tab label in probe/keytips.tsv for the tabs that gain where-built controls.
export const KEYTIP_TABS = { shapeFormat: 'Shape Format' };

// Group order where where-built groups join a probed tab (the modern Shape Format; the compatibility-mode groups the probe
// saw go last, as placeholders).
export const GROUP_ORDER = {
  shapeFormat: ['insertShapes', 'shapeStyles', 'wordArtStyles', 'text', 'accessibility', 'arrange', 'size', 'shadowEffects', '3DEffects'],
};

// Layout overrides: group id → Column[] (§1.4), where the probe's columns do not give Word's arrangement.
export const LAYOUTS = {
  'outlining.outlineTools': [
    { rows: [[['outlining.outlineTools.promoteToHeading1', 'outlining.outlineTools.promote'], 'outlining.outlineTools.outlineLevel',
      ['outlining.outlineTools.demote', 'outlining.outlineTools.demoteToBodyText']],
    [['outlining.outlineTools.moveUp', 'outlining.outlineTools.moveDown'], ['outlining.outlineTools.expand', 'outlining.outlineTools.collapse']]] },
    { rows: [['outlining.outlineTools.showLevel'], ['outlining.outlineTools.showTextFormatting'], ['outlining.outlineTools.showFirstLineOnly']] },
  ],
  'mailings.previewResults': [
    { large: 'mailings.previewResults.previewResults' },
    { rows: [[['mailings.previewResults.first', 'mailings.previewResults.previous'], 'mailings.previewResults.record',
      ['mailings.previewResults.next', 'mailings.previewResults.last']], ['mailings.previewResults.findRecipient'], ['mailings.previewResults.checkForErrors']] },
  ],
  'shapeFormat.shapeStyles': [
    { gallery: 'shapeFormat.shapeStyles.shapeStyles' },
    { rows: [['shapeFormat.shapeStyles.shapeFill'], ['shapeFormat.shapeStyles.shapeOutline'], ['shapeFormat.shapeStyles.shapeEffects']] },
    { rows: [['shapeFormat.shapeStyles.changeShape']] },
  ],
  'shapeFormat.wordArtStyles': [
    { gallery: 'shapeFormat.wordArtStyles.quickStyles' },
    { rows: [['shapeFormat.wordArtStyles.textFill'], ['shapeFormat.wordArtStyles.textOutline'], ['shapeFormat.wordArtStyles.textEffects']] },
  ],
  'shapeFormat.text': [{ rows: [['shapeFormat.text.textDirection'], ['shapeFormat.text.alignText'], ['shapeFormat.text.createLink']] }],
  'graphicsFormat.graphicsStyles': [
    { gallery: 'graphicsFormat.graphicsStyles.styles' },
    { rows: [['graphicsFormat.graphicsStyles.graphicsFill'], ['graphicsFormat.graphicsStyles.graphicsOutline'], ['graphicsFormat.graphicsStyles.graphicsEffects']] },
  ],
  'chartDesign.chart': [
    { large: 'chartDesign.chart.addChartElement' }, { large: 'chartDesign.chart.quickLayout' }, { large: 'chartDesign.chart.changeColors' },
    { gallery: 'chartDesign.chart.chartStyles' }, { large: 'chartDesign.chart.switchRowColumn' }, { large: 'chartDesign.chart.selectData' },
    { large: 'chartDesign.chart.editData' }, { large: 'chartDesign.chart.refreshData' }, { large: 'chartDesign.chart.changeChartType' },
  ],
  'chartFormat.chart': [{ rows: [['chartFormat.chart.currentSelection']] }, { gallery: 'chartFormat.chart.shapeStyles' }, { gallery: 'chartFormat.chart.wordArtStyles' }],
  'model3d.model': [{ gallery: 'model3d.model.modelViews' }, { large: 'model3d.model.panZoom' }, { large: 'model3d.model.resetModel' }],
  'developer.controls': [
    { rows: [[['developer.controls.richTextContentControl', 'developer.controls.plainTextContentControl', 'developer.controls.pictureContentControl',
      'developer.controls.buildingBlockGalleryContentControl', 'developer.controls.checkBoxContentControl']],
    [['developer.controls.comboBoxContentControl', 'developer.controls.dropDownListContentControl', 'developer.controls.datePickerContentControl',
      'developer.controls.repeatingSectionContentControl', 'developer.controls.legacyTools']]] },
    { rows: [['developer.controls.designMode'], ['developer.controls.properties'], ['developer.controls.group']] },
  ],
};
// Sizes of where-built controls that are not large buttons (the layouts above place them).
export const SIZES = {
  'shapeFormat.shapeStyles.shapeEffects': 'medium', 'shapeFormat.wordArtStyles.textFill': 'medium', 'shapeFormat.wordArtStyles.textOutline': 'medium',
  'shapeFormat.wordArtStyles.textEffects': 'medium', 'shapeFormat.text.textDirection': 'medium', 'shapeFormat.text.alignText': 'medium',
  'shapeFormat.text.createLink': 'medium', 'graphicsFormat.graphicsStyles.graphicsFill': 'medium', 'graphicsFormat.graphicsStyles.graphicsOutline': 'medium',
  'graphicsFormat.graphicsStyles.graphicsEffects': 'medium', 'chartFormat.chart.currentSelection': 'medium',
  'developer.controls.richTextContentControl': 'small', 'developer.controls.plainTextContentControl': 'small', 'developer.controls.pictureContentControl': 'small',
  'developer.controls.buildingBlockGalleryContentControl': 'small', 'developer.controls.checkBoxContentControl': 'small',
  'developer.controls.comboBoxContentControl': 'small', 'developer.controls.dropDownListContentControl': 'small',
  'developer.controls.datePickerContentControl': 'small', 'developer.controls.repeatingSectionContentControl': 'small',
  'developer.controls.legacyTools': 'small', 'developer.controls.designMode': 'medium', 'developer.controls.properties': 'medium',
  'developer.controls.group': 'medium',
};
// Small headings Word draws above a column that are no control: the column's first control id → caption.
export const CAPTIONS = { 'layout.paragraph.indentLeft': 'Indent', 'layout.paragraph.spacingBefore': 'Spacing' };
// In-ribbon gallery sizes (items shown before the More button), read off probe/img.
export const GRIDS = {
  'home.styles.styles': { rows: 1, cols: 7 }, 'design.documentFormatting.documentFormatting': { rows: 1, cols: 12 },
  'draw.drawingTools.drawingTools': { rows: 1, cols: 10 }, 'tableDesign.tableStyles.tableStyles': { rows: 1, cols: 7 },
  'pictureFormat.pictureStyles.pictureStyles': { rows: 1, cols: 7 }, 'shapeFormat.insertShapes.insertShapes': { rows: 3, cols: 7 },
  'shapeFormat.shapeStyles.shapeStyles': { rows: 1, cols: 7 }, 'shapeFormat.wordArtStyles.quickStyles': { rows: 1, cols: 3 },
  'textBox.textBoxStyles.textBoxStyles': { rows: 1, cols: 7 }, 'smartArtDesign.layouts.layouts': { rows: 1, cols: 6 },
  'smartArtDesign.smartArtStyles.smartArtStyles': { rows: 1, cols: 8 }, 'smartArtFormat.shapeStyles.shapeStyles': { rows: 1, cols: 7 },
  'smartArtFormat.wordArtStyles.wordArtStyles': { rows: 1, cols: 3 }, 'equation.symbols.symbols': { rows: 3, cols: 24 },
  'graphicsFormat.graphicsStyles.styles': { rows: 1, cols: 7 }, 'chartDesign.chart.chartStyles': { rows: 1, cols: 7 },
  'chartFormat.chart.shapeStyles': { rows: 1, cols: 7 }, 'chartFormat.chart.wordArtStyles': { rows: 1, cols: 3 },
  'model3d.model.modelViews': { rows: 1, cols: 5 },
};
// Spinner units: points for spacing, the document's length unit for sizes and indents.
export const UNITS = { 'layout.paragraph.spacingBefore': 'pt', 'layout.paragraph.spacingAfter': 'pt' };
// Where-built KeyTips probe/keytips.tsv cannot match by label.
export const KEYTIPS = { 'shapeFormat.wordArtStyles.quickStyles': 'Q' };

// `same` overrides: a whole group that points at one control gets a dropdown of the group's controls instead.
export const SAME = { 'graphicsFormat.arrangeSize.arrange': null };
export const TYPES = { 'graphicsFormat.arrangeSize.arrange': 'dropdown', 'insert.text.object': 'dropdown', 'pictureFormat.adjust.removeBackground': 'button' };
// Controls that open another control's menu (§1.4: Graphics Format > Crop takes Picture Format's crop menu).
export const MENU_OF = { 'graphicsFormat.arrangeSize.crop': 'pictureFormat.size.crop' };

// Add Chart Element, Word's submenus (no probe holds the Chart tabs; labels are Word 365's). The five without a submenu here are drawn
// off by their rows until the chart reader draws them.
const ACE = 'chartDesign.chart.addChartElement';
const ACE_SUBS = [
  ['axes', 'Axes', [['primaryHorizontal', 'Primary Horizontal'], ['primaryVertical', 'Primary Vertical']]],
  ['axisTitles', 'Axis Titles', [['primaryHorizontal', 'Primary Horizontal'], ['primaryVertical', 'Primary Vertical'], ['moreAxisTitleOptions', 'More Axis Title Options', 'chartTitleText']]],
  ['chartTitle', 'Chart Title', [['none', 'None'], ['aboveChart', 'Above Chart'], ['centeredOverlay', 'Centered Overlay'], ['moreTitleOptions', 'More Title Options', 'chartTitleText']]],
  ['dataLabels', 'Data Labels', [['none', 'None'], ['center', 'Center'], ['insideEnd', 'Inside End'], ['insideBase', 'Inside Base'], ['outsideEnd', 'Outside End']]],
  ['gridlines', 'Gridlines', [['primaryMajorHorizontal', 'Primary Major Horizontal'], ['primaryMajorVertical', 'Primary Major Vertical']]],
  ['legend', 'Legend', [['none', 'None'], ['right', 'Right'], ['top', 'Top'], ['left', 'Left'], ['bottom', 'Bottom'], ['rightOverlay', 'Right Overlay'], ['leftOverlay', 'Left Overlay']]],
];
const ACE_PLAIN = [['dataTable', 'Data Table'], ['errorBars', 'Error Bars'], ['lines', 'Lines'], ['trendline', 'Trendline'], ['upDownBars', 'Up/Down Bars']];
const ACE_ORDER = ['axes', 'axisTitles', 'chartTitle', 'dataLabels', 'dataTable', 'errorBars', 'gridlines', 'legend', 'lines', 'trendline', 'upDownBars'];

// Menus written by hand, replacing the generated one of the same key (§1.4 Menus the probe could not read).
const ARRANGE = [['position', 'Position', 'layout.arrange.position'], ['wrapText', 'Wrap Text', 'layout.arrange.wrapText'],
  ['bringForward', 'Bring Forward', 'layout.arrange.bringForward'], ['sendBackward', 'Send Backward', 'layout.arrange.sendBackward'],
  ['selectionPane', 'Selection Pane', null], ['align', 'Align', 'layout.arrange.align'], ['group', 'Group', 'layout.arrange.group'],
  ['rotate', 'Rotate', 'layout.arrange.rotate']];
const CHANGE_LIST_LEVEL = [{ gallery: 'lists.changeListLevel' }];
export const HAND_MENUS = {
  'graphicsFormat.arrangeSize.arrange': ARRANGE.map(([k, , menu]) => (menu ? { sub: menu, item: `graphicsFormat.arrangeSize.arrange.${k}` }
    : { item: `graphicsFormat.arrangeSize.arrange.${k}` })),
  'home.paragraph.bullets.changeListLevel': CHANGE_LIST_LEVEL,
  'home.paragraph.numbering.changeListLevel': CHANGE_LIST_LEVEL,
  'home.paragraph.multilevelList.changeListLevel': CHANGE_LIST_LEVEL,
  'home.font.textHighlightColor': [{ panel: 'highlight' }, { sep: true }, { item: 'home.font.textHighlightColor.stopHighlighting' }],
  // Cell shading stores a hex string: the shading panel, not the font colour's {color, themeColor}.
  'tableDesign.tableStyles.shading': [{ panel: 'shading' }, { sep: true }, { item: 'tableDesign.tableStyles.shading.moreColors' }],
  // Word draws the recently used symbols as a grid of 5 by 4.
  'insert.symbols.symbol': [{ gallery: 'insert.symbols.symbol', view: 'grid', cols: 5 }, { sep: true }, { item: 'insert.symbols.symbol.moreSymbols' }],
  // The probe saw only All Reviewers (one author); Word adds one check item per reviewer below it (markup's gallery).
  'review.markup.showMarkup.specificPeople': [{ item: 'review.markup.showMarkup.specificPeople.allReviewers' }, { gallery: 'review.markup.showMarkup.specificPeople' }],
  'frame.qat.undo': [{ panel: 'frame.qat.undo' }],
  'frame.qat.customize': [{ panel: 'frame.qat.customize' }],
  [ACE]: ACE_ORDER.map((k) => (ACE_SUBS.some(([s]) => s === k) ? { sub: `${ACE}.${k}`, item: `${ACE}.${k}` } : { item: `${ACE}.${k}` })),
  ...Object.fromEntries(ACE_SUBS.map(([k, , leaves]) => [`${ACE}.${k}`, leaves.map(([leaf]) => ({ item: `${ACE}.${k}.${leaf}` }))])),
};
// Galleries of pictures drawn as a grid, not one long column (the user, 2026-10-28: "long list = bad"); `cols` per row.
const STRUCTURES = Object.fromEntries(['fraction', 'script', 'radical', 'integral', 'largeOperator', 'bracket', 'function', 'accent',
  'limitAndLog', 'operator', 'matrix'].map((k) => [`equation.structures.${k}`, { view: 'grid', cols: 4 }]));
const EFFECTS = Object.fromEntries(['preset', 'shadow', 'reflection', 'glow', 'softEdges', 'bevel', '3DRotation']
  .map((k) => [`pictureFormat.pictureStyles.pictureEffects.${k}`, { view: 'grid', cols: 4 }]));
export const GALLERY_VIEWS = {
  'home.paragraph.bullets': { view: 'grid', cols: 4 },
  'home.paragraph.numbering': { view: 'grid', cols: 4 },
  'home.paragraph.multilevelList': { view: 'grid', cols: 3 },
  'home.styles.styles': { view: 'grid', cols: 3 },
  'home.font.textEffectsAndTypography.stylisticSets': { view: 'grid', cols: 5 },
  'insert.text.quickParts.documentProperty': { view: 'grid', cols: 2 },
  'headerFooter.insert.documentInfo.documentProperty': { view: 'grid', cols: 2 },
  'design.documentFormatting.themes': { view: 'grid', cols: 2 },
  'design.documentFormatting.documentFormatting': { view: 'grid', cols: 4 },
  'design.documentFormatting.fonts': { view: 'grid', cols: 2 },
  'design.pageBackground.watermark': { view: 'grid', cols: 2 },
  'tableDesign.borders.borderStyles': { view: 'grid', cols: 3 },
  'tableDesign.borders.penStyle': { view: 'grid', cols: 3 },
  'pictureFormat.pictureStyles.pictureStyles': { view: 'grid', cols: 7 },
  'layout.arrange.position': { view: 'grid', cols: 3 },
  'graphicsFormat.graphicsStyles.styles': { view: 'grid', cols: 6 },
  'graphicsFormat.graphicsStyles.graphicsFill': { view: 'grid', cols: 10 },
  'graphicsFormat.graphicsStyles.graphicsOutline': { view: 'grid', cols: 5 },
  'pictureFormat.pictureStyles.pictureEffects.glow.moreGlowColors': { view: 'grid', cols: 10 },
  'chartDesign.chart.quickLayout': { view: 'grid', cols: 4 },
  'chartDesign.chart.chartStyles': { view: 'grid', cols: 4 },
  'chartFormat.chart.shapeStyles': { view: 'grid', cols: 7 },
  'chartFormat.chart.wordArtStyles': { view: 'grid', cols: 5 },
  ...EFFECTS,
  ...STRUCTURES,
};
// Hand menu items that open their feature's dialog (the probe named them with an ellipsis, which a hand menu does not carry).
export const HAND_DIALOGS = ['tableDesign.tableStyles.shading.moreColors', 'insert.symbols.symbol.moreSymbols'];
// Submenus that need a provider: MENUS[item] = [{gallery: item}] (§1.4).
export const PROVIDER_SUBMENUS = ['home.font.textEffectsAndTypography.outline', 'home.font.textEffectsAndTypography.shadow',
  'home.font.textEffectsAndTypography.reflection', 'home.font.textEffectsAndTypography.glow', 'home.font.textEffectsAndTypography.numberStyles',
  'home.font.textEffectsAndTypography.ligatures', 'home.font.textEffectsAndTypography.stylisticSets', 'home.font.fontColor.gradient'];
// Gallery ids that more than one menu holds on purpose (one provider serves them all).
export const SHARED_GALLERIES = ['lists.changeListLevel'];
// Items with no probe entry: explicit ids (§1.4 Derived items). menu: where they go; at: the entry index there.
export const HAND_ITEMS = {
  'layout.pageSetup.margins.lastCustomSetting': { label: 'Last Custom Setting', menu: 'layout.pageSetup.margins', at: 0, cmd: 'layout.pageSetup.margins', arg: 'lastCustomSetting' },
  'insert.text.quickParts.autoText.saveSelectionToAutoTextGallery': { label: 'Save Selection to AutoText Gallery', menu: 'insert.text.quickParts.autoText' },
  'insert.tables.table.quickTables.saveSelectionToQuickTablesGallery': { label: 'Save Selection to Quick Tables Gallery', menu: 'insert.tables.table.quickTables', dialog: 'createNewBuildingBlock' },
  ...Object.fromEntries(ARRANGE.map(([k, label, menu]) => [`graphicsFormat.arrangeSize.arrange.${k}`,
    { label, cmd: menu ?? 'layout.arrange.selectionPane' }])),
  ...Object.fromEntries([...ACE_SUBS, ...ACE_PLAIN].map(([k, label]) => [`${ACE}.${k}`, { label }])),
  ...Object.fromEntries(ACE_SUBS.flatMap(([k, , leaves]) => leaves.map(([leaf, label, dialog]) => [`${ACE}.${k}.${leaf}`, { label, ...(dialog && { dialog }) }]))),
};
// Saved building blocks: a {gallery: <control>} slot after the built-in items ('builtins') or first ('start').
export const GALLERY_SLOTS = {
  'references.tableOfContents.tableOfContents': 'builtins', 'references.citationsBibliography.bibliography': 'builtins', 'insert.text.quickParts': 'start',
};
// Word's building block gallery name → gallery id (_gaps-fields-core.md G8). Page Numbers is Current Position's gallery:
// its Save Selection item saves to the Page Numbers gallery, the other three to their own.
export const BLOCK_GALLERIES = {
  'Quick Parts': 'insert.text.quickParts', AutoText: 'insert.text.quickParts.autoText', 'Cover Pages': 'insert.pages.coverPage',
  Headers: 'insert.headerFooter.header', Footers: 'insert.headerFooter.footer', 'Page Numbers': 'insert.headerFooter.pageNumber.currentPosition',
  'Page Numbers (Top of Page)': 'insert.headerFooter.pageNumber.topOfPage', 'Page Numbers (Bottom of Page)': 'insert.headerFooter.pageNumber.bottomOfPage',
  'Page Numbers (Margins)': 'insert.headerFooter.pageNumber.pageMargins', 'Text Boxes': 'insert.text.textBox', Equations: 'insert.symbols.equation',
  Tables: 'insert.tables.table.quickTables', 'Table of Contents': 'references.tableOfContents.tableOfContents',
  Bibliographies: 'references.citationsBibliography.bibliography', Watermarks: 'design.pageBackground.watermark',
};

// EasyWriter's own group on Insert, after Symbols: the app's objects one click away.
export const EXTRA_GROUPS = [{
  tab: 'insert', after: 'insert.symbols', id: 'insert.boards', label: 'Boards',
  controls: [
    { id: 'x.insert.boards.canvas', type: 'button', size: 'large', label: 'Canvas', icon: 'Frame', tip: 'Adds a canvas to draw and lay out shapes, text and pictures.' },
    { id: 'x.insert.boards.flowchart', type: 'button', size: 'large', label: 'Flowchart', icon: 'Workflow', tip: 'Adds a flowchart with shapes joined by connectors.' },
    { id: 'x.insert.boards.planChart', type: 'button', size: 'large', label: 'Plan chart', icon: 'ChartGantt', tip: 'Adds a chart of a plan\'s tickets on a timeline.' },
  ],
}];

// The backstage navigation in Word's order (probe/ribbon.md File), Back first.
export const BACKSTAGE = ['file.back', 'file.home', 'file.new', 'file.open', 'file.share', 'file.info', 'file.save', 'file.saveAs', 'file.print',
  'file.export', 'file.close', 'file.account', 'file.options'];
export const QAT = ['frame.qat.save', 'frame.qat.undo', 'frame.qat.redoRepeat', 'frame.qat.customize'];
export const TITLE = ['frame.titleBar.documentName', 'frame.titleBar.search'];
export const TAB_ROW = ['frame.tabRow.comments', 'frame.tabRow.editingMode', 'frame.tabRow.share', 'frame.tabRow.collapse', 'frame.tabRow.ribbonDisplayOptions'];
// Frame menus (probe/menus/frame.*.json) → the control whose menu they are.
export const FRAME_MENUS = { 'frame.ribbon-display-options': 'frame.tabRow.ribbonDisplayOptions', 'frame.editing': 'frame.tabRow.editingMode' };

// Features outside the ribbon that can be commands (tool search lists the registered ones, §1.14), by index.json kind,
// and the tool search group of each area (the first id segment; probe/scripts/merge-index.js AREA, shortened).
export const FEATURE_KINDS = ['button', 'toggle', 'menu', 'dialog', 'pane', 'option', 'item', 'edit', 'page', 'command', 'toolbar', 'gallery', 'split', 'menuItem'];
export const AREAS = {
  file: 'File', ruler: 'Ruler', tabs: 'Tab stops', indents: 'Indents', paragraph: 'Paragraph', font: 'Font', spacing: 'Spacing',
  pagination: 'Line and page breaks', sections: 'Sections', columns: 'Columns', headersFooters: 'Headers and footers', notes: 'Footnotes and endnotes',
  statusBar: 'Status bar', views: 'Views', navPane: 'Navigation pane', find: 'Find and replace', selection: 'Selection', navigation: 'Moving around',
  editing: 'Editing', chars: 'Special characters', autocorrect: 'AutoCorrect', autoformat: 'AutoFormat', paste: 'Paste', marks: 'Formatting marks',
  contextMenu: 'Context menus', miniToolbar: 'Mini toolbar', proofing: 'Proofing', readAloud: 'Read Aloud', wordCount: 'Word Count',
  tables: 'Tables', pictures: 'Objects', fieldsUi: 'Fields', styles: 'Styles', lists: 'Lists', comments: 'Comments', tracking: 'Track Changes',
  outline: 'Outline', panes: 'Panes', options: 'Options', print: 'Print', keytips: 'Ribbon keys', window: 'Window', keys: 'Keys',
};

// Names (§1.4): labels that name a Microsoft product get a generic label; Word's stays as wordLabel and a search keyword.
export const RENAMES = {
  'Office Clipboard': 'Clipboard',
  'More Cover Pages from Office.com': 'More Cover Pages Online', 'More Headers from Office.com': 'More Headers Online',
  'More Footers from Office.com': 'More Footers Online', 'More Text Boxes from Office.com': 'More Text Boxes Online',
  'More Equations from Office.com': 'More Equations Online', 'More Watermarks from Office.com': 'More Watermarks Online',
  'More Tables of Contents from Office.com': 'More Tables of Contents Online', 'More Page Numbers from Office.com': 'More Page Numbers Online',
  'Excel Spreadsheet': 'Spreadsheet', 'Microsoft Office Signature Line': 'Signature Line', 'Normal Word Document': 'Normal Document',
  'Choose from Outlook Contacts': 'Choose from Contacts',
  SmartArt: 'Diagram', 'SmartArt Styles': 'Diagram Styles', 'SmartArt Design': 'Diagram Design', 'Recolor Pictures in SmartArt Graphic': 'Recolor Pictures in Diagram',
  WordArt: 'Styled Text', 'WordArt Styles': 'Styled Text Styles',
  'Immersive Reader': 'Reader', 'Close Immersive Reader': 'Close Reader',
  OneNote: 'Linked Notes', SharePoint: 'Document Properties',
};
// Word labels that read as a colon pivot: reworded, Word's stays as wordLabel.
export const LABELS = {
  'Options: Accessibility': 'Accessibility Options',
  ...Object.fromEntries([0, 15, 30, 50, 65, 80, 95].map((n) => [`Transparency: ${n}%`, `Transparency ${n}%`])),
  'Current Selection, Shape Styles, WordArt Styles, Arrange, Size': 'Chart Format',
};
// Word's name on derived items that point at an online service: they carry the cloud reason.
export const CLOUD_LABELS = /Office\.com/;
// The copy lint (§1.4 Tips and names): names no label or tip may hold, and the generic phrases that contain one.
export const DENY = ['Word', 'Microsoft', 'Office', 'Office.com', 'Excel', 'Outlook', 'OneNote', 'OneDrive', 'SharePoint', 'Bing', 'Copilot',
  'SmartArt', 'WordArt', 'Immersive Reader'];
export const ALLOWED = ['Word Count', 'Capitalize Each Word'];

// Icons: a lucide-react export name, or 'own:<name>' for an SVG in src/document/ribbon/icons.jsx. By label first, then by id.
export const ICONS = {
  // Frame and File
  Save: 'Save', Undo: 'Undo2', 'Redo / Repeat': 'Redo2', Repeat: 'Repeat', 'Customize Quick Access Toolbar': 'ChevronDown', 'Document name': 'FileText',
  Search: 'Search', Comments: 'MessagesSquare', 'Editing / Reviewing / Viewing': 'Pencil', Share: 'Share2', 'Collapse the Ribbon': 'ChevronUp',
  'Ribbon Display Options': 'PanelTop',
  // Home
  Paste: 'ClipboardPaste', Cut: 'Scissors', Copy: 'Copy', 'Format Painter': 'Paintbrush', 'Office Clipboard': 'Clipboard',
  Font: 'CaseSensitive', 'Font Size': 'ALargeSmall', 'Grow Font': 'AArrowUp', 'Shrink Font': 'AArrowDown', 'Change Case': 'CaseUpper',
  'Clear Formatting': 'RemoveFormatting', 'Phonetic Guide': 'LetterText', 'Character Border': 'SquareDashedText', Bold: 'Bold', Italic: 'Italic',
  Underline: 'Underline', Strikethrough: 'Strikethrough', Subscript: 'Subscript', Superscript: 'Superscript', 'Text Effects and Typography': 'Sparkles',
  'Text Highlight Color': 'Highlighter', 'Font Color': 'Baseline', 'Character Shading': 'SquareDot', 'Enclose Characters': 'CircleDot',
  Bullets: 'List', Numbering: 'ListOrdered', 'Multilevel List': 'ListTree', 'Decrease Indent': 'IndentDecrease', 'Increase Indent': 'IndentIncrease',
  'Asian Layout': 'Languages', Sort: 'ArrowDownAZ', 'Show All': 'Pilcrow', 'Align Left': 'AlignLeft', Center: 'AlignCenter', 'Align Right': 'AlignRight',
  Justify: 'AlignJustify', Distributed: 'own:alignDistributed', 'Line and Paragraph Spacing': 'UnfoldVertical', Shading: 'PaintBucket',
  Borders: 'own:borderBottom', Styles: 'Pilcrow', Paragraph: 'Pilcrow', Find: 'Search', Replace: 'Replace', Select: 'TextSelect', Dictate: 'Mic',
  Editor: 'SpellCheck2',
  // Insert
  'Cover Page': 'BookOpen', 'Blank Page': 'FilePlus', 'Page Break': 'SeparatorHorizontal', Table: 'Table', Pictures: 'Image', Shapes: 'Shapes',
  Icons: 'Smile', '3D Models': 'Box', SmartArt: 'Network', Chart: 'ChartColumn', Screenshot: 'Monitor', 'Online Videos': 'Video', Link: 'Link',
  Bookmark: 'Bookmark', 'Cross-reference': 'Waypoints', Comment: 'MessageSquarePlus', Header: 'PanelTop', Footer: 'PanelBottom', 'Page Number': 'Hash',
  'Text Box': 'SquareDashedText', 'Quick Parts': 'Blocks', WordArt: 'TypeOutline', 'Drop Cap': 'own:dropCap', 'Signature Line': 'Signature',
  'Date & Time': 'CalendarClock', Object: 'Paperclip', Equation: 'Sigma', Symbol: 'Omega', Number: 'Binary', 'eSignature fields': 'FileSignature',
  // Draw
  'Drawing Tools': 'PenTool', Add: 'Plus', 'Draw with Touch': 'Hand', Ruler: 'Ruler', 'Format Background': 'Palette', 'Ink to Shape': 'Shapes',
  'Ink to Math': 'Sigma', 'Drawing Canvas': 'Frame', 'Ink Replay': 'Play', 'Ink Help': 'CircleHelp',
  // Design
  Themes: 'Palette', 'Document Formatting': 'LayoutTemplate', Colors: 'Droplets', Fonts: 'Type', 'Paragraph Spacing': 'UnfoldVertical',
  Effects: 'Sparkle', 'Set as Default': 'CheckCheck', Watermark: 'Stamp', 'Page Color': 'PaintBucket', 'Page Borders': 'SquareDashed',
  // Layout
  'Text Direction': 'own:textDirection', Margins: 'PanelsLeftRight', Orientation: 'RectangleHorizontal', Size: 'Proportions', Columns: 'Columns2',
  Breaks: 'SeparatorHorizontal', 'Line Numbers': 'ListOrdered', Hyphenation: 'WrapText', 'Page Setup': 'Settings2', 'Indent Left': 'IndentIncrease',
  'Indent Right': 'IndentDecrease', 'Spacing Before': 'ArrowUpToLine', 'Spacing After': 'ArrowDownToLine', Position: 'LayoutPanelLeft',
  'Wrap Text': 'TextWrap', 'Bring Forward': 'BringToFront', 'Send Backward': 'SendToBack', 'Selection Pane': 'Layers', Align: 'AlignStartVertical',
  Group: 'Group', Rotate: 'RotateCw', Arrange: 'Layers',
  // References
  'Table of Contents': 'TableOfContents', 'Add Text': 'ListPlus', 'Update Table': 'RefreshCw', 'Insert Footnote': 'own:footnote',
  'Insert Endnote': 'own:endnote', 'Next Footnote': 'ChevronsDown', 'Show Notes': 'StickyNote', 'Footnote and Endnote Dialog': 'Settings2',
  'Insert Citation': 'TextQuote', 'Manage Sources': 'BookMarked', Style: 'BookA', Bibliography: 'ScrollText', 'Insert Caption': 'Captions',
  'Insert Table of Figures': 'Images', 'Mark Entry': 'BookmarkPlus', 'Insert Index': 'BookOpenText', 'Update Index': 'RefreshCw',
  'Mark Citation': 'BookmarkCheck', 'Insert Table of Authorities': 'Scale',
  // Mailings
  Envelopes: 'Mail', Labels: 'Tags', 'Start Mail Merge': 'Mails', 'Select Recipients': 'Users', 'Edit Recipient List': 'UserPen',
  'Highlight Merge Fields': 'Highlighter', 'Address Block': 'Contact', 'Greeting Line': 'Hand', 'Insert Merge Field': 'Braces', Rules: 'ListFilter',
  'Match Fields': 'Link2', 'Update Labels': 'RefreshCw', 'Preview Results': 'Eye', First: 'ChevronFirst', Previous: 'ChevronLeft', Record: 'Hash',
  Next: 'ChevronRight', Last: 'ChevronLast', 'Find Recipient': 'UserSearch', 'Check for Errors': 'FileCheck', 'Finish & Merge': 'MailCheck',
  // Review
  'Spelling and Grammar': 'SpellCheck', Thesaurus: 'BookA', 'Word Count': 'WholeWord', 'Read Aloud': 'AudioLines', 'Check Accessibility': 'Accessibility',
  Translate: 'Languages', Language: 'Globe', 'Update IME Dictionary': 'BookPlus', 'New Comment': 'MessageSquarePlus', Delete: 'Trash2',
  'Show Comments': 'MessagesSquare', 'Filter All Markup': 'ListFilter', 'Display for Review': 'FileDiff', 'Show Markup': 'Eye',
  'Reviewing Pane': 'PanelLeft', 'Change Tracking Options': 'Settings2', 'Track Changes': 'FilePen', Accept: 'Check', Reject: 'X',
  Compare: 'GitCompare', 'Block Authors': 'UserX', 'Restrict Editing': 'Lock', 'Hide Ink': 'PenOff', 'Linked Notes': 'NotebookPen',
  // View
  'Read Mode': 'BookOpen', 'Print Layout': 'FileText', 'Web Layout': 'Globe', Outline: 'ListTree', Draft: 'AlignLeft', Focus: 'Focus',
  'Immersive Reader': 'Glasses', Vertical: 'MoveVertical', 'Side to Side': 'MoveHorizontal', Gridlines: 'Grid3x3', 'Navigation Pane': 'PanelLeft',
  Zoom: 'ZoomIn', '100%': 'Scan', 'One Page': 'File', 'Multiple Pages': 'Files', 'Page Width': 'MoveHorizontal', 'New Window': 'AppWindow',
  'Arrange All': 'LayoutGrid', Split: 'SquareSplitVertical', 'View Side by Side': 'Columns2', 'Synchronous Scrolling': 'ChevronsUpDown',
  'Reset Window Position': 'RotateCcw', 'Switch Windows': 'AppWindow', Properties: 'SlidersHorizontal',
  // Help
  Help: 'CircleHelp', 'Contact Support': 'LifeBuoy', Feedback: 'MessageCircle', 'Show Training': 'GraduationCap', "What's New": 'Megaphone',
  // Developer
  'Rich Text Content Control': 'Type', 'Plain Text Content Control': 'TextCursorInput', 'Picture Content Control': 'ImagePlus',
  'Building Block Gallery Content Control': 'Blocks', 'Check Box Content Control': 'SquareCheck', 'Combo Box Content Control': 'ChevronsUpDown',
  'Drop-Down List Content Control': 'SquareChevronDown', 'Date Picker Content Control': 'Calendar', 'Repeating Section Content Control': 'Repeat',
  'Legacy Tools': 'Wrench', 'Design Mode': 'PencilRuler', 'XML Mapping Pane': 'Code', 'Document Template': 'FileStack',
  // Table Design and Table Layout
  'Header Row': 'Rows2', 'Total Row': 'Rows2', 'Banded Rows': 'Rows3', 'First Column': 'Columns2', 'Last Column': 'Columns2', 'Banded Columns': 'Columns3',
  'Table Styles': 'Table2', 'Border Styles': 'own:borderAll', 'Pen Style': 'Minus', 'Pen Weight': 'Equal', 'Pen Color': 'Pen', 'Border Painter': 'Brush',
  'Borders and Shading': 'own:borderOutside', 'View Gridlines': 'Grid3x3', 'Draw Table': 'Pencil', Eraser: 'Eraser', 'Insert Cells': 'Settings2',
  'Insert Row Above': 'BetweenHorizontalStart', 'Insert Row Below': 'BetweenHorizontalEnd', 'Insert Column Left': 'BetweenVerticalStart',
  'Insert Column Right': 'BetweenVerticalEnd', 'Merge Cells': 'TableCellsMerge', 'Split Cells': 'TableCellsSplit', 'Split Table': 'TableRowsSplit',
  AutoFit: 'Scaling', 'Table Row Height': 'MoveVertical', 'Table Column Width': 'MoveHorizontal', 'Distribute Rows': 'AlignVerticalDistributeCenter',
  'Distribute Columns': 'AlignHorizontalDistributeCenter', 'Align Top Left': 'own:cellTopLeft', 'Align Top Center': 'own:cellTopCenter',
  'Align Top Right': 'own:cellTopRight', 'Align Center Left': 'own:cellCenterLeft', 'Align Center': 'own:cellCenter',
  'Align Center Right': 'own:cellCenterRight', 'Align Bottom Left': 'own:cellBottomLeft', 'Align Bottom Center': 'own:cellBottomCenter',
  'Align Bottom Right': 'own:cellBottomRight', 'Cell Margins': 'SquareDashed', 'Repeat Header Rows': 'Rows2', 'Convert to Text': 'FileText',
  Formula: 'SquareFunction',
  // Picture Format and Graphics Format
  'Remove Background': 'ImageMinus', Corrections: 'SunMedium', Color: 'Droplet', 'Artistic Effects': 'WandSparkles', Transparency: 'Blend',
  'Compress Pictures': 'Minimize2', 'Change Picture': 'ImageUp', 'Reset Picture': 'RotateCcw', 'Picture Styles': 'GalleryHorizontal',
  'Picture Border': 'SquareDashed', 'Picture Effects': 'Sparkles', 'Picture Layout': 'Network', 'Alt Text': 'Captions', Picture: 'Settings2',
  Crop: 'Crop', 'Shape Height': 'MoveVertical', 'Shape Width': 'MoveHorizontal', 'Size and Position': 'Settings2', 'Change Graphic': 'ImageUp',
  'Convert to Shape': 'Shapes', 'Graphics Styles': 'GalleryHorizontal', 'Graphics Fill': 'PaintBucket', 'Graphics Outline': 'SquareDashed',
  'Graphics Effects': 'Sparkles',
  // Shape Format and the compatibility Text Box tab
  'Insert Shapes': 'Shapes', 'Edit Shape': 'PenTool', 'Shape Styles': 'GalleryHorizontal', 'Shape Fill': 'PaintBucket', 'Shape Outline': 'SquareDashed',
  'Change Shape': 'Shapes', 'Shape Effects': 'Sparkles', 'Advanced Tools': 'Settings2', 'WordArt Styles': 'TypeOutline', 'Text Fill': 'Baseline',
  'Text Outline': 'TypeOutline', 'Text Effects': 'Sparkles', 'Format Text Effects': 'Settings2', 'Align Text': 'AlignVerticalJustifyCenter',
  'Create Link': 'Link', 'Shadow Effects': 'Copy', 'Nudge Shadow Up': 'ArrowUp', 'Nudge Shadow Down': 'ArrowDown', 'Nudge Shadow Left': 'ArrowLeft',
  'Nudge Shadow Right': 'ArrowRight', 'Shadow On/Off': 'SquareSquare', '3-D Effects': 'Box', 'Tilt Up': 'ArrowUp', 'Tilt Down': 'ArrowDown',
  'Tilt Left': 'ArrowLeft', 'Tilt Right': 'ArrowRight', '3-D On/Off': 'Cuboid', 'Draw Text Box': 'SquareDashedText', 'Text Box Styles': 'GalleryHorizontal',
  // Diagram (SmartArt), chart and 3D model placeholders
  'Add Shape': 'SquarePlus', 'Add Bullet': 'ListPlus', 'Text Pane': 'PanelLeft', Promote: 'ArrowLeft', Demote: 'ArrowRight', 'Right to Left': 'ArrowLeftRight',
  'Move Before': 'ArrowUp', 'Move After': 'ArrowDown', Layout: 'LayoutTemplate', Layouts: 'LayoutTemplate', 'Change Colors': 'Palette',
  'SmartArt Styles': 'GalleryHorizontal', 'Reset Graphic': 'RotateCcw', 'Edit in 2-D': 'Square', Larger: 'ZoomIn', Smaller: 'ZoomOut',
  'Add Chart Element': 'ChartBar', 'Quick Layout': 'LayoutTemplate', 'Chart Styles': 'GalleryHorizontal', 'Switch Row/Column': 'ArrowLeftRight',
  'Select Data': 'Table', 'Edit Data': 'FileSpreadsheet', 'Refresh Data': 'RefreshCw', 'Change Chart Type': 'ChartPie', 'Current Selection': 'MousePointer2',
  '3D Model Views': 'Rotate3d', 'Pan & Zoom': 'Move', 'Reset 3D Model': 'RotateCcw',
  // Header & Footer
  'Document Info': 'FileText', 'Online Pictures': 'ImageUp', 'Go to Header': 'ArrowUpToLine', 'Go to Footer': 'ArrowDownToLine',
  'Link to Previous': 'Link', 'Different First Page': 'File', 'Different Odd & Even Pages': 'Files', 'Show Document Text': 'Eye',
  'Header Position from Top': 'ArrowUpToLine', 'Footer Position from Bottom': 'ArrowDownToLine', 'Insert Alignment Tab': 'ArrowRightToLine',
  'Close Header and Footer': 'X',
  // Equation
  'Ink Equation': 'PenLine', Unicode: 'Binary', LaTeX: 'Code', Text: 'Type', Convert: 'ArrowLeftRight', 'Equation Options': 'Settings2', Symbols: 'Omega',
  Fraction: 'Divide', Script: 'Superscript', Radical: 'Radical', Integral: 'own:integral', 'Large Operator': 'Sigma', Bracket: 'Parentheses',
  Function: 'SquareFunction', Accent: 'own:accent', 'Limit and Log': 'ArrowRightToLine', Operator: 'Plus', Matrix: 'Grid3x3',
  // Outlining
  'Promote to Heading 1': 'ChevronsLeft', 'Demote to Body Text': 'ChevronsRight', 'Outline Level': 'ListTree', 'Move Up': 'ArrowUp',
  'Move Down': 'ArrowDown', Expand: 'Plus', Collapse: 'Minus', 'Show Level': 'ListCollapse', 'Show Text Formatting': 'Type',
  'Show First Line Only': 'AlignLeft', 'Show Document': 'FileStack', 'Collapse Subdocuments': 'ListCollapse', 'Close Outline View': 'X',
  // Reader
  'Column Width': 'Columns2', 'Line Focus': 'Focus', 'Text Spacing': 'Space', Syllables: 'Ellipsis', 'Close Immersive Reader': 'X',
};
export const ICON_IDS = {
  'review.tracking.previous': 'ChevronUp', 'review.tracking.next': 'ChevronDown', 'review.comments.previous': 'ChevronUp',
  'review.comments.next': 'ChevronDown', 'headerFooter.navigation.previous': 'ChevronUp', 'headerFooter.navigation.next': 'ChevronDown',
  'tableLayout.rowsColumns.delete': 'Trash2', 'tableLayout.table.select': 'TextSelect', 'tableLayout.alignment.textDirection': 'own:textDirection',
  'tableLayout.table.properties': 'SlidersHorizontal', 'smartArtDesign.createGraphic.layout': 'Network', 'pictureFormat.pictureStyles.launcher': 'Settings2',
  'immersiveReader.immersiveReader.pageColor': 'PaintBucket', 'immersiveReader.immersiveReader.readAloud': 'AudioLines', 'equation.tools.equation': 'Sigma',
  // The Borders gallery's edges, drawn in icons.jsx.
  ...Object.fromEntries([['bottomBorder', 'Bottom'], ['topBorder', 'Top'], ['leftBorder', 'Left'], ['rightBorder', 'Right'], ['noBorder', 'None'],
    ['allBorders', 'All'], ['outsideBorders', 'Outside'], ['insideBorders', 'Inside'], ['insideHorizontalBorder', 'InsideH'],
    ['insideVerticalBorder', 'InsideV'], ['diagonalDownBorder', 'DiagonalDown'], ['diagonalUpBorder', 'DiagonalUp']]
    .map(([k, own]) => [`home.paragraph.borders.${k}`, `own:border${own}`])),
};

// Tooltips for controls whose index.json summary fails the lint, in our words.
export const TIPS = {
  'developer.protect.blockAuthors': 'Locks a region against co-authors in a shared document.',
  'graphicsFormat.arrangeSize.arrange': 'Positions, wraps, orders, aligns, groups and rotates the graphic.',
  'graphicsFormat.arrangeSize.crop': 'Crop handles; the arrow has Crop to Shape, Aspect Ratio, Fill and Fit.',
  'frame.qat.customize': 'Chooses which buttons the Quick Access Toolbar shows.',
  'frame.tabRow.editingMode': 'Switches between editing, reviewing with tracked changes and viewing only.',
  'frame.tabRow.share': 'Shares the document with other people online.',
  'frame.tabRow.ribbonDisplayOptions': 'Chooses whether the ribbon stays open, shows only its tabs or hides with the toolbar.',
  'home.clipboard.launcher': 'Shows the clipboard pane with the last 24 items you cut or copied.',
  'home.font.font': 'Picks the font, with theme fonts first and each name drawn in its own face.',
  'home.font.fontSize': 'Picks the font size or takes a size you type, from 1 to 1638 points.',
  'home.font.changeCase': 'Changes the selected text to sentence case, lowercase, uppercase and more.',
  'home.font.phoneticGuide': 'Adds a pronunciation guide above East Asian characters.',
  'home.font.fontColor': 'Changes the colour of the text.',
  'home.font.encloseCharacters': 'Draws a circle, square, triangle or diamond around one character.',
  'home.font.launcher': 'Opens the Font dialog with every character setting.',
  'home.paragraph.asianLayout': 'Lays out East Asian text in special ways, such as two lines in one.',
  'home.paragraph.sort': 'Sorts the selected paragraphs or table rows by text, number or date.',
  'home.paragraph.borders': 'Adds or removes borders around the selected paragraphs or cells.',
  'home.paragraph.launcher': 'Opens the Paragraph dialog with indents, spacing and page breaks.',
  'home.styles.styles': 'Applies a style to the paragraph or the selected text.',
  'home.styles.launcher': 'Shows the Styles pane with every style in the document.',
  'home.editing.select': 'Selects all text, objects or text with similar formatting.',
  'home.voice.dictate': 'Types what you say at the insertion point.',
  'home.editor.editor': 'Checks spelling and grammar and suggests improvements.',
  'insert.tables.table': 'Inserts a table by picking its size on a grid, or draws or converts one.',
  'insert.illustrations.shapes': 'Inserts a shape that you draw on the page.',
  'insert.illustrations.smartArt': 'Inserts a diagram such as a list, process, cycle or hierarchy.',
  'insert.links.bookmark': 'Names the selection so links and references can go to it.',
  'insert.links.crossReference': 'Inserts a reference to a heading, bookmark, footnote, caption or numbered item.',
  'insert.headerFooter.pageNumber': 'Adds page numbers at the top or bottom of the page, in the margin or at the insertion point.',
  'insert.text.quickParts': 'Inserts saved text, document properties and fields.',
  'insert.text.wordArt': 'Inserts a text box with decorated text.',
  'insert.text.dropCap': 'Makes a large first letter at the start of the paragraph.',
  'insert.text.signatureLine': 'Inserts a line for someone to sign the document.',
  'insert.text.dateTime': 'Inserts the date or time in a format you pick, optionally kept up to date.',
  'insert.text.object': 'Inserts an object made in another program, or the text of a file.',
  'insert.symbols.equation': 'Inserts a new equation or a common one you pick.',
  'insert.symbols.number': 'Types a number in a style such as Roman or circled numerals.',
  'insert.eSignature.eSignatureFields': 'Adds fields for an online signing service.',
  'draw.drawingTools.drawingTools': 'Picks a pen, pencil, highlighter or eraser for drawing.',
  'design.documentFormatting.themes': 'Changes the document\'s colours, fonts and effects together.',
  'design.documentFormatting.documentFormatting': 'Changes the look of the whole document by redefining its styles together.',
  'design.documentFormatting.colors': 'Picks the set of theme colours the document uses.',
  'design.documentFormatting.paragraphSpacing': 'Sets the spacing between lines and paragraphs for the whole document.',
  'design.documentFormatting.effects': 'Picks the theme effects for shapes and diagrams.',
  'design.pageBackground.pageBorders': 'Adds a border around each page.',
  'layout.pageSetup.textDirection': 'Changes the direction of the text in the section or text box.',
  'layout.pageSetup.margins': 'Sets the margins of the section, from presets or your own.',
  'layout.pageSetup.lineNumbers': 'Numbers the lines in the margin.',
  'layout.pageSetup.hyphenation': 'Breaks words at line ends with a hyphen, automatically or by hand.',
  'layout.pageSetup.launcher': 'Opens the Page Setup dialog with margins, paper and layout.',
  'layout.arrange.position': 'Places the selected object on the page with text wrapping around it.',
  'layout.arrange.selectionPane': 'Lists every object on the page so you can select, hide or reorder them.',
  'references.tableOfContents.addText': 'Sets whether the paragraph shows in the table of contents, and at which level.',
  'references.tableOfContents.updateTable': 'Updates the table of contents, either the page numbers or the whole table.',
  'references.footnotes.launcher': 'Opens the Footnote and Endnote dialog with placement and numbering.',
  'references.citationsBibliography.manageSources': 'Adds, edits and deletes the sources you cite.',
  'references.citationsBibliography.style': 'Picks the citation style, such as APA, Harvard or IEEE.',
  'references.captions.insertCaption': 'Adds a numbered caption to a figure, table or equation.',
  'references.captions.insertTableOfFigures': 'Inserts a list of the figures, tables or equations with their page numbers.',
  'references.index.markEntry': 'Marks the selected text as an entry for the index.',
  'references.index.insertIndex': 'Inserts an index of the marked entries.',
  'references.tableOfAuthorities.markCitation': 'Marks the selected text as a citation for the table of authorities.',
  'references.tableOfAuthorities.insertTableOfAuthorities': 'Inserts a table of authorities listing the marked citations.',
  'mailings.create.envelopes': 'Creates and prints an envelope with the delivery and return address.',
  'mailings.create.labels': 'Creates and prints labels with an address.',
  'mailings.startMailMerge.startMailMerge': 'Starts a mail merge for letters, emails, envelopes, labels or a directory.',
  'mailings.startMailMerge.selectRecipients': 'Picks the list of people the merge goes to.',
  'mailings.startMailMerge.editRecipientList': 'Chooses, sorts and filters the people in the merge.',
  'mailings.writeInsertFields.addressBlock': 'Inserts each recipient\'s address in the format you pick.',
  'mailings.writeInsertFields.greetingLine': 'Inserts a greeting with each recipient\'s name.',
  'mailings.writeInsertFields.rules': 'Adds fields that ask for input, choose text or skip records during the merge.',
  'mailings.writeInsertFields.matchFields': 'Matches the address parts to the columns of the recipient list.',
  'mailings.previewResults.findRecipient': 'Finds a recipient by text in the list.',
  'mailings.previewResults.checkForErrors': 'Checks the merge for errors before you finish it.',
  'mailings.finish.finishMerge': 'Finishes the merge into one document, printed copies or emails.',
  'review.proofing.spellingAndGrammar': 'Checks the spelling of the whole document.',
  'review.proofing.thesaurus': 'Suggests words with a similar meaning.',
  'review.proofing.wordCount': 'Counts the pages, words, characters, paragraphs and lines.',
  'review.accessibility.checkAccessibility': 'Finds things that make the document hard to read for people with disabilities.',
  'review.markup.filterAllMarkup': 'Filters which comments show.',
  'review.markup.showMarkup': 'Chooses which kinds of tracked changes and comments show.',
  'review.markup.launcher': 'Opens the Track Changes Options dialog.',
  'review.protect.restrictEditing': 'Limits the formatting and edits other people can make.',
  'review.oneNote.linkedNotes': 'Links the document to notes kept in a notebook program.',
  'view.views.readMode': 'Shows the document in columns that fill the screen for reading.',
  'view.views.draft': 'Shows the text alone, without page edges, headers or floating objects.',
  'view.immersive.immersiveReader': 'Shows the document in a reading view with line focus, text spacing and read aloud.',
  'view.zoom.zoom': 'Opens the Zoom dialog to pick a zoom level.',
  'view.sharePoint.properties': 'Shows the document properties pane for files stored online.',
  'help.help.contactSupport': 'Contacts the support team.',
  'help.help.feedback': 'Sends feedback about the app.',
  'tableLayout.table.properties': 'Opens the Table Properties dialog for the table, rows, columns and cells.',
  'tableLayout.rowsColumns.launcher': 'Inserts cells and moves the others right or down.',
  'tableLayout.merge.splitCells': 'Splits the selected cells into the number of columns and rows you pick.',
  'tableLayout.alignment.textDirection': 'Turns the text in the cell to read sideways.',
  'tableLayout.alignment.cellMargins': 'Sets the default space inside and between the cells.',
  'tableLayout.data.convertToText': 'Turns the table into text with the separator you pick.',
  'tableLayout.data.formula': 'Inserts a calculation such as the sum of the cells above.',
  'pictureFormat.adjust.compressPictures': 'Makes pictures smaller by lowering their resolution and removing cropped areas.',
  'pictureFormat.adjust.changePicture': 'Replaces the picture and keeps its size and formatting.',
  'pictureFormat.pictureStyles.pictureLayout': 'Turns the selected pictures into a diagram.',
  'pictureFormat.pictureStyles.launcher': 'Shows the Format Picture pane.',
  'pictureFormat.accessibility.altText': 'Describes the picture for people who use a screen reader.',
  'pictureFormat.size.launcher': 'Opens the Layout dialog at the size settings.',
  'shapeFormat.shapeStyles.launcher': 'Shows the Format Shape pane.',
  'smartArtDesign.createGraphic.layout': 'Changes how a branch of the organisation chart hangs.',
  'smartArtDesign.layouts.layouts': 'Picks the diagram layout.',
  'smartArtDesign.smartArtStyles.smartArtStyles': 'Picks a style for the whole diagram.',
  'smartArtFormat.shapes.changeShape': 'Swaps the selected diagram shape for another.',
  'smartArtFormat.shapeStyles.shapeEffects': 'Adds effects to the selected diagram shape.',
  'smartArtFormat.shapeStyles.launcher': 'Shows the Format Shape pane for the diagram shape.',
  'smartArtFormat.wordArtStyles.wordArtStyles': 'Applies a decorated text style to the diagram text.',
  'shapeFormat.wordArtStyles.quickStyles': 'Applies a decorated text style to the shape\'s text.',
  'headerFooter.insert.onlinePictures': 'Inserts a picture found online.',
  'headerFooter.navigation.linkToPrevious': 'Uses the previous section\'s header or footer in this section too.',
  'headerFooter.position.insertAlignmentTab': 'Inserts a tab that aligns text left, centre or right in the header or footer.',
  'equation.conversions.convert': 'Switches the equation between its built-up and linear forms.',
  'equation.conversions.launcher': 'Opens the Equation Options dialog.',
  'equation.symbols.symbols': 'Inserts a maths symbol.',
  'outlining.masterDocument.showDocument': 'Shows the tools for master documents and their subdocuments.',
  'developer.controls.properties': 'Opens the properties of the content control.',
  'developer.templates.documentTemplate': 'Attaches a template to the document.',
};

// Icons tool search draws beside the spec's own (src/document/ribbon/search.js): key rows and features outside the ribbon.
export const EXTRA_ICONS = ['Keyboard', 'SquareDot', 'FileText'];

// Shape Format and the Text Box tab were probed in compatibility mode, whose Shape Outline menu showed no colour grid: the
// modern menu has one first, so these menus get the colour panel.
export const COLOR_MENUS = ['shapeFormat.shapeStyles.shapeOutline', 'textBox.textBoxStyles.shapeOutline'];
// Items a repeated control's probe menu has that its canonical (compatibility-mode) menu lacks: recorded, not copied.
export const SAME_MENU_GAPS = { 'smartArtFormat.shapeStyles.shapeOutline': ['Sketched'] };
