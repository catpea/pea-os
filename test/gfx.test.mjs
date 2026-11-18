import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseXml } from '../src/core/xml.js';
import { Bitmap } from '../src/gfx/bitmap.js';
import { parseColor, rgba, toHex, over } from '../src/gfx/color.js';
import { PixelFont } from '../src/gfx/font.js';
import { Sprites } from '../src/gfx/sprites.js';
import { Theme } from '../src/gfx/theme.js';

const RED = parseColor('#ff0000');
const BLUE = parseColor('#00f');

const theme = (extra = '', attrs = '') => new Theme(parseXml(`
  <theme version="1" id="t" ${attrs}>
    <color role="ink" value="#000000"/>
    <color role="paper" value="#ffffff"/>
    <color role="accent" value="#ff0000"/>
    ${extra}
  </theme>`, 'theme.xml'));

test('colors pack as premultiplied RGBA and blend source-over', () => {
  assert.equal(toHex(RED), '#ff0000');
  assert.equal(parseColor('#00000080') >>> 24, 128);
  assert.equal(over(BLUE, RED), RED);
  assert.equal(over(BLUE, 0), BLUE);
  assert.equal(toHex(over(parseColor('#ffffff'), rgba(0, 0, 0, 128))), '#7f7f7f');
  assert.throws(() => parseColor('red'), /is not a color/);
});

test('bitmap drawing clips to its bounds', () => {
  const bitmap = new Bitmap(8, 6);
  bitmap.fill(-4, -4, 6, 6, RED);
  bitmap.fill(6, 4, 99, 99, BLUE);
  assert.equal(bitmap.get(1, 1), RED);
  assert.equal(bitmap.get(2, 2), 0);
  assert.equal(bitmap.get(7, 5), BLUE);
  bitmap.set(99, 99, RED);
  bitmap.line(-5, 3, 20, 3, RED);
  assert.equal(bitmap.get(4, 3), RED);
});

test('rounded frames are closed outlines with clear corners', () => {
  const bitmap = new Bitmap(12, 10);
  bitmap.roundFrame(0, 0, 12, 10, 3, RED);
  assert.equal(bitmap.get(0, 0), 0);
  assert.equal(bitmap.get(3, 0), RED);
  assert.equal(bitmap.get(2, 1), RED);
  assert.equal(bitmap.get(1, 2), RED);
  assert.equal(bitmap.get(0, 3), RED);
  assert.equal(bitmap.get(5, 5), 0);
  assert.equal(bitmap.get(11, 6), RED);
});

test('blit scales, flips and respects transparency', () => {
  const source = new Bitmap(2, 1);
  source.set(0, 0, RED);
  const target = new Bitmap(6, 2).clear(BLUE);
  target.blit(source, 0, 0, { scale: 2 });
  assert.deepEqual([target.get(0, 0), target.get(1, 1), target.get(2, 0)], [RED, RED, BLUE]);
  target.blit(source, 4, 0, { flipX: true });
  assert.deepEqual([target.get(4, 0), target.get(5, 0)], [BLUE, RED]);
});

test('font measures and draws proportional glyphs', () => {
  const font = new PixelFont(parseXml(`
    <font version="1" id="tiny" height="3" spacing="1" space="2">
      <glyph ch="i">
        #
        #
      </glyph>
      <glyph ch="m">
        #.#
        ###
      </glyph>
      <glyph ch="?">
        ##
      </glyph>
    </font>`));
  assert.equal(font.measure('im'), 1 + 1 + 3);
  assert.equal(font.measure('i m'), 1 + 1 + 2 + 1 + 3);
  assert.equal(font.measure('im', { scale: 2 }), 10);
  assert.equal(font.measure('z'), 2, 'unknown characters fall back to "?"');
  const bitmap = new Bitmap(8, 4);
  font.draw(bitmap, 'im', 0, 0, RED);
  assert.deepEqual([0, 1, 2, 3, 4].map(x => bitmap.get(x, 0) === RED), [true, false, true, false, true]);
  assert.deepEqual(font.wrap('i i i', 6), ['i i', 'i']);
  assert.throws(() => new PixelFont(parseXml('<font id="x"><glyph ch="ab">#</glyph></font>')), /exactly one character/);
});

test('themes resolve roles through fallbacks and reject unknown ones', () => {
  const plain = theme();
  assert.equal(plain.color('text'), plain.color('ink'));
  assert.equal(plain.color('shadow'), 0);
  assert.equal(plain.has('shadow'), false);
  assert.throws(() => plain.color('nope'), /Unknown color role/);
  assert.throws(() => theme('<color role="inky" value="#000"/>'), /role="inky" is unknown/);
  assert.throws(() => theme('', 'title="wavy"'), /title="wavy" must be one of/);
  assert.throws(() => new Theme(parseXml('<theme id="t"><color role="ink" value="#000"/></theme>')), /needs a <color role="paper">/);
});

test('a palette theme locks every color to its palette', () => {
  const locked = theme('', 'palette="#000000 #ffffff"');
  assert.equal(toHex(locked.color('accent')), '#000000');
  assert.equal(toHex(locked.paint('#eeeeee')), '#ffffff');
  assert.equal(locked.lock(parseColor('#00000080')) >>> 24, 128, 'translucent colors pass through');
});

test('sprite sheets build per theme and validate their pixels', () => {
  const sprites = new Sprites();
  sprites.add(parseXml(`
    <sprites version="1">
      <color key="r" value="#ff0000"/>
      <color key="a" role="accent"/>
      <sprite id="dot">
        .r
        a.
      </sprite>
      <sprite id="blink" fps="4">
        <frame>r</frame>
        <frame>a</frame>
      </sprite>
    </sprites>`));
  sprites.define('made', () => new Bitmap(3, 3));
  sprites.build(theme('', 'palette="#000000 #ffffff"'));
  const dot = sprites.get('dot');
  assert.deepEqual([dot.width, dot.height, dot.frames.length], [2, 2, 1]);
  assert.equal(dot.frames[0].get(0, 0), 0);
  assert.equal(toHex(dot.frames[0].get(1, 0)), '#000000', 'fixed colors follow the palette lock');
  assert.equal(sprites.get('blink').frames.length, 2);
  assert.equal(sprites.get('made').width, 3);
  assert.throws(() => sprites.get('nope'), /Unknown sprite "nope"/);

  const bad = text => () => new Sprites().add(parseXml(`<sprites version="1"><color key="r" value="#f00"/>${text}</sprites>`, 's.xml'));
  assert.throws(bad('<sprite id="a">rr\nr</sprite>'), /row "r" is 1 wide; expected 2/);
  assert.throws(bad('<sprite id="a">rx</sprite>'), /palette key "x"/);
  assert.throws(bad('<sprite id="a">r</sprite><sprite id="a">r</sprite>'), /already used/);
});
