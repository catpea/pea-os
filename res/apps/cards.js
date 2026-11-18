import { createDocumentController } from '../../src/os/document-controller.js';

/**
 * Pea Cards: stacks of cards. A card has a picture, text, and buttons that
 * lead to other cards. Pick the hand to browse; pick any other tool to build.
 *
 * A stack is an XML document. The same text is kept between runs, saved to a
 * file with "Save", and read back with "Open":
 *
 *   <stack version="1" name="Welcome" width="192" height="120">
 *     <card id="1">
 *       <picture x="20" y="8">        rows of palette keys, "." is clear paper
 *         ..77..
 *       </picture>
 *       <field x="8" y="60" w="120" h="30" big="true" text="Hello"/>
 *       <button x="120" y="96" w="64" h="18" text="Next" go="next"/>
 *     </card>
 *   </stack>
 *
 * go: "none", "next", "prev", "first", or "card:ID" for one card in particular.
 */

export const CARD_W = 192;
export const CARD_H = 120;

/** The sixteen colors a picture may use, keyed 0-9 and a-f. */
export const COLORS = [
  '#16161d', '#3a3550', '#6b6a86', '#a9aec4', '#ffffff', '#ffd75e', '#ff9a3d', '#e8475a',
  '#c74aa6', '#6d3fa8', '#2b3a8c', '#3f7fe0', '#63d2f0', '#1f8a78', '#46b04a', '#b5e35a'
];
const KEYS = '0123456789abcdef';
const GO = ['none', 'prev', 'next', 'first'];
const HANDLE = 5;
const DEFAULT_SIZE = { button: { w: 64, h: 18 }, field: { w: 96, h: 32 } };
const HINTS = {
  browse: 'Tap a button to follow it',
  button: 'Tap the card to add a button',
  text: 'Tap the card to add text'
};

/** Validates a <stack> document. kit: { Bitmap, parseColor } */
export function readStack(node, { Bitmap, parseColor }) {
  if (node.name !== 'stack') node.fail('must be <stack>');
  node.expect({ attrs: ['version', 'name', 'width', 'height'], children: ['card'] });
  if (node.need('version') !== '1') node.fail(`version="${node.attr('version')}" is not supported; Pea Cards reads version 1`);
  if (node.num('width', CARD_W) !== CARD_W || node.num('height', CARD_H) !== CARD_H) node.fail(`cards must be ${CARD_W} x ${CARD_H}`);
  const palette = COLORS.map(parseColor);
  const whole = (part, name, low, high) => {
    const value = part.num(name);
    if (!Number.isInteger(value) || value < low || value > high) part.fail(`${name}="${part.attr(name)}" must be a whole number from ${low} to ${high}`);
    return value;
  };

  const ids = new Set();
  const cards = node.all('card').map(card => {
    card.expect({ attrs: ['id'], children: ['picture', 'button', 'field'] });
    const id = whole(card, 'id', 1, 1e6);
    if (ids.has(id)) card.fail(`id="${id}" is used by two cards`);
    ids.add(id);

    const pictures = card.all('picture');
    if (pictures.length > 1) card.fail('has more than one <picture>');
    let picture = null;
    if (pictures.length) {
      const [art] = pictures;
      art.expect({ attrs: ['x', 'y'], text: true });
      const rows = art.rows();
      const left = art.has('x') ? whole(art, 'x', 0, CARD_W - 1) : 0;
      const top = art.has('y') ? whole(art, 'y', 0, CARD_H - 1) : 0;
      if (top + rows.length > CARD_H || rows.some(row => left + row.length > CARD_W)) art.fail('does not fit on the card');
      picture = new Bitmap(CARD_W, CARD_H);
      rows.forEach((row, j) => [...row].forEach((key, i) => {
        if (key === '.') return;
        const color = KEYS.indexOf(key);
        if (color < 0) art.fail(`uses "${key}"; a picture uses 0-9, a-f and "."`);
        picture.px[(top + j) * CARD_W + left + i] = palette[color];
      }));
    }

    const parts = card.children.filter(child => child.name !== 'picture').map(part => {
      const button = part.name === 'button';
      part.expect({ attrs: ['x', 'y', 'w', 'h', 'text', button ? 'go' : 'big'] });
      const w = whole(part, 'w', 8, CARD_W);
      const h = whole(part, 'h', 8, CARD_H);
      const rect = { x: whole(part, 'x', 0, CARD_W - w), y: whole(part, 'y', 0, CARD_H - h), w, h, text: part.attr('text', '') };
      if (!button) return { kind: 'field', ...rect, big: part.flag('big') };
      const go = part.attr('go', 'none');
      if (!GO.includes(go) && !/^card:[1-9]\d*$/.test(go)) part.fail(`go="${go}" must be ${GO.join(', ')} or card:ID`);
      return { kind: 'button', ...rect, go, node: part };
    });
    return { id, picture, parts };
  });
  if (!cards.length) node.fail('needs at least one <card>');
  for (const part of cards.flatMap(card => card.parts)) {
    if (part.go?.startsWith('card:') && !ids.has(Number(part.go.slice(5)))) part.node.fail(`go="${part.go}" names a card that is not in the stack`);
    delete part.node;
  }
  return { name: node.attr('name', 'Stack'), cards };
}

