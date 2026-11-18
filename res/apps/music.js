/**
 * Jukebox: a playlist player. It never touches a speaker or a disk itself:
 * the files service keeps the music and the sound service plays it, so on
 * Android it is the system's media player, awake with the screen off, and in
 * a browser the page's own, with media keys and lock-screen controls.
 *
 * Playlists are XSPF, the XML playlist format: tracks are files of the
 * files service, named like "music/Artist - Title.mp3".
 */

const FOLDER = 'music';
const ACCEPT = 'audio/*,.mp3,.ogg,.oga,.opus,.wav,.flac,.m4a,.aac,.weba';
const XSPF = 'http://xspf.org/ns/0/';
const BANDS = 20;

/** "1:05", or "1:02:05" past an hour; "–:––" when unknown. */
export function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––';
  const s = Math.floor(seconds);
  const pad = n => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** A track's title and artist from its file name: "music/Artist - Title.mp3". */
export function describe(file) {
  const base = file.slice(file.lastIndexOf('/') + 1).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/_/g, ' ').trim();
  const split = base.indexOf(' - ');
  return split > 0 ? { artist: base.slice(0, split).trim(), title: base.slice(split + 3).trim() } : { artist: '', title: base };
}

/** Reads an XSPF playlist: [{ file, title, artist, duration }], and how many tracks were left out. */
export function parseXspf(xml, text, source = 'playlist.xspf') {
  const root = xml.parseXml(text, source, { foreign: true });
  if (root.name !== 'playlist') root.fail('is not an XSPF playlist (<playlist>)');
  const tracks = [];
  let skipped = 0;
  for (const node of root.child('trackList')?.all('track') ?? []) {
    const location = node.child('location')?.text.trim() ?? '';
    // Only files Pea keeps can be played; web addresses and other computers' paths are left out.
    if (!location || /^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith('/') || location.includes('..')) { skipped++; continue; }
    const file = decodeURIComponent(location);
    const named = describe(file);
    const ms = Number(node.child('duration')?.text.trim());
    tracks.push({ file, title: node.child('title')?.text.trim() || named.title, artist: node.child('creator')?.text.trim() ?? named.artist, duration: Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0 });
  }
  return { title: root.child('title')?.text.trim() ?? '', tracks, skipped };
}

