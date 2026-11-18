import { Signal } from '../core/reactive.js';

const MAX_HISTORY = 40;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const FILE_ACTIONS = ['new', 'open', 'save', 'save-as', 'import', 'export'];
const cleanName = name => String(name ?? 'Untitled').replace(/[\\/\u0000-\u001f]/g, '-').trim() || 'Untitled';

/** One active document, conventional saving and a bounded undo stack for an app. */
export class DocumentController {
  state = new Signal({ id: null, name: 'Untitled', dirty: false, saving: false, error: '', ready: false, canUndo: false, canRedo: false });
  updating = false;
  #queue = Promise.resolve();
  #history = [];
  #at = 0;
  #saved = '';
  #savedAt = null;
  #generation = 0;
  #group = null;
  #groupTime = 0;
  #timer = null;
  #disposed = false;
  #recoveryChanged = false;

  constructor(app, options) {
    this.app = app;
    this.options = options;
    this.store = app.os.documents;
    if (!this.store) throw new Error('The document store is not ready.');
    app.files = this;
    this.#saved = this.serialize();
    this.#history = [this.#saved];
    this.#set({ name: options.initialName ?? 'Untitled' });
    for (const action of FILE_ACTIONS) app.command(`file-${action}`, () => this.run(action));
    app.command('undo', () => this.run('undo'));
    app.command('redo', () => this.run('redo'));
    app.scope.subscribe(this.state, state => {
      const values = {
        'file-name': state.name, 'file-status': state.error ? `Could not save: ${state.error}`
          : state.saving ? 'Saving…' : !state.ready ? 'Opening…' : state.dirty ? 'Unsaved changes' : state.id ? 'Saved in Pea' : 'New document',
        'file-dirty': state.dirty, 'can-undo': state.canUndo, 'can-redo': state.canRedo
      };
      for (const [name, value] of Object.entries(values)) if (app.scope.has(name)) app.scope.set(name, value);
    });
    app.scope.on(app.keys, 'down', ({ key, ctrl, shift }) => {
      if (!ctrl) return;
      const k = key.toLowerCase();
      const action = k === 's' ? (shift ? 'save-as' : 'save') : k === 'o' ? 'open' : k === 'n' ? 'new'
        : k === 'z' ? (shift ? 'redo' : 'undo') : k === 'y' ? 'redo' : null;
      if (action) this.run(action);
    });
    app.scope.subscribe(app.visible, visible => { if (!visible) this.flushRecovery(); }, { immediate: false });
    app.scope.subscribe(this.store.changed, () => this.#refreshMetadata(), { immediate: false });
    app.scope.add(() => this.dispose());
    this.ready = this.#initialize().catch(error => this.#failure(error, false)).finally(() => {
      this.#set({ ready: true });
      if (this.dirty) this.#scheduleRecovery();
    });
  }

  #set(patch) { if (!this.#disposed) this.state.set({ ...this.state.value, ...patch }); }
  serialize() { return String(this.options.serialize()); }
  get dirty() { return this.state.value.dirty; }

  #session(id) {
    try { this.app.os.platform.storage?.set(`pea-os.active-document.${this.app.id}`, id ?? ''); }
    catch { /* A saved document is still safe if a preference cannot be remembered. */ }
  }

  async #refreshMetadata() {
    const { id, saving } = this.state.value;
    if (!id || saving || this.#disposed) return;
    try {
      const record = await this.store.get(id);
      if (this.#disposed || this.state.value.id !== id || this.state.value.saving) return;
      if (record && record.content === this.#saved) {
        this.#savedAt = record.updatedAt;
        this.#set({ name: record.name });
      }
    } catch (error) { this.#failure(error, false); }
  }

  async #initialize() {
    let id = null;
    let migrated = false;
    try { id = this.app.os.platform.storage?.get(`pea-os.active-document.${this.app.id}`); } catch { /* Optional preference. */ }
    try { migrated = this.app.os.platform.storage?.get(`pea-os.migrated-document.${this.app.id}`) === '1'; } catch { /* Optional preference. */ }
    const generation = this.#generation;
    const [record, recovery] = await Promise.all([id ? this.store.get(id) : null, this.store.readRecovery(this.app.id)]);
    if (this.#disposed || generation !== this.#generation) return;
    if (record?.appId === this.app.id) this.#installRecord(record);
    else if (this.options.legacyText && !migrated) {
      const legacy = this.options.parse(this.options.legacyText, 'previously saved document');
      this.#install(legacy, { name: this.options.initialName ?? 'Recovered document', id: null, saved: true });
      const savedLegacy = await this.store.save({ appId: this.app.id, name: this.state.value.name, format: this.options.format, content: this.serialize() });
      this.#savedAt = savedLegacy.updatedAt;
      this.#set({ id: savedLegacy.id });
      this.#session(savedLegacy.id);
      try { this.app.os.platform.storage?.set(`pea-os.migrated-document.${this.app.id}`, '1'); } catch { /* The saved record remains available. */ }
    } else if (this.options.legacyText && migrated) this.#install(this.options.create());
    if (!recovery || this.#disposed || generation !== this.#generation) return;
    let parsed;
    try { parsed = this.options.parse(recovery.content, 'recovery draft'); }
    catch (error) { this.#failure(new Error(`A recovery draft could not be read: ${error.message}`), false); return; }
    if (recovery.content === this.#saved && recovery.documentId === this.state.value.id) {
      await this.store.clearRecovery(this.app.id);
      return;
    }
    const choice = await this.app.os.dialogs.confirm({
      title: 'Recover your work', message: `Restore the unsaved draft of “${recovery.name || 'Untitled'}”?`,
      buttons: [{ value: 'restore', text: 'Restore draft' }, { value: 'saved', text: 'Use saved version' }]
    });
    if (this.#disposed || generation !== this.#generation) return;
    if (choice === 'restore') {
      let saved = recovery.documentId ? await this.store.get(recovery.documentId) : null;
      if (saved?.appId !== this.app.id) saved = null;
      this.#install(parsed, { id: saved?.id ?? null, name: recovery.name || saved?.name || 'Recovered document', saved: false });
      this.#saved = recovery.baseContent ?? saved?.content ?? '';
      this.#savedAt = saved ? (recovery.baseUpdatedAt ?? saved.updatedAt) : null;
      this.#set({ dirty: this.serialize() !== this.#saved });
    } else if (choice === 'saved') await this.store.clearRecovery(this.app.id);
  }

  #install(value, { id = null, name = 'Untitled', saved = true } = {}) {
    this.updating = true;
    try { this.options.install(value, { reset: true }); } finally { this.updating = false; }
    const content = this.serialize();
    this.#history = [content];
    this.#at = 0;
    this.#group = null;
    this.#recoveryChanged = false;
    if (saved) this.#saved = content;
    this.#savedAt = null;
    this.#set({ id, name, dirty: !saved, error: '', canUndo: false, canRedo: false });
  }

  #installRecord(record) {
    const parsed = this.options.parse(record.content, record.name);
    this.#install(parsed, { id: record.id, name: record.name });
    this.#savedAt = record.updatedAt;
    this.#session(record.id);
  }

  /** Call once after a gesture or edit; typing can share a short coalescing group. */
  changed({ coalesce = null } = {}) {
    if (this.updating || this.#disposed) return;
    const content = this.serialize();
    if (content === this.#history[this.#at]) return;
    this.#generation++;
    this.#recoveryChanged = true;
    const now = Date.now();
    const combine = coalesce && coalesce === this.#group && now - this.#groupTime < 700
      && this.#at > 0 && this.#at === this.#history.length - 1 && this.#history[this.#at] !== this.#saved;
    this.#history.length = this.#at + 1;
    if (combine) this.#history[this.#at] = content;
    else { this.#history.push(content); this.#at++; }
    while (this.#history.length > MAX_HISTORY || (this.#history.length > 2 && this.#history.reduce((sum, item) => sum + item.length * 2, 0) > MAX_HISTORY_BYTES)) {
      this.#history.shift(); this.#at--;
    }
    this.#group = coalesce;
    this.#groupTime = now;
    this.#set({ dirty: content !== this.#saved, error: '', canUndo: this.#at > 0, canRedo: false });
    this.#scheduleRecovery();
  }

  transact(fn, options) { fn(); this.changed(options); }

  #scheduleRecovery() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = null; this.flushRecovery(); }, 450);
  }

  async flushRecovery() {
    clearTimeout(this.#timer); this.#timer = null;
    if (this.updating || !this.state.value.ready) return true;
    if (!this.dirty && !this.#recoveryChanged) return true;
    const { id, name } = this.state.value;
    const generation = this.#generation;
    try {
      if (!this.dirty) await this.store.clearRecovery(this.app.id);
      else await this.store.writeRecovery(this.app.id, { documentId: id, name, format: this.options.format, content: this.serialize(), baseContent: this.#saved, baseUpdatedAt: this.#savedAt });
      if (generation === this.#generation) this.#recoveryChanged = false;
      return true;
    } catch (error) { this.#failure(error, false); return false; }
  }

  run(action) {
    const task = async () => {
      await this.ready;
      if (this.#disposed) return false;
      const methods = { new: () => this.#new(), open: () => this.#choose(), save: () => this.#save(false), 'save-as': () => this.#save(true),
        import: () => this.#import(), export: () => this.#export(), undo: () => this.#undo(-1), redo: () => this.#undo(1) };
      if (!methods[action]) throw new Error(`Unknown document action “${action}”.`);
      try { return await methods[action](); } catch (error) { await this.#failure(error); return false; }
    };
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }

  open(id) {
    const task = async () => {
      await this.ready;
      try { return await this.#open(id); } catch (error) { await this.#failure(error); return false; }
    };
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }

  /** Starts a new document holding `value`, such as a template, after offering to save the current one. It counts as unchanged until edited. */
  begin(value, { name = 'Untitled' } = {}) {
    const task = async () => {
      await this.ready;
      if (this.#disposed) return false;
      try {
        if (!(await this.#guard())) return false;
        await this.store.clearRecovery(this.app.id);
        this.#generation++;
        this.#install(value, { name });
        this.#session(null);
        return true;
      } catch (error) { await this.#failure(error); return false; }
    };
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #guard() {
    if (!this.dirty) return true;
    const answer = await this.app.os.dialogs.confirm({ title: 'Unsaved changes', message: `Save changes to “${this.state.value.name}” first?`,
      buttons: [{ value: 'save', text: 'Save' }, { value: 'discard', text: 'Discard' }, { value: 'cancel', text: 'Cancel' }] });
    if (answer === 'save') return (await this.#save(false)) && !this.dirty;
    return answer === 'discard';
  }

  async #new() {
    if (!(await this.#guard())) return false;
    const value = this.options.create();
    await this.store.clearRecovery(this.app.id);
    this.#generation++;
    this.#install(value, { name: 'Untitled' });
    this.#session(null);
    return true;
  }

  async #choose() {
    const records = await this.store.list({ appId: this.app.id });
    if (!records.length) {
      await this.app.os.dialogs.alert({ title: 'Open document', message: 'No saved documents yet. Use Import to open a file from your device.' });
      return false;
    }
    const id = await this.app.os.dialogs.choose({ title: 'Open document', message: 'Saved in Pea', acceptLabel: 'Open',
      items: records.map(record => ({ value: record.id, text: record.name, detail: new Date(record.updatedAt).toLocaleDateString() })) });
    return id ? this.#open(id) : false;
  }

  async #open(id) {
    const record = await this.store.get(id);
    if (!record || record.appId !== this.app.id) throw new Error('This document is unavailable in this app.');
    const parsed = this.options.parse(record.content, record.name);
    if (!(await this.#guard())) return false;
    await this.store.clearRecovery(this.app.id);
    this.#generation++;
    this.#install(parsed, { id: record.id, name: record.name });
    this.#savedAt = record.updatedAt;
    this.#session(record.id);
    return true;
  }

  async #save(asCopy) {
    let { id, name } = this.state.value;
    let expectedUpdatedAt = this.#savedAt;
    if (!id || asCopy) {
      const answer = await this.app.os.dialogs.prompt({ title: asCopy ? 'Save As' : 'Save document', message: 'Name this document. It will be saved in Pea.',
        value: asCopy && id ? `${name} copy` : name, acceptLabel: 'Save' });
      if (answer === null || answer === undefined) return false;
      name = cleanName(answer);
      if (name.length > 120) throw new Error('Use a name with no more than 120 characters.');
      if (asCopy) { id = null; expectedUpdatedAt = null; }
      const conflict = (await this.store.list({ appId: this.app.id })).find(record => record.name.toLowerCase() === name.toLowerCase() && record.id !== id);
      if (conflict) {
        const answer = await this.app.os.dialogs.confirm({ title: 'Name already used', message: `A document named “${name}” exists. Replace it?`,
          buttons: [{ value: 'replace', text: 'Replace' }, { value: 'cancel', text: 'Cancel' }] });
        if (answer !== 'replace') return false;
        id = conflict.id;
        expectedUpdatedAt = conflict.updatedAt;
      }
    }
    if (!asCopy && id === this.state.value.id) {
      const latest = await this.store.get(id);
      if (latest?.content === this.#saved) {
        expectedUpdatedAt = latest.updatedAt;
        name = latest.name;
      }
    }
    const content = this.serialize();
    const generation = this.#generation;
    this.#group = null; // Edits made while saving must not coalesce away this saved checkpoint.
    this.#set({ saving: true, error: '' });
    try {
      const record = await this.store.save({ id, appId: this.app.id, name, format: this.options.format, content, expectedUpdatedAt });
      this.#saved = content;
      this.#savedAt = record.updatedAt;
      const dirty = generation !== this.#generation && this.serialize() !== content;
      this.#set({ id: record.id, name: record.name, dirty, saving: false, error: '' });
      this.#group = null;
      this.#session(record.id);
      if (!dirty) await this.store.clearRecovery(this.app.id);
      else await this.flushRecovery();
      return true;
    } catch (error) { this.#set({ saving: false }); throw error; }
  }

  async #import() {
    const file = await this.app.pick(this.options.accept ?? this.options.extension);
    if (!file) return false;
    const parsed = this.options.parse(file.text, file.name);
    if (!(await this.#guard())) return false;
    await this.store.clearRecovery(this.app.id);
    this.#generation++;
    this.#recoveryChanged = true;
    this.#install(parsed, { name: cleanName(file.name.replace(/\.[^.]+$/, '')), saved: false });
    this.#saved = '';
    this.#session(null);
    await this.flushRecovery();
    return true;
  }

  async #export() {
    const name = cleanName(this.state.value.name);
    if (this.options.export) await this.options.export({ name, content: this.serialize() });
    else this.app.os.download(`${name}${this.options.extension ?? '.txt'}`, this.serialize(), this.options.format ?? 'text/plain');
    return true;
  }

  #undo(direction) {
    const next = this.#at + direction;
    if (next < 0 || next >= this.#history.length) return false;
    const parsed = this.options.parse(this.#history[next], this.state.value.name);
    this.updating = true;
    try { this.options.install(parsed); } finally { this.updating = false; }
    this.#at = next;
    this.#generation++;
    this.#recoveryChanged = true;
    this.#group = null;
    this.#set({ dirty: this.serialize() !== this.#saved, canUndo: next > 0, canRedo: next < this.#history.length - 1, error: '' });
    this.#scheduleRecovery();
    return true;
  }

  async #failure(error, show = true) {
    const message = error?.message ?? String(error);
    this.#set({ error: message, saving: false });
    this.app.report(error, { notify: false });
    if (show && this.app.os.dialogs) await this.app.os.dialogs.alert({ title: 'Document operation failed', message });
    return false;
  }

  dispose() {
    if (this.#disposed) return;
    this.flushRecovery();
    clearTimeout(this.#timer);
    this.#disposed = true;
    this.state.dispose();
  }
}

export const createDocumentController = (app, options) => new DocumentController(app, options);
