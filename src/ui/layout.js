import { Widget } from './widget.js';
import { card, field } from '../gfx/skin.js';

/** Layout containers: <row>, <column>, <grid>, <panel>, <spacer>. */

const ALIGN = ['start', 'center', 'end', 'stretch'];
const JUSTIFY = ['start', 'center', 'end'];

/** padding="4" or padding="4 8" (vertical horizontal). */
function padding(value = '0') {
  const [v, h = v] = String(value).trim().split(/\s+/).map(Number);
  return { v: v || 0, h: h || 0 };
}

export class Flex extends Widget {
  static attrs = { ...Widget.attrs, gap: 'number', padding: 'string', align: 'string', justify: 'string', wrap: 'boolean' };
  static container = true;

  constructor(ui, props, horizontal) {
    super(ui, props);
    this.horizontal = horizontal;
    this.pad = padding(props.padding);
    this.gap = props.gap ?? 0;
    this.align = props.align ?? 'stretch';
    this.justify = props.justify ?? 'start';
    if (!ALIGN.includes(this.align)) throw new Error(`align="${this.align}" must be one of ${ALIGN.join(', ')}`);
    if (!JUSTIFY.includes(this.justify)) throw new Error(`justify="${this.justify}" must be one of ${JUSTIFY.join(', ')}`);
  }

  get flow() {
    return this.children.filter(child => child.visible);
  }

  content(maxW, maxH) {
    if (this.horizontal && this.props.wrap && Number.isFinite(maxW)) return this.wrapRows(maxW);
    const { horizontal, pad, gap } = this;
    let main = 0;
    let cross = 0;
    const kids = this.flow;
    for (const kid of kids) {
      const size = kid.measure(maxW - 2 * pad.h, maxH - 2 * pad.v);
      main += horizontal ? size.w : size.h;
      cross = Math.max(cross, horizontal ? size.h : size.w);
    }
    main += gap * Math.max(0, kids.length - 1);
    return horizontal
      ? { w: main + 2 * pad.h, h: cross + 2 * pad.v }
      : { w: cross + 2 * pad.h, h: main + 2 * pad.v };
  }

  arrange() {
    if (this.horizontal && this.props.wrap) { this.wrapRows(this.w, true); return; }
    const { horizontal, pad, gap } = this;
    const kids = this.flow;
    const innerW = this.w - 2 * pad.h;
    const innerH = this.h - 2 * pad.v;
    const innerMain = horizontal ? innerW : innerH;
    const innerCross = horizontal ? innerH : innerW;
    const sizes = kids.map(kid => kid.measure(innerW, innerH));
    const mains = sizes.map(size => (horizontal ? size.w : size.h));
    const grow = kids.reduce((sum, kid) => sum + (kid.props.grow ?? 0), 0);
    let free = innerMain - mains.reduce((sum, main) => sum + main, 0) - gap * Math.max(0, kids.length - 1);

    let cursor = horizontal ? pad.h : pad.v;
    if (!grow && free > 0) cursor += this.justify === 'center' ? free >> 1 : this.justify === 'end' ? free : 0;

    let shares = grow;
    kids.forEach((kid, i) => {
      let main = mains[i];
      if (kid.props.grow) {
        const share = Math.round(free * kid.props.grow / shares);
        main = Math.max(0, main + share);
        free -= share;
        shares -= kid.props.grow;
      }
      const fixed = horizontal ? kid.props.height : kid.props.width;
      const wanted = horizontal ? sizes[i].h : sizes[i].w;
      const align = kid.props.self ?? (this.align === 'stretch' && fixed !== undefined ? 'center' : this.align);
      const cross = align === 'stretch' ? innerCross : Math.min(wanted, innerCross);
      const offset = align === 'center' ? (innerCross - cross) >> 1 : align === 'end' ? innerCross - cross : 0;
      const crossAt = (horizontal ? pad.v : pad.h) + offset;
      if (horizontal) kid.place(cursor, crossAt, main, cross);
      else kid.place(crossAt, cursor, cross, main);
      cursor += main + gap;
    });
  }

