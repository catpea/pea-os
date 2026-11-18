import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml, escapeXml } from '../src/core/xml.js';
import { Bitmap } from '../src/gfx/bitmap.js';
import { parseColor } from '../src/gfx/color.js';
import { readStack, writeStack } from '../res/apps/cards.js';
import { session } from './helpers.mjs';

const kit = { Bitmap, parseColor, escapeXml };
const DESK = { width: 480, height: 270 };

/** Opens Pea Cards and returns ways to use it the way a person would. */
async function open(t, config = {}) {
  const live = await session(t, { ...DESK, ...config, options: { open: ['cards'] } });
  await live.frames(25);
  const { os } = live;
  os.run('set:os.minimap=false'); // the map, on top, would cover the docked tools in the corner
  const app = os.app('cards');
  await app.files.ready;
  const { card } = app.refs;
  const at = (x, y) => { const point = card.toScreen(x, y); return [point.x, point.y]; };
  return {
    live,
    os,
    app,
    place: () => app.signal('place').value,
    /** Taps a point of the card, then lets a dissolve finish. */
    async tap(x, y) {
      await live.tap(...at(x, y));
      await live.frames(25);
    },
    drag: points => live.drag(points.map(([x, y]) => at(x, y))),
    type(text) {
      for (const key of text) os.stage.keys.emit('down', { key });
    },
    key: key => os.stage.keys.emit('down', { key }),
    async run(action) {
      await app.run(action);
      await live.frames(25);
    },
    /** The stack as Pea Cards would save it to a file. */
    saved() {
      app.run('export');
      return live.downloads.at(-1).text;
    }
  };
}

test('browsing: buttons lead to cards, arrows step through the stack', async t => {
  const cards = await open(t);
  assert.equal(cards.place(), '1 / 4');
  await cards.tap(136, 105); // "Take the tour"
  assert.equal(cards.place(), '2 / 4');
  cards.key('ArrowRight');
  await cards.live.frames(25);
  cards.key('ArrowRight');
  await cards.live.frames(25);
  assert.equal(cards.place(), '4 / 4');
  await cards.tap(93, 109); // "Start over" goes to card 1 by id
  assert.equal(cards.place(), '1 / 4');
  await cards.run('prev');
  assert.equal(cards.place(), '4 / 4', 'the stack wraps around');
});

test('building: a tap makes a button, typing names it, Link points it anywhere', async t => {
  const cards = await open(t);
  const { app } = cards;
  const { buttonRow, linkRow, browseRow } = app.refs;
  await cards.run('next');
  await cards.run('next');
  assert.equal(browseRow.visible, true);

  app.signal('tool').set('button');
  await cards.tap(100, 88);
  assert.deepEqual([buttonRow.visible, browseRow.visible, app.signal('go').value], [true, false, 'next'], 'the row under the card is about the new button');
  cards.type('Go');
  assert.match(cards.saved(), /<button x="68" y="79" w="64" h="18" text="Go" go="next"\/>/, 'the first key replaces the stand-in name');
  cards.key('Backspace');
  cards.type('o home');
  assert.match(cards.saved(), /text="Go home" go="next"/);

  // Dragging moves it; the corner resizes it.
  await cards.drag([[100, 88], [110, 80], [120, 70]]);
  assert.match(cards.saved(), /<button x="88" y="61" w="64" h="18" text="Go home"/);
  await cards.drag([[150, 77], [160, 80], [170, 84]]);
  assert.match(cards.saved(), /<button x="88" y="61" w="84" h="25" text="Go home"/);

  // Link: choose the card by going to it.
  await cards.run('link');
  assert.equal(linkRow.visible, true);
  await cards.run('prev');
  await cards.run('prev');
  await cards.run('link-here');
  assert.deepEqual([cards.place(), linkRow.visible, buttonRow.visible, app.signal('linked').value], ['3 / 4', false, true, 'card 1']);
  assert.match(cards.saved(), /text="Go home" go="card:1"/);

  app.signal('tool').set('browse');
  await cards.tap(120, 70);
  assert.equal(cards.place(), '1 / 4', 'and in browse mode the button does what it says');

  // Deleting the card a button leads to leaves the button, leading nowhere.
  await cards.run('delete-card');
  assert.equal(cards.place(), '1 / 3');
  assert.match(cards.saved(), /text="Go home" go="none"/);
});

