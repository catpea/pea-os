import { Bitmap, bayer } from './bitmap.js';
import { lighten, darken } from './color.js';

/** Chrome painters. Each one draws a themed control into a Bitmap. */

export const TITLE_H = 13;
export const TOOL_H = 9;   // the caption of a tool window
export const TASK_H = 16;  // the taskbar
export const BAR_H = 14;
export const SHADOW = 2;

/** The close box area of a window title bar, generous enough for a thumb. */
export const CLOSE_BOX = { x: 0, y: 0, w: 17, h: TITLE_H };

/**
 * A raised arcade button: a face sitting on a darker lip that it sinks into
 * when pressed. Returns the vertical offset to apply to the button's content.
 */
export function button(bitmap, theme, x, y, w, h, { pressed = false, face = 'panel', radius = Math.min(theme.radius, 3) } = {}) {
  const base = typeof face === 'number' ? face : theme.color(face);
  const top = pressed ? 1 : 0;
  const lip = pressed ? 1 : 2;
  const edge = Math.max(1, radius);
  bitmap.roundFill(x, y + top, w, h - top, radius, theme.lock(darken(base, 0.3)));
  bitmap.roundFill(x, y + top, w, h - top - lip, radius, base);
  bitmap.fill(x + edge, y + top + 1, w - 2 * edge, 1, theme.lock(lighten(base, 0.45)));
  bitmap.roundFrame(x, y + top, w, h - top, radius, theme.color('ink'));
  return top;
}

/** A sunken field: display panels, slider tracks, check boxes. */
export function field(bitmap, theme, x, y, w, h, face = 'field') {
  const base = theme.color(face);
  bitmap.fill(x, y, w, h, base);
  bitmap.fill(x + 1, y + 1, w - 2, 1, theme.lock(darken(base, 0.16)));
  bitmap.frame(x, y, w, h, theme.color('ink'));
}

export function card(bitmap, theme, x, y, w, h, face = 'panel') {
  bitmap.roundFill(x, y, w, h, theme.radius, theme.color(face));
  bitmap.roundFrame(x, y, w, h, theme.radius, theme.color('ink'));
}

export function checkbox(bitmap, theme, x, y, checked) {
  field(bitmap, theme, x, y, 9, 9, checked ? 'accent' : 'field');
  if (!checked) return;
  const mark = theme.color('accent-ink');
  for (const lift of [0, 1]) {
    bitmap.line(x + 2, y + 3 + lift, x + 3, y + 4 + lift, mark);
    bitmap.line(x + 3, y + 4 + lift, x + 6, y + 1 + lift, mark);
  }
}

/** The caption boxes of a w-wide window: name -> { x, w } hit zones. */
export function captionBoxes(w, { tool = false, min = false, max = false } = {}) {
  if (tool) return { close: { x: 0, w: 9 } };
  const boxes = { close: { x: CLOSE_BOX.x, w: CLOSE_BOX.w } };
  let right = w;
  if (max) boxes.max = { x: (right -= 14), w: 14 };
  if (min) boxes.min = { x: (right -= 12), w: 12 };
  return boxes;
}

/**
 * A window frame of w x h pixels, drawn at the bitmap origin. The shadow, when
 * the theme has one, extends SHADOW pixels beyond the right and bottom edges.
 * A tool window has a short caption with a close box and no title.
 */
