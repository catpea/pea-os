import { Widget } from '../ui/widget.js';
import { paintMap } from './minimap.js';
import { caption, CLOSE_BOX, TITLE_H } from '../gfx/skin.js';

function shorten(font, text, width) {
  if (font.measure(text) <= width) return text;
  let value = text;
  while (value && font.measure(`${value}…`) > width) value = value.slice(0, -1);
  return `${value}…`;
}

/** Four desk previews and an explicit list of each desk's windows. */
export class Overview extends Widget {
  interactive = true;
  focusable = true;
  focusMark = 'none'; // the chosen desktop is framed
  #selection = 0;
  #hits = [];

  constructor(ui, { desktop, onPick, onClose }) {
    super(ui);
    this.desktop = desktop;
    this.onPick = onPick;
    this.onClose = onClose;
    this.#selection = desktop.os.model.state.value.desk;
  }

  paint(bitmap, theme) {
    const { font } = this.ui;
    const { state } = this.desktop.os.model;
    bitmap.fill(0, 0, this.w, this.h, theme.color('paper'));
    bitmap.frame(0, 0, this.w, this.h, theme.color('ink'));
    caption(bitmap, theme, font, 1, 1, this.w - 2, { title: 'Desktops' });
    bitmap.fill(1, TITLE_H, this.w - 2, 1, theme.color('ink'));
    const gap = 6;
    const top = TITLE_H + 1;
    const cw = Math.floor((this.w - gap * 3) / 2);
    const ch = Math.floor((this.h - top - gap * 3) / 2);
    this.#hits = [];
    state.value.desks.forEach((desk, index) => {
      const x = gap + (index % 2) * (cw + gap);
      const y = top + gap + Math.floor(index / 2) * (ch + gap);
      bitmap.fill(x, y, cw, ch, theme.color('panel'));
      bitmap.frame(x, y, cw, ch, theme.color(index === this.#selection ? 'accent' : 'dim'));
      font.draw(bitmap, `Desktop ${index + 1}${index === state.value.desk ? ' •' : ''}`, x + 5, y + 4, theme.color('panel-ink'));
      const all = desk.windows.filter(win => !win.owner && win.open);
      const previewH = Math.max(18, Math.min(54, ch - 37));
      paintMap(bitmap, theme, this.desktop.worldItems(index), { ...desk.pan, w: this.desktop.work.w, h: this.desktop.work.h },
        { x: x + 4, y: y + 17, w: cw - 8, h: previewH });
      this.#hits.push({ x, y, w: cw, h: ch, desk: index });
      const rows = Math.max(1, Math.floor((ch - previewH - 21) / 13));
      if (!all.length) font.draw(bitmap, 'Empty desktop', x + 5, y + previewH + 21, theme.color('dim'));
      all.slice(0, rows).forEach((win, i) => {
        const yy = y + previewH + 20 + i * 13;
        const title = `${win.min ? '_ ' : '• '}${win.title}`;
        font.draw(bitmap, shorten(font, title, cw - 10), x + 5, yy, theme.color('panel-ink'));
        this.#hits.push({ x: x + 2, y: yy - 1, w: cw - 4, h: 13, desk: index, id: win.id });
      });
    });
  }

  pointer(type, event) {
    if (type !== 'up' || !event.inside) return;
    if (event.y <= TITLE_H && event.x < CLOSE_BOX.w) { this.onClose(); return; }
    const hit = this.#hits.findLast(hit => event.x >= hit.x && event.x < hit.x + hit.w && event.y >= hit.y && event.y < hit.y + hit.h);
    if (hit) this.onPick(hit.desk, hit.id);
  }

  menu(event) {
    return this.desktop.openContext('overview', null, event, item => { if (item.action?.startsWith('magnify:')) this.desktop.openOverview(); });
  }

  key(type, event) {
    if (type !== 'down') return false;
    if (event.key === 'Escape') { this.onClose(); return true; }
    if (event.key === 'Enter' || event.key === ' ') { this.onPick(this.#selection); return true; }
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 }[event.key];
    if (step !== undefined) { this.#selection = (this.#selection + step + 4) % 4; this.invalidate(); return true; }
    return false;
  }
}
