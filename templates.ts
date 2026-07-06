/**
 * Layer 4: parameterized templates. The model's coordinate arithmetic is the
 * worst failure class the judge hunts for (bars ending shy of their label,
 * uneven ticks) — so for the families where scale errors bite most, the model
 * emits a small JSON spec and this file renders it. Tick spacing, bar heights,
 * and mark positions become provably correct; Haiku's job shrinks to
 * understanding the request and away from geometry.
 *
 * Two kinds in v1 — `numberLine` and `barChart` — chosen because they cover 8
 * of the 30 dataset requests and carry the most visible scale arithmetic.
 * Everything else stays on the raw-SVG path (see GENERATOR_SYSTEM_PROMPT).
 *
 * Templates style via the layer-2 vocabulary only (classes + #symbol ids, no
 * inline colors, no <defs> of their own): `prepareSvg` injects the defs and
 * expands the classes, so template output shares one look with raw-SVG output
 * and flows through the existing render pipeline unchanged.
 *
 * Keep `DiagramSpec` and `SPEC_GUIDE` in lockstep — the guide is the model's
 * only documentation of this schema.
 */
import { Schema } from "effect";

/**
 * Positions accept a number OR a fraction string like "2/3", resolved here at
 * render time. Making the model divide 1/6 into 0.1667 would reintroduce
 * exactly the in-head arithmetic this layer exists to kill — and the fraction
 * string doubles as the natural default tick label.
 */
const Fraction = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^-?\d+\/[1-9]\d*$/)),
);
const Pos = Schema.Union([Schema.Number, Fraction]);
type Pos = typeof Pos.Type;

const resolvePos = (pos: Pos): number => {
  if (typeof pos === "number") return pos;
  const [num, den] = pos.split("/");
  return Number(num) / Number(den);
};

/** A position's default display text: fractions stay written as fractions. */
const posLabel = (pos: Pos): string => String(pos);

const PositiveNumber = Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0)));

const NumberLineSpec = Schema.Struct({
  kind: Schema.Literal("numberLine"),
  min: Schema.Number,
  max: Schema.Number,
  /** Regular tick spacing (number or fraction string — "1/6" also makes the
   *  tick labels read as sixths); omit when using only custom `ticks`. */
  tickEvery: Schema.optionalKey(Pos),
  /** Label spacing for the regular ticks (default: every tick). */
  labelEvery: Schema.optionalKey(Pos),
  /** Extra ticks at exact positions, e.g. fraction ticks; label defaults to
   *  the position as written ("2/6"). */
  ticks: Schema.optionalKey(Schema.Array(Schema.Struct({
    at: Pos,
    label: Schema.optionalKey(Schema.String),
  }))),
  /** Open/closed point marks on the line (inequality endpoints, plotted values). */
  marks: Schema.optionalKey(Schema.Array(Schema.Struct({
    at: Pos,
    style: Schema.Literals(["open", "closed"]),
  }))),
  /** Accent-colored span on the line; `arrow` extends it past the line's end
   *  with an arrowhead (inequality rays). */
  shade: Schema.optionalKey(Schema.Struct({
    from: Pos,
    to: Pos,
    arrow: Schema.optionalKey(Schema.Boolean),
  })),
  /** Jump arcs above the line, e.g. "+1/4" hops. */
  jumps: Schema.optionalKey(Schema.Array(Schema.Struct({
    from: Pos,
    to: Pos,
    label: Schema.optionalKey(Schema.String),
  }))),
  /** Square brackets under the line marking sections, e.g. counting how many
   *  1/6 pieces fit in 2/3. */
  brackets: Schema.optionalKey(Schema.Array(Schema.Struct({
    from: Pos,
    to: Pos,
    label: Schema.optionalKey(Schema.String),
  }))),
});
type NumberLineSpec = typeof NumberLineSpec.Type;

const BarChartSpec = Schema.Struct({
  kind: Schema.Literal("barChart"),
  title: Schema.optionalKey(Schema.String),
  /** Top of the value axis (default: max bar value rounded up to a tick). */
  axisMax: Schema.optionalKey(PositiveNumber),
  /** Value-axis tick spacing (default 1). */
  tickEvery: Schema.optionalKey(PositiveNumber),
  bars: Schema.Array(Schema.Struct({
    label: Schema.String,
    value: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    /** Explicit color slot; defaults to cycling shade-1..4 by index. */
    shade: Schema.optionalKey(Schema.Literals([1, 2, 3, 4])),
  })).pipe(Schema.check(Schema.isNonEmpty())),
});
type BarChartSpec = typeof BarChartSpec.Type;

const ClockSpec = Schema.Struct({
  kind: Schema.Literal("clock"),
  /** Omit entirely for a blank practice face (numbers and minute marks, no
   *  hands). Hand angles are computed — the hour hand advances with minutes. */
  time: Schema.optionalKey(Schema.Struct({
    hour: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(12))),
    minute: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(59))),
  })),
});
type ClockSpec = typeof ClockSpec.Type;

const CoordinatePlaneSpec = Schema.Struct({
  kind: Schema.Literal("coordinatePlane"),
  xMin: Schema.Number,
  xMax: Schema.Number,
  yMin: Schema.Number,
  yMax: Schema.Number,
  /** Axis-number spacing (default 1). */
  labelEvery: Schema.optionalKey(PositiveNumber),
  /** Plotted exactly; label like "(-3, 2)". Omit for a blank grid. */
  points: Schema.optionalKey(Schema.Array(Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    label: Schema.optionalKey(Schema.String),
  }))),
});
type CoordinatePlaneSpec = typeof CoordinatePlaneSpec.Type;

const LinePlotSpec = Schema.Struct({
  kind: Schema.Literal("linePlot"),
  min: Schema.Number,
  max: Schema.Number,
  tickEvery: Schema.optionalKey(Pos),
  title: Schema.optionalKey(Schema.String),
  /** Axis caption under the number line, e.g. "Hours". */
  axisLabel: Schema.optionalKey(Schema.String),
  /** `count` dots stacked above the line at each position. */
  dots: Schema.Array(Schema.Struct({
    at: Pos,
    count: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  })).pipe(Schema.check(Schema.isNonEmpty())),
});
type LinePlotSpec = typeof LinePlotSpec.Type;

const FractionBarSpec = Schema.Struct({
  kind: Schema.Literal("fractionBar"),
  /** All bars align left and share one drawn length (equivalence comparisons). */
  bars: Schema.Array(Schema.Struct({
    /** N equal parts, the first `shaded` filled — OR give total+partSize. */
    parts: Schema.optionalKey(PositiveNumber),
    shaded: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
    /** Measurement strips: a strip of length `total` tiled with parts of size
     *  `partSize` — the renderer computes how many fit (6 ÷ 1/4 = 24). */
    total: Schema.optionalKey(PositiveNumber),
    partSize: Schema.optionalKey(Pos),
    /** Text inside every part, e.g. "1/4 ft". */
    partLabel: Schema.optionalKey(Schema.String),
    /** Whole-bar label drawn above, e.g. "6 feet". */
    label: Schema.optionalKey(Schema.String),
  })).pipe(Schema.check(Schema.isNonEmpty())),
});
type FractionBarSpec = typeof FractionBarSpec.Type;

