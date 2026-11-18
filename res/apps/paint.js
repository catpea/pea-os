import { createDocumentController } from '../../src/os/document-controller.js';

/** Pea Paint keeps its picture independently of the window's viewport. */
export const PAINT_COLORS = [
  '#16161d', '#3a3550', '#6b6a86', '#a9aec4', '#ffffff', '#ffd75e', '#ff9a3d', '#e8475a',
  '#c74aa6', '#6d3fa8', '#2b3a8c', '#3f7fe0', '#63d2f0', '#1f8a78', '#46b04a', '#b5e35a'
];
const KEYS = '0123456789abcdef';
const LIMIT = 512;

export function readPainting(node, { Bitmap, parseColor }) {
  if (node.name !== 'painting') node.fail('must be <painting>');
  node.expect({ attrs: ['version', 'width', 'height'], children: ['pixels'] });
  if (node.need('version') !== '1') node.fail('only painting version 1 is supported');
  const width = node.num('width');
  const height = node.num('height');
  if (![width, height].every(n => Number.isInteger(n) && n >= 1 && n <= LIMIT)) node.fail(`width and height must be whole numbers from 1 to ${LIMIT}`);
  const parts = node.all('pixels');
  if (parts.length !== 1) node.fail('needs one <pixels> element');
  const part = parts[0].expect({ text: true });
  const rows = part.rows();
  if (rows.length !== height || rows.some(row => row.length !== width)) part.fail('pixel rows must match the painting size');
  const colors = PAINT_COLORS.map(parseColor);
  const bitmap = new Bitmap(width, height);
  rows.forEach((row, y) => [...row].forEach((key, x) => {
    if (key === '.') return;
    const value = KEYS.indexOf(key);
    if (value < 0) part.fail('pixels use 0-9, a-f or "." for transparency');
    bitmap.px[y * width + x] = colors[value];
  }));
  return bitmap;
}

