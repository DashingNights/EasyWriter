// The shape gallery every editor lists (docs/plans/word/briefs/shape-pool.md): the DrawingML presets in Word's groups and order,
// each under the name Word shows (docs/plans/word/probe: the current names of the Crop to Shape and Change Shape galleries, the
// groups of Insert > Shapes). Word's Lines group and its text box and freeform tools are Word's own (src/document/wp/shapes/map.mjs);
// the board adds its own kinds to these groups (src/flow/shapes.mjs). Pure data.

const g = (id, title, list) => ({ id, title, shapes: list.split(';').map((s) => s.trim().split('=')) });

/** [{id, title, shapes: [[prst, name]]}] in Word's order. */
export const GALLERY = [
  g('rects', 'Rectangles', 'rect=Rectangle; roundRect=Rectangle: Rounded Corners; snip1Rect=Rectangle: Single Corner Snipped;'
    + 'snip2SameRect=Rectangle: Top Corners Snipped; snip2DiagRect=Rectangle: Diagonal Corners Snipped;'
    + 'snipRoundRect=Rectangle: Top Corners One Rounded and One Snipped; round1Rect=Rectangle: Single Corner Rounded;'
    + 'round2SameRect=Rectangle: Top Corners Rounded; round2DiagRect=Rectangle: Diagonal Corners Rounded'),
  g('basic', 'Basic Shapes', 'ellipse=Oval; triangle=Isosceles Triangle; rtTriangle=Right Triangle; parallelogram=Parallelogram;'
    + 'trapezoid=Trapezoid; diamond=Diamond; pentagon=Pentagon; hexagon=Hexagon; heptagon=Heptagon; octagon=Octagon; decagon=Decagon;'
    + 'dodecagon=Dodecagon; pie=Partial Circle; chord=Chord; teardrop=Teardrop; frame=Frame; halfFrame=Half Frame; corner=L-Shape;'
    + 'diagStripe=Diagonal Stripe; plus=Cross; plaque=Plaque; can=Cylinder; cube=Cube; bevel=Rectangle: Beveled; donut=Circle: Hollow;'
    + 'noSmoking="Not Allowed" Symbol; blockArc=Block Arc; foldedCorner=Rectangle: Folded Corner; smileyFace=Smiley Face; heart=Heart;'
    + 'lightningBolt=Lightning Bolt; sun=Sun; moon=Moon; cloud=Cloud; arc=Arc; bracketPair=Double Bracket; bracePair=Double Brace;'
    + 'leftBracket=Left Bracket; rightBracket=Right Bracket; leftBrace=Left Brace; rightBrace=Right Brace'),
  g('arrows', 'Block Arrows', 'rightArrow=Arrow: Right; leftArrow=Arrow: Left; upArrow=Arrow: Up; downArrow=Arrow: Down;'
    + 'leftRightArrow=Arrow: Left-Right; upDownArrow=Arrow: Up-Down; quadArrow=Arrow: Quad; leftRightUpArrow=Arrow: Left-Right-Up;'
    + 'bentArrow=Arrow: Bent; uturnArrow=Arrow: U-Turn; leftUpArrow=Arrow: Left-Up; bentUpArrow=Arrow: Bent-Up;'
    + 'curvedRightArrow=Arrow: Curved Right; curvedLeftArrow=Arrow: Curved Left; curvedUpArrow=Arrow: Curved Up;'
    + 'curvedDownArrow=Arrow: Curved Down; stripedRightArrow=Arrow: Striped Right; notchedRightArrow=Arrow: Notched Right;'
    + 'homePlate=Arrow: Pentagon; chevron=Arrow: Chevron; rightArrowCallout=Callout: Right Arrow; downArrowCallout=Callout: Down Arrow;'
    + 'leftArrowCallout=Callout: Left Arrow; upArrowCallout=Callout: Up Arrow; leftRightArrowCallout=Callout: Left-Right Arrow;'
    + 'quadArrowCallout=Callout: Quad Arrow; circularArrow=Arrow: Circular'),
  g('equation', 'Equation Shapes', 'mathPlus=Plus Sign; mathMinus=Minus Sign; mathMultiply=Multiplication Sign; mathDivide=Division Sign;'
    + 'mathEqual=Equals; mathNotEqual=Not Equal'),
  g('flow', 'Flowchart', 'flowChartProcess=Flowchart: Process; flowChartAlternateProcess=Flowchart: Alternate Process;'
    + 'flowChartDecision=Flowchart: Decision; flowChartInputOutput=Flowchart: Data; flowChartPredefinedProcess=Flowchart: Predefined Process;'
    + 'flowChartInternalStorage=Flowchart: Internal Storage; flowChartDocument=Flowchart: Document; flowChartMultidocument=Flowchart: Multidocument;'
    + 'flowChartTerminator=Flowchart: Terminator; flowChartPreparation=Flowchart: Preparation; flowChartManualInput=Flowchart: Manual Input;'
    + 'flowChartManualOperation=Flowchart: Manual Operation; flowChartConnector=Flowchart: Connector;'
    + 'flowChartOffpageConnector=Flowchart: Off-page Connector; flowChartPunchedCard=Flowchart: Card; flowChartPunchedTape=Flowchart: Punched Tape;'
    + 'flowChartSummingJunction=Flowchart: Summing Junction; flowChartOr=Flowchart: Or; flowChartCollate=Flowchart: Collate;'
    + 'flowChartSort=Flowchart: Sort; flowChartExtract=Flowchart: Extract; flowChartMerge=Flowchart: Merge;'
    + 'flowChartOnlineStorage=Flowchart: Stored Data; flowChartDelay=Flowchart: Delay; flowChartMagneticTape=Flowchart: Sequential Access Storage;'
    + 'flowChartMagneticDisk=Flowchart: Magnetic Disk; flowChartMagneticDrum=Flowchart: Direct Access Storage; flowChartDisplay=Flowchart: Display'),
  g('stars', 'Stars and Banners', 'irregularSeal1=Explosion: 8 Points; irregularSeal2=Explosion: 14 Points; star4=Star: 4 Points; star5=Star: 5 Points;'
    + 'star6=Star: 6 Points; star7=Star: 7 Points; star8=Star: 8 Points; star10=Star: 10 Points; star12=Star: 12 Points; star16=Star: 16 Points;'
    + 'star24=Star: 24 Points; star32=Star: 32 Points; ribbon2=Ribbon: Tilted Up; ribbon=Ribbon: Tilted Down; ellipseRibbon2=Ribbon: Curved and Tilted Up;'
    + 'ellipseRibbon=Ribbon: Curved and Tilted Down; verticalScroll=Scroll: Vertical; horizontalScroll=Scroll: Horizontal; wave=Wave; doubleWave=Double Wave'),
  g('callouts', 'Callouts', 'wedgeRectCallout=Speech Bubble: Rectangle; wedgeRoundRectCallout=Speech Bubble: Rectangle with Corners Rounded;'
    + 'wedgeEllipseCallout=Speech Bubble: Oval; cloudCallout=Thought Bubble: Cloud; borderCallout1=Callout: Line; borderCallout2=Callout: Bent Line;'
    + 'borderCallout3=Callout: Double Bent Line; accentCallout1=Callout: Line with Accent Bar; accentCallout2=Callout: Bent Line with Accent Bar;'
    + 'accentCallout3=Callout: Double Bent Line with Accent Bar; callout1=Callout: Line with No Border; callout2=Callout: Bent Line with No Border;'
    + 'callout3=Callout: Double Bent Line with No Border; accentBorderCallout1=Callout: Line with Border and Accent Bar;'
    + 'accentBorderCallout2=Callout: Bent Line with Border and Accent Bar; accentBorderCallout3=Callout: Double Bent Line with Border and Accent Bar'),
];

/** Preset → the name Word shows for it (the gallery's presets only). */
export const PRESET_LABELS = Object.fromEntries(GALLERY.flatMap((s) => s.shapes));
/** Preset → the gallery group it sits in. */
export const PRESET_GROUP = Object.fromEntries(GALLERY.flatMap((s) => s.shapes.map(([p]) => [p, s.id])));