const FractionCircleSpec = Schema.Struct({
  kind: Schema.Literal("fractionCircle"),
  parts: PositiveNumber,
  shaded: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
type FractionCircleSpec = typeof FractionCircleSpec.Type;

const TenFrameSpec = Schema.Struct({
  kind: Schema.Literal("tenFrame"),
  /** Counters in the frame, filled left-to-right, top row first. */
  filled: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10))),
  /** Side-by-side identical frames (default 1) — "multiple ten-frames". */
  frames: Schema.optionalKey(PositiveNumber),
});
type TenFrameSpec = typeof TenFrameSpec.Type;

const DotArraySpec = Schema.Struct({
  kind: Schema.Literal("dotArray"),
  /** One or more dot arrays drawn side by side (two groups = an addition
   *  model; one group = a set model). */
  groups: Schema.Array(Schema.Struct({
    rows: PositiveNumber,
    cols: PositiveNumber,
    /** The first `shaded` dots (row-major) are filled in the group's color;
     *  the rest draw as empty circles. Default: all filled. */
    shaded: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
    /** Color slot; defaults to cycling shade-1..4 by group index. */
    shade: Schema.optionalKey(Schema.Literals([1, 2, 3, 4])),
    /** Caption under the group, e.g. "3 × 4". */
    label: Schema.optionalKey(Schema.String),
  })).pipe(Schema.check(Schema.isNonEmpty())),
});
type DotArraySpec = typeof DotArraySpec.Type;

const AreaGridSpec = Schema.Struct({
  kind: Schema.Literal("areaGrid"),
  rows: PositiveNumber,
  cols: PositiveNumber,
  /** Count labels along the side (rows) and top (cols), e.g. "4" and "6".
   *  Omitted → no dimension labels. */
  rowLabel: Schema.optionalKey(Schema.String),
  colLabel: Schema.optionalKey(Schema.String),
  /** The first `shaded` cells (row-major) are filled. */
  shaded: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});
type AreaGridSpec = typeof AreaGridSpec.Type;