  /** Opt-in toolbar wrapping; ordinary rows retain their established layout. */
  wrapRows(width, place = false) {
    const inner = Math.max(0, width - 2 * this.pad.h);
    const rows = [];
    let row = { kids: [], width: 0, height: 0 };
    for (const child of this.flow) {
      const size = child.measure(inner, Infinity);
      const w = Math.min(inner, size.w);
      const gap = row.kids.length ? this.gap : 0;
      if (row.kids.length && row.width + gap + w > inner) { rows.push(row); row = { kids: [], width: 0, height: 0 }; }
      row.width += (row.kids.length ? this.gap : 0) + w;
      row.height = Math.max(row.height, size.h);
      row.kids.push({ child, w, h: size.h });
    }
    if (row.kids.length) rows.push(row);
    let y = this.pad.v;
    for (const line of rows) {
      const grow = line.kids.reduce((sum, item) => sum + (item.child.props.grow ?? 0), 0);
      const free = Math.max(0, inner - line.width);
      let x = this.pad.h + (!grow ? this.justify === 'center' ? free / 2 : this.justify === 'end' ? free : 0 : 0);
      for (const { child, w, h } of line.kids) {
        const full = w + (grow ? free * (child.props.grow ?? 0) / grow : 0);
        const align = child.props.self ?? this.align;
        const offset = align === 'end' ? line.height - h : align === 'center' ? (line.height - h) / 2 : 0;
        if (place) child.place(x, y + offset, full, align === 'stretch' ? line.height : h);
        x += full + this.gap;
      }
      y += line.height + this.gap;
    }
    return { w: width, h: y + this.pad.v - (rows.length ? this.gap : 0) };
  }
}

export class Row extends Flex {
  constructor(ui, props) {
    super(ui, props, true);
  }
}

export class Column extends Flex {
  constructor(ui, props) {
    super(ui, props, false);
  }
}

/** A column with a painted background: kind="card" | "inset" | "plain". */
export class Panel extends Flex {
  static attrs = { ...Flex.attrs, kind: 'string' };

  constructor(ui, props) {
    super(ui, { padding: '4', ...props }, false);
    this.kind = props.kind ?? 'card';
    if (!['card', 'inset', 'plain'].includes(this.kind)) throw new Error(`kind="${this.kind}" must be card, inset or plain`);
  }

  paint(bitmap, theme) {
    if (this.kind === 'card') card(bitmap, theme, 0, 0, this.w, this.h);
    else if (this.kind === 'inset') field(bitmap, theme, 0, 0, this.w, this.h);
    else bitmap.fill(0, 0, this.w, this.h, theme.color('paper'));
  }
}

/** Equal cells in a fixed number of columns. Rows share any extra height. */
export class Grid extends Widget {
  static attrs = { ...Widget.attrs, columns: 'number', gap: 'number', padding: 'string' };
  static container = true;

  constructor(ui, props) {
    super(ui, props);
    this.columns = Math.max(1, props.columns ?? 2);
    this.gap = props.gap ?? 0;
    this.pad = padding(props.padding);
  }

  get rows() {
    return Math.ceil(this.children.length / this.columns);
  }

  content() {
    let w = 0;
    let h = 0;
    for (const kid of this.children) {
      const size = kid.measure();
      w = Math.max(w, size.w);
      h = Math.max(h, size.h);
    }
    const { columns, rows, gap, pad } = this;
    return {
      w: columns * w + gap * (columns - 1) + 2 * pad.h,
      h: rows * h + gap * Math.max(0, rows - 1) + 2 * pad.v
    };
  }

  arrange() {
    const { columns, rows, gap, pad } = this;
    if (!rows) return;
    const edge = (inner, count, i) => Math.round(i * (inner + gap) / count);
    const innerW = this.w - 2 * pad.h;
    const innerH = this.h - 2 * pad.v;
    this.children.forEach((kid, i) => {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x0 = edge(innerW, columns, col);
      const y0 = edge(innerH, rows, row);
      kid.place(pad.h + x0, pad.v + y0, edge(innerW, columns, col + 1) - x0 - gap, edge(innerH, rows, row + 1) - y0 - gap);
    });
  }
}

/** Takes up free space: <spacer/> grows by default. */
export class Spacer extends Widget {
  constructor(ui, props) {
    super(ui, { grow: 1, ...props });
  }
}
