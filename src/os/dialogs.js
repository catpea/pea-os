import { Widget } from '../ui/widget.js';
import { Column } from '../ui/layout.js';
import { Label, Button } from '../ui/controls.js';
import { Field } from '../ui/fields.js';
import { List } from '../ui/lists.js';
import { Scroll } from '../ui/containers.js';
import { windowFrame, TITLE_H } from '../gfx/skin.js';

class Message extends Label {
  lines(width) {
    const result = [];
    for (const line of super.lines(width)) {
      let chunk = '';
      for (const ch of line) {
        if (chunk && this.ui.font.measure(chunk + ch) > width) { result.push(chunk); chunk = ''; }
        chunk += ch;
      }
      result.push(chunk);
    }
    return result;
  }
}

/** Wrapping action row keeps every action reachable on the smallest art viewport. */
class Actions extends Widget {
  flow(width, place = false) {
    let x = 0; let y = 0; let height = 0;
    for (const child of this.children) {
      const size = child.measure(width, Infinity);
      const w = Math.min(width, size.w);
      if (x && x + w > width) { x = 0; y += height + 4; height = 0; }
      if (place) child.place(x, y, w, size.h);
      x += w + 4; height = Math.max(height, size.h);
    }
    return y + height;
  }
  content(width = 240) { return { w: width, h: this.flow(width) }; }
  arrange() { this.flow(this.w, true); }
}

class DialogPanel extends Widget {
  interactive = true;
  constructor(ui, options, done) {
    super(ui);
    this.options = options;
    this.done = done;
    this.scroll = this.add(new Scroll(ui));
    this.body = this.scroll.add(new Column(ui, { gap: 6 }));
    this.actions = this.add(new Actions(ui));
  }
  paint(bitmap, theme) {
    windowFrame(bitmap, theme, this.ui.font, this.w, this.h, { title: this.options.title, active: true, flat: true });
  }
  arrange() {
    if (!this.actions) return;
    const width = Math.max(1, this.w - 14);
    const actions = this.actions.measure(width).h;
    this.actions.place(7, Math.max(TITLE_H + 7, this.h - actions - 7), width, actions);
    this.scroll.place(7, TITLE_H + 7, width, Math.max(8, this.h - TITLE_H - 21 - actions));
  }
  pointer(type, event) { if (type === 'up' && event.y < TITLE_H && event.x < 17) this.done(null); }
}

class DialogLayer extends Widget {
  interactive = true;
  focusBoundary = true;
  constructor(ui, cancel, accept) { super(ui); this.cancel = cancel; this.accept = accept; }
  paint(bitmap, theme) { bitmap.fill(0, 0, this.w, this.h, theme.has('shadow') ? theme.color('shadow') : 0x66000000); }
  key(type, event) {
    if (event.key === 'Escape') { if (type === 'down') this.cancel(); return true; }
    if (event.key === 'Enter') { if (type === 'down') this.accept(); return true; }
    // Modal dialogs do not leak typing or document shortcuts to an underlying app.
    return true;
  }
}

/** Small queued service. The root is looked up when opening, never in the constructor. */
export class DialogService {
  active = null;
  #queue = [];
  #disposed = false;
  #waiting = null;

  constructor(ui) { this.ui = ui; }

  prompt({ title = 'Enter text', message = '', value = '', acceptLabel = 'OK' } = {}) {
    return this.#enqueue({ kind: 'prompt', title, message, value, acceptLabel });
  }
  choose({ title = 'Choose', message = '', items = [], value, acceptLabel = 'Open' } = {}) {
    return this.#enqueue({ kind: 'choose', title, message, items, value, acceptLabel });
  }
  confirm({ title = 'Confirm', message = '', buttons = [{ value: 'cancel', text: 'Cancel' }, { value: 'ok', text: 'OK' }] } = {}) {
    return this.#enqueue({ kind: 'confirm', title, message, buttons });
  }
  alert({ title = 'Pea OS', message = '' } = {}) {
    return this.#enqueue({ kind: 'alert', title, message }).then(() => undefined);
  }

