import { parseColor, channels } from './color.js';

/** Every color role a theme may define, and what each falls back to. */
export const ROLES = {
  ink: null,            // outlines
  paper: null,          // window background
  accent: null,         // selection, primary buttons
  text: 'ink',
  panel: 'paper',       // button and control faces
  'panel-ink': 'text',
  field: 'paper',       // inset fields and tracks
  'field-ink': 'text',
  'accent-ink': 'paper',
  title: 'panel',       // window title bar
  'title-ink': 'ink',
  bar: 'paper',         // menu bar
  'bar-ink': 'text',
  dim: 'text',          // secondary text
  shadow: null,         // window shadow; omit for none
  label: 'paper',       // icon captions on the wallpaper
  'label-edge': 'ink',  // and their outline
  'wall-a': 'paper',    // wallpaper: sky or pattern colors, top to bottom
  'wall-b': 'wall-a',
  'wall-c': 'wall-b',
  'wall-d': 'wall-c',
  'wall-far': 'accent',
  'wall-near': 'wall-far',
  'wall-sun': 'accent',
  'wall-cloud': 'paper',
  'wall-star': 'paper',
  'wall-grid': 'accent'
};

export const TITLE_STYLES = ['stripes', 'bands', 'solid'];

/**
 * A theme is a set of color roles plus a few skin switches. A `palette`
 * locks the whole screen to a handful of colors, like a 4-shade handheld.
 */
export class Theme {
  #colors = new Map();
  #nearest = new Map();

  constructor(node) {
    node.expect({ attrs: ['version', 'id', 'name', 'wallpaper', 'radius', 'title', 'palette'], children: ['color'] });
    this.id = node.need('id');
    this.name = node.attr('name', this.id);
    this.wallpaper = node.attr('wallpaper', 'dither');
    this.radius = node.num('radius', 2);
    this.titleStyle = node.attr('title', 'stripes');
    if (!TITLE_STYLES.includes(this.titleStyle)) node.fail(`title="${this.titleStyle}" must be one of ${TITLE_STYLES.join(', ')}`);

    for (const color of node.all('color')) {
      color.expect({ attrs: ['role', 'value'] });
      const role = color.need('role');
      if (!(role in ROLES)) color.fail(`role="${role}" is unknown. Roles: ${Object.keys(ROLES).join(', ')}`);
      if (this.#colors.has(role)) color.fail(`role="${role}" is defined twice`);
      try {
        this.#colors.set(role, parseColor(color.need('value')));
      } catch (error) {
        color.fail(error.message);
      }
    }
    for (const role of ['ink', 'paper', 'accent']) {
      if (!this.#colors.has(role)) node.fail(`needs a <color role="${role}">`);
    }

    this.palette = null;
    if (node.has('palette')) {
      try {
        this.palette = node.attr('palette').trim().split(/\s+/).map(parseColor);
      } catch (error) {
        node.fail(`palette: ${error.message}`);
      }
    }
  }

  has(role) {
    for (let name = role; name; name = ROLES[name]) if (this.#colors.has(name)) return true;
    return false;
  }

  /** A packed color for a role, following fallbacks; 0 when the role is unset. */
  color(role) {
    if (!(role in ROLES)) throw new Error(`Unknown color role "${role}"`);
    for (let name = role; name; name = ROLES[name]) {
      if (this.#colors.has(name)) return this.lock(this.#colors.get(name));
    }
    return 0;
  }

  /** A role name or a "#hex" literal. */
  paint(spec) {
    return spec.startsWith('#') ? this.lock(parseColor(spec)) : this.color(spec);
  }

  /** Snaps an opaque color to the theme palette, when there is one. */
  lock(color) {
    if (!this.palette || color >>> 24 !== 255) return color;
    let best = this.#nearest.get(color);
    if (best === undefined) {
      const [r, g, b] = channels(color);
      let distance = Infinity;
      for (const candidate of this.palette) {
        const [cr, cg, cb] = channels(candidate);
        const d = (r - cr) ** 2 * 0.3 + (g - cg) ** 2 * 0.59 + (b - cb) ** 2 * 0.11;
        if (d < distance) {
          distance = d;
          best = candidate;
        }
      }
      this.#nearest.set(color, best);
    }
    return best;
  }
}
