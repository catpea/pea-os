import { createDocumentController } from '../../src/os/document-controller.js';

const MAX_TEXT = 2_000_000;

export default function notepad(app) {
  const content = app.signal('content');
  const find = app.signal('find');
  const matchCase = app.signal('match-case');
  const findOpen = app.signal('find-open');
  const { editor, findText } = app.refs;
  editor.documentUndo = true;
  app.view.props.onResize = ({ h }) => { app.refs.body.props.height = Math.max(180, h); };
  const parse = text => {
    if (text.length > MAX_TEXT) throw new Error('This text file is too large. Pea Notepad opens files up to two million characters.');
    if (text.includes('\0')) throw new Error('This looks like a binary file. Open a plain text document instead.');
    return text;
  };
  const files = createDocumentController(app, {
    format: 'text/plain', extension: '.txt', accept: '.txt,.md,.csv,.log,.xml,.json,.js,.mjs,.css,.html,text/plain',
    create: () => '', parse,
    serialize: () => content.value,
    install(text) { content.set(text); editor.setSelection(0); }
  });

  function stats() {
    const text = content.value;
    const start = editor.selection.start;
    const before = text.slice(0, start);
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n');
    app.signal('stats').set(`Ln ${line}, Col ${column} · ${text.length} chars`);
  }
  app.scope.subscribe(content, () => {
    if (!files.updating) files.changed({ coalesce: 'typing' });
    stats();
  }, { immediate: false });
  app.scope.on(editor.events, 'selection', stats);

  function search(backward = false, fromStart = false) {
    const needle = find.value;
    if (!needle) { app.signal('find-result').set('Type something to find'); return; }
    const selection = editor.selection;
    const start = fromStart ? 0 : backward ? selection.start : selection.end;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(escaped, matchCase.value ? 'gu' : 'giu');
    let first = null, last = null, chosen = null;
    for (const match of content.value.matchAll(expression)) {
      first ??= match;
      last = match;
      if (backward && match.index < start) chosen = match;
      if (!backward && match.index >= start) { chosen = match; break; }
    }
    const wrapped = !chosen;
    chosen ??= backward ? last : first;
    if (!chosen) { app.signal('find-result').set('No matches'); return; }
    editor.setSelection(chosen.index, chosen.index + chosen[0].length);
    app.os.ui.focus(editor);
    app.signal('find-result').set(wrapped ? 'Wrapped to the next match' : 'Match selected');
    stats();
  }
  app.command('find', () => {
    findOpen.set(!findOpen.value);
    if (findOpen.value) { app.os.ui.focus(findText); findText.selectAll(); }
    else app.os.ui.focus(editor);
  });
  app.command('find-next', () => search());
  app.command('find-previous', () => search(true));
  app.scope.on(findText.events, 'submit', () => search(false, true));
  app.scope.on(app.keys, 'down', ({ key, ctrl, shift }) => {
    if (ctrl && key.toLowerCase() === 'f') app.run('find');
    else if (key === 'F3') search(Boolean(shift));
    else if (key === 'Escape' && findOpen.value) { findOpen.set(false); app.os.ui.focus(editor); }
  });
  app.command('insert-date', () => {
    editor.replaceSelection(new Date().toLocaleString());
    app.os.ui.focus(editor);
  });
  files.ready.then(stats);
  stats();
}
