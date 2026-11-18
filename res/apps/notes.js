import { NOTE_COLORS, noteTitle } from '../../src/os/sticky-notes.js';

const ago = time => {
  if (!time) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'edited just now';
  if (minutes < 60) return `edited ${minutes} min ago`;
  if (minutes < 1440) return `edited ${Math.round(minutes / 60)} h ago`;
  return `edited ${new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
};

/** A small index for the notes that live on the desktop. */
export default function (app) {
  let connected = false;
  const notes = () => app.os.desktop?.notes;
  const refresh = () => {
    const store = notes();
    if (!store) return;
    const { notes: all } = store.state.value;
    const query = app.scope.get('query').trim().toLowerCase();
    const active = all.filter(note => !note.deleted);
    const shown = active.filter(note => !query || note.text.toLowerCase().includes(query)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    app.refs.notesList.empty = query ? 'No note says that' : 'No notes yet';
    app.refs.notesList.items = shown.map(note => ({
      value: note.id,
      text: noteTitle(note).slice(0, 56),
      detail: [`Desktop ${note.desk + 1}`, note.hidden ? 'hidden' : '', note.rolled ? 'rolled up' : '', ago(note.updated)].filter(Boolean).join(' · '),
      sprite: `note-${NOTE_COLORS.indexOf(note.color) + 1}`
    }));
    if (!shown.some(note => note.id === app.scope.get('selection'))) app.scope.set('selection', shown[0]?.id ?? '');
    const archived = all.length - active.length;
    app.scope.set('has-selection', active.some(note => note.id === app.scope.get('selection')));
    app.scope.set('has-archive', archived > 0);
    app.scope.set('status', store.error?.value || `${active.length} notes · ${archived} archived. Notes save automatically.`);
  };
  const connect = () => {
    if (connected || app.scope.disposed || !notes()) return;
    connected = true;
    app.scope.subscribe(notes().state, refresh);
    if (notes().error) app.scope.subscribe(notes().error, refresh);
  };
  app.scope.subscribe(app.visible, visible => { if (visible) connect(); });
  app.scope.subscribe(app.signal('query'), refresh, { immediate: false });
  app.scope.subscribe(app.signal('selection'), () => {
    const all = notes()?.state.value.notes ?? [];
    app.scope.set('has-selection', all.some(note => !note.deleted && note.id === app.scope.get('selection')));
  });
  // A restored window can mount while Desktop is still being constructed.
  queueMicrotask(connect);
  const safely = fn => (...args) => {
    try { return fn(...args); } catch (error) { app.report(error); }
  };
  app.command('create-note', safely(() => { connect(); app.os.desktop.newNote(); }));
  app.command('reveal-note', safely(() => {
    connect();
    if (app.scope.get('selection')) notes()?.reveal(app.scope.get('selection'));
  }));
  app.command('duplicate-note', safely(() => {
    connect();
    const id = app.scope.get('selection');
    if (id) app.scope.set('selection', notes().duplicate(id).id);
  }));
  app.command('archive-note', safely(() => {
    connect();
    if (app.scope.get('selection')) notes()?.remove(app.scope.get('selection'));
  }));
  app.command('restore-note', safely(() => {
    connect();
    const last = notes()?.state.value.notes.filter(note => note.deleted).at(-1);
    if (last) notes().restore(last.id);
  }));
  app.command('export-notes', safely(() => {
    connect();
    return app.download('pea-sticky-notes.json', notes().export(), 'application/json');
  }));
  app.command('import-notes', async () => {
    connect();
    try {
      const file = await app.os.pick('.json');
      if (file) notes().import(file.text);
    } catch (error) { app.report(error); }
  });
  app.command('empty-archive', async () => {
    connect();
    const archived = notes().state.value.notes.filter(note => note.deleted);
    if (!archived.length) {
      await app.os.dialogs.alert({ title: 'Sticky Notes', message: 'The archive is empty.' });
      return;
    }
    const answer = await app.os.dialogs.confirm({
      title: 'Empty note archive',
      message: `Permanently delete ${archived.length} archived notes? Export your notes first if you want to keep a copy.`,
      buttons: [{ value: 'cancel', text: 'Cancel' }, { value: 'delete', text: 'Delete permanently' }]
    });
    if (answer !== 'delete') return;
    try { for (const note of archived) notes().purge(note.id); }
    catch (error) { app.report(error); }
  });
}