  #enqueue(options) {
    if (this.#disposed) return Promise.resolve(null);
    return new Promise(resolve => { this.#queue.push({ options, resolve }); this.#pump(); });
  }

  #pump() {
    if (this.active || this.#disposed || !this.#queue.length) return;
    const { ui } = this;
    if (!ui.root) {
      if (!this.#waiting) this.#waiting = ui.stage.frame.on('paint', () => { if (ui.root) { this.#waiting(); this.#waiting = null; this.#pump(); } });
      return;
    }
    const request = this.#queue.shift();
    const { options } = request;
    const record = { ...request, field: null, list: null, buttons: [] };
    this.active = record;
    const done = value => this.#finish(record, value);
    const accept = () => {
      if (record.accept?.disabled) return;
      if (options.kind === 'prompt') done(record.field.text);
      else if (options.kind === 'choose') { if (record.list.selectedItem && !record.list.selectedItem.disabled) done(record.list.model.value); }
      else done(options.kind === 'alert' ? 'ok' : options.buttons[record.defaultIndex]?.value ?? null);
    };
    const layer = ui.root.add(new DialogLayer(ui, () => done(null), accept));
    record.view = layer;
    const panel = layer.add(new DialogPanel(ui, options, done));
    record.panel = panel;
    if (options.message) panel.body.add(new Message(ui, { text: options.message, wrap: true }));
    if (options.kind === 'prompt') {
      record.field = panel.body.add(new Field(ui, { value: options.value, label: options.title, onSubmit: accept }));
    } else if (options.kind === 'choose') {
      const first = options.items.find(item => !item.disabled)?.value ?? null;
      record.list = panel.body.add(new List(ui, { items: options.items, value: options.value ?? first, height: 92, label: options.title, onActivate: accept }));
    }
    const buttons = options.kind === 'confirm' ? options.buttons : options.kind === 'alert' ? [{ value: 'ok', text: 'OK' }] : [{ value: null, text: 'Cancel' }, { value: '__accept', text: options.acceptLabel }];
    const cancelIndex = buttons.findIndex(button => button.value === 'cancel' || button.value === null);
    record.defaultIndex = options.kind === 'confirm' ? Math.max(0, cancelIndex) : buttons.length - 1;
    for (const [index, definition] of buttons.entries()) {
      const control = panel.actions.add(new Button(ui, { text: definition.text, kind: index === record.defaultIndex ? 'accent' : undefined, onPress: () => definition.value === '__accept' ? accept() : done(definition.value) }));
      record.buttons.push(control);
    }
    record.accept = record.buttons[record.defaultIndex];
    if (record.list) record.accept.disabled = !record.list.items.some(item => !item.disabled);
    const layout = () => {
      if (layer.disposed) return;
      const size = ui.stage.size.value;
      layer.place(0, 0, size.w, size.h);
      const wanted = ui.root.os?.zoomOf?.('menubar') ?? 1;
      panel.zoom = Math.max(1, Math.min(wanted, Math.floor(size.w / 170), Math.floor(size.h / 125)));
      const width = Math.max(80, Math.min(280, Math.floor((size.w - 10) / panel.zoom)));
      const contentWidth = width - 14;
      const body = panel.body.measure(contentWidth, Infinity).h;
      const actions = panel.actions.measure(contentWidth).h;
      const height = Math.min(TITLE_H + 21 + body + actions, Math.max(64, Math.floor((size.h - 10) / panel.zoom)));
      panel.place(Math.round((size.w - width * panel.zoom) / 2), Math.round((size.h - height * panel.zoom) / 2), width, height);
    };
    record.offSize = ui.stage.size.subscribe(layout);
    // Layout changes from native keyboard/screen changes retain the same dialog and value.
    record.release = ui.focusWithin(layer, { trap: true });
    const first = record.field ?? record.list ?? record.accept;
    first?.focus();
    record.field?.selectAll();
    ui.requestLayout();
  }

  #finish(record, value) {
    if (record !== this.active) return;
    this.active = null;
    record.offSize?.();
    record.view.dispose();
    record.release?.();
    record.resolve(value);
    this.#pump();
  }

  cancel() { if (this.active) this.#finish(this.active, null); }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#waiting?.(); this.#waiting = null;
    this.cancel();
    for (const request of this.#queue.splice(0)) request.resolve(null);
  }
}