/** A stack as its XML document. kit: { parseColor, escapeXml } */
export function writeStack(stack, { parseColor, escapeXml }) {
  const keys = new Map(COLORS.map((color, i) => [parseColor(color), KEYS[i]]));
  const attr = value => escapeXml(value).replace(/\n/g, '&#10;');
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<stack version="1" name="${attr(stack.name)}" width="${CARD_W}" height="${CARD_H}">`];
  for (const { id, picture, parts } of stack.cards) {
    lines.push(`  <card id="${id}">`);
    const box = picture ? inked(picture) : null;
    if (box) {
      lines.push(`    <picture x="${box.x}" y="${box.y}">`);
      for (let y = box.y; y < box.y + box.h; y++) {
        let row = '';
        for (let x = box.x; x < box.x + box.w; x++) row += keys.get(picture.px[y * CARD_W + x]) ?? '.';
        lines.push(`      ${row}`);
      }
      lines.push('    </picture>');
    }
    for (const part of parts) {
      const rect = `x="${part.x}" y="${part.y}" w="${part.w}" h="${part.h}" text="${attr(part.text)}"`;
      lines.push(part.kind === 'button' ? `    <button ${rect} go="${part.go}"/>` : `    <field ${rect} big="${part.big}"/>`);
    }
    lines.push('  </card>');
  }
  lines.push('</stack>', '');
  return lines.join('\n');
}

/** The smallest rectangle holding every painted pixel, or null for clear paper. */
function inked(picture) {
  let x0 = CARD_W;
  let y0 = CARD_H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < CARD_H; y++) {
    for (let x = 0; x < CARD_W; x++) {
      if (!picture.px[y * CARD_W + x]) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export default function cards(app) {
  const { Bitmap, parseColor, bayer, ease } = app.gfx;
  const { card, colors: swatches, browseRow, buttonRow, textRow, paintRow, linkRow } = app.refs;
  const { font } = app;
  const kit = { Bitmap, parseColor, escapeXml: app.xml.escapeXml };
  const palette = COLORS.map(parseColor);
  const [BLACK, , , GREY, WHITE] = palette;
  const BLUE = palette[11];

  const tool = app.signal('tool');
  const place = app.signal('place');
  const hint = app.signal('hint');
  const go = app.signal('go');
  const linked = app.signal('linked');
  const brush = app.signal('brush');
  const big = app.signal('big');
  const partText = app.signal('part-text');
  const cardSelection = app.signal('card-selection');

  const sheet = new Bitmap(CARD_W, CARD_H); // the card as drawn; the canvas shows it
  let legacyText = null;
  let stack = load();
  let files = null;
  let index = 0;
  let ink = palette[7];
  let selected = null;  // the part being edited
  let typing = false;   // keys go into the selected part's text
  let fresh = false;    // the next key replaces a new part's placeholder text
  let pressed = null;   // a button held down in browse mode
  let gesture = null;
  let linking = null;   // { part, from }: choosing the card a button leads to
  let transition = null;
  let phase = 0;        // marching ants and the caret, on the frame clock
  let syncing = false;

  const current = () => stack.cards[index];
  const editing = () => tool.value === 'button' || tool.value === 'text';
  const kindOf = () => (tool.value === 'button' ? 'button' : 'field');

  function load() {
    const saved = app.document.load();
    if (saved) {
      try {
        const restored = readStack(app.xml.parseXml(saved, 'the saved stack'), kit);
        legacyText = saved;
        return restored;
      } catch (error) {
        app.report(error); // a stack that cannot be read is left alone, not overwritten until edited
      }
    }
    return readStack(app.data('welcome-stack'), kit);
  }

  const save = options => files?.changed(options);
  save.flush = () => files?.flushRecovery();

  // ---- Drawing ---------------------------------------------------------------

  /** A dotted rectangle; `step` makes the dots march. */
  function dotted(target, x, y, w, h, color, step = 0) {
    let n = step;
    const dot = (px, py) => { if ((n++ & 3) < 2) target.set(px, py, color); };
    for (let i = 0; i < w; i++) dot(x + i, y);
    for (let j = 1; j < h; j++) dot(x + w - 1, y + j);
    for (let i = w - 2; i >= 0; i--) dot(x + i, y + h - 1);
    for (let j = h - 2; j > 0; j--) dot(x, y + j);
  }

  function drawPart(target, part, chrome) {
    const layer = new Bitmap(part.w, part.h); // text never spills out of its part
    const caret = chrome && typing && part === selected && phase < 2;
    if (part.kind === 'button') {
      const down = part === pressed;
      target.roundFill(part.x + 1, part.y + 1, part.w, part.h, 3, BLACK);
      target.roundFill(part.x, part.y, part.w, part.h, 3, down ? BLACK : WHITE);
      target.roundFrame(part.x, part.y, part.w, part.h, 3, BLACK);
      const style = { bold: true };
      const width = font.measure(part.text, style);
      const x = Math.max(3, (part.w - width) >> 1);
      const y = (part.h - font.cap) >> 1;
      const end = font.draw(layer, part.text, x, y, down ? WHITE : BLACK, style);
      if (caret) layer.fill(end, y - 1, 1, font.height, down ? WHITE : BLACK);
    } else {
      const style = { scale: part.big ? 2 : 1 };
      const step = font.lineHeight * style.scale;
      let end = 2;
      const lines = font.wrap(part.text, part.w - 4, style);
      lines.forEach((line, i) => { end = font.draw(layer, line, 2, 2 + i * step, BLACK, style); });
      if (caret) layer.fill(end, 1 + (lines.length - 1) * step, style.scale, font.height * style.scale, BLACK);
      if (chrome && (tool.value === 'text' || (typing && part === selected))) dotted(target, part.x, part.y, part.w, part.h, GREY);
    }
    target.blit(layer, part.x, part.y);
    if (chrome && part === selected && editing()) {
      dotted(target, part.x - 1, part.y - 1, part.w + 2, part.h + 2, BLUE, app.motion.value ? phase : 0);
      target.fill(part.x + part.w - HANDLE, part.y + part.h - HANDLE, HANDLE, HANDLE, BLUE);
    }
  }

  function paintCard(target, which, chrome) {
    target.clear(WHITE);
    if (which.picture) target.blit(which.picture, 0, 0);
    for (const part of which.parts) drawPart(target, part, chrome);
    if (chrome && gesture?.type === 'create' && gesture.moved) {
      const { x, y, w, h } = box(gesture);
      dotted(target, x, y, w, h, BLUE);
    }
  }

  function present() {
    if (!card.bitmap) return;
    card.bitmap.clear(WHITE);
    card.bitmap.blit(sheet, 0, 0);
    card.commit();
  }

  function render() {
    if (transition) return; // the dissolve owns the canvas until it ends
    paintCard(sheet, current(), true);
    present();
  }

  // ---- The row under the card ------------------------------------------------

  function inspect() {
    const part = selected;
    const row = linking ? linkRow
      : part && tool.value === 'button' ? buttonRow
      : part && tool.value === 'text' ? textRow
      : ['draw', 'erase', 'fill'].includes(tool.value) ? paintRow
      : browseRow;
    for (const candidate of [browseRow, buttonRow, textRow, paintRow, linkRow]) candidate.visible = candidate === row;
    place.set(`${index + 1} / ${stack.cards.length}`);
    hint.set(part ? 'Type to write' : HINTS[tool.value] ?? '');
    syncing = true;
    partText.set(part?.text ?? '');
    app.refs.partText.visible = Boolean(part);
    cardSelection.set(String(current().id));
    app.refs.cardPicker.items = stack.cards.map((item, i) => ({ value: String(item.id), text: `${i + 1}. ${item.parts.find(part => part.text)?.text.slice(0, 22) || 'Card'}` }));
    if (part?.kind === 'button') {
      const specific = part.go.startsWith('card:');
      go.set(specific ? 'card' : part.go);
      const target = specific ? stack.cards.findIndex(other => other.id === Number(part.go.slice(5))) : -1;
      linked.set(target >= 0 ? `card ${target + 1}` : '');
    } else if (part) {
      big.set(part.big);
    }
    syncing = false;
    app.os.ui.requestLayout();
  }

  /** Makes a part the one being edited; `placeholder` when its text is a stand-in the first key replaces. */
  function select(part, placeholder = false) {
    selected = part;
    typing = Boolean(part);
    fresh = placeholder;
    inspect();
    render();
    if (part) {
      app.os.ui.focus(app.refs.partText);
      app.refs.partText.setSelection(placeholder ? 0 : part.text.length, part.text.length);
    }
  }

  function changed(options) {
    save(options);
    if (selected && partText.value !== selected.text) {
      syncing = true;
      partText.set(selected.text);
      syncing = false;
    }
    render();
  }

  // ---- Moving through the stack -----------------------------------------------

  function show(next, dissolve = false) {
    const from = dissolve && app.motion.value && card.bitmap ? sheet.clone() : null;
    transition?.cancel();
    transition = null;
    index = Math.min(stack.cards.length - 1, Math.max(0, next));
    selected = null;
    typing = false;
    pressed = null;
    inspect();
    if (!from) {
      render();
      return;
    }
    // An ordered dissolve, the way a 1-bit machine faded between cards.
    const to = new Bitmap(CARD_W, CARD_H);
    paintCard(to, current(), true);
    const running = transition = app.anim.tween(300, t => {
      for (let y = 0; y < CARD_H; y++) {
        for (let x = 0; x < CARD_W; x++) {
          const at = y * CARD_W + x;
          sheet.px[at] = bayer(x, y) < t ? to.px[at] : from.px[at];
        }
      }
      present();
    }, { easing: ease.linear });
    running.then(() => {
      if (transition !== running) return;
      transition = null;
      render();
    });
  }

  function follow(target) {
    const count = stack.cards.length;
    if (target === 'next') show((index + 1) % count, true);
    else if (target === 'prev') show((index + count - 1) % count, true);
    else if (target === 'first') show(0, true);
    else if (target.startsWith('card:')) {
      const at = stack.cards.findIndex(other => other.id === Number(target.slice(5)));
      if (at >= 0) show(at, true);
    }
  }

  // The card owns its browsing arrows; the surrounding scroll view keeps its
  // own keyboard scrolling when its scrollbar, rather than the card, has focus.
  card.focusable = true;
  card.key = (type, { key, ctrl, alt }) => {
    if (ctrl || alt || typing || linking || !['ArrowLeft', 'ArrowRight'].includes(key)) return false;
    if (type === 'down') app.run(key === 'ArrowRight' ? 'next' : 'prev');
    return true;
  };

  // ---- Pointer ----------------------------------------------------------------

  const partAt = (x, y, kind) => current().parts.findLast(part => (!kind || part.kind === kind) && x >= part.x && y >= part.y && x < part.x + part.w && y < part.y + part.h);
  const inside = point => ({ x: Math.min(CARD_W - 1, Math.max(0, point.x)), y: Math.min(CARD_H - 1, Math.max(0, point.y)) });
  const box = ({ from, to }) => ({ x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x) + 1, h: Math.abs(to.y - from.y) + 1 });

  function dab({ x, y }) {
    const size = tool.value === 'erase' ? Math.max(3, brush.value * 2) : brush.value;
    const picture = current().picture ??= new Bitmap(CARD_W, CARD_H);
    if (tool.value === 'erase') picture.erase(x - (size >> 1), y - (size >> 1), size, size);
    else picture.fill(x - (size >> 1), y - (size >> 1), size, size, ink);
  }

  function stroke(from, to) {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
    for (let i = 1; i <= steps; i++) dab({ x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps) });
  }

  function flood({ x, y }) {
    const picture = current().picture ??= new Bitmap(CARD_W, CARD_H);
    const { px } = picture;
    const old = px[y * CARD_W + x];
    if (old === ink) return;
    const todo = [y * CARD_W + x];
    while (todo.length) {
      const at = todo.pop();
      if (px[at] !== old) continue;
      px[at] = ink;
      const col = at % CARD_W;
      if (col > 0) todo.push(at - 1);
      if (col < CARD_W - 1) todo.push(at + 1);
      if (at >= CARD_W) todo.push(at - CARD_W);
      if (at < CARD_W * (CARD_H - 1)) todo.push(at + CARD_W);
    }
  }

  function down(point) {
    if (linking || transition || !files?.state.value.ready) return;
    const at = inside(point);
    if (tool.value === 'browse') {
      const part = partAt(at.x, at.y);
      if (part?.kind === 'button') {
        pressed = part;
        gesture = { type: 'press', part };
        select(null);
      } else {
        select(part ?? null);
      }
    } else if (editing()) {
      const part = partAt(at.x, at.y, kindOf());
      if (!part) {
        gesture = { type: 'create', from: at, to: at, moved: false };
        select(null);
        return;
      }
      const corner = at.x >= part.x + part.w - HANDLE - 1 && at.y >= part.y + part.h - HANDLE - 1;
      gesture = { type: corner ? 'size' : 'move', part, dx: at.x - part.x, dy: at.y - part.y, moved: false, before: { x: part.x, y: part.y, w: part.w, h: part.h } };
      select(part, fresh && part === selected);
    } else if (tool.value === 'fill') {
      flood(at);
      changed();
    } else {
      gesture = { type: 'stroke', last: at, before: current().picture?.clone() ?? null };
      dab(at);
      render();
    }
  }

  function move(point) {
    if (!gesture) return;
    const at = inside(point);
    const { part } = gesture;
    if (gesture.type === 'press') {
      const held = partAt(at.x, at.y) === part ? part : null;
      if (held === pressed) return;
      pressed = held;
    } else if (gesture.type === 'stroke') {
      stroke(gesture.last, at);
      gesture.last = at;
    } else if (gesture.type === 'create') {
      gesture.to = at;
      gesture.moved = true;
    } else if (gesture.type === 'move') {
      part.x = Math.min(CARD_W - part.w, Math.max(0, at.x - gesture.dx));
      part.y = Math.min(CARD_H - part.h, Math.max(0, at.y - gesture.dy));
      gesture.moved = true;
    } else {
      part.w = Math.min(CARD_W - part.x, Math.max(12, at.x - part.x + 2));
      part.h = Math.min(CARD_H - part.y, Math.max(10, at.y - part.y + 2));
      gesture.moved = true;
    }
    render();
  }

  function up(point, cancelled = false) {
    const done = gesture;
    gesture = null;
    if (!done) return;
    if (done.type === 'press') {
      const hit = !cancelled && pressed === done.part;
      pressed = null;
      render();
      if (hit) follow(done.part.go);
    } else if (done.type === 'stroke') {
      if (cancelled) { current().picture = done.before; render(); }
      else changed();
    } else if (done.type === 'create') {
      if (cancelled) return render();
      const kind = kindOf();
      const drawn = box(done);
      const size = drawn.w >= 12 && drawn.h >= 10 ? drawn : DEFAULT_SIZE[kind];
      const at = drawn.w >= 12 && drawn.h >= 10 ? drawn : { x: done.from.x - (size.w >> 1), y: done.from.y - (size.h >> 1) };
      const part = {
        kind,
        x: Math.min(CARD_W - size.w, Math.max(0, at.x)),
        y: Math.min(CARD_H - size.h, Math.max(0, at.y)),
        w: size.w,
        h: size.h,
        text: kind === 'button' ? 'Button' : 'Text',
        ...(kind === 'button' ? { go: 'next' } : { big: false })
      };
      current().parts.push(part);
      select(part, true);
      save();
    } else if (done.moved) {
      if (cancelled) { Object.assign(done.part, done.before); render(); }
      else changed();
    }
  }

  app.scope.on(card.events, 'down', down);
  app.scope.on(card.events, 'move', move);
  app.scope.on(card.events, 'up', point => up(point));
  app.scope.on(card.events, 'cancel', point => up(point, true));
  app.scope.on(card.events, 'resize', present);

  // ---- Keys -------------------------------------------------------------------

  app.scope.on(app.keys, 'down', ({ key, ctrl }) => {
    if (ctrl || linking) return;
    if (!typing || !selected) {
      if (key === 'ArrowRight') app.run('next');
      else if (key === 'ArrowLeft') app.run('prev');
      return;
    }
    const part = selected;
    if (key === 'Escape' || (key === 'Enter' && part.kind === 'button')) return select(null);
    if (key === 'Delete' && editing()) return app.run('remove');
    if (key === 'Backspace') part.text = fresh ? '' : part.text.slice(0, -1);
    else if (key === 'Enter') part.text += '\n';
    else if ([...key].length === 1) part.text = (fresh ? '' : part.text) + key;
    else return undefined;
    fresh = false;
    phase = 0;
    return changed({ coalesce: 'card-text' });
  });

  // ---- Commands ---------------------------------------------------------------

  app.command('next', () => show((index + 1) % stack.cards.length, true));
  app.command('prev', () => show((index + stack.cards.length - 1) % stack.cards.length, true));
  app.command('select-card', () => {
    const next = stack.cards.findIndex(item => String(item.id) === cardSelection.value);
    if (next >= 0 && next !== index) show(next, true);
  });
  app.command('new', () => {
    const id = Math.max(...stack.cards.map(other => other.id)) + 1;
    stack.cards.splice(index + 1, 0, { id, picture: null, parts: [] });
    save();
    show(index + 1, true);
  });
  app.command('delete-card', () => {
    const [gone] = stack.cards.splice(index, 1);
    if (!stack.cards.length) stack.cards.push({ id: gone.id, picture: null, parts: [] });
    // Buttons that led to the card that is gone now lead nowhere.
    for (const part of stack.cards.flatMap(other => other.parts)) if (part.go === `card:${gone.id}`) part.go = 'none';
    if (linking?.from === gone.id) linking = null;
    save();
    show(index, true);
  });
  app.command('remove', () => {
    if (!selected) return;
    current().parts.splice(current().parts.indexOf(selected), 1);
    select(null);
    save();
  });
  app.command('clear', () => {
    current().picture = null;
    changed();
  });
  app.command('link', () => {
    if (selected?.kind !== 'button') return;
    linking = { part: selected, from: current().id };
    select(null);
  });
  const endLink = target => {
    if (!linking) return;
    const { part, from } = linking;
    if (target) part.go = target;
    linking = null;
    if (target) save();
    show(stack.cards.findIndex(other => other.id === from));
    select(part);
  };
  app.command('link-here', () => endLink(`card:${current().id}`));
  app.command('link-cancel', () => endLink(null));
  app.command('export', () => {
    const name = files.state.value.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'stack';
    app.download(`${name}.xml`, writeStack(stack, kit));
  });
  app.command('import', () => files.run('import'));

  // ---- State that follows signals ------------------------------------------------

  app.scope.subscribe(tool, () => {
    gesture = null;
    select(null);
  }, { immediate: false });
  app.scope.subscribe(go, value => {
    if (syncing || selected?.kind !== 'button' || value === 'card') return;
    selected.go = value;
    inspect();
    save();
  }, { immediate: false });
  app.scope.subscribe(big, value => {
    if (syncing || selected?.kind !== 'field') return;
    selected.big = value;
    changed();
  }, { immediate: false });
  app.scope.subscribe(partText, value => {
    if (syncing || !selected || files?.updating) return;
    selected.text = value;
    fresh = false;
    changed({ coalesce: 'card-text' });
  }, { immediate: false });
  app.scope.subscribe(app.visible, visible => { if (!visible) save.flush(); }, { immediate: false });

  // The selection's dots march and the caret blinks, four steps a second.
  app.frame(({ time }) => {
    const step = Math.floor(time / 250) & 3;
    if (step === phase) return;
    phase = step;
    if (selected && !gesture) render();
  });

  // ---- The color palette, in the tool window --------------------------------------

  function drawSwatches() {
    const { bitmap } = swatches;
    if (!bitmap) return;
    const w = bitmap.width >> 1;
    const h = Math.floor(bitmap.height / 8);
    bitmap.clear();
    palette.forEach((color, i) => {
      const x = (i & 1) * w;
      const y = (i >> 1) * h;
      bitmap.fill(x, y, w, h, color);
      if (color !== ink) return;
      bitmap.frame(x, y, w, h, BLACK);
      bitmap.frame(x + 1, y + 1, w - 2, h - 2, WHITE);
    });
    swatches.commit();
  }
  app.scope.on(swatches.events, 'resize', drawSwatches);
  app.scope.on(swatches.events, 'down', point => {
    const w = Math.max(1, swatches.w >> 1);
    const h = Math.max(1, Math.floor(swatches.h / 8));
    ink = palette[Math.min(15, Math.min(7, Math.floor(point.y / h)) * 2 + Math.min(1, Math.floor(point.x / w)))];
    if (!['draw', 'fill'].includes(tool.value)) tool.set('draw'); // picking a color means you want to paint
    drawSwatches();
  });

  drawSwatches();
  files = createDocumentController(app, {
    format: 'application/x-pea-stack+xml', extension: '.xml', accept: '.xml', initialName: stack.name, legacyText,
    create: () => ({ name: 'Untitled', cards: [{ id: 1, picture: null, parts: [] }] }),
    parse: (text, name) => readStack(app.xml.parseXml(text, name), kit),
    serialize: () => writeStack(stack, kit),
    install(value, { reset = false } = {}) {
      stack = value;
      gesture = null;
      linking = null;
      show(reset ? 0 : index);
    }
  });
  app.refs.partText.documentUndo = true;
  show(0);
}