export function writePainting(bitmap, { parseColor }) {
  const colors = new Map(PAINT_COLORS.map((color, i) => [parseColor(color), KEYS[i]]));
  const rows = [];
  for (let y = 0; y < bitmap.height; y++) {
    let row = '';
    for (let x = 0; x < bitmap.width; x++) {
      const pixel = bitmap.px[y * bitmap.width + x];
      if (!pixel) row += '.';
      else {
        const key = colors.get(pixel);
        if (!key) throw new Error('This painting contains a color outside the Pea palette.');
        row += key;
      }
    }
    rows.push(`    ${row}`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<painting version="1" width="${bitmap.width}" height="${bitmap.height}">\n  <pixels>\n${rows.join('\n')}\n  </pixels>\n</painting>\n`;
}

export default function paint(app) {
  const { Bitmap, parseColor } = app.gfx;
  const { paper, swatches } = app.refs;
  const size = app.signal('size');
  const tool = app.signal('tool');
  const colors = PAINT_COLORS.map(parseColor);
  const white = parseColor('#ffffff');
  const black = parseColor('#16161d');
  const grey = parseColor('#a9aec4');
  const kit = { Bitmap, parseColor };
  let picture = new Bitmap(200, 128).clear(white);
  let ink = colors[7];
  let gesture = null;
  let files;
  app.view.props.onResize = ({ h }) => { app.refs.body.props.height = Math.max(195, h); };

  function present() {
    if (paper.props.width !== picture.width || paper.props.height !== picture.height) {
      paper.props.width = picture.width;
      paper.props.height = picture.height;
      app.os.ui.requestLayout();
    }
    if (!paper.bitmap) return;
    paper.bitmap.checker(0, 0, paper.w, paper.h, white, grey);
    paper.bitmap.blit(picture, 0, 0);
    paper.commit();
    app.signal('dimensions').set(`${picture.width} × ${picture.height}`);
  }

  const at = point => ({ x: Math.max(0, Math.min(picture.width - 1, Math.floor(point.x))), y: Math.max(0, Math.min(picture.height - 1, Math.floor(point.y))) });
  function dab(point) {
    const brush = size.value;
    if (tool.value === 'erase') picture.erase(point.x - (brush >> 1), point.y - (brush >> 1), brush, brush);
    else picture.fill(point.x - (brush >> 1), point.y - (brush >> 1), brush, brush, ink);
  }
  function stroke(from, to) {
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
    for (let i = 1; i <= steps; i++) dab({ x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps) });
  }
  function flood(point) {
    const target = picture.get(point.x, point.y);
    if (target === ink) return;
    const todo = [point.y * picture.width + point.x];
    while (todo.length) {
      const i = todo.pop();
      if (picture.px[i] !== target) continue;
      picture.px[i] = ink;
      const x = i % picture.width;
      if (x) todo.push(i - 1);
      if (x + 1 < picture.width) todo.push(i + 1);
      if (i >= picture.width) todo.push(i - picture.width);
      if (i + picture.width < picture.px.length) todo.push(i + picture.width);
    }
  }
  function shape(point) {
    picture = gesture.before.clone();
    const start = gesture.start;
    if (gesture.tool === 'line') picture.line(start.x, start.y, point.x, point.y, ink);
    else picture.frame(Math.min(start.x, point.x), Math.min(start.y, point.y), Math.abs(start.x - point.x) + 1, Math.abs(start.y - point.y) + 1, ink);
  }

  app.scope.on(paper.events, 'down', point => {
    if (!files.state.value.ready || point.x >= picture.width || point.y >= picture.height) return;
    const position = at(point);
    if (tool.value === 'pick') {
      ink = picture.get(position.x, position.y) || white;
      tool.set('pencil');
      drawSwatches();
      return;
    }
    if (tool.value === 'fill') {
      flood(position); present(); files.changed(); return;
    }
    gesture = { before: picture.clone(), start: position, last: position, tool: tool.value };
    if (['line', 'rect'].includes(tool.value)) shape(position);
    else dab(position);
    present();
  });
  app.scope.on(paper.events, 'move', point => {
    if (!gesture) return;
    const position = at(point);
    if (['line', 'rect'].includes(gesture.tool)) shape(position);
    else stroke(gesture.last, position);
    gesture.last = position;
    present();
  });
  app.scope.on(paper.events, 'up', () => {
    if (!gesture) return;
    gesture = null;
    files.changed();
  });
  app.scope.on(paper.events, 'cancel', () => {
    if (!gesture) return;
    picture = gesture.before;
    gesture = null;
    present();
  });
  app.scope.on(paper.events, 'resize', present);

  function drawSwatches() {
    const { bitmap } = swatches;
    if (!bitmap) return;
    const width = bitmap.width / colors.length;
    bitmap.clear();
    colors.forEach((color, i) => {
      const x = Math.floor(i * width);
      const w = Math.ceil(width);
      bitmap.fill(x, 0, w, bitmap.height, color);
      if (color !== ink) return;
      bitmap.frame(x, 0, w, bitmap.height, black);
      bitmap.frame(x + 1, 1, w - 2, bitmap.height - 2, white);
    });
    swatches.commit();
  }
  app.scope.on(swatches.events, 'resize', drawSwatches);
  app.scope.on(swatches.events, 'down', point => {
    ink = colors[Math.min(colors.length - 1, Math.max(0, Math.floor(point.x * colors.length / Math.max(1, swatches.w))))];
    if (['erase', 'pick'].includes(tool.value)) tool.set('pencil');
    drawSwatches();
  });

  app.command('clear', () => { picture.clear(white); present(); files.changed(); });
  app.command('resize-picture', async () => {
    const value = await app.os.dialogs.prompt({ title: 'Picture size', message: `Width × height, from 1 to ${LIMIT} pixels.`, value: `${picture.width}x${picture.height}`, acceptLabel: 'Resize' });
    if (value === null) return;
    const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(value);
    const width = Number(match?.[1]), height = Number(match?.[2]);
    if (!match || ![width, height].every(n => n >= 1 && n <= LIMIT)) {
      await app.os.dialogs.alert({ title: 'Picture size', message: `Use a size such as 200x128, with each dimension from 1 to ${LIMIT}.` });
      return;
    }
    // New room is white; what was there is copied pixel for pixel, so erased (clear) pixels stay clear rather than blending onto white.
    const resized = new Bitmap(width, height).clear(white);
    const keep = Math.min(width, picture.width);
    for (let y = 0; y < Math.min(height, picture.height); y++) resized.px.set(picture.px.subarray(y * picture.width, y * picture.width + keep), y * width);
    picture = resized;
    present(); files.changed();
  });
  app.command('export-png', async () => {
    try {
      if (!app.os.platform.exportBitmap) throw new Error('PNG export is unavailable on this platform. Use File → Export for the editable XML picture.');
      await app.os.platform.exportBitmap(`${files.state.value.name}.png`, picture);
    } catch (error) { await app.os.dialogs.alert({ title: 'PNG export', message: error.message }); }
  });

  files = createDocumentController(app, {
    format: 'application/x-pea-painting+xml', extension: '.xml', accept: '.xml',
    create: () => new Bitmap(200, 128).clear(white),
    parse: (text, name) => readPainting(app.xml.parseXml(text, name), kit),
    serialize: () => writePainting(picture, kit),
    install(value) { gesture = null; picture = value; present(); }
  });
  drawSwatches();
  present();
}
