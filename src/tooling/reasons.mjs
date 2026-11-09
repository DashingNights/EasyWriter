// Placeholder reasons (docs/plans/word plan.md §1.5): why a control is drawn disabled, in our words. `pending` is the runtime
// reason of every unregistered command; the others are what a spec control's `needs` names. A registered command disabled for
// the current object gives its own reason(ctx) instead. `engine` is the reason of a granted command the focused canvas draft's
// table does not name yet (docs/plans/engine/viewport-design.md section 4.7). Pure: the spec generator, its test and the registry read it.

export const REASONS = {
  pending: 'Not built yet.',
  engine: 'Not built for the canvas engine yet.',
  cloud: 'Needs an online service EasyWriter does not use.',
  smartart: 'EasyWriter diagrams do not have this.',
  encrypt: 'Needs file encryption, which EasyWriter does not have yet.',
  chart: 'Needs a chart linked to a workbook, which comes with the spreadsheet format.',
  render3d: 'Needs 3-D rendering, which EasyWriter does not have.',
  compat: 'Shows only for files in an old compatibility mode.',
  ole: 'Needs linked and embedded objects, which come with the other document types.',
  excel: 'Needs the spreadsheet format, which comes later.',
  docx: 'EasyWriter opens and saves .docx files, but not this part of them yet.',
  signature: 'Needs digital signature certificates.',
  ink: 'Needs handwriting recognition.',
  grammar: 'Needs a grammar checker.',
  thesaurus: 'Needs a thesaurus word list.',
  imageFilter: 'Needs an image effects engine.',
  ime: 'Needs input method dictionaries.',
  outlook: "Needs a mail program's contacts.",
  onenote: 'Needs a notebook program.',
  printer: 'Needs printer driver features.',
  dataSource: 'Needs links to databases and other programs.',
  mac: 'Needs publish and subscribe links.',
  subdocs: 'Needs subdocument files.',
  windows: 'EasyWriter shows one draft at a time.',
  verticalText: 'Needs vertical text layout.',
};
