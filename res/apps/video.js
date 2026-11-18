import { createDocumentController } from '../../src/os/document-controller.js';
import { emptyProject, parseProject, serializeProject, duration, placed, at, length } from '../../src/os/video-project.js';

/**
 * Pea Cut: a video editor that is a front end to ffmpeg, as Shotcut is.
 * Pea Cut itself only keeps a project document (src/os/video-project.js)
 * and draws; the media service probes, shows pictures, measures loudness
 * and renders. Sources are kept by that provider's own files, where its
 * ffmpeg can reach them.
 */

const ACCEPT = 'video/*,audio/*,.mp4,.m4v,.webm,.mkv,.mov,.ogv,.mp3,.ogg,.oga,.opus,.wav,.flac,.m4a';
const FOLDER = 'video';
const MIN_LENGTH = 0.1;

/** "0:03.25": minutes, seconds and hundredths. */
export function stamp(seconds) {
  const hundredths = Math.round(Math.max(0, Number(seconds) || 0) * 100);
  const whole = Math.floor(hundredths / 100);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}

/** Where on the video track something dropped at `time` goes: before the first item whose middle is later. */
export function insertIndex(project, time, without = null) {
  let start = 0;
  let index = 0;
  for (const item of project.video) {
    if (item.id === without) continue;
    if (time < start + length(item) / 2) return index;
    start += length(item);
    index++;
  }
  return index;
}

/** Cuts the item `id` in two at timeline `time`; the second half gets `fresh` as its id. True when it cut. */
export function splitAt(project, id, time, fresh) {
  const video = project.video.findIndex(item => item.id === id);
  if (video >= 0) {
    const span = placed(project)[video];
    const cut = span.item.in + (time - span.start);
    if (cut - span.item.in < MIN_LENGTH || span.item.out - cut < MIN_LENGTH) return false;
    project.video.splice(video + 1, 0, { ...span.item, id: fresh, in: cut });
    span.item.out = cut;
    return true;
  }
  const item = project.audio.find(entry => entry.id === id);
  if (!item) return false;
  const cut = item.in + (time - item.at);
  if (cut - item.in < MIN_LENGTH || item.out - cut < MIN_LENGTH) return false;
  project.audio.push({ ...item, id: fresh, in: cut, at: time });
  item.out = cut;
  return true;
}

/** The next free id with a prefix: "s3", "c12", "i7". */
export function freshId(project, prefix) {
  const used = [...project.sources, ...project.clips, ...project.video, ...project.audio].map(item => item.id);
  let n = 1;
  for (const id of used) if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) n = Math.max(n, Number(id.slice(prefix.length)) + 1);
  return `${prefix}${n}`;
}

const base = file => file.slice(file.lastIndexOf('/') + 1).replace(/\.[a-z0-9]{1,5}$/i, '');