export function windowFrame(bitmap, theme, font, w, h, { title, active = true, flat = false, tool = false, min = false, max = false, maxed = false }) {
  const radius = flat ? 0 : tool ? Math.min(1, theme.radius) : theme.radius;
  const titleH = tool ? TOOL_H : TITLE_H;
  const ink = theme.color('ink');
  const bar = theme.color(active ? 'title' : 'panel');
  const barInk = theme.color(active ? 'title-ink' : 'dim');
  const style = active ? theme.titleStyle : 'solid';

  if (!flat && theme.has('shadow')) bitmap.roundFill(SHADOW, SHADOW, w, h, radius, theme.color('shadow'));
  bitmap.roundFill(0, 0, w, h, radius, theme.color('paper'));

  const accent = theme.color('accent');
  for (let j = 1; j < titleH; j++) {
    const inset = Math.max(1, Bitmap.inset(radius, j, h));
    if (style !== 'bands') {
      bitmap.fill(inset, j, w - 2 * inset, 1, bar);
      continue;
    }
    const t = (j - 1) / (titleH - 2);
    for (let i = inset; i < w - inset; i++) bitmap.set(i, j, bayer(i, j) < t ? accent : bar);
  }

  if (tool) {
    if (style === 'stripes') for (let j = 2; j < titleH - 1; j += 2) bitmap.fill(2, j, w - 4, 1, barInk);
    bitmap.fill(1, 1, 8, titleH - 1, bar);
    bitmap.frame(2, 2, 5, 5, barInk);
  } else {
    const boxes = captionBoxes(w, { min, max });
    const room = (boxes.min ?? boxes.max)?.x ?? w - 3;
    caption(bitmap, theme, font, 1, 1, w - 2, { title, active, right: Math.max(2, w - 1 - room), fill: false });

    if (boxes.min) {
      const bx = boxes.min.x + 1;
      bitmap.frame(bx, 2, 9, 9, barInk);
      bitmap.fill(bx + 2, 7, 5, 2, barInk);
    }
    if (boxes.max) {
      const bx = boxes.max.x + 2;
      bitmap.frame(bx, 2, 9, 9, barInk);
      if (maxed) {
        bitmap.frame(bx + 2, 4, 5, 5, barInk);
      } else {
        bitmap.fill(bx + 1, 3, 7, 2, barInk);
      }
    }
  }

  bitmap.fill(1, titleH, w - 2, 1, ink);
  bitmap.roundFrame(0, 0, w, h, radius, ink);
}

/**
 * The caption every titled panel shares with windows, so the Start menu, the
 * map, the overview and notes wear the theme's motif too: stripes, dithered
 * bands or a solid bar behind a centered bold title, with a close box (or an
 * icon) at the left and `right` pixels kept clear for boxes or a note.
 *
 * It covers x..x+w and TITLE_H - 1 rows from y; the caller rules the line
 * under it. `colors` ({ bar, ink, band, rule }) dress it in something other than
 * the theme's title colors. Returns those colors and where the title went.
 */
export function caption(bitmap, theme, font, x, y, w, { title = '', active = true, close = true, icon = null, right = 2, fill = true, colors = null } = {}) {
  const h = TITLE_H - 1;
  const style = active ? theme.titleStyle : 'solid';
  const bar = colors?.bar ?? theme.color(active ? 'title' : 'panel');
  const ink = colors?.ink ?? theme.color(active ? 'title-ink' : 'dim');
  const band = colors?.band ?? theme.color('accent');
  const rule = colors?.rule ?? ink;
  if (fill && style === 'bands') {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) bitmap.set(x + i, y + j, bayer(x + i, y + j) < j / (h - 1) ? band : bar);
  } else if (fill) bitmap.fill(x, y, w, h, bar);

  const text = { bold: true };
  const lead = close || icon ? CLOSE_BOX.w : 3;
  const room = w - right;
  let label = title;
  while (label.length > 1 && font.measure(label, text) > room - lead - 3) label = `${label.slice(0, -2)}…`;
  const width = label ? font.measure(label, text) : 0;
  const tx = Math.max(lead, Math.min(((w + 2 - width) >> 1) - 1, room - width - 3));
  if (style === 'stripes') {
    for (let j = 2; j < h - 2; j += 2) bitmap.fill(x + 2, y + j, w - 4, 1, rule);
    if (close || icon) bitmap.fill(x + 2, y, 11, h, bar);
    if (label) bitmap.fill(x + tx - 3, y, width + 6, h, bar);
    if (right > 2) bitmap.fill(x + w - right, y, right, h, bar);
  }
  if (icon) bitmap.blit(icon, x + 3, y + 1);
  else if (close) {
    bitmap.frame(x + 3, y + 1, 9, 9, ink);
    bitmap.fill(x + 6, y + 4, 3, 3, ink);
  }
  if (label) font.draw(bitmap, label, x + tx, y + 2, ink, text);
  return { bar, ink, x: x + tx, width };
}

/** The grow corner: three diagonal strokes at the bottom right of a 9 x 9 box. */
export function grip(bitmap, theme, x, y) {
  const ink = theme.color('ink');
  const light = theme.color('paper');
  for (const offset of [0, 3, 6]) {
    bitmap.line(x + 8, y + offset, x + offset, y + 8, ink);
    bitmap.line(x + 8, y + offset + 1, x + offset + 1, y + 8, light);
  }
}
