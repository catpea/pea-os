import { Signal } from '../core/reactive.js';
import { Field } from '../ui/fields.js';
import { Popup, drawIcon } from './menu.js';
import { caption, TITLE_H } from '../gfx/skin.js';
import { CATEGORIES } from './app.js';

const FAVORITES_KEY = 'pea-os.favorites.v1';
const DEFAULTS = ['documents', 'notepad', 'paint', 'flow', 'agents', 'records', 'feeds', 'chat', 'notes', 'software'];
const ROW = 21;
const HEAD = TITLE_H + 1;
const TABS = [['favorites', 'Pinned'], ['all', 'All apps'], ['recent', 'Recent']];
/** The footer's shortcuts: label, glyph, and what a tap does. */
const FOOT = [['Settings', 'glyph-settings', desktop => desktop.os.open('settings')],
  ['Desktops', 'glyph-overview', desktop => desktop.openOverview()],
  ['New note', 'glyph-note', desktop => desktop.newNote()]];
const short = (font, text, max) => {
  if (font.measure(text) <= max) return text;
  let end = text;
  while (end && font.measure(`${end}…`) > max) end = end.slice(0, -1);
  return `${end}…`;
};

/** Searchable launcher; favorites and recent documents are useful without indexing private file contents. */
export class Launcher extends Popup {
  #tab = 'favorites';
  #selected = 0;
  #offset = 0;
  #favorites = [];
  #documents = [];
  #closed = false;
  #loadRevision = 0;
  #hotFoot = null;
  documentError = '';