const BaseTenBlocksSpec = Schema.Struct({
  kind: Schema.Literal("baseTenBlocks"),
  hundreds: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  tens: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ones: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
type BaseTenBlocksSpec = typeof BaseTenBlocksSpec.Type;

const ShapeSpec = Schema.Struct({
  kind: Schema.Literal("shape"),
  shape: Schema.Literals(["rightTriangle", "parallelogram"]),
  /** Numeric dimensions set the drawn proportions (a 6-8 triangle really is
   *  3:4). Both optional — omitted dims fall back to pleasant defaults. */
  base: Schema.optionalKey(PositiveNumber),
  height: Schema.optionalKey(PositiveNumber),
  /** Edge labels. rightTriangle: baseLabel = horizontal leg, heightLabel =
   *  vertical leg, hypotenuseLabel = the slant (omit to leave it blank).
   *  parallelogram: baseLabel + heightLabel (height draws as a dashed
   *  interior altitude). */
  baseLabel: Schema.optionalKey(Schema.String),
  heightLabel: Schema.optionalKey(Schema.String),
  hypotenuseLabel: Schema.optionalKey(Schema.String),
  /** parallelogram only: draw a corner-to-corner diagonal splitting it into
   *  two triangles. */
  diagonal: Schema.optionalKey(Schema.Boolean),
});
type ShapeSpec = typeof ShapeSpec.Type;

const RectPrismSpec = Schema.Struct({
  kind: Schema.Literal("rectPrism"),
  /** One or more prisms drawn side by side, distinguished by shade. */
  prisms: Schema.Array(Schema.Struct({
    /** Relative dimensions (drawing units, not pixels); default 4×3×2. */
    width: Schema.optionalKey(PositiveNumber),
    height: Schema.optionalKey(PositiveNumber),
    depth: Schema.optionalKey(PositiveNumber),
    /** Edge labels; omit any the request doesn't give. */
    widthLabel: Schema.optionalKey(Schema.String),
    heightLabel: Schema.optionalKey(Schema.String),
    depthLabel: Schema.optionalKey(Schema.String),
    /** Color slot; defaults to cycling shade-1..4 by index. */
    shade: Schema.optionalKey(Schema.Literals([1, 2, 3, 4])),
  })).pipe(Schema.check(Schema.isNonEmpty())),
});
type RectPrismSpec = typeof RectPrismSpec.Type;

export const DiagramSpec = Schema.Union([
  NumberLineSpec,
  BarChartSpec,
  ClockSpec,
  CoordinatePlaneSpec,
  LinePlotSpec,
  FractionBarSpec,
  FractionCircleSpec,
  TenFrameSpec,
  DotArraySpec,
  AreaGridSpec,
  BaseTenBlocksSpec,
  ShapeSpec,
  RectPrismSpec,
]);
export type DiagramSpec = typeof DiagramSpec.Type;

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Render a number line. Fixed drawn width regardless of value range (auto-crop
 * makes canvas size cosmetic anyway), so 0–1 fraction lines and -10–10 integer
 * lines come out the same physical size.
 */
const renderNumberLine = (spec: NumberLineSpec): string => {
  const min = spec.min;
  const max = spec.max;
  if (!(max > min)) throw new Error(`numberLine needs max > min (got ${min}..${max})`);
  const W = 900;
  const M = 60;
  const Y = 120;
  const x = (pos: Pos) => M + ((resolvePos(pos) - min) / (max - min)) * W;

  const shapes: string[] = [];
  const text: string[] = [];

  // Axis, extended a touch past both ends so end ticks don't sit on the tip.
  shapes.push(`<line class="axis" x1="${M - 15}" y1="${Y}" x2="${M + W + 15}" y2="${Y}"/>`);

  // Regular ticks (default spacing 1 when nothing else is specified), then
  // custom ticks. Iterate by index, not by accumulating floats.
  const tickEvery = spec.tickEvery ?? (spec.ticks ? undefined : 1);
  const addTick = (at: Pos, label: string | undefined) => {
    const tx = fmt(x(at));
    shapes.push(`<line class="tick" x1="${tx}" y1="${Y - 8}" x2="${tx}" y2="${Y + 8}"/>`);
    if (label !== undefined) {
      text.push(`<text class="label" x="${tx}" y="${Y + 34}" text-anchor="middle">${esc(label)}</text>`);
    }
  };
  if (tickEvery !== undefined) {
    const step = resolvePos(tickEvery);
    if (!(step > 0)) throw new Error(`numberLine tickEvery must be positive (got ${tickEvery})`);
    const labelStep = spec.labelEvery !== undefined ? resolvePos(spec.labelEvery) : step;
    // A fractional spacing "a/b" also sets how labels read: n/b (unsimplified,
    // that's how counting fractions is taught), collapsing to integers at
    // whole numbers — 0, 1/6, 2/6, …, 5/6, 1.
    const den = typeof tickEvery === "string" ? Number(tickEvery.split("/")[1]) : undefined;
    const count = Math.round((max - min) / step);
    for (let i = 0; i <= count; i++) {
      const v = min + i * step;
      const labeled = Math.abs((v - min) % labelStep) < 1e-9
        || Math.abs(((v - min) % labelStep) - labelStep) < 1e-9;
      let label = fmt(v);
      if (den) {
        const n = Math.round(v * den);
        if (Math.abs(v - n / den) < 1e-9) label = n % den === 0 ? String(n / den) : `${n}/${den}`;
      }
      addTick(v, labeled ? label : undefined);
    }
  }
  for (const t of spec.ticks ?? []) addTick(t.at, t.label ?? posLabel(t.at));

  // Shaded span sits on the baseline, under any marks (an open endpoint's
  // white fill must cover it). Thicker near-black, not a color — the palette
  // is grayscale-first, and thickness is what reads over the 2px axis.
  if (spec.shade) {
    const x1 = x(spec.shade.from);
    const x2 = spec.shade.arrow ? M + W + 45 : x(spec.shade.to);
    const arrow = spec.shade.arrow ? ` marker-end="url(#arrow)"` : "";
    shapes.push(
      `<line x1="${fmt(x1)}" y1="${Y}" x2="${fmt(x2)}" y2="${Y}" stroke="#333333" stroke-width="6"${arrow}/>`,
    );
  }

  for (const j of spec.jumps ?? []) {
    const x1 = x(j.from);
    const x2 = x(j.to);
    const apexY = Y - Math.min(70, Math.max(28, Math.abs(x2 - x1) * 0.35));
    const mid = (x1 + x2) / 2;
    shapes.push(
      `<path d="M ${fmt(x1)} ${Y - 10} Q ${fmt(mid)} ${fmt(apexY)} ${fmt(x2)} ${Y - 10}"` +
        ` fill="none" stroke="#333333" stroke-width="2.5" marker-end="url(#arrow)"/>`,
    );
    if (j.label !== undefined) {
      text.push(`<text class="label" x="${fmt(mid)}" y="${fmt(apexY - 8)}" text-anchor="middle">${esc(j.label)}</text>`);
    }
  }

  // Brackets sit below the tick labels (which end at Y+34).
  for (const b of spec.brackets ?? []) {
    const x1 = fmt(x(b.from));
    const x2 = fmt(x(b.to));
    shapes.push(
      `<path d="M ${x1} ${Y + 44} L ${x1} ${Y + 54} L ${x2} ${Y + 54} L ${x2} ${Y + 44}"` +
        ` fill="none" stroke="#333333" stroke-width="1.5"/>`,
    );
    if (b.label !== undefined) {
      const mid = fmt((x(b.from) + x(b.to)) / 2);
      text.push(`<text class="label" x="${mid}" y="${Y + 74}" text-anchor="middle">${esc(b.label)}</text>`);
    }
  }

  for (const m of spec.marks ?? []) {
    shapes.push(`<use href="#point-${m.style === "open" ? "open" : "closed"}" x="${fmt(x(m.at))}" y="${Y}"/>`);
  }

  // Text last so labels win against everything under them.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${M * 2 + W} 240">${shapes.join("")}${text.join("")}</svg>`;
};

/**
 * Render a vertical bar chart. Bar top = baseline − value·pxPerUnit, so "the
 * bar labeled 9 ends exactly at the 9 tick" holds by construction — the exact
 * property the judge's scale check hunts for.
 */
const renderBarChart = (spec: BarChartSpec): string => {
  const tickEvery = spec.tickEvery ?? 1;
  const maxValue = Math.max(...spec.bars.map((b) => b.value));
  const axisMax = spec.axisMax
    ?? Math.max(tickEvery, Math.ceil(maxValue / tickEvery) * tickEvery);
  const H = 360; // drawn height of the value axis
  const px = H / axisMax;
  const axisX = 80;
  const baseY = 440;
  const topY = baseY - H;
  const barW = 60;
  const gap = 30;
  const chartRight = axisX + gap + spec.bars.length * (barW + gap);

  const shapes: string[] = [];
  const text: string[] = [];

  // Gridlines + value-axis ticks/labels at every tick step.
  for (let v = 0; v <= axisMax + 1e-9; v += tickEvery) {
    const y = fmt(baseY - v * px);
    if (v > 0) shapes.push(`<line class="grid" x1="${axisX}" y1="${y}" x2="${chartRight}" y2="${y}"/>`);
    shapes.push(`<line class="tick" x1="${axisX - 6}" y1="${y}" x2="${axisX}" y2="${y}"/>`);
    text.push(`<text class="label" x="${axisX - 12}" y="${y}" text-anchor="end" dominant-baseline="middle">${fmt(v)}</text>`);
  }

  spec.bars.forEach((bar, i) => {
    const bx = axisX + gap + i * (barW + gap);
    const by = baseY - bar.value * px;
    const shade = bar.shade ?? (i % 4) + 1;
    shapes.push(
      `<rect class="shade-${shade}" x="${bx}" y="${fmt(by)}" width="${barW}" height="${fmt(bar.value * px)}"/>`,
    );
    text.push(
      `<text class="label" x="${bx + barW / 2}" y="${baseY + 26}" text-anchor="middle">${esc(bar.label)}</text>`,
    );
  });

  // Axes drawn after bars so the baseline stays crisp over bar bottoms.
  shapes.push(`<line class="axis" x1="${axisX}" y1="${topY - 10}" x2="${axisX}" y2="${baseY}"/>`);
  shapes.push(`<line class="axis" x1="${axisX}" y1="${baseY}" x2="${chartRight}" y2="${baseY}"/>`);

  if (spec.title !== undefined) {
    text.push(
      `<text class="title" x="${(axisX + chartRight) / 2}" y="${topY - 34}" text-anchor="middle">${esc(spec.title)}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${chartRight + 40} ${baseY + 60}">${shapes.join("")}${text.join("")}</svg>`;
};

/**
 * Render an analog clock. The poster child for templates: "hour hand just past
 * 3" at 3:15 is a precise 97.5° that code gets right and models don't — and a
 * hand-drawn face needs 60 minute-mark coordinates, which chronically blows
 * the generation token cap.
 */
const renderClock = (spec: ClockSpec): string => {
  const cx = 250;
  const cy = 250;
  const R = 200;
  // Angle helpers: degrees clockwise from 12 o'clock → canvas coordinates.
  const px = (deg: number, len: number) => fmt(cx + len * Math.sin((deg * Math.PI) / 180));
  const py = (deg: number, len: number) => fmt(cy - len * Math.cos((deg * Math.PI) / 180));

  const shapes: string[] = [];
  const text: string[] = [];

  shapes.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="#ffffff" stroke="#333333" stroke-width="4"/>`);
  for (let m = 0; m < 60; m++) {
    const deg = m * 6;
    const inner = m % 5 === 0 ? R - 18 : R - 10;
    const width = m % 5 === 0 ? 3 : 1.5;
    shapes.push(
      `<line x1="${px(deg, inner)}" y1="${py(deg, inner)}" x2="${px(deg, R)}" y2="${py(deg, R)}"` +
        ` stroke="#333333" stroke-width="${width}"/>`,
    );
  }
  for (let n = 1; n <= 12; n++) {
    const deg = n * 30;
    text.push(
      `<text x="${px(deg, R - 44)}" y="${py(deg, R - 44)}" font-size="34" fill="#111111"` +
        ` text-anchor="middle" dominant-baseline="central">${n}</text>`,
    );
  }
  if (spec.time) {
    const hourDeg = ((spec.time.hour % 12) + spec.time.minute / 60) * 30;
    const minuteDeg = spec.time.minute * 6;
    shapes.push(
      `<line x1="${cx}" y1="${cy}" x2="${px(hourDeg, R * 0.5)}" y2="${py(hourDeg, R * 0.5)}"` +
        ` stroke="#333333" stroke-width="10" stroke-linecap="round"/>`,
      `<line x1="${cx}" y1="${cy}" x2="${px(minuteDeg, R * 0.8)}" y2="${py(minuteDeg, R * 0.8)}"` +
        ` stroke="#333333" stroke-width="5" stroke-linecap="round"/>`,
    );
  }
  shapes.push(`<circle cx="${cx}" cy="${cy}" r="9" fill="#333333"/>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500">${shapes.join("")}${text.join("")}</svg>`;
};

/**
 * Render a coordinate plane. Axes (with arrowheads) run through 0 when 0 is
 * inside the range, else along the grid edge; every plotted point lands at
 * exactly (x, y) by construction.
 */
const renderCoordinatePlane = (spec: CoordinatePlaneSpec): string => {
  const { xMin, xMax, yMin, yMax } = spec;
  if (!(xMax > xMin) || !(yMax > yMin)) {
    throw new Error(`coordinatePlane needs xMax > xMin and yMax > yMin`);
  }
  const U = 40;
  const M = 60;
  const px = (x: number) => M + (x - xMin) * U;
  const py = (y: number) => M + (yMax - y) * U;
  const labelEvery = spec.labelEvery ?? 1;

  const shapes: string[] = [];
  const text: string[] = [];

  for (let x = Math.ceil(xMin); x <= xMax; x++) {
    shapes.push(`<line class="grid" x1="${px(x)}" y1="${py(yMax)}" x2="${px(x)}" y2="${py(yMin)}"/>`);
  }
  for (let y = Math.ceil(yMin); y <= yMax; y++) {
    shapes.push(`<line class="grid" x1="${px(xMin)}" y1="${py(y)}" x2="${px(xMax)}" y2="${py(y)}"/>`);
  }

  // Axis positions: through 0 when it's in range, else along the near edge.
  // Arrowheads only where the plane actually continues — a first-quadrant
  // grid gets arrows on +x/+y only, a four-quadrant plane on all four ends.
  const axisY = yMin <= 0 && 0 <= yMax ? 0 : yMin; // the x-axis's y
  const axisX = xMin <= 0 && 0 <= xMax ? 0 : xMin; // the y-axis's x
  // Each arrowed direction is its own line drawn outward from the crossing
  // with marker-end — marker-start is unusable (resvg orients it backward,
  // into the line; see the note on SVG_VOCABULARY_DEFS).
  const xNeg = xMin < axisX;
  const yNeg = yMin < axisY;
  shapes.push(
    `<line class="axis" x1="${px(axisX)}" y1="${py(axisY)}" x2="${px(xMax) + 20}" y2="${py(axisY)}" marker-end="url(#arrow)"/>`,
    xNeg
      ? `<line class="axis" x1="${px(axisX)}" y1="${py(axisY)}" x2="${px(xMin) - 20}" y2="${py(axisY)}" marker-end="url(#arrow)"/>`
      : `<line class="axis" x1="${px(xMin)}" y1="${py(axisY)}" x2="${px(axisX)}" y2="${py(axisY)}"/>`,
    `<line class="axis" x1="${px(axisX)}" y1="${py(axisY)}" x2="${px(axisX)}" y2="${py(yMax) - 20}" marker-end="url(#arrow)"/>`,
    yNeg
      ? `<line class="axis" x1="${px(axisX)}" y1="${py(axisY)}" x2="${px(axisX)}" y2="${py(yMin) + 20}" marker-end="url(#arrow)"/>`
      : `<line class="axis" x1="${px(axisX)}" y1="${py(yMin)}" x2="${px(axisX)}" y2="${py(axisY)}"/>`,
  );
  text.push(
    `<text class="label" x="${px(xMax) + 34}" y="${py(axisY) + 5}" text-anchor="middle">x</text>`,
    `<text class="label" x="${px(axisX)}" y="${py(yMax) - 30}" text-anchor="middle">y</text>`,
  );

  // Axis numbers sit just outside their axis; 0 appears once, by the origin.
  for (let x = Math.ceil(xMin / labelEvery) * labelEvery; x <= xMax; x += labelEvery) {
    if (x === axisX) continue;
    text.push(`<text class="label" x="${px(x)}" y="${py(axisY) + 24}" text-anchor="middle">${fmt(x)}</text>`);
  }
  for (let y = Math.ceil(yMin / labelEvery) * labelEvery; y <= yMax; y += labelEvery) {
    if (y === axisY) continue;
    text.push(`<text class="label" x="${px(axisX) - 10}" y="${py(y) + 5}" text-anchor="end">${fmt(y)}</text>`);
  }
  if (axisX === 0 && axisY === 0) {
    text.push(`<text class="label" x="${px(0) - 10}" y="${py(0) + 24}" text-anchor="end">0</text>`);
  }

  for (const p of spec.points ?? []) {
    shapes.push(`<use href="#point-closed" x="${fmt(px(p.x))}" y="${fmt(py(p.y))}"/>`);
    if (p.label !== undefined) {
      text.push(`<text class="label" x="${fmt(px(p.x) + 12)}" y="${fmt(py(p.y) - 12)}">${esc(p.label)}</text>`);
    }
  }

  const w = px(xMax) + M + 40;
  const h = py(yMin) + M;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${shapes.join("")}${text.join("")}</svg>`;
};

/** Render a line plot: a number-line axis with counted dot stacks above it. */
const renderLinePlot = (spec: LinePlotSpec): string => {
  const { min, max } = spec;
  if (!(max > min)) throw new Error(`linePlot needs max > min (got ${min}..${max})`);
  const W = 700;
  const M = 60;
  const maxCount = Math.max(...spec.dots.map((d) => Math.round(d.count)), 1);
  const Y = 80 + maxCount * 26; // baseline low enough for the tallest stack
  const x = (pos: Pos) => M + ((resolvePos(pos) - min) / (max - min)) * W;

  const shapes: string[] = [];
  const text: string[] = [];

  shapes.push(`<line class="axis" x1="${M - 15}" y1="${Y}" x2="${M + W + 15}" y2="${Y}"/>`);
  const step = resolvePos(spec.tickEvery ?? 1);
  if (!(step > 0)) throw new Error(`linePlot tickEvery must be positive`);
  const count = Math.round((max - min) / step);
  for (let i = 0; i <= count; i++) {
    const v = min + i * step;
    const tx = fmt(x(v));
    shapes.push(`<line class="tick" x1="${tx}" y1="${Y - 8}" x2="${tx}" y2="${Y + 8}"/>`);
    text.push(`<text class="label" x="${tx}" y="${Y + 34}" text-anchor="middle">${fmt(v)}</text>`);
  }

  for (const d of spec.dots) {
    const tx = fmt(x(d.at));
    for (let i = 0; i < Math.round(d.count); i++) {
      shapes.push(`<use href="#dot-filled" x="${tx}" y="${fmt(Y - 22 - i * 26)}"/>`);
    }
  }

  if (spec.axisLabel !== undefined) {
    text.push(`<text class="label" x="${M + W / 2}" y="${Y + 66}" text-anchor="middle">${esc(spec.axisLabel)}</text>`);
  }
  if (spec.title !== undefined) {
    text.push(`<text class="title" x="${M + W / 2}" y="36" text-anchor="middle">${esc(spec.title)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${M * 2 + W} ${Y + 90}">${shapes.join("")}${text.join("")}</svg>`;
};

/**
 * Render fraction bars / measurement strips. Part boundaries are tiled exactly
 * (one part = width / count, shared edges) — the arithmetic that produced
 * "three 60px parts with gaps inside a 200px border" on the raw path. All bars
 * share one drawn length and a left edge, so equivalence comparisons line up.
 */
const renderFractionBar = (spec: FractionBarSpec): string => {
  const bars = spec.bars.map((bar) => {
    const parts = bar.parts !== undefined
      ? Math.round(bar.parts)
      : bar.total !== undefined && bar.partSize !== undefined
        ? Math.round(bar.total / resolvePos(bar.partSize))
        : undefined;
    if (!parts || parts < 1) {
      throw new Error(`fractionBar bar needs parts, or total + partSize`);
    }
    return { ...bar, parts };
  });

  // Wide enough that a per-part label ("1/4 ft") fits in every part.
  const W = Math.max(720, 60 * Math.max(...bars.filter((b) => b.partLabel !== undefined).map((b) => b.parts), 0));
  const M = 40;
  const barH = 70;
  const gap = 56;

  const shapes: string[] = [];
  const text: string[] = [];
  let y = 20;

  for (const bar of bars) {
    if (bar.label !== undefined) {
      text.push(`<text class="label" x="${M + W / 2}" y="${y + 8}" text-anchor="middle">${esc(bar.label)}</text>`);
      y += 24;
    }
    const partW = W / bar.parts;
    const shaded = Math.round(bar.shaded ?? 0);
    for (let i = 0; i < bar.parts; i++) {
      const bx = M + i * partW;
      const fill = i < shaded ? ` class="shaded"` : ` fill="none"`;
      shapes.push(
        `<rect x="${fmt(bx)}" y="${y}" width="${fmt(partW)}" height="${barH}"${fill}` +
          ` stroke="#333333" stroke-width="1.5"/>`,
      );
      if (bar.partLabel !== undefined) {
        text.push(
          `<text class="label" x="${fmt(bx + partW / 2)}" y="${y + barH / 2 + 5}" text-anchor="middle">${esc(bar.partLabel)}</text>`,
        );
      }
    }
    // A crisp outer border over the shared part edges.
    shapes.push(`<rect x="${M}" y="${y}" width="${W}" height="${barH}" fill="none" stroke="#333333" stroke-width="3"/>`);
    y += barH + gap;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${M * 2 + W} ${y - gap + 20}">${shapes.join("")}${text.join("")}</svg>`;
};

/** Render a circle in `parts` equal sectors, the first `shaded` filled. */
const renderFractionCircle = (spec: FractionCircleSpec): string => {
  const parts = Math.round(spec.parts);
  const shaded = Math.round(spec.shaded);
  if (parts < 1) throw new Error(`fractionCircle needs parts >= 1`);
  const cx = 220;
  const cy = 220;
  const r = 180;

  if (parts === 1) {
    const fill = shaded >= 1 ? ` class="shaded"` : ` fill="none"`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 440">` +
      `<circle cx="${cx}" cy="${cy}" r="${r}"${fill} stroke="#333333" stroke-width="2.5"/></svg>`;
  }

  const shapes: string[] = [];
  // Sectors start at 12 o'clock and sweep clockwise, shaded ones first.
  const pt = (i: number) => {
    const a = (i / parts) * 2 * Math.PI - Math.PI / 2;
    return `${fmt(cx + r * Math.cos(a))} ${fmt(cy + r * Math.sin(a))}`;
  };
  for (let i = 0; i < parts; i++) {
    const fill = i < shaded ? ` class="shaded"` : ` fill="none"`;
    shapes.push(
      `<path d="M ${cx} ${cy} L ${pt(i)} A ${r} ${r} 0 0 1 ${pt(i + 1)} Z"${fill}` +
        ` stroke="#333333" stroke-width="2.5"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 440">${shapes.join("")}</svg>`;
};

/**
 * Render ten-frames: a 2×5 grid of cells, counters filling left-to-right, top
 * row first — the layout every K-1 curriculum draws. Cells tile exactly (the
 * partition rule), counters reuse the vocabulary's #dot symbols.
 */
const renderTenFrame = (spec: TenFrameSpec): string => {
  const frames = Math.round(spec.frames ?? 1);
  const filled = Math.round(spec.filled);
  const C = 80; // cell size
  const gap = 60; // between frames
  const shapes: string[] = [];

  for (let f = 0; f < frames; f++) {
    const ox = 20 + f * (5 * C + gap);
    const oy = 20;
    for (let i = 0; i < 10; i++) {
      const row = Math.floor(i / 5);
      const col = i % 5;
      const x = ox + col * C;
      const y = oy + row * C;
      shapes.push(`<rect x="${x}" y="${y}" width="${C}" height="${C}" fill="none" stroke="#333333" stroke-width="1.5"/>`);
      if (i < filled) {
        shapes.push(`<circle cx="${x + C / 2}" cy="${y + C / 2}" r="${C * 0.32}" fill="#333333"/>`);
      }
    }
    // Crisp outer border over the shared cell edges, matching fractionBar.
    shapes.push(`<rect x="${ox}" y="${oy}" width="${5 * C}" height="${2 * C}" fill="none" stroke="#333333" stroke-width="3"/>`);
  }

  const w = 40 + frames * 5 * C + (frames - 1) * gap;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${2 * C + 40}">${shapes.join("")}</svg>`;
};

/**
 * Render dot arrays: rows×cols circles per group, groups side by side. The
 * cell-count rule holds by construction — an m×n group contains exactly m·n
 * dots, the first `shaded` (row-major) filled in the group's color.
 */
const renderDotArray = (spec: DotArraySpec): string => {
  const S = 64; // dot pitch
  const R = 22; // dot radius
  const gap = 80; // between groups
  const shapes: string[] = [];
  const text: string[] = [];
  let ox = 40;
  let maxRows = 0;

  spec.groups.forEach((g, gi) => {
    const rows = Math.round(g.rows);
    const cols = Math.round(g.cols);
    maxRows = Math.max(maxRows, rows);
    const shaded = Math.round(g.shaded ?? rows * cols);
    // Default cycle starts at the color slots (2, 3, 4, then gray): dot
    // groups exist to be told apart, and "colorful" requests picked gray
    // when the cycle led with shade-1.
    const shade = g.shade ?? ([2, 3, 4, 1][gi % 4] as 1 | 2 | 3 | 4);
    for (let i = 0; i < rows * cols; i++) {
      const cx = ox + (i % cols) * S + S / 2;
      const cy = 40 + Math.floor(i / cols) * S + S / 2;
      shapes.push(
        i < shaded
          ? `<circle class="shade-${shade}" cx="${cx}" cy="${cy}" r="${R}" stroke="#333333" stroke-width="1.5"/>`
          : `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#333333" stroke-width="1.5"/>`,
      );
    }
    if (g.label !== undefined) {
      text.push(`<text class="label" x="${ox + (cols * S) / 2}" y="${40 + rows * S + 36}" text-anchor="middle">${esc(g.label)}</text>`);
    }
    ox += cols * S + gap;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ox - gap + 40} ${maxRows * S + 120}">${shapes.join("")}${text.join("")}</svg>`;
};

/**
 * Render an area model: a rectangle tiled into a rows×cols grid of equal unit
 * squares, with optional dimension labels beside brackets. Exactly rows·cols
 * cells, shared edges — the tiling the raw path kept getting wrong.
 */
const renderAreaGrid = (spec: AreaGridSpec): string => {
  const rows = Math.round(spec.rows);
  const cols = Math.round(spec.cols);
  const C = 70;
  const M = 70; // room for dimension labels
  const shapes: string[] = [];
  const text: string[] = [];
  const shaded = Math.round(spec.shaded ?? 0);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const fill = r * cols + c < shaded ? ` class="shaded"` : ` fill="none"`;
      shapes.push(`<rect x="${M + c * C}" y="${M + r * C}" width="${C}" height="${C}"${fill} stroke="#333333" stroke-width="1.5"/>`);
    }
  }
  shapes.push(`<rect x="${M}" y="${M}" width="${cols * C}" height="${rows * C}" fill="none" stroke="#333333" stroke-width="3"/>`);

  if (spec.colLabel !== undefined) {
    text.push(`<text class="label" x="${M + (cols * C) / 2}" y="${M - 24}" text-anchor="middle">${esc(spec.colLabel)}</text>`);
  }
  if (spec.rowLabel !== undefined) {
    text.push(`<text class="label" x="${M - 24}" y="${M + (rows * C) / 2 + 5}" text-anchor="end">${esc(spec.rowLabel)}</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${M * 2 + cols * C} ${M * 2 + rows * C}">${shapes.join("")}${text.join("")}</svg>`;
};

/**
 * Render base-ten blocks: hundred-flats as 10×10 grids, ten-rods as 1×10
 * strips, unit cubes as single squares — grouped left to right with clear
 * separation, every internal line computed by tiling.
 */
const renderBaseTenBlocks = (spec: BaseTenBlocksSpec): string => {
  const u = 16; // one unit square, small enough that flats stay printable
  const gap = 50; // between groups
  const inner = 14; // between blocks in a group
  const shapes: string[] = [];
  const grid = (x: number, y: number, rows: number, cols: number) => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        shapes.push(`<rect x="${x + c * u}" y="${y + r * u}" width="${u}" height="${u}" class="shaded" stroke="#333333" stroke-width="1"/>`);
      }
    }
    shapes.push(`<rect x="${x}" y="${y}" width="${cols * u}" height="${rows * u}" fill="none" stroke="#333333" stroke-width="2.5"/>`);
  };

  const hundreds = Math.round(spec.hundreds);
  const tens = Math.round(spec.tens);
  const ones = Math.round(spec.ones);
  let x = 30;
  const y = 30;
  for (let i = 0; i < hundreds; i++) {
    grid(x, y, 10, 10);
    x += 10 * u + inner;
  }
  if (hundreds > 0) x += gap - inner;
  for (let i = 0; i < tens; i++) {
    grid(x, y, 10, 1);
    x += u + inner;
  }
  if (tens > 0) x += gap - inner;
  for (let i = 0; i < ones; i++) {
    grid(x, y, 1, 1);
    x += u + inner;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + 30 - inner} ${10 * u + 60}">${shapes.join("")}</svg>`;
};

/**
 * Render a labeled 2-D shape. Numeric base/height set the drawn proportions
 * (legs labeled 6 and 8 really draw 3:4 — the one-scale rule the judge checks);
 * the right angle uses the vocabulary's #right-angle mark.
 */
const renderShape = (spec: ShapeSpec): string => {
  const base = spec.base ?? 8;
  const height = spec.height ?? 5;
  // One scale for both dims, sized so the longer edge draws ~560px.
  const s = 560 / Math.max(base, height);
  const W = base * s;
  const H = height * s;
  const M = 80;
  const shapes: string[] = [];
  const text: string[] = [];

  if (spec.shape === "rightTriangle") {
    // Right angle at the bottom-left corner; hypotenuse from top of the
    // vertical leg to the end of the horizontal leg.
    const x0 = M;
    const y0 = M + H; // the right-angle corner
    shapes.push(
      `<path d="M ${x0} ${fmt(y0 - H)} L ${x0} ${y0} L ${fmt(x0 + W)} ${y0} Z" fill="none" stroke="#333333" stroke-width="2.5"/>`,
      `<use href="#right-angle" x="${x0}" y="${y0}"/>`,
    );
    if (spec.heightLabel !== undefined) {
      text.push(`<text class="label" x="${x0 - 14}" y="${fmt(y0 - H / 2 + 5)}" text-anchor="end">${esc(spec.heightLabel)}</text>`);
    }
    if (spec.baseLabel !== undefined) {
      text.push(`<text class="label" x="${fmt(x0 + W / 2)}" y="${y0 + 30}" text-anchor="middle">${esc(spec.baseLabel)}</text>`);
    }
    if (spec.hypotenuseLabel !== undefined) {
      text.push(`<text class="label" x="${fmt(x0 + W / 2 + 16)}" y="${fmt(y0 - H / 2 - 16)}">${esc(spec.hypotenuseLabel)}</text>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(W + 2 * M)} ${fmt(H + 2 * M)}">${shapes.join("")}${text.join("")}</svg>`;
  }

  // Parallelogram: bottom edge on the baseline, slanted right by a fixed
  // offset; the height draws as a dashed interior altitude when labeled.
  const slant = Math.min(120, W * 0.25);
  const x0 = M;
  const y0 = M + H;
  const p = [
    [x0, y0], // bottom-left
    [x0 + W, y0], // bottom-right
    [x0 + W + slant, y0 - H], // top-right
    [x0 + slant, y0 - H], // top-left
  ] as const;
  shapes.push(
    `<path d="M ${p.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(" L ")} Z" fill="none" stroke="#333333" stroke-width="2.5"/>`,
  );
  if (spec.diagonal) {
    shapes.push(`<line x1="${fmt(p[0][0])}" y1="${fmt(p[0][1])}" x2="${fmt(p[2][0])}" y2="${fmt(p[2][1])}" stroke="#333333" stroke-width="2"/>`);
  }
  if (spec.baseLabel !== undefined) {
    text.push(`<text class="label" x="${fmt(x0 + W / 2)}" y="${y0 + 30}" text-anchor="middle">${esc(spec.baseLabel)}</text>`);
  }
  if (spec.heightLabel !== undefined) {
    // Dashed altitude dropped from the top edge, far enough right that the
    // bottom-left → top-right diagonal crosses it near the top and the
    // mid-height label stays clear.
    const hx = x0 + slant + W * 0.82;
    shapes.push(
      `<line x1="${fmt(hx)}" y1="${fmt(y0 - H)}" x2="${fmt(hx)}" y2="${y0}" stroke="#333333" stroke-width="2" stroke-dasharray="8 6"/>`,
      `<use href="#right-angle" x="${fmt(hx)}" y="${y0}"/>`,
    );
    text.push(`<text class="label" x="${fmt(hx + 12)}" y="${fmt(y0 - H / 2 + 5)}">${esc(spec.heightLabel)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(W + slant + 2 * M)} ${fmt(H + 2 * M)}">${shapes.join("")}${text.join("")}</svg>`;
};

/**
 * Render rectangular prisms in cabinet projection (depth at 45° and half
 * scale — the standard textbook look): front face true-size, computed
 * vertices, hidden edges dashed. Labels sit along the bottom-front (width),
 * left-front (height), and receding bottom-right (depth) edges.
 */
const renderRectPrism = (spec: RectPrismSpec): string => {
  const shapes: string[] = [];
  const text: string[] = [];
  const gap = 110;
  let ox = 60;
  let maxH = 0;

  spec.prisms.forEach((prism, i) => {
    const w = prism.width ?? 4;
    const h = prism.height ?? 3;
    const d = prism.depth ?? 2;
    const s = 320 / Math.max(w, h, d * 0.5 + w); // keep each prism ~320-420px
    const W = w * s;
    const H = h * s;
    const D = d * s * 0.5; // cabinet: depth at half scale
    const dx = D * Math.SQRT1_2;
    const dy = D * Math.SQRT1_2;
    const shade = prism.shade ?? ((i % 4) + 1);
    maxH = Math.max(maxH, H + dy);

    // Front face corners (top-left origin at ox, oy); back face offset +dx,-dy.
    const oy = 60 + dy + (maxH - (H + dy)); // top margin leaves room for the back face
    const f = { x: ox, y: oy };
    const faces = {
      // Painted back-to-front so shared edges read correctly.
      top: `M ${fmt(f.x)} ${fmt(f.y)} L ${fmt(f.x + dx)} ${fmt(f.y - dy)} L ${fmt(f.x + dx + W)} ${fmt(f.y - dy)} L ${fmt(f.x + W)} ${fmt(f.y)} Z`,
      side: `M ${fmt(f.x + W)} ${fmt(f.y)} L ${fmt(f.x + dx + W)} ${fmt(f.y - dy)} L ${fmt(f.x + dx + W)} ${fmt(f.y - dy + H)} L ${fmt(f.x + W)} ${fmt(f.y + H)} Z`,
      front: `M ${fmt(f.x)} ${fmt(f.y)} L ${fmt(f.x + W)} ${fmt(f.y)} L ${fmt(f.x + W)} ${fmt(f.y + H)} L ${fmt(f.x)} ${fmt(f.y + H)} Z`,
    };
    // Top and side take a lightened version of the front's color by drawing
    // the same class under a translucent white — keeps to the vocabulary
    // palette without inventing new fills.
    for (const face of [faces.top, faces.side]) {
      shapes.push(
        `<path d="${face}" class="shade-${shade}" stroke="none"/>`,
        `<path d="${face}" fill="#ffffff" fill-opacity="0.55" stroke="#333333" stroke-width="2"/>`,
      );
    }
    shapes.push(`<path d="${faces.front}" class="shade-${shade}" stroke="#333333" stroke-width="2.5"/>`);
    // Hidden edges, dashed: the far bottom edge pair and the back-left vertical.
    shapes.push(
      `<path d="M ${fmt(f.x)} ${fmt(f.y + H)} L ${fmt(f.x + dx)} ${fmt(f.y - dy + H)} L ${fmt(f.x + dx + W)} ${fmt(f.y - dy + H)}" fill="none" stroke="#333333" stroke-width="1.5" stroke-dasharray="7 6"/>`,
      `<line x1="${fmt(f.x + dx)}" y1="${fmt(f.y - dy)}" x2="${fmt(f.x + dx)}" y2="${fmt(f.y - dy + H)}" stroke="#333333" stroke-width="1.5" stroke-dasharray="7 6"/>`,
    );

    if (prism.widthLabel !== undefined) {
      text.push(`<text class="label" x="${fmt(f.x + W / 2)}" y="${fmt(f.y + H + 30)}" text-anchor="middle">${esc(prism.widthLabel)}</text>`);
    }
    if (prism.heightLabel !== undefined) {
      text.push(`<text class="label" x="${fmt(f.x - 12)}" y="${fmt(f.y + H / 2 + 5)}" text-anchor="end">${esc(prism.heightLabel)}</text>`);
    }
    if (prism.depthLabel !== undefined) {
      text.push(`<text class="label" x="${fmt(f.x + W + dx / 2 + 14)}" y="${fmt(f.y + H - dy / 2 + 24)}">${esc(prism.depthLabel)}</text>`);
    }

    ox += W + dx + gap;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(ox - gap + 60)} ${fmt(maxH + 160)}">${shapes.join("")}${text.join("")}</svg>`;
};

/** Spec → SVG string, ready for the same prepareSvg/renderPng path as raw SVG. */
export const renderSpec = (spec: DiagramSpec): string => {
  switch (spec.kind) {
    case "numberLine": return renderNumberLine(spec);
    case "barChart": return renderBarChart(spec);
    case "clock": return renderClock(spec);
    case "coordinatePlane": return renderCoordinatePlane(spec);
    case "linePlot": return renderLinePlot(spec);
    case "fractionBar": return renderFractionBar(spec);
    case "fractionCircle": return renderFractionCircle(spec);
    case "tenFrame": return renderTenFrame(spec);
    case "dotArray": return renderDotArray(spec);
    case "areaGrid": return renderAreaGrid(spec);
    case "baseTenBlocks": return renderBaseTenBlocks(spec);
    case "shape": return renderShape(spec);
    case "rectPrism": return renderRectPrism(spec);
  }
};

/**
 * The prompt-facing documentation of `DiagramSpec` — what the generator's
 * system prompt teaches the model. Kept adjacent to the schema so they can't
 * drift (same pattern as SVG_VOCABULARY_DEFS / SVG_VOCABULARY_GUIDE).
 */
/**
 * The guide is assembled from per-kind sections so a router can send the
 * model only the kinds a request might need (ROUTED_PROMPT=1 in
 * generator.ts) — the full SPEC_GUIDE below is the same sections, all of
 * them. Keep each section in lockstep with its Schema above.
 */
export const SPEC_GUIDE_SECTIONS: Record<DiagramSpec["kind"], string> = {
  numberLine: `numberLine fields:
- kind: "numberLine", min: number, max: number (required)
- tickEvery?: Pos — spacing of regular ticks (default 1). A fraction spacing like "1/6" also labels the ticks as sixths: 0, 1/6, 2/6, ... Omit when only custom ticks are wanted.
- labelEvery?: Pos — label the regular ticks at this spacing (default: every tick)
- ticks?: [{ at: Pos, label?: string }] — extra ticks at exact positions (fraction ticks)
- marks?: [{ at: Pos, style: "open" | "closed" }] — endpoint dots (open = value excluded)
- shade?: { from: Pos, to: Pos, arrow?: boolean } — accent-colored span on the line; arrow: true extends it past the end with an arrowhead (inequality rays)
- jumps?: [{ from: Pos, to: Pos, label?: string }] — labeled hop arcs above the line
- brackets?: [{ from: Pos, to: Pos, label?: string }] — section brackets below the line

Example — the inequality x > 3 on a 0-10 line:
\`\`\`json
{ "kind": "numberLine", "min": 0, "max": 10, "tickEvery": 1,
  "marks": [{ "at": 3, "style": "open" }],
  "shade": { "from": 3, "to": 10, "arrow": true } }
\`\`\``,
  barChart: `barChart fields:
- kind: "barChart", bars: [{ label: string, value: number, shade?: 1|2|3|4 }] (required; bars get distinct colors automatically — set shade only to override)
- title?: string
- tickEvery?: value-axis tick spacing (default 1)
- axisMax?: top of the value axis (default: highest bar, rounded up to a tick)

Example:
\`\`\`json
{ "kind": "barChart", "title": "Animals at the Zoo", "axisMax": 10,
  "bars": [{ "label": "Lions", "value": 9 }, { "label": "Tigers", "value": 6 }] }
\`\`\``,
  clock: `clock fields (analog clock face):
- kind: "clock"
- time?: { hour: 1-12, minute: 0-59 } — omit \`time\` entirely for a blank practice face. The face, numbers 1-12, and minute marks are always drawn; hand angles are computed exactly (the hour hand advances as minutes pass — at 3:15 it sits just past the 3).`,
  coordinatePlane: `coordinatePlane fields (coordinate grid / plane with axes):
- kind: "coordinatePlane", xMin, xMax, yMin, yMax (required)
- labelEvery?: axis-number spacing (default 1)
- points?: [{ x, y, label?: string }] — plotted exactly; label like "(-3, 2)". Omit for a blank grid for students to plot on.
Gridlines at every integer; axes with arrowheads run through 0 when 0 is in range.`,
  linePlot: `linePlot fields (dots stacked above a number line):
- kind: "linePlot", min, max, dots: [{ at: Pos, count: number }] (required) — \`count\` dots stacked at each position
- tickEvery?, title?, axisLabel? (caption under the axis, e.g. "Hours")`,
  fractionBar: `fractionBar fields (fraction bars, tape diagrams, measurement strips; one or more equal-length horizontal bars):
- kind: "fractionBar", bars: [...] — each bar is EITHER
  - { parts, shaded? }: N equal parts with the first \`shaded\` filled — e.g. { "parts": 3, "shaded": 2 } for 2/3
  - OR { total, partSize, partLabel?, label? }: a strip of length \`total\` tiled with parts of size \`partSize\` — the renderer computes how many parts fit; NEVER compute the count yourself. E.g. a 6-foot strip in 1/4-foot pieces: { "total": 6, "partSize": "1/4", "partLabel": "1/4 ft", "label": "6 feet" }
- bars stack vertically, aligned left, all the same drawn length — right for equivalent-fraction comparisons.`,
  fractionCircle: `fractionCircle fields (a circle in equal sectors):
- kind: "fractionCircle", parts: number, shaded: number — e.g. { "kind": "fractionCircle", "parts": 8, "shaded": 5 } for five-eighths.`,
  tenFrame: `tenFrame fields (the 2-by-5 counting grid):
- kind: "tenFrame", filled: 0-10 — counters fill left-to-right, top row first
- frames?: number — side-by-side identical frames (default 1)`,
  dotArray: `dotArray fields (dot/set arrays; groups of dots in rows and columns):
- kind: "dotArray", groups: [{ rows, cols, shaded?, shade?, label? }] (required) — groups draw side by side. \`shaded\`: the first N dots (row-major) fill in the group's color, the rest draw as empty circles (default: all filled). \`shade\`: 1|2|3|4 color slot (defaults cycle through the colored slots by group; for colorful/decorative requests give each group a different shade of 2, 3, or 4 — 1 is gray). \`label\`: caption under the group.
- One group = a set model (12 circles, 9 shaded → { "rows": 3, "cols": 4, "shaded": 9 }); two groups = an addition model.`,
  areaGrid: `areaGrid fields (an area model: a rectangle tiled into countable unit squares):
- kind: "areaGrid", rows: number, cols: number (required)
- rowLabel? / colLabel?: dimension labels beside/above the grid, e.g. "4" and "6"
- shaded?: number — the first N cells (row-major) filled`,
  baseTenBlocks: `baseTenBlocks fields (place-value blocks):
- kind: "baseTenBlocks", hundreds, tens, ones (required) — hundred-flats (10×10), ten-rods (1×10), unit cubes, grouped left to right with clear separation.`,
  shape: `shape fields (a labeled 2-D figure):
- kind: "shape", shape: "rightTriangle" | "parallelogram" (required)
- base? / height?: numbers setting the drawn proportions — pass the labeled measurements (legs 6 cm and 8 cm → base: 8, height: 6) so the drawing is to scale
- baseLabel? / heightLabel?: edge labels, e.g. "8 cm". For rightTriangle, heightLabel is the vertical leg. For parallelogram, the height draws as a dashed interior altitude with a right-angle mark.
- hypotenuseLabel?: rightTriangle only — omit to leave the hypotenuse unlabeled
- diagonal?: parallelogram only — true draws a corner-to-corner diagonal splitting it into two triangles

Example — legs 6 cm and 8 cm, right angle marked, hypotenuse blank:
\`\`\`json
{ "kind": "shape", "shape": "rightTriangle", "base": 8, "height": 6,
  "baseLabel": "8 cm", "heightLabel": "6 cm" }
\`\`\``,
  rectPrism: `rectPrism fields (rectangular prisms drawn in 3-D):
- kind: "rectPrism", prisms: [{ width?, height?, depth?, widthLabel?, heightLabel?, depthLabel?, shade? }] (required) — prisms draw side by side, hidden edges dashed. Dimensions are relative proportions (default 4×3×2); pass the labeled measurements when given (5 × 3 × 2 → width: 5, depth: 3, height: 2). Labels are free text ("5 units"); omit any the request doesn't give. \`shade\`: 1|2|3|4 color slot (defaults cycle), so multiple prisms come out visually distinct.`,
};

const SPEC_GUIDE_PREAMBLE = `Positions ("Pos" below) are a number or a fraction string like "2/3" — prefer the fraction string for any non-integer position, and NEVER do the division yourself. A fraction position used as a tick is labeled as written (e.g. "2/6").`;

const SPEC_GUIDE_CLOSING = `NOT these kinds — use raw SVG instead: composite/irregular figures, geometry the fields above can't express, pictures and scenes, anything without a matching kind.`;

export const ALL_SPEC_KINDS = Object.keys(SPEC_GUIDE_SECTIONS) as DiagramSpec["kind"][];

/** Assemble the prompt-facing guide for a subset of kinds (or all of them). */
export const specGuideFor = (kinds: readonly DiagramSpec["kind"][]): string =>
  `${kinds.length} spec kinds are available — ${kinds.map((k) => `"${k}"`).join(", ")}. Never invent other kinds.

${SPEC_GUIDE_PREAMBLE}

${kinds.map((k) => SPEC_GUIDE_SECTIONS[k]).join("\n\n")}

${SPEC_GUIDE_CLOSING}`;

/**
 * The prompt-facing documentation of `DiagramSpec`, all kinds — what the
 * generator's system prompt teaches by default. Kept adjacent to the schema
 * so they can't drift (same pattern as SVG_VOCABULARY_DEFS / _GUIDE).
 */
export const SPEC_GUIDE = specGuideFor(ALL_SPEC_KINDS);