export function xspf(xml, tracks, title = 'Jukebox') {
  const e = xml.escapeXml;
  const location = file => file.split('/').map(encodeURIComponent).join('/');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<playlist version="1" xmlns="${XSPF}">`,
    `  <title>${e(title)}</title>`,
    '  <trackList>',
    ...tracks.map(track => `    <track><location>${e(location(track.file))}</location><title>${e(track.title)}</title>${track.artist ? `<creator>${e(track.artist)}</creator>` : ''}${track.duration ? `<duration>${Math.round(track.duration * 1000)}</duration>` : ''}</track>`),
    '  </trackList>',
    '</playlist>',
    ''
  ].join('\n');
}

/**
 * What comes after `current` in a playlist of `count`: an index, or -1 to
 * stop. Shuffle picks among tracks not yet `played`, and with repeat starts
 * the bag again when every track has had its turn.
 */
export function following(count, current, { shuffle = false, repeat = false, played = new Set(), random = Math.random } = {}) {
  if (!count) return -1;
  if (!shuffle) return current + 1 < count ? current + 1 : repeat ? 0 : -1;
  let bag = [...Array(count).keys()].filter(index => !played.has(index) && index !== current);
  if (!bag.length) {
    if (!repeat) return -1;
    played.clear();
    bag = [...Array(count).keys()].filter(index => index !== current);
    if (!bag.length) return current;
  }
  return bag[Math.floor(random() * bag.length)];
}

export default function music(app) {
  const { os, gfx } = app;
  const { display, tracks: list } = app.refs;
  const selected = app.signal('track');
  const shuffle = app.signal('shuffle');
  const repeat = app.signal('repeat');
  const volume = app.signal('volume');

  /** The playlist: [{ id, file, title, artist, duration }]. */
  let playlist = [];
  let ids = 0;
  let current = -1;         // index of the loaded track
  let player = null;        // from the sound service, made on first use
  let source = null;        // the loaded file's playable address
  let wantPlay = false;     // play as soon as the track has loaded
  let message = '';         // shown in the display instead of the title
  let busy = 0;             // file work under way
  const played = new Set(); // indexes heard since shuffle began
  const history = [];       // indexes in the order they played, for Previous
  const bands = new Uint8Array(BANDS);
  let dirty = true;

  const status = () => player?.state.value ?? { status: 'empty', position: 0, at: 0, duration: 0, error: '' };
  const position = () => {
    const state = status();
    return state.status === 'playing' ? Math.min(state.duration || Infinity, state.position + (player.now() - state.at) / 1000) : state.position;
  };

  // ---- The playlist -----------------------------------------------------------

  function show() {
    list.items = playlist.map((track, index) => ({
      value: track.id,
      text: `${index === current ? '▶ ' : ''}${index + 1}. ${track.artist ? `${track.artist} - ` : ''}${track.title}${track.duration ? ` (${clock(track.duration)})` : ''}`
    }));
    const total = playlist.reduce((sum, track) => sum + (track.duration || 0), 0);
    app.signal('playlist-info').set(`${playlist.length} ${playlist.length === 1 ? 'track' : 'tracks'}${total ? ` · ${clock(total)}` : ''}`);
    dirty = true;
  }

  const save = app.debounce(400, () => {
    try { app.document.save(xspf(app.xml, playlist)); }
    catch (error) { app.report(error); }
  });
  const changed = () => { show(); save(); };

  function add(entries) {
    const before = playlist.length;
    for (const entry of entries) playlist.push({ id: `t${++ids}`, file: entry.file, title: entry.title, artist: entry.artist ?? '', duration: entry.duration ?? 0 });
    changed();
    if (!selected.value && playlist.length) selected.set(playlist[before]?.id ?? playlist[0].id);
    return before;
  }

  try {
    const saved = app.document.load();
    if (saved) add(parseXspf(app.xml, saved, 'the saved playlist').tracks);
  } catch (error) {
    app.report(new Error(`The saved playlist could not be read, so Jukebox starts with an empty one: ${error.message}`), { notify: false });
  }
  show();

  // ---- Playing ----------------------------------------------------------------

  async function ensurePlayer() {
    if (player) return player;
    const provider = await app.service('audio').use();
    if (app.scope.disposed) return null;
    player = provider.player();
    app.scope.add(() => { source?.release(); player.dispose(); });
    player.volume(volume.value / 100);
    app.scope.subscribe(player.state, (state, previous) => {
      if (state.duration && playlist[current] && Math.abs((playlist[current].duration || 0) - state.duration) > 0.05) {
        playlist[current].duration = state.duration;
        changed();
      }
      if (state.status === 'paused' && previous?.status === 'loading' && wantPlay) { wantPlay = false; player.play(); }
      if (state.status === 'ended' && previous?.status !== 'ended') advance();
      if (state.status === 'error') { wantPlay = false; message = state.error; }
      app.signal('play-text').set(state.status === 'playing' || (state.status === 'loading' && wantPlay) ? '⏸' : '▶');
      dirty = true;
    });
    app.scope.on(player.remote, 'next', () => app.run('next'));
    app.scope.on(player.remote, 'previous', () => app.run('previous'));
    return player;
  }

  /** Loads track `index` and, when `start`, plays it. */
  async function load(index, start = true) {
    const track = playlist[index];
    if (!track) return;
    try {
      await ensurePlayer();
      if (!player) return;
      const files = await app.service('files').use();
      const next = await files.source(track.file);
      if (app.scope.disposed) { next.release(); return; }
      source?.release();
      source = next;
      current = index;
      message = '';
      wantPlay = start;
      if (history.at(-1) !== index) history.push(index);
      if (history.length > 200) history.shift();
      played.add(index);
      selected.set(track.id);
      player.load({ url: source.url, data: source.data, title: track.title, artist: track.artist, album: 'Jukebox' });
      show();
    } catch (error) {
      message = error.message;
      dirty = true;
      app.report(error);
    }
  }

  function advance() {
    const next = following(playlist.length, current, { shuffle: shuffle.value, repeat: repeat.value, played });
    if (next < 0) { wantPlay = false; dirty = true; return; }
    load(next);
  }

  app.scope.subscribe(shuffle, () => { played.clear(); if (current >= 0) played.add(current); }, { immediate: false });

  app.command('play-pause', () => {
    const state = status();
    if (state.status === 'playing') return player.pause();
    if (wantPlay && state.status === 'loading') { wantPlay = false; app.signal('play-text').set('▶'); return; }
    const chosen = playlist.findIndex(track => track.id === selected.value);
    if (current < 0 || (chosen >= 0 && chosen !== current && state.status !== 'paused')) return load(chosen >= 0 ? chosen : 0);
    if (state.status === 'paused' || state.status === 'ended') player.play();
    else if (state.status === 'error' || state.status === 'empty') load(current);
  });
  app.command('play-selected', () => {
    const index = playlist.findIndex(track => track.id === selected.value);
    if (index >= 0) load(index);
  });
  app.command('stop', () => { wantPlay = false; player?.stop(); dirty = true; });
  app.command('next', () => {
    if (!playlist.length) return;
    const next = following(playlist.length, current, { shuffle: shuffle.value, repeat: true, played });
    load(next < 0 ? 0 : next, status().status === 'playing' || wantPlay);
  });
  app.command('previous', () => {
    if (!playlist.length) return;
    // Past the first seconds, Previous starts the track again, as players do.
    if (position() > 3 && status().status !== 'empty') { player.seek(0); return; }
    let index;
    if (shuffle.value && history.length > 1) { history.pop(); index = history.pop(); }
    else index = current > 0 ? current - 1 : repeat.value ? playlist.length - 1 : 0;
    load(index, status().status === 'playing' || wantPlay);
  });
  app.command('seek', () => {
    const { duration } = status();
    if (player && duration > 0) player.seek(app.scope.get('seek') / 1000 * duration);
  });
  app.command('volume', () => player?.volume(volume.value / 100));

  // Closing Jukebox stops the music; minimizing it, or leaving Pea OS for another app, does not.
  app.scope.subscribe(app.open, open => { if (!open && player) { wantPlay = false; player.pause(); } }, { immediate: false });

  // ---- Files ------------------------------------------------------------------

  async function work(fn) {
    busy++;
    dirty = true;
    try { return await fn(); }
    catch (error) { app.report(error); }
    finally { busy--; dirty = true; }
  }

  app.command('add-files', () => work(async () => {
    const chosen = await app.pickFiles(ACCEPT, { multiple: true });
    if (!chosen.length) return;
    const files = await app.service('files').use();
    const taken = new Set((await files.list(FOLDER)).map(file => file.name));
    const added = [];
    for (const [n, file] of chosen.entries()) {
      message = `Adding ${n + 1} of ${chosen.length}…`;
      dirty = true;
      const clean = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim().slice(0, 100) || 'track';
      let name = `${FOLDER}/${clean}`;
      for (let i = 2; taken.has(name); i++) name = `${FOLDER}/${clean.replace(/(\.[^.]*)?$/, `-${i}$1`)}`;
      taken.add(name);
      await files.write(name, file.data);
      added.push({ file: name, ...describe(name) });
    }
    message = '';
    const first = add(added);
    if (status().status !== 'playing') load(first);
  }));

  app.command('add-stored', () => work(async () => {
    const files = await app.service('files').use();
    const known = new Set(playlist.map(track => track.file));
    const found = (await files.list(FOLDER)).filter(file => /^audio\//.test(file.type) && !known.has(file.name));
    if (!found.length) { message = `Nothing new in ${files.title} › ${FOLDER}.`; return; }
    add(found.map(file => ({ file: file.name, ...describe(file.name) })));
  }));

  app.command('remove-track', () => {
    const index = playlist.findIndex(track => track.id === selected.value);
    if (index < 0) return;
    playlist.splice(index, 1);
    if (index === current) { player?.stop(); current = -1; }
    else if (index < current) current--;
    played.clear();
    history.length = 0;
    selected.set(playlist[Math.min(index, playlist.length - 1)]?.id ?? '');
    changed();
  });

  app.command('clear-list', () => {
    if (!playlist.length) return;
    player?.stop();
    playlist = [];
    current = -1;
    played.clear();
    history.length = 0;
    selected.set('');
    changed();
  });

  app.command('save-list', () => app.download('playlist.xspf', xspf(app.xml, playlist), 'application/xspf+xml'));

  app.command('open-list', () => work(async () => {
    const file = await app.pick('.xspf,application/xspf+xml,.xml');
    if (!file) return;
    const { tracks, skipped } = parseXspf(app.xml, file.text, file.name);
    player?.stop();
    playlist = [];
    current = -1;
    selected.set('');
    add(tracks);
    message = skipped ? `${skipped} ${skipped === 1 ? 'track was a web address or a path' : 'tracks were web addresses or paths'} Jukebox cannot play.` : '';
  }));

  // ---- The display ------------------------------------------------------------

  let strip = null;
  let scrolling = false;
  function paint(time) {
    const bitmap = display.bitmap;
    if (!bitmap) return;
    dirty = false;
    const theme = app.theme.value;
    const { font } = app;
    const back = theme.lock(gfx.mix(theme.color('ink'), gfx.parseColor('#000000'), 0.35));
    const glow = theme.lock(gfx.mix(theme.color('accent'), gfx.parseColor('#ffffff'), 0.35));
    const faint = theme.lock(gfx.mix(glow, back, 0.7));
    const state = status();
    const w = bitmap.width, h = bitmap.height;
    bitmap.clear(back);
    bitmap.frame(0, 0, w, h, theme.color('ink'));

    // The time, large, with the state beside it.
    const mark = { playing: '▶', paused: '⏸', loading: '…', ended: '■', error: '!' }[state.status] ?? '■';
    font.draw(bitmap, mark, 4, 4, glow);
    font.draw(bitmap, clock(state.status === 'empty' ? 0 : position()), 12, 3, glow, { scale: 2 });
    const info = current >= 0 ? `${current + 1}/${playlist.length}${state.duration ? ` · ${clock(state.duration)}` : ''}` : `${playlist.length} in list`;
    font.draw(bitmap, info, 4, h - 11, faint);

    // The title, scrolling when it does not fit.
    const left = 74;
    const room = Math.max(8, w - left - 4);
    const track = playlist[current];
    const title = busy && message ? message : message || (track ? `${track.artist ? `${track.artist} - ` : ''}${track.title}` : 'Jukebox · add music to begin');
    const width = font.measure(title);
    if (!strip || strip.width !== room) strip = new gfx.Bitmap(room, 9);
    strip.clear(back);
    scrolling = width > room;
    if (!scrolling) font.draw(strip, title, 0, 0, glow);
    else {
      const gap = 24;
      const shift = Math.floor((time / 1000) * 18) % (width + gap);
      font.draw(strip, title, -shift, 0, glow);
      font.draw(strip, title, width + gap - shift, 0, glow);
    }
    bitmap.blit(strip, left, 4);

    // The spectrum, where the sound service can hear it; quiet bars where it cannot.
    const top = 16, bottom = h - 3;
    const live = player?.spectrum(bands);
    const bar = Math.max(2, Math.floor((room + 1) / BANDS) - 1);
    for (let i = 0; i < BANDS; i++) {
      const x = left + i * (bar + 1);
      if (x + bar > w - 3) break;
      const level = live ? bands[i] / 255 : 0;
      const height = Math.max(1, Math.round(level * (bottom - top)));
      bitmap.fill(x, bottom - height, bar, height, live ? glow : faint);
    }
    display.commit();
  }

  app.frame(({ time }) => {
    const state = status();
    const moving = state.status === 'playing' || busy;
    if (state.duration > 0) {
      const at = Math.round(position() / state.duration * 1000);
      if (at !== app.scope.get('seek')) app.scope.set('seek', Math.max(0, Math.min(1000, at)));
    } else if (app.scope.get('seek') !== 0) app.scope.set('seek', 0);
    if (dirty || moving || scrolling) paint(time);
  });
  app.scope.on(display.events, 'resize', () => { dirty = true; paint(0); });
  app.scope.subscribe(app.theme, () => { dirty = true; }, { immediate: false });
}
