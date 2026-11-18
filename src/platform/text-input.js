/**
 * Browser-only text adapter. A native textarea owns IME, clipboard, spelling,
 * and selection; the widget still paints every visible pixel. No DOM leaks
 * into the core. Other platforms retain Field's ordinary key-event fallback.
 */
export function attachTextInput(ui, canvas) {
  const input = document.createElement('textarea');
  input.dataset.peaTextInput = '';
  input.tabIndex = -1;
  input.autocomplete = 'off';
  input.autocapitalize = 'off';
  input.spellcheck = false;
  input.wrap = 'off';
  Object.assign(input.style, {
    position: 'fixed', width: '1px', height: '1px', padding: '0', border: '0',
    opacity: '0.01', overflow: 'hidden', pointerEvents: 'none', resize: 'none',
    fontSize: '16px', zIndex: '-1'
  });
  (canvas.parentElement ?? document.body).append(input);
  let active = null;
  let syncing = false;
  let composing = false;
  let disposed = false;
  const listeners = [];
  const on = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };

  const position = () => {
    if (!active) return;
    const box = canvas.getBoundingClientRect();
    const size = ui.stage.size.value;
    const caret = active.caretRect;
    input.style.left = `${Math.max(box.left, Math.min(box.right - 1, box.left + caret.x * box.width / size.w))}px`;
    input.style.top = `${Math.max(box.top, Math.min(box.bottom - 1, box.top + caret.y * box.height / size.h))}px`;
  };
  const sync = field => {
    if (field !== active || composing || disposed) return;
    syncing = true;
    try {
      if (input.value !== field.text) input.value = field.text;
      input.readOnly = field.readonly;
      if (Number.isFinite(field.maxlength)) input.maxLength = field.maxlength;
      else input.removeAttribute('maxlength');
      const label = field.props.label?.value ?? field.props.label ?? field.placeholder ?? 'Text input';
      input.setAttribute('aria-label', String(label || 'Text input'));
      input.setAttribute('aria-multiline', String(field.multiline));
      const { start, end } = field.selection;
      if (input.selectionStart !== start || input.selectionEnd !== end || input.selectionDirection !== field.selectionDirection) input.setSelectionRange(start, end, field.selectionDirection);
      position();
    } finally { syncing = false; }
  };
  const read = () => {
    if (!active || syncing) return;
    active.applyNative(input.value, input.selectionStart, input.selectionEnd, input.selectionDirection);
    position();
  };
  const keyEvent = event => ({ key: event.key, ctrl: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey, repeat: event.repeat, nativeText: true });

  on(input, 'keydown', event => {
    event.stopPropagation();
    if (!active || event.isComposing || composing) return;
    const field = active;
    const key = keyEvent(event);
    ui.stage.keys.emit('down', key);
    if (key.handled && !key.nativeDefault || (!field.multiline && event.key === 'Enter') || (key.ctrl && ['s', 'n', 'o', 'f', 'z', 'y'].includes(event.key.toLowerCase()))) event.preventDefault();
  });
  on(input, 'keyup', event => {
    event.stopPropagation();
    if (!active || event.isComposing || composing) return;
    const key = keyEvent(event);
    ui.stage.keys.emit('up', key);
  });
  on(input, 'input', read);
  on(input, 'select', () => {
    if (active && !syncing && !composing) active.setSelection(input.selectionStart, input.selectionEnd, input.selectionDirection);
  });
  on(document, 'selectionchange', () => {
    if (document.activeElement === input && active && !syncing && !composing) active.setSelection(input.selectionStart, input.selectionEnd, input.selectionDirection);
  });
  on(input, 'compositionstart', () => { composing = true; active?.beginComposition(); });
  on(input, 'compositionend', () => {
    read();
    active?.endComposition();
    composing = false;
    if (active) sync(active);
  });
  on(window, 'resize', position);

  const adapter = {
    focus(field) {
      active = field;
      composing = false;
      sync(field);
      input.focus({ preventScroll: true });
    },
    blur() {
      active?.endComposition();
      active = null;
      composing = false;
      if (document.activeElement === input) {
        input.blur();
        if (!disposed) canvas.focus({ preventScroll: true });
      }
    },
    sync,
    async clipboard(kind, field = active) {
      if (!field) return false;
      try {
        const { start, end } = field.selection;
        const snapshot = field.text;
        const unchanged = () => !field.disposed && field.text === snapshot && field.selection.start === start && field.selection.end === end;
        if (kind === 'v') {
          const text = await navigator.clipboard.readText();
          if (unchanged()) field.replaceSelection(text);
        } else {
          await navigator.clipboard.writeText(snapshot.slice(start, end));
          if (kind === 'x' && unchanged()) field.replaceSelection('');
        }
        return true;
      } catch (error) { field.events.emit('error', error); return false; }
    }
  };
  const release = ui.attachTextInput(adapter);
  const offFrame = ui.stage.frame.on('paint', position);
  return () => {
    if (disposed) return;
    disposed = true;
    release();
    offFrame();
    for (const off of listeners) off();
    input.remove();
  };
}