  constructor(ui, { desktop, onClose }) {
    super(ui, { items: [], onPick: () => {}, onClose });
    this.desktop = desktop;
    const { os } = desktop;
    this.#favorites = DEFAULTS.filter(id => os.apps.has(id));
    try {
      const raw = os.platform.storage?.get(FAVORITES_KEY);
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids) && ids.length <= 100 && ids.every(id => typeof id === 'string')) this.#favorites = [...new Set(ids)].filter(id => os.apps.has(id));
      }
    } catch (error) { os.report(new Error(`Favorites could not be loaded: ${error.message}`)); }
    this.query = new Signal('');
    this.search = this.add(new Field(ui, { value: this.query, placeholder: 'Search apps and documents', maxlength: 120 }));
    this.#refresh(); // Installed apps never depend on the document store becoming available.
    this.watch(this.query, () => { this.#offset = 0; this.#selected = 0; this.#refresh(); });
    this.watch(os.software.changed, () => this.#refresh());
    if (os.documents?.changed) this.watch(os.documents.changed, () => this.#loadDocuments());
    else this.#refresh();
  }

  async #loadDocuments() {
    const revision = ++this.#loadRevision;
    try {
      const records = await this.desktop.os.documents.list();
      if (this.#closed || revision !== this.#loadRevision) return;
      this.documentError = '';
      this.#documents = records;
      this.#refresh();
    } catch (error) {
      if (this.#closed || revision !== this.#loadRevision) return;
      this.documentError = String(error.message ?? error);
      this.#documents = [];
      this.#refresh();
    }
  }

  #refresh() {
    const query = this.query.value.trim().toLocaleLowerCase();
    const { os } = this.desktop;
    let apps = [...os.apps.values()].filter(app => os.software.installed(app.id));
    if (!query && this.#tab === 'favorites') apps = this.#favorites.filter(id => os.software.installed(id)).map(id => os.apps.get(id)).filter(Boolean);
    else apps.sort((a, b) => a.title.localeCompare(b.title));
    if (!query && this.#tab === 'recent') apps = [];
    const appRows = apps.filter(app => !query || `${app.title} ${app.id} ${CATEGORIES[app.category]} ${app.summary}`.toLocaleLowerCase().includes(query))
      .map(app => ({ text: app.title, subtitle: app.summary || CATEGORIES[app.category], app, action: `launch:${app.id}`, kind: 'app' }));
    const docs = (query || this.#tab === 'recent') ? this.#documents.filter(doc => !query || doc.name.toLocaleLowerCase().includes(query)) : [];
    this.items = [...appRows, ...docs.map(doc => ({ text: doc.name, subtitle: os.apps.get(doc.appId)?.title ?? doc.appId, doc, kind: 'document' }))];
    this.#selected = Math.max(0, Math.min(this.#selected, this.items.length - 1));
    this.#offset = Math.min(this.#offset, Math.max(0, this.items.length - this.#capacity()));
    this.invalidate();
  }

  content() { return { w: 280, h: 286 }; }
  arrange() { this.search.place(8, this.#compact() ? 4 : HEAD + 4, Math.max(20, this.w - 16), 20); }
  #compact() { return this.h < 135; }
  #tabTop() { return HEAD + 28; }
  #rowTop() { return this.#compact() ? 29 : this.#tabTop() + 17; }
  /** The footer buttons that fit: [{ label, icon, run, x, w }]. */
  #foot() {
    const { font } = this.ui;
    let x = 5;
    return FOOT.flatMap(([label, icon, run]) => {
      const w = font.measure(label) + 18;
      if (x + w > this.w - 5) return [];
      const button = { label, icon, run, x, w };
      x += w + 3;
      return [button];
    });
  }
  #footer() { return this.#compact() ? 0 : 20; }
  #capacity() { return Math.max(1, Math.floor((this.h - this.#rowTop() - this.#footer() - 3) / ROW)); }
  #rowAt(event) {
    if (event.y < this.#rowTop() || event.y >= this.#rowTop() + this.#capacity() * ROW) return -1;
    const index = this.#offset + Math.floor((event.y - this.#rowTop()) / ROW);
    return index < this.items.length ? index : -1;
  }
  #ensureVisible() {
    if (this.#selected < this.#offset) this.#offset = this.#selected;
    if (this.#selected >= this.#offset + this.#capacity()) this.#offset = this.#selected - this.#capacity() + 1;
  }

  locate(text) {
    const index = this.items.findIndex(item => item.text === text);
    if (index < 0) {
      this.#tab = 'all'; this.#refresh();
      const found = this.items.findIndex(item => item.text === text);
      if (found < 0) return null;
      this.#selected = found;
    } else this.#selected = index;
    this.#ensureVisible(); this.invalidate();
    return { x: Math.floor(this.w / 2), y: this.#rowTop() + (this.#selected - this.#offset) * ROW + 9 };
  }

  paint(bitmap, theme) {
    const { font, sprites } = this.ui;
    bitmap.fill(0, 0, this.w, this.h, theme.color('paper'));
    bitmap.frame(0, 0, this.w, this.h, theme.color('ink'));
    if (!this.#compact()) {
      const desk = `Desk ${this.desktop.os.model.state.value.desk + 1}`;
      const right = font.measure(desk) + 8;
      const { ink } = caption(bitmap, theme, font, 1, 1, this.w - 2, { title: 'Pea OS', icon: sprites.get('pea-9').frames[0], right });
      font.draw(bitmap, desk, this.w - right + 3, 3, ink);
      bitmap.fill(1, TITLE_H, this.w - 2, 1, theme.color('ink'));
      // Tabs: the chosen one is bold and underlined in the accent.
      const tabW = Math.floor((this.w - 16) / 3);
      const top = this.#tabTop();
      bitmap.fill(8, top + 13, this.w - 16, 1, theme.color('panel'));
      TABS.forEach(([id, title], i) => {
        const on = this.#tab === id && !this.query.value;
        const x = 8 + i * tabW;
        const width = font.measure(title, { bold: on });
        font.draw(bitmap, title, x + ((tabW - width) >> 1), top + 2, theme.color(on ? 'text' : 'dim'), { bold: on });
        if (on) bitmap.fill(x + 2, top + 12, tabW - 4, 2, theme.color('accent'));
      });
    }
    const rows = this.items.slice(this.#offset, this.#offset + this.#capacity());
    if (!rows.length) {
      const message = this.documentError && this.#tab === 'recent' ? 'Recent documents unavailable' : this.query.value ? 'No matches' : this.#tab === 'favorites' ? 'Pin apps in All apps.' : 'No recent documents yet.';
      font.draw(bitmap, short(font, message, this.w - 18), 9, this.#rowTop() + 8, theme.color('dim'));
      if (this.documentError && this.#tab === 'recent') font.draw(bitmap, short(font, this.documentError, this.w - 18), 9, this.#rowTop() + 22, theme.color('dim'));
    }
    rows.forEach((item, i) => {
      const y = this.#rowTop() + i * ROW;
      const hot = this.#offset + i === this.#selected;
      if (hot) bitmap.fill(5, y, this.w - 10, ROW - 1, theme.color('accent'));
      const ink = theme.color(hot ? 'accent-ink' : 'text');
      if (item.app) {
        const sprite = sprites.get(item.app.sprite).frames[0];
        bitmap.blit(sprite, 10, y + 3);
      } else {
        bitmap.fill(11, y + 3, 9, 13, theme.color('paper'));
        bitmap.frame(11, y + 3, 9, 13, ink);
      }
      font.draw(bitmap, short(font, item.text, this.w - 63), 29, y + 2, ink);
      font.draw(bitmap, short(font, item.subtitle, this.w - 63), 29, y + 12, hot ? ink : theme.color('dim'));
      if (item.app) font.draw(bitmap, this.#favorites.includes(item.app.id) ? '✓' : '+', this.w - 22, y + 6, ink);
    });
    if (!this.#compact()) {
      bitmap.fill(1, this.h - 19, this.w - 2, 18, theme.color('panel'));
      bitmap.fill(1, this.h - 20, this.w - 2, 1, theme.color('dim'));
      const foot = this.#foot();
      for (const button of foot) {
        const hot = this.#hotFoot === button.label;
        if (hot) {
          bitmap.roundFill(button.x, this.h - 17, button.w, 14, 2, theme.color('paper'));
          bitmap.roundFrame(button.x, this.h - 17, button.w, 14, 2, theme.color('ink'));
        }
        drawIcon(bitmap, sprites, button.icon, button.x + 4, this.h - 15, theme.color('panel-ink'));
        font.draw(bitmap, button.label, button.x + 15, this.h - 14, theme.color('panel-ink'));
      }
      const end = foot.at(-1) ? foot.at(-1).x + foot.at(-1).w : 0;
      const page = `${this.#offset + 1}/${this.items.length}`;
      if (this.items.length > this.#capacity() && end + font.measure(page) + 12 < this.w) font.draw(bitmap, page, this.w - font.measure(page) - 8, this.h - 14, theme.color('dim'));
    }
    if (this.items.length > this.#capacity()) {
      const height = this.#capacity() * ROW;
      bitmap.fill(this.w - 4, this.#rowTop(), 2, height, theme.color('panel'));
      bitmap.fill(this.w - 4, this.#rowTop() + Math.round(this.#offset / this.items.length * height), 2, Math.max(4, Math.round(this.#capacity() / this.items.length * height)), theme.color('accent'));
    }
  }

  #activate(index) {
    const item = this.items[index];
    if (!item) return;
    this.onClose();
    if (item.app) this.desktop.os.open(item.app.id);
    else Promise.resolve(this.desktop.os.openDocument(item.doc.id)).catch(error => this.desktop.os.report(error));
  }

  pointer(type, event) {
    if (type !== 'up' || !event.inside) return;
    if (event.x >= this.w - 7 && event.y >= this.#rowTop() && event.y < this.#rowTop() + this.#capacity() * ROW) {
      this.#offset = Math.max(0, Math.min(this.items.length - this.#capacity(), Math.round((event.y - this.#rowTop()) / (this.#capacity() * ROW) * this.items.length)));
      this.invalidate(); return;
    }
    if (!this.#compact() && event.y >= this.#tabTop() && event.y < this.#tabTop() + 15) {
      const at = Math.floor((event.x - 8) / Math.floor((this.w - 16) / 3));
      this.#tab = ['favorites', 'all', 'recent'][at] ?? this.#tab;
      this.query.set(''); this.#selected = 0; this.#offset = 0; this.#refresh(); return;
    }
    if (!this.#compact() && event.y >= this.h - 19) {
      const button = this.#foot().find(button => event.x >= button.x && event.x < button.x + button.w);
      if (!button) return;
      this.onClose();
      button.run(this.desktop);
      return;
    }
    const index = this.#rowAt(event);
    const item = this.items[index];
    if (!item) return;
    if (item.app && event.x >= this.w - 32) {
      this.#favorites = this.#favorites.includes(item.app.id) ? this.#favorites.filter(id => id !== item.app.id) : [...this.#favorites, item.app.id];
      try { this.desktop.os.platform.storage?.set(FAVORITES_KEY, JSON.stringify(this.#favorites)); }
      catch (error) { this.desktop.os.report(error); }
      this.#refresh();
    } else this.#activate(index);
  }

  wheel(event) { this.#offset = Math.max(0, Math.min(Math.max(0, this.items.length - this.#capacity()), this.#offset + Math.sign(event.dy) * 3)); this.invalidate(); return true; }
  key(type, event) {
    if (type !== 'down') return false;
    if (event.key === 'Escape') { this.onClose(); return true; }
    if (event.key === 'Enter') { this.#activate(this.#selected); return true; }
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(event.key)) {
      const step = (event.key.includes('Down') ? 1 : -1) * (event.key.startsWith('Page') ? this.#capacity() : 1);
      this.#selected = Math.max(0, Math.min(this.items.length - 1, this.#selected + step));
      this.#ensureVisible(); this.invalidate(); return true;
    }
    return false;
  }
  /** Right click: the Start menu's own size, and it comes back at that size. */
  menu(event) {
    return this.desktop.openContext('start', null, event, item => { if (item.action?.startsWith('magnify:')) this.desktop.openStart(); });
  }

  hover(inside) {
    super.hover(inside);
    if (!inside && this.#hotFoot) { this.#hotFoot = null; this.invalidate(); }
  }

  cursor(event) {
    const foot = !this.#compact() && event.y >= this.h - 19 ? this.#foot().find(button => event.x >= button.x && event.x < button.x + button.w)?.label ?? null : null;
    if (foot !== this.#hotFoot) { this.#hotFoot = foot; this.invalidate(); }
    const index = this.#rowAt(event);
    if (index >= 0 && index !== this.#selected) { this.#selected = index; this.invalidate(); }
    return 'pointer';
  }
  dispose() { this.#closed = true; super.dispose(); this.query.dispose(); }
}