test('text can be changed while browsing; the text tool adds more', async t => {
  const cards = await open(t);
  const { app } = cards;
  await cards.tap(100, 18); // the title on the first card
  cards.type('!');
  cards.key('Escape');
  cards.type('zzz'); // nothing is being edited now
  assert.match(cards.saved(), /text="Pea Cards!"/);
  assert.doesNotMatch(cards.saved(), /zzz/);

  app.signal('tool').set('text');
  await cards.tap(40, 100);
  assert.equal(app.refs.textRow.visible, true);
  cards.type('Hi');
  cards.key('Enter');
  cards.type('there');
  app.signal('big').set(true);
  assert.match(cards.saved(), /<field x="0" y="84" w="96" h="32" text="Hi&#10;there" big="true"\/>/, 'new text keeps to the card; Enter starts a line');

  await cards.run('remove');
  assert.doesNotMatch(cards.saved(), /Hi&#10;there/);
});

test('painting: pencil, bucket and eraser draw into the card\'s picture', async t => {
  const cards = await open(t);
  const { app, os } = cards;
  await cards.run('new');
  assert.equal(cards.place(), '2 / 5');
  assert.doesNotMatch(cards.saved().split('<card id="5">')[1].split('</card>')[0], /picture/, 'a new card is clear paper');
  const picture = () => readStack(parseXml(cards.saved(), 'saved'), kit).cards[1].picture;
  const red = parseColor('#e8475a');
  const lime = parseColor('#b5e35a');

  app.signal('tool').set('draw');
  app.signal('brush').set(1);
  await cards.drag([[20, 20], [60, 20], [60, 50], [20, 50], [20, 20]]);
  assert.deepEqual([picture().get(40, 20), picture().get(60, 35), picture().get(40, 35)], [red, red, 0], 'an outline, empty inside');

  // Picking a color in the tool window selects it for the next stroke or fill.
  const swatches = app.refs.colors;
  const last = swatches.toScreen(swatches.w - 3, swatches.h - 3);
  app.signal('tool').set('fill');
  await cards.live.tap(last.x, last.y);
  await cards.tap(40, 35);
  assert.deepEqual([picture().get(40, 35), picture().get(21, 49), picture().get(40, 20), picture().get(100, 100)], [lime, lime, red, 0], 'the bucket fills up to the outline');

  app.signal('tool').set('erase');
  await cards.drag([[40, 30], [40, 40]]);
  assert.equal(picture().get(40, 35), 0);

  await cards.run('clear');
  assert.equal(picture(), null);
  assert.deepEqual(os.app('cards').refs.paintRow.visible, true);
});

test('a stack has recoverable drafts, explicit saved documents, portable export and validated import', async t => {
  const stored = new Map();
  const cards = await open(t, { stored });
  cards.app.signal('tool').set('button');
  await cards.tap(40, 100);
  cards.type('Mine');
  const file = cards.saved();
  cards.os.close('cards'); // closing hides the app; its draft remains recoverable
  await cards.app.files.flushRecovery();
  assert.equal((await cards.os.documents.readRecovery('cards')).content, file);
  assert.equal(cards.app.files.state.value.dirty, true, 'recovery does not pretend that a draft was explicitly saved');
  assert.equal(JSON.parse(stored.get('pea-os.layout')).value.desks[0].windows.find(win => win.id === 'cards').open, false);
  assert.doesNotMatch(stored.get('pea-os.layout'), /Mine/, 'layout never holds what an app holds');

  cards.os.dialogs.prompt = async () => 'Mine stack';
  assert.equal(await cards.app.files.run('save'), true);
  const documentId = cards.app.files.state.value.id;
  assert.equal((await cards.os.documents.get(documentId)).content, file);
  assert.equal(await cards.os.documents.readRecovery('cards'), null);

  const again = await open(t, { stored });
  assert.equal(again.saved(), file, 'the next run opens the same stack');

  // "Open" replaces the stack; a file with a mistake is refused whole.
  const small = '<stack version="1" name="Tiny"><card id="7"><button x="10" y="10" w="40" h="18" text="Loop" go="card:7"/></card></stack>';
  const broken = small.replace('card:7', 'card:8');
  const other = await open(t, { files: [{ name: 'broken.xml', text: broken }, { name: 'tiny.xml', text: small }] });
  const alerts = [];
  other.os.dialogs.alert = async value => { alerts.push(value); };
  await other.run('import');
  assert.match(String(other.live.errors[0]), /broken\.xml:1: <button> go="card:8" names a card that is not in the stack/);
  assert.match(alerts[0].message, /card:8/, 'the failed import is explained in a visible error dialog');
  assert.equal(other.place(), '1 / 4');
  await other.run('import');
  assert.equal(other.place(), '1 / 1');
  assert.match(other.saved(), /<stack version="1" name="Tiny"/);
  other.app.run('export');
  assert.equal(other.live.downloads.at(-1).name, 'tiny.xml');
});

test('the old single-stack autosave is migrated without changing its original XML', async t => {
  const legacy = '<stack version="1" name="Legacy"><card id="9"><field x="1" y="1" w="80" h="20" text="Old work"/></card></stack>';
  const stored = new Map([['pea-os.doc.cards', legacy]]);
  const cards = await open(t, { stored });
  assert.equal(cards.place(), '1 / 1');
  assert.match(cards.saved(), /Old work/);
  assert.equal(stored.get('pea-os.doc.cards'), legacy, 'the legacy source is retained as a migration backup');
  const record = await cards.os.documents.get(cards.app.files.state.value.id);
  assert.equal(record.name, 'Legacy');
  assert.match(record.content, /Old work/);
  assert.equal(cards.app.files.dirty, false);
});

test('stack documents: a round trip is exact and mistakes are located', () => {
  const picture = new Bitmap(192, 120);
  picture.fill(10, 5, 3, 2, parseColor('#46b04a'));
  picture.set(12, 9, parseColor('#16161d'));
  const stack = {
    name: 'A & B',
    cards: [
      { id: 1, picture, parts: [{ kind: 'field', x: 1, y: 2, w: 60, h: 20, text: 'two\nlines <3', big: true }, { kind: 'button', x: 5, y: 60, w: 40, h: 18, text: '"Go"', go: 'card:2' }] },
      { id: 2, picture: null, parts: [] }
    ]
  };
  const text = writeStack(stack, kit);
  assert.match(text, /<picture x="10" y="5">\n {6}eee\n {6}eee\n {6}\.\.\.\n {6}\.\.\.\n {6}\.\.0\n/, 'a picture is stored as the rows it covers');
  const back = readStack(parseXml(text, 'stack.xml'), kit);
  assert.equal(back.name, 'A & B');
  assert.deepEqual(back.cards[0].parts, stack.cards[0].parts);
  assert.deepEqual([...back.cards[0].picture.px], [...picture.px]);
  assert.equal(writeStack(back, kit), text);

  const read = body => () => readStack(parseXml(`<stack version="1">\n${body}\n</stack>`, 's.xml'), kit);
  assert.throws(read(''), /needs at least one <card>/);
  assert.throws(read('<card id="1"/><card id="1"/>'), /s\.xml:2: <card> id="1" is used by two cards/);
  assert.throws(read('<card id="1"><button x="180" y="0" w="40" h="18"/></card>'), /x="180" must be a whole number from 0 to 152/);
  assert.throws(read('<card id="1"><button x="0" y="0" w="40" h="18" go="away"/></card>'), /go="away" must be none, prev, next, first or card:ID/);
  assert.throws(read('<card id="1"><picture>zz</picture></card>'), /uses "z"; a picture uses 0-9, a-f and "\."/);
  assert.throws(read('<card id="1"><picture x="190">00000</picture></card>'), /does not fit on the card/);
  assert.throws(read('<card id="1"><field x="0" y="0" w="40" h="18" go="next"/></card>'), /unknown attribute "go"/);
  assert.throws(() => readStack(parseXml('<stack version="2"><card id="1"/></stack>'), kit), /version="2" is not supported/);
});
