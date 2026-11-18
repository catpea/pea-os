import { readStack, CARD_W, CARD_H } from './cards.js';
import { readPainting } from './paint.js';
import { parseDatabase } from './records.js';
import { parseFlow } from './flow.js';
import { parseAgentFlow } from '../../src/ai/flow.js';

/** A small local document shelf: no paths, mounts or hidden background services. */
export default function documents(app) {
  const store = app.os.documents;
  const selected = app.signal('selected');
  const search = app.signal('search');
  const kind = app.signal('kind');
  const { fileList, preview, previewText } = app.refs;
  const { Bitmap, parseColor } = app.gfx;
  let records = [];
  let current = null;
  let picture = null;
  let request = 0;
  let listing = 0;
  let narrow = false;
  app.view.props.onResize = ({ w, h }) => {
    app.refs.body.props.height = Math.max(165, h);
    const compact = w < 240;
    if (compact !== narrow) {
      narrow = compact;
      app.signal('list-open').set(true);
      app.signal('preview-open').set(!compact);
      app.signal('preview-label').set('Preview');
    }
  };
  const title = id => app.os.apps.get(id)?.title ?? id;

  function filtered() {
    const query = search.value.trim().toLocaleLowerCase();
    const items = records.filter(record => (kind.value === 'all' || record.appId === kind.value)
      && (!query || `${record.name} ${title(record.appId)}`.toLocaleLowerCase().includes(query)));
    fileList.items = items.map(record => ({ value: record.id, text: record.name, detail: `${title(record.appId)} · ${new Date(record.updatedAt).toLocaleDateString()}` }));
    app.signal('status').set(`${items.length} document${items.length === 1 ? '' : 's'} · Saved in this browser`);
    if (!items.some(item => item.id === selected.value)) selected.set(items[0]?.id ?? '');
  }

  async function refresh() {
    const ticket = ++listing;
    try {
      const next = await store.list();
      if (ticket !== listing || app.scope.disposed) return;
      records = next;
      filtered();
      await inspect();
    } catch (error) { app.signal('status').set(error.message); }
  }

  function drawPreview() {
    const bitmap = preview.bitmap;
    if (!bitmap) return;
    bitmap.clear(parseColor('#fbf7ea'));
    if (picture) {
      const scale = Math.min(bitmap.width / picture.width, bitmap.height / picture.height, 2);
      const width = Math.max(1, Math.floor(picture.width * scale));
      const height = Math.max(1, Math.floor(picture.height * scale));
      const left = Math.floor((bitmap.width - width) / 2), top = Math.floor((bitmap.height - height) / 2);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        bitmap.set(left + x, top + y, picture.get(Math.floor(x / scale), Math.floor(y / scale)));
      }
    }
    preview.commit();
  }

  async function inspect() {
    const ticket = ++request;
    const id = selected.value;
    app.signal('has-selection').set(Boolean(id));
    if (!id) {
      current = null; picture = null;
      preview.visible = false; previewText.visible = true;
      app.signal('selected-name').set('Your documents');
      app.signal('details').set('Create something in Notepad, Paint, Cards, Records or Flow, then choose Save.');
      app.signal('preview-text').set('Saved documents live in this browser. Export a copy to keep on your device.');
      return;
    }
    try {
      const record = await store.get(id);
      if (ticket !== request || app.scope.disposed) return;
      current = record;
      if (!record) { selected.set(''); return; }
      app.signal('selected-name').set(record.name);
      app.signal('details').set(`${title(record.appId)} · ${Math.max(1, Math.ceil(record.content.length / 1024))} KB`);
      picture = null;
      if (record.appId === 'paint') picture = readPainting(app.xml.parseXml(record.content, record.name), { Bitmap, parseColor });
      else if (record.appId === 'cards') {
        const stack = readStack(app.xml.parseXml(record.content, record.name), { Bitmap, parseColor });
        const first = stack.cards[0];
        picture = new Bitmap(CARD_W, CARD_H).clear(parseColor('#ffffff'));
        if (first.picture) picture.blit(first.picture, 0, 0);
        for (const part of first.parts) {
          const ink = parseColor('#16161d');
          if (part.kind === 'button') picture.frame(part.x, part.y, part.w, part.h, ink);
          const layer = new Bitmap(part.w, part.h);
          const style = { scale: part.big ? 2 : 1 };
          app.font.wrap(part.text, part.w - 4, style).forEach((line, i) => app.font.draw(layer, line, 2, 2 + i * app.font.lineHeight * style.scale, ink, style));
          picture.blit(layer, part.x, part.y);
        }
        app.signal('details').set(`${stack.cards.length} cards · Pea Cards`);
      } else if (record.appId === 'records') {
        const db = parseDatabase(app.xml, record.content, record.name);
        app.signal('details').set(`${db.records.length} records · ${db.fields.length} fields · Pea Records`);
      } else if (record.appId === 'flow') {
        const flow = parseFlow(app.xml, record.content, record.name);
        app.signal('details').set(`${flow.nodes.length} nodes · ${flow.wires.length} wires · Pea Flow`);
      } else if (record.appId === 'agents') {
        const flow = parseAgentFlow(app.xml, record.content, record.name);
        app.signal('details').set(`${flow.nodes.length} agents and helpers · ${flow.wires.length} wires · Agent Flow`);
      }
      preview.visible = Boolean(picture);
      previewText.visible = !picture;
      app.signal('preview-text').set(picture ? '' : record.content.slice(0, 20000));
      drawPreview();
    } catch (error) {
      if (ticket !== request) return;
      picture = null; preview.visible = false; previewText.visible = true;
      app.signal('preview-text').set(`Preview unavailable: ${error.message}`);
    }
  }

  const action = fn => async () => {
    try { await fn(); } catch (error) { await app.os.dialogs.alert({ title: 'Documents', message: error.message }); }
  };
  app.command('open-document', action(async () => { if (selected.value) await app.os.openDocument(selected.value); }));
  app.command('preview-document', () => inspect());
  app.command('toggle-preview', () => {
    const show = !app.signal('preview-open').value;
    app.signal('preview-open').set(show);
    app.signal('list-open').set(!narrow || !show);
    app.signal('preview-label').set(narrow && show ? 'Back' : 'Preview');
  });
  app.command('rename-document', action(async () => {
    if (!current) return;
    const record = current;
    const name = await app.os.dialogs.prompt({ title: 'Rename document', message: 'Choose a new name.', value: record.name, acceptLabel: 'Rename' });
    if (name === null) return;
    const clean = name.trim();
    if (!clean) throw new Error('A document needs a name.');
    const collision = records.find(item => item.id !== record.id && item.appId === record.appId && item.name.toLocaleLowerCase() === clean.toLocaleLowerCase());
    if (collision) throw new Error('That name is already used. Choose a different name.');
    await store.rename(record.id, clean);
  }));
  app.command('export-document', action(async () => {
    const record = selected.value ? await store.get(selected.value) : null;
    if (!record) return;
    const extension = record.format.includes('xml') ? '.xml' : '.txt';
    app.download(`${record.name}${extension}`, record.content, record.format);
  }));
  app.command('delete-document', action(async () => {
    if (!current) return;
    const record = current;
    const answer = await app.os.dialogs.confirm({ title: 'Delete document', message: `Delete “${record.name}” from Pea? Export a copy first if you want to keep it.`,
      buttons: [{ value: 'delete', text: 'Delete' }, { value: 'cancel', text: 'Cancel' }] });
    if (answer === 'delete') await store.remove(record.id);
  }));
  app.command('new-document', action(async () => {
    const id = await app.os.dialogs.choose({ title: 'New document', message: 'Choose an app.', acceptLabel: 'Create', items: [
      { value: 'notepad', text: 'Text document', detail: 'Notepad' },
      { value: 'paint', text: 'Pixel painting', detail: 'Pea Paint' },
      { value: 'cards', text: 'Card stack', detail: 'Pea Cards' },
      { value: 'records', text: 'Database', detail: 'Pea Records' },
      { value: 'flow', text: 'Flow program', detail: 'Pea Flow' },
      { value: 'agents', text: 'Agent team', detail: 'Agent Flow' }
    ] });
    if (!id) return;
    app.os.open(id);
    await app.os.app(id).files.run('new');
  }));
  app.scope.subscribe(selected, () => inspect(), { immediate: false });
  app.scope.subscribe(search, filtered, { immediate: false });
  app.scope.subscribe(kind, filtered, { immediate: false });
  app.scope.subscribe(store.changed, refresh, { immediate: false });
  app.scope.on(preview.events, 'resize', drawPreview);
  refresh();
}