export default function video(app) {
  const { os, gfx } = app;
  const { sources: sourceList, clips: clipList, monitor, timeline } = app.refs;
  const sourceId = app.signal('source-id');
  const clipId = app.signal('clip-id');
  const status = app.signal('status');

  let project = emptyProject();
  let chosen = null;        // the timeline item picked: its id
  let playhead = 0;         // seconds on the timeline
  let mode = 'source';      // the monitor shows a source (or clip) or the timeline
  let shown = 0;            // seconds into what the monitor shows
  let marks = { in: null, out: null };
  let lastRender = '';
  let rendering = null;     // an AbortController while a render runs
  let view = { scale: 30, scroll: 0 };   // pixels per second, and the first second shown
  let dirty = { monitor: true, timeline: true };
  const frames = new Map(); // "file|time|width" -> Bitmap | 'pending' | 'failed'
  const peaks = new Map();  // file -> Uint8Array | 'pending' | 'failed'

  const sourceOf = id => project.sources.find(source => source.id === id);
  const itemOf = id => project.video.find(item => item.id === id) ?? project.audio.find(item => item.id === id) ?? null;
  const tools = app.service('media');
  const media = () => tools.use();

  // ---- The document -------------------------------------------------------------

  const files = createDocumentController(app, {
    format: 'application/xml', extension: '.xml', accept: '.xml,application/xml',
    create: () => emptyProject(),
    parse: (text, name) => parseProject(app.xml, text, name),
    serialize: () => serializeProject(app.xml, project),
    install(value) {
      project = value;
      chosen = null;
      playhead = Math.min(playhead, duration(project));
      marks = { in: null, out: null };
      app.scope.set('size', `${project.width}x${project.height}`);
      app.scope.set('fps', project.fps);
      refresh();
    }
  });
  const edited = () => { files.changed(); refresh(); };

  function refresh() {
    sourceList.items = project.sources.map(source => ({
      value: source.id,
      text: base(source.file),
      detail: `${stamp(source.duration)} · ${source.video ? `${source.width}×${source.height}${source.audio ? ' · sound' : ''}` : 'sound only'}`
    }));
    clipList.items = project.clips.map(clip => ({
      value: clip.id,
      text: clip.name || base(sourceOf(clip.source)?.file ?? ''),
      detail: `${stamp(clip.in)} – ${stamp(clip.out)} · ${stamp(length(clip))}`
    }));
    if (!sourceOf(sourceId.value)) sourceId.set(project.sources[0]?.id ?? '');
    if (!project.clips.some(clip => clip.id === clipId.value)) clipId.set(project.clips[0]?.id ?? '');
    if (chosen && !itemOf(chosen)) chosen = null;
    const item = itemOf(chosen);
    app.scope.set('has-item', Boolean(item));
    if (item) {
      app.scope.set('item-volume', Math.round(item.volume * 100));
      app.scope.set('item-mute', Boolean(item.mute));
    }
    app.scope.set('timeline-info', `${project.video.length + project.audio.length} on the timeline · ${stamp(duration(project))}`);
    showMarks();
    dirty = { monitor: true, timeline: true };
  }

  app.scope.subscribe(app.signal('size'), size => {
    const [width, height] = String(size).split('x').map(Number);
    if (width && height && (width !== project.width || height !== project.height)) { project.width = width; project.height = height; edited(); }
  }, { immediate: false });
  app.scope.subscribe(app.signal('fps'), fps => {
    if (Number(fps) && fps !== project.fps) { project.fps = Number(fps); edited(); }
  }, { immediate: false });

  // ---- The media service --------------------------------------------------------

  const missing = /^Pea Cut can't/;
  app.scope.subscribe(tools.ready, async ready => {
    app.scope.set('has-media', ready);
    if (ready) { if (missing.test(status.value)) status.set(''); dirty.monitor = true; return; }
    const why = await tools.why();
    if (!app.scope.disposed && !tools.ready.value) status.set(why);
  });

  async function work(label, fn) {
    app.scope.set('busy', true);
    status.set(label);
    try { return await fn(); }
    catch (error) { status.set(error.message); app.report(error); }
    finally { if (!app.scope.disposed) app.scope.set('busy', false); }
  }

  /** A picture of `file` at `time`, `width` wide: a Bitmap when it has arrived, null until then. */
  function frame(file, time, width) {
    const key = `${file}|${time.toFixed(2)}|${width}`;
    const known = frames.get(key);
    if (known) return known instanceof gfx.Bitmap ? known : null;
    frames.set(key, 'pending');
    if (frames.size > 160) frames.delete(frames.keys().next().value);
    media().then(provider => provider.frame(file, time, width)).then(({ width: w, height: h, data }) => {
      const bitmap = new gfx.Bitmap(w, h);
      bitmap.data.set(data.subarray(0, bitmap.data.length));
      frames.set(key, bitmap);
    }, () => frames.set(key, 'failed')).finally(() => { dirty = { monitor: true, timeline: true }; });
    return null;
  }

  /** Loudness across a whole file, about 25 steps a second, or null until it arrives. */
  function loudness(source) {
    const known = peaks.get(source.file);
    if (known) return known instanceof Uint8Array ? known : null;
    peaks.set(source.file, 'pending');
    media().then(provider => provider.peaks(source.file, Math.max(10, Math.min(4000, Math.ceil(source.duration * 25)))))
      .then(data => peaks.set(source.file, data), () => peaks.set(source.file, 'failed'))
      .finally(() => { dirty.timeline = true; });
    return null;
  }

  async function addSource(name) {
    const provider = await media();
    const probe = await provider.probe(name);
    const source = { id: freshId(project, 's'), file: name, duration: probe.duration, width: probe.video?.width ?? 0, height: probe.video?.height ?? 0, video: Boolean(probe.video), audio: Boolean(probe.audio) };
    if (!source.duration) throw new Error(`${base(name)} has no length that ffmpeg can tell.`);
    project.sources.push(source);
    sourceId.set(source.id);
    return source;
  }

  app.command('import-media', () => work('Choosing files…', async () => {
    const provider = await media();
    const picked = await app.pickFiles(ACCEPT, { multiple: true });
    if (!picked.length) { status.set(''); return; }
    const taken = new Set((await provider.files.list(FOLDER)).map(file => file.name));
    for (const [n, file] of picked.entries()) {
      status.set(`Importing ${n + 1} of ${picked.length}: ${file.name}`);
      const clean = file.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').trim().slice(0, 100) || 'media';
      let name = `${FOLDER}/${clean}`;
      for (let i = 2; taken.has(name); i++) name = `${FOLDER}/${clean.replace(/(\.[^.]*)?$/, `-${i}$1`)}`;
      taken.add(name);
      await provider.files.write(name, file.data);
      await addSource(name);
    }
    app.scope.set('bin', 'sources');
    mode = 'source';
    edited();
    status.set(`Imported ${picked.length} ${picked.length === 1 ? 'file' : 'files'}.`);
  }));

  app.command('stored-media', (_, widget) => work('Looking at stored files…', async () => {
    const provider = await media();
    const known = new Set(project.sources.map(source => source.file));
    const found = (await provider.files.list()).filter(file => /^(video|audio)\//.test(file.type) && !known.has(file.name));
    status.set('');
    if (!found.length) { status.set(`Every video and sound kept by ${provider.files.title} is already here.`); return; }
    const add = names => work('Reading…', async () => {
      for (const name of names) await addSource(name);
      edited();
      status.set('');
    });
    const items = found.slice(0, 24).map(file => ({ text: file.name, invoke: () => add([file.name]) }));
    if (found.length > 1) items.push({ separator: true }, { text: `All ${found.length}`, invoke: () => add(found.map(file => file.name)) });
    const { x, y } = (widget ?? timeline).toScreen(0, widget?.h ?? 0);
    os.desktop.popupMenu(items, { x, y });
  }));

  app.command('remove-source', () => {
    const id = sourceId.value;
    if (!id) return;
    const used = [...project.clips, ...project.video, ...project.audio].filter(item => item.source === id).length;
    project.sources = project.sources.filter(source => source.id !== id);
    project.clips = project.clips.filter(item => item.source !== id);
    project.video = project.video.filter(item => item.source !== id);
    project.audio = project.audio.filter(item => item.source !== id);
    status.set(used ? `Removed the source and the ${used} ${used === 1 ? 'clip' : 'clips'} cut from it. Undo brings them back.` : 'Removed. The file stays in Files.');
    edited();
  });

  // ---- The monitor and clips ----------------------------------------------------

  /** What the monitor shows: { source, length } where length is how long it is. */
  function subject() {
    if (mode === 'timeline') {
      const found = at(project, playhead);
      return found ? { source: sourceOf(found.item.source), time: found.source, length: duration(project), at: playhead } : null;
    }
    const source = sourceOf(sourceId.value);
    return source ? { source, time: shown, length: source.duration, at: shown } : null;
  }

  function showMarks() {
    const source = sourceOf(sourceId.value);
    const start = marks.in ?? 0;
    const end = marks.out ?? source?.duration ?? 0;
    app.scope.set('has-marks', mode === 'source' && Boolean(source) && end - start >= MIN_LENGTH);
    app.scope.set('range', source && mode === 'source' ? `${stamp(start)} – ${stamp(end)}` : '');
    const what = subject();
    app.scope.set('monitor-title', mode === 'timeline' ? `Timeline at ${stamp(playhead)}` : what ? `${base(what.source.file)} at ${stamp(shown)}` : 'Monitor');
    const scrub = what?.length ? Math.round(what.at / what.length * 1000) : 0;
    if (scrub !== app.scope.get('scrub')) app.scope.set('scrub', Math.max(0, Math.min(1000, scrub)));
  }

  function showSource() {
    mode = 'source';
    shown = Math.min(shown, sourceOf(sourceId.value)?.duration ?? 0);
    showMarks();
    dirty.monitor = true;
  }

  app.scope.subscribe(sourceId, () => { marks = { in: null, out: null }; shown = 0; showSource(); }, { immediate: false });
  app.scope.subscribe(clipId, id => {
    const clip = project.clips.find(item => item.id === id);
    if (!clip) return;
    if (sourceId.value !== clip.source) sourceId.set(clip.source);
    marks = { in: clip.in, out: clip.out };
    shown = clip.in;
    showSource();
  }, { immediate: false });

  app.command('scrub', () => {
    const what = subject() ?? (mode === 'timeline' ? null : null);
    const fraction = app.scope.get('scrub') / 1000;
    if (mode === 'timeline') { playhead = fraction * duration(project); dirty.timeline = true; }
    else if (what) shown = fraction * what.source.duration;
    showMarks();
    dirty.monitor = true;
  });

  app.command('mark-in', () => {
    if (mode !== 'source' || !sourceOf(sourceId.value)) return status.set('Choose a source first; marks belong to a source.');
    marks = { in: shown, out: marks.out !== null && marks.out > shown ? marks.out : null };
    showMarks();
  });
  app.command('mark-out', () => {
    if (mode !== 'source' || !sourceOf(sourceId.value)) return status.set('Choose a source first; marks belong to a source.');
    marks = { in: marks.in !== null && marks.in < shown ? marks.in : null, out: shown };
    showMarks();
  });
  app.command('make-clip', () => {
    const source = sourceOf(sourceId.value);
    if (!source) return;
    const clip = { id: freshId(project, 'c'), source: source.id, in: marks.in ?? 0, out: marks.out ?? source.duration, name: `${base(source.file)} ${project.clips.filter(item => item.source === source.id).length + 1}` };
    if (length(clip) < MIN_LENGTH) return status.set('A clip needs Out after In.');
    project.clips.push(clip);
    edited();
    app.scope.set('bin', 'clips');
    clipId.set(clip.id);
    status.set(`Made ${clip.name}, ${stamp(length(clip))} long. Drag it to the timeline, or press To video.`);
  });

  // ---- Putting things on the timeline -------------------------------------------

  function place(from, track, time = null) {
    const source = sourceOf(from.source);
    if (!source) return;
    if (track === 'video' && !source.video) { status.set(`${base(source.file)} has no picture, so it goes on the audio track.`); track = 'audio'; }
    if (track === 'audio' && !source.audio) return status.set(`${base(source.file)} has no sound for the audio track.`);
    const item = { id: freshId(project, 'i'), source: source.id, in: from.in, out: from.out, name: from.name || base(source.file), volume: 1 };
    if (track === 'video') {
      item.mute = false;
      project.video.splice(time === null ? project.video.length : insertIndex(project, time), 0, item);
    } else {
      item.at = Math.max(0, time ?? playhead);
      project.audio.push(item);
    }
    chosen = item.id;
    edited();
  }
  const wholeSource = id => {
    const source = sourceOf(id);
    return source && { source: source.id, in: 0, out: source.duration, name: base(source.file) };
  };
  app.command('source-to-timeline', () => { const from = wholeSource(sourceId.value); if (from) place(from, 'video'); });
  app.command('clip-to-video', () => { const clip = project.clips.find(item => item.id === clipId.value); if (clip) place(clip, 'video'); });
  app.command('clip-to-audio', () => { const clip = project.clips.find(item => item.id === clipId.value); if (clip) place(clip, 'audio'); });
  app.command('remove-clip', () => {
    project.clips = project.clips.filter(clip => clip.id !== clipId.value);
    edited();
  });

  app.command('delete-item', () => {
    if (!chosen) return;
    project.video = project.video.filter(item => item.id !== chosen);
    project.audio = project.audio.filter(item => item.id !== chosen);
    chosen = null;
    edited();
  });
  app.command('split-item', () => {
    const item = itemOf(chosen);
    if (!item) return;
    if (splitAt(project, item.id, playhead, freshId(project, 'i'))) edited();
    else status.set('Move the marker inside the chosen clip to split it there.');
  });
  app.command('item-mute', () => {
    const item = itemOf(chosen);
    if (!item || !('mute' in item)) return status.set(item ? 'Audio track clips are silenced with Volume.' : '');
    item.mute = app.scope.get('item-mute');
    edited();
  });
  app.command('item-volume', () => {
    const item = itemOf(chosen);
    if (!item) return;
    item.volume = app.scope.get('item-volume') / 100;
    files.changed({ coalesce: 'volume' });
    dirty.timeline = true;
  });

  // ---- Rendering ----------------------------------------------------------------

  app.command('render', () => {
    if (rendering) { rendering.abort(); return; }
    if (!project.video.length) return status.set('Put a clip on the video track first.');
    rendering = new AbortController();
    const signal = rendering.signal;
    app.scope.set('render-text', 'Stop');
    work('Rendering…', async () => {
      const provider = await media();
      // The render is named after the document.
      const { name } = await provider.render(serializeProject(app.xml, { ...project, name: files.state.value.name }), {
        signal,
        onProgress: done => { if (!app.scope.disposed) { status.set(`Rendering ${Math.round(done * 100)}%…`); app.scope.set('render-text', `Stop (${Math.round(done * 100)}%)`); } }
      });
      lastRender = name;
      status.set(`Rendered ${name}. Watch plays it.`);
    }).finally(() => {
      if (signal.aborted && !app.scope.disposed) status.set('The render was stopped.');
      rendering = null;
      if (!app.scope.disposed) app.scope.set('render-text', 'Render');
    });
  });
  app.scope.add(() => rendering?.abort());

  app.command('watch', () => work('Opening…', async () => {
    const provider = await media();
    const name = lastRender || (await provider.files.list('renders')).sort((a, b) => b.modified - a.modified)[0]?.name;
    if (!name) { status.set('Nothing has been rendered yet.'); return; }
    const { url } = await provider.files.source(name);
    app.openUrl(url);
    status.set(`Playing ${name} in a new tab.`);
  }));

  // ---- Painting -----------------------------------------------------------------

  const RULER = 11, GUTTER = 12, VIDEO = 26, SOUND = 9, AUDIO = 18;
  const rows = () => ({ video: RULER + 2, sound: RULER + 2 + VIDEO, audio: RULER + 4 + VIDEO + SOUND });
  const xOf = time => GUTTER + Math.round((time - view.scroll) * view.scale);
  const timeOf = x => view.scroll + (x - GUTTER) / view.scale;

  const fit = (font, text, width) => {
    if (font.measure(text) <= width) return text;
    while (text && font.measure(`${text}…`) > width) text = text.slice(0, -1);
    return text ? `${text}…` : '';
  };

  function paintMonitor() {
    const bitmap = monitor.bitmap;
    if (!bitmap) return;
    dirty.monitor = false;
    const theme = app.theme.value;
    const black = theme.lock(gfx.parseColor('#101014'));
    bitmap.clear(black);
    const what = subject();
    const { font } = app;
    const say = text => font.draw(bitmap, text, Math.max(3, (bitmap.width - font.measure(text)) >> 1), (bitmap.height >> 1) - 4, theme.lock(gfx.parseColor('#a9aec4')));
    if (!app.scope.get('has-media')) say('No video tools here');
    else if (!what) say(mode === 'timeline' ? 'The timeline is empty' : 'Import a video to begin');
    else if (!what.source.video) say('Sound only');
    else {
      // Ask for exactly the size that fits, so the picture is never stretched.
      const aspect = what.source.width / Math.max(1, what.source.height);
      const width = Math.max(8, Math.min(bitmap.width, Math.floor(bitmap.height * aspect)) & ~1);
      const picture = frame(what.source.file, Math.round(what.time * 25) / 25, width);
      if (picture) bitmap.blit(picture, (bitmap.width - picture.width) >> 1, (bitmap.height - picture.height) >> 1);
      else say('…');
    }
    if (what) {
      const label = `${stamp(what.at)} / ${stamp(what.length)}`;
      bitmap.fill(0, bitmap.height - 11, font.measure(label) + 6, 11, theme.lock(gfx.parseColor('#16161d')));
      font.draw(bitmap, label, 3, bitmap.height - 10, theme.lock(gfx.parseColor('#fbf7ea')));
    }
    monitor.commit();
  }

  function waveform(bitmap, source, from, to, x0, x1, y, h, color) {
    const data = source.audio ? loudness(source) : null;
    if (!data) { bitmap.fill(x0, y + (h >> 1), Math.max(0, x1 - x0), 1, color); return; }
    for (let x = Math.max(x0, 0); x < Math.min(x1, bitmap.width); x++) {
      const t = from + (x - x0) / Math.max(1, x1 - x0) * (to - from);
      const level = data[Math.min(data.length - 1, Math.floor(t / source.duration * data.length))] / 255;
      const bar = Math.max(1, Math.round(Math.sqrt(level) * (h - 1)));
      bitmap.fill(x, y + ((h - bar) >> 1), 1, bar, color);
    }
  }

  function paintTimeline() {
    const bitmap = timeline.bitmap;
    if (!bitmap) return;
    dirty.timeline = false;
    const theme = app.theme.value;
    const { font } = app;
    const w = bitmap.width, h = bitmap.height;
    const field = theme.color('field');
    const ink = theme.color('ink');
    const dim = theme.color('dim');
    const tone = (hex, t = 0.35) => theme.lock(gfx.mix(gfx.parseColor(hex), field, t));
    const faces = { video: tone('#3f7fe0'), sound: tone('#46b04a', 0.55), audio: tone('#1f8a78'), muted: tone('#a9aec4', 0.6) };
    const r = rows();
    bitmap.clear(field);

    // The ruler: marks far enough apart to read.
    bitmap.fill(0, 0, w, RULER, theme.color('panel'));
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find(value => value * view.scale >= 34) ?? 600;
    for (let t = Math.floor(view.scroll / step) * step; xOf(t) < w; t += step) {
      const x = xOf(t);
      if (x < GUTTER) continue;
      bitmap.fill(x, RULER - 4, 1, 4, dim);
      font.draw(bitmap, stamp(t).replace(/\.00$/, ''), x + 2, 1, theme.color('panel-ink'));
    }
    bitmap.fill(0, RULER, w, 1, ink);

    // The video track, each clip with its own sound under it.
    for (const { item, start, end } of placed(project)) {
      const x0 = Math.max(GUTTER, xOf(start)), x1 = Math.min(w, xOf(end));
      if (x1 <= GUTTER || x0 >= w) continue;
      const source = sourceOf(item.source);
      bitmap.fill(x0, r.video, x1 - x0, VIDEO - 1, faces.video);
      const thumbH = VIDEO - 5;
      const thumbW = Math.max(8, Math.round(thumbH * source.width / Math.max(1, source.height)) & ~1);
      const roomy = x1 - x0 > thumbW + 30;
      if (roomy && xOf(start) >= GUTTER) {
        const thumb = frame(source.file, item.in + 0.04, thumbW);
        if (thumb) bitmap.blit(thumb, x0 + 2, r.video + 2, { sh: Math.min(thumb.height, thumbH) });
      }
      const textX = x0 + (roomy ? thumbW + 5 : 3);
      font.draw(bitmap, fit(font, item.name, x1 - textX - 2), textX, r.video + 3, theme.color('field-ink'));
      font.draw(bitmap, fit(font, stamp(length(item)), x1 - textX - 2), textX, r.video + 13, dim);
      const muted = item.mute || !source.audio;
      bitmap.fill(x0, r.sound, x1 - x0, SOUND - 1, muted ? faces.muted : faces.sound);
      if (!muted) waveform(bitmap, source, item.in, item.out, xOf(start), xOf(end), r.sound, SOUND - 1, theme.lock(gfx.mix(gfx.parseColor('#1d4d2b'), field, 0.1)));
      bitmap.frame(x0, r.video, x1 - x0, VIDEO + SOUND - 1, item.id === chosen ? theme.color('accent') : ink);
      if (item.id === chosen) bitmap.frame(x0 + 1, r.video + 1, x1 - x0 - 2, VIDEO + SOUND - 3, theme.color('accent'));
    }

    // The audio track: music and sounds, each at its own time.
    bitmap.fill(GUTTER, r.audio + AUDIO, w - GUTTER, 1, theme.lock(gfx.mix(ink, field, 0.7)));
    for (const item of project.audio) {
      const start = xOf(item.at), end = xOf(item.at + length(item));
      const x0 = Math.max(GUTTER, start), x1 = Math.min(w, end);
      if (x1 <= GUTTER || x0 >= w) continue;
      const source = sourceOf(item.source);
      bitmap.fill(x0, r.audio, x1 - x0, AUDIO, faces.audio);
      waveform(bitmap, source, item.in, item.out, start, end, r.audio + 1, AUDIO - 2, theme.lock(gfx.mix(gfx.parseColor('#63d2f0'), faces.audio, 0.3)));
      font.draw(bitmap, fit(font, item.name, x1 - x0 - 4), x0 + 2, r.audio + 2, theme.color('field-ink'));
      bitmap.frame(x0, r.audio, x1 - x0, AUDIO, item.id === chosen ? theme.color('accent') : ink);
      if (item.id === chosen) bitmap.frame(x0 + 1, r.audio + 1, x1 - x0 - 2, AUDIO - 2, theme.color('accent'));
    }
    if (!project.video.length && !project.audio.length) {
      font.draw(bitmap, 'Drag clips here, or press To video.', GUTTER + 6, r.video + 8, dim);
    }

    // The track names, and the marker over everything.
    bitmap.fill(0, RULER + 1, GUTTER - 1, h - RULER - 1, theme.color('panel'));
    bitmap.fill(GUTTER - 1, RULER + 1, 1, h - RULER - 1, ink);
    font.draw(bitmap, 'V', 3, r.video + 9, theme.color('panel-ink'));
    font.draw(bitmap, 'A', 3, r.audio + 5, theme.color('panel-ink'));
    const marker = xOf(playhead);
    if (marker >= GUTTER && marker < w) {
      const red = theme.lock(gfx.parseColor('#e8475a'));
      bitmap.fill(marker, 0, 1, h, red);
      bitmap.fill(marker - 2, 0, 5, 2, red);
      bitmap.fill(marker - 1, 2, 3, 1, red);
    }
    bitmap.frame(0, 0, w, h, ink);
    timeline.commit();
  }

  app.frame(() => {
    if (dirty.monitor) paintMonitor();
    if (dirty.timeline) paintTimeline();
  });
  app.scope.on(monitor.events, 'resize', () => { dirty.monitor = true; });
  app.scope.on(timeline.events, 'resize', () => { dirty.timeline = true; });
  app.scope.subscribe(app.theme, () => { dirty = { monitor: true, timeline: true }; }, { immediate: false });

  // ---- The timeline by hand -----------------------------------------------------

  /** What is under a point: { kind: 'ruler' | 'video' | 'audio' | 'empty', item, edge }. */
  function hit(x, y) {
    const r = rows();
    if (y < RULER + 1) return { kind: 'ruler' };
    const t = timeOf(x);
    const edgeOf = (start, end) => (Math.abs(x - xOf(start)) <= 2 ? 'in' : Math.abs(x - xOf(end)) <= 2 ? 'out' : null);
    if (y >= r.video && y < r.video + VIDEO + SOUND) {
      for (const { item, start, end } of placed(project)) {
        const edge = edgeOf(start, end);
        if ((t >= start && t < end) || edge) return { kind: 'video', item, edge, start };
      }
    }
    if (y >= r.audio && y < r.audio + AUDIO + 2) {
      for (const item of [...project.audio].reverse()) {
        const edge = edgeOf(item.at, item.at + length(item));
        if ((t >= item.at && t < item.at + length(item)) || edge) return { kind: 'audio', item, edge };
      }
    }
    return { kind: 'empty' };
  }

  function seekTo(x) {
    playhead = Math.max(0, Math.min(duration(project), timeOf(x)));
    mode = 'timeline';
    showMarks();
    dirty = { monitor: true, timeline: true };
  }

  let gesture = null;
  app.scope.on(timeline.events, 'down', event => {
    const found = hit(event.x, event.y);
    if (found.item) {
      chosen = found.item.id;
      refresh();
      gesture = { ...found, x: event.x, before: serializeProject(app.xml, project), from: { ...found.item }, moved: false };
      if (!found.edge) seekTo(event.x);
    } else {
      gesture = { kind: 'scrub' };
      if (chosen) { chosen = null; refresh(); }
      seekTo(event.x);
    }
  });
  app.scope.on(timeline.events, 'move', event => {
    if (!gesture) return;
    if (gesture.kind === 'scrub') return seekTo(event.x);
    const dt = (event.x - gesture.x) / view.scale;
    if (Math.abs(event.x - gesture.x) < 2 && !gesture.moved) return;
    gesture.moved = true;
    const { item, from } = gesture;
    const source = sourceOf(item.source);
    if (gesture.edge === 'in') {
      item.in = Math.max(0, Math.min(from.out - MIN_LENGTH, from.in + dt));
      if (gesture.kind === 'audio') item.at = Math.max(0, from.at + (item.in - from.in));
    } else if (gesture.edge === 'out') {
      item.out = Math.max(from.in + MIN_LENGTH, Math.min(source.duration, from.out + dt));
    } else if (gesture.kind === 'audio') {
      item.at = Math.max(0, from.at + dt);
    } else {
      // A video clip moves to where it would be dropped; the rest close up behind it.
      const index = project.video.indexOf(item);
      const target = insertIndex(project, timeOf(event.x), item.id);
      if (target !== index) { project.video.splice(index, 1); project.video.splice(target, 0, item); }
    }
    dirty.timeline = true;
  });
  const finish = commit => {
    if (!gesture) return;
    const done = gesture;
    gesture = null;
    if (done.kind === 'scrub' || !done.moved) return;
    if (commit) edited();
    else { project = parseProject(app.xml, done.before, 'project'); refresh(); }
  };
  app.scope.on(timeline.events, 'up', () => finish(true));
  app.scope.on(timeline.events, 'cancel', () => finish(false));
  app.scope.on(timeline.events, 'wheel', event => {
    event.handled = true;
    if (Math.abs(event.dx) > Math.abs(event.dy) || event.shift) {
      view.scroll = Math.max(0, view.scroll + (event.dx || event.dy) / view.scale);
    } else {
      // Zoom about the time under the pointer.
      const t = timeOf(event.x);
      view.scale = Math.max(2, Math.min(400, view.scale * (event.dy < 0 ? 1.25 : 0.8)));
      view.scroll = Math.max(0, t - (event.x - GUTTER) / view.scale);
    }
    dirty.timeline = true;
  });
  timeline.useCursor(event => {
    const found = hit(event.x, event.y);
    return found.edge ? 'ew-resize' : found.item ? 'grab' : 'default';
  });
  timeline.useDrop({
    accepts: payload => payload?.kind === 'clip' || payload?.kind === 'source',
    drop(payload, event) {
      const from = payload.kind === 'clip' ? project.clips.find(clip => clip.id === payload.value) : wholeSource(payload.value);
      if (!from) return;
      const track = event.y >= rows().audio - 1 ? 'audio' : 'video';
      place(from, track, Math.max(0, timeOf(event.x)));
    }
  });
  app.scope.on(app.keys, 'down', ({ key }) => {
    if (os.ui.focused !== timeline) return;
    const step = 1 / project.fps;
    if (key === 'Delete' || key === 'Backspace') app.run('delete-item');
    else if (key === 's' || key === 'S') app.run('split-item');
    else if (key === 'ArrowLeft' || key === 'ArrowRight') {
      playhead = Math.max(0, Math.min(duration(project), playhead + (key === 'ArrowLeft' ? -step : step)));
      mode = 'timeline';
      showMarks();
      dirty = { monitor: true, timeline: true };
    }
  });

  refresh();
}
