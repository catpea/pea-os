import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Signal } from '../src/core/reactive.js';
import { parseXml, escapeXml } from '../src/core/xml.js';
import { ProviderSet } from '../src/core/providers.js';
import { fileName, memoryFiles } from '../src/os/files.js';
import { parseProject, serializeProject, emptyProject, placed, at, duration } from '../src/os/video-project.js';
import { webAudio } from '../src/platform/audio.js';
import { servedProviders } from '../src/platform/served.js';
import { handler } from '../cli/serve.mjs';
import { byteRange } from '../cli/files.mjs';
import { loadManifest, ROOT } from '../cli/project.mjs';
import { clock, describe, parseXspf, xspf, following } from '../res/apps/music.js';
import { stamp, insertIndex, splitAt, freshId } from '../res/apps/video.js';
import { session } from './helpers.mjs';

const xml = { parseXml, escapeXml };
const FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0 && spawnSync('ffprobe', ['-hide_banner', '-version']).status === 0;

/** A WAV file of silence, `seconds` long, at 8 kHz mono. */
function wav(seconds) {
  const samples = Math.round(seconds * 8000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples * 2, true);
  return bytes;
}

/** A pos serve handler on a free port with its own data folder; stopped after the test. */
async function server(t) {
  const data = await mkdtemp(join(tmpdir(), 'pea-media-'));
  const http = createServer(handler(await loadManifest(ROOT), ROOT, { write() {} }, data));
  await new Promise(done => http.listen(0, '127.0.0.1', done));
  t.after(async () => { http.closeAllConnections(); http.close(); await rm(data, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${http.address().port}/`, data };
}

const fakeOs = (store = new Map()) => ({ platform: { storage: { get: key => store.get(key) ?? null, set: (key, value) => store.set(key, value) } }, report: error => { throw error; } });

// ---- Providers -------------------------------------------------------------------

test('a provider set routes to the first ready provider in order, remembers what was turned off, and says why none works', async () => {
  const store = new Map();
  const make = (id, ok) => ({ id, title: id.toUpperCase(), kind: 'test', status: async () => ({ ok, reason: ok ? 'fine' : `${id} is broken` }), probe() {} });
  const set = new ProviderSet(fakeOs(store), { service: 'media', title: 'Video tools', methods: ['probe'], order: ['a', 'b'] });
  assert.throws(() => set.register({ id: 'x', title: 'X', kind: 'test', status() {} }), /needs "probe"/);
  set.register(make('a', false));
  set.register(make('b', true));
  assert.equal((await set.route()).id, 'b');
  assert.equal(await set.refresh(), 'b');
  assert.equal(set.current.value, 'b');
  set.install('b', false);
  assert.deepEqual(JSON.parse(store.get('pea-os.providers.media.v1')).off, ['b']);
  await set.refresh();
  assert.equal(set.current.value, null, 'nothing works once the one ready provider is off');
  await assert.rejects(set.route(), /Nothing here gives video tools\. A: a is broken B: turned off in Software/);
  const again = new ProviderSet(fakeOs(store), { service: 'media', title: 'Video tools', methods: ['probe'] });
  assert.deepEqual(again.settings.value.off, ['b'], 'the choice survives a restart');
});

test('Pea OS lists every provider it knows of, with why the missing ones are missing, and always keeps memory files', async t => {
  const live = await session(t, { width: 320, height: 200 });
  const { os } = live;
  await os.ready;
  const media = Object.fromEntries((await os.providers.media.survey()).map(entry => [entry.id, entry]));
  assert.match(media['ffmpeg-server'].reason, /^Not available here: only when Pea OS is opened from pos serve/);
  assert.match(media['ffmpeg-wasm'].reason, /never downloads code/);
  assert.match(media['ffmpeg-android'].reason, /^Not built yet/);
  assert.equal(os.providers.media.current.value, null);
  assert.equal(os.providers.files.current.value, 'storage-files', 'files are kept with the preferences when nothing better is here');
  assert.equal(os.providers.audio.current.value, 'test-audio');
  assert.equal(os.providers.schedule.current.value, 'page');
  assert.equal(os.providers.network.current.value, null, 'this host gives no internet');
  assert.match((await os.providers.network.why()), /^Relay \(pos serve\): Not available here/);
  assert.throws(() => os.providers.files.install('memory', false), /always stays/);
  assert.throws(() => os.providers.media.install('ffmpeg-wasm', true), /cannot be installed here/);
  assert.equal(os.providers.thinking, os.ai, 'the model router is the thinking service');
  assert.equal(os.providers.catalog.get('ffmpeg-server').license.includes('LGPL'), true);
});

test('memory files keep bytes, list by folder and refuse names that could escape', async () => {
  const files = memoryFiles();
  await files.write('music/a.wav', wav(0.1));
  await files.write('video/b.mp4', new Uint8Array([1, 2, 3]));
  assert.deepEqual((await files.list('music')).map(file => [file.name, file.type]), [['music/a.wav', 'audio/wav']]);
  assert.equal((await files.list()).length, 2);
  const source = await files.source('video/b.mp4');
  assert.deepEqual([...source.data], [1, 2, 3]);
  source.release();
  for (const bad of ['../x', 'a/b/c', '.hidden', 'x/.y', '', 'con:', 'a\\b']) assert.throws(() => fileName(bad), /not a file name/, bad);
  assert.equal(fileName('music/Pea Band - Song (live).mp3'), 'music/Pea Band - Song (live).mp3');
});

test('an app that needs a missing service is not installed, and arrives when a provider does', async t => {
  let ready = false;
  const fake = { service: 'media', id: 'ffmpeg-server', title: 'Fake ffmpeg', kind: 'test', status: async () => ({ ok: ready, reason: ready ? 'here' : 'Not available here: no server.' }), probe() {}, frame() {}, peaks() {}, render() {} };
  const live = await session(t, { width: 640, height: 400, providers: [fake] });
  const { os } = live;
  await os.ready;
  assert.equal(os.software.installed('video'), false);
  assert.deepEqual(os.software.missing('video').map(item => item.service), ['media']);
  assert.throws(() => os.software.install('video', true), /Pea Cut needs video tools, and nothing here gives it/);
  ready = true;
  const before = os.software.changed.value;
  await os.providers.media.refresh();
  assert.ok(os.software.changed.value > before, 'Software heard the service arrive');
  assert.equal(os.software.installed('video'), true);
  assert.deepEqual(live.errors, []);
});

// ---- The video project language ---------------------------------------------------

const PROJECT = `<videoproject version="1" name="Holiday" width="640" height="360" fps="25">
  <source id="s1" file="video/beach.mp4" duration="10" width="320" height="240" video="true" audio="true"/>
  <source id="s2" file="music/song.wav" duration="30" audio="true"/>
  <clip id="c1" source="s1" in="1" out="4" name="Waves"/>
  <video><item id="i1" source="s1" in="1" out="4" name="Waves"/><item id="i2" source="s1" in="6" out="8" mute="true"/></video>
  <audio><item id="i3" source="s2" in="0" out="30" at="0.5" volume="0.4"/></audio>
</videoproject>`;

test('video projects read, write back the same, and refuse what cannot be rendered', () => {
  const project = parseProject(xml, PROJECT);
  assert.equal(duration(project), 5);
  assert.deepEqual(placed(project).map(span => [span.start, span.end]), [[0, 3], [3, 5]]);
  assert.deepEqual(at(project, 3.5), { item: project.video[1], index: 1, source: 6.5 });
  assert.equal(at(project, 99).index, 1, 'past the end is the last frame');
  assert.deepEqual(parseProject(xml, serializeProject(xml, project)), project);
  const broken = [
    [PROJECT.replace('out="4" name="Waves"/><item', 'out="11" name="Waves"/><item'), /past the end of video\/beach.mp4/],
    [PROJECT.replace('<item id="i2" source="s1"', '<item id="i2" source="s2"'), /has no picture, so it belongs on the audio track/],
    [PROJECT.replace('id="i3"', 'id="i1"'), /every source, clip and item needs its own id/],
    [PROJECT.replace('in="6" out="8"', 'in="8" out="6"'), /must come after/],
    [PROJECT.replace('file="video/beach.mp4"', 'file="../beach.mp4"'), /not a file name/],
    [PROJECT.replace('width="640"', 'width="641"'), /even numbers/]
  ];
  for (const [text, problem] of broken) assert.throws(() => parseProject(xml, text), problem);
  assert.equal(serializeProject(xml, emptyProject()).includes('<video>'), true);
});

test('Pea Cut cuts, inserts and names things where an editor would', () => {
  const project = parseProject(xml, PROJECT);
  assert.equal(stamp(0.9), '0:00.90');
  assert.equal(stamp(83.456), '1:23.46');
  assert.equal(insertIndex(project, 0), 0);
  assert.equal(insertIndex(project, 2), 1, 'past the middle of the first clip');
  assert.equal(insertIndex(project, 9), 2);
  assert.equal(freshId(project, 'i'), 'i4');
  assert.equal(splitAt(project, 'i1', 2, 'i4'), true);
  assert.deepEqual(project.video.map(item => [item.id, item.in, item.out]), [['i1', 1, 3], ['i4', 3, 4], ['i2', 6, 8]]);
  assert.equal(splitAt(project, 'i1', 0.05, 'i5'), false, 'too close to an edge');
  assert.equal(splitAt(project, 'i3', 10.5, 'i5'), true);
  assert.deepEqual(project.audio.map(item => [item.id, item.in, item.out, item.at]), [['i3', 0, 10, 0.5], ['i5', 10, 30, 10.5]]);
});

// ---- Jukebox ----------------------------------------------------------------------

test('XSPF playlists round-trip, and only files Pea keeps are taken from them', () => {
  const tracks = [{ file: 'music/Pea Band - Garden Song.mp3', title: 'Garden Song', artist: 'Pea Band', duration: 61.5 }, { file: 'music/rain & sun.ogg', title: 'rain & sun', artist: '', duration: 0 }];
  const text = xspf(xml, tracks);
  assert.match(text, /<location>music\/Pea%20Band%20-%20Garden%20Song\.mp3<\/location>/);
  assert.deepEqual(parseXspf(xml, text).tracks, tracks);
  const foreign = `<playlist version="1" xmlns="http://xspf.org/ns/0/"><trackList>
    <track><location>https://example.com/a.mp3</location></track><track><location>/home/me/b.mp3</location></track>
    <track><location>music/c.mp3</location></track></trackList></playlist>`;
  const read = parseXspf(xml, foreign);
  assert.deepEqual(read.tracks.map(track => track.file), ['music/c.mp3']);
  assert.equal(read.skipped, 2);
  assert.deepEqual(describe('music/Pea Band - Garden Song.mp3'), { artist: 'Pea Band', title: 'Garden Song' });
  assert.equal(clock(3725), '1:02:05');
  assert.equal(clock(NaN), '–:––');
});

test('shuffle plays every track once before repeating, and stops at the end without repeat', () => {
  const played = new Set([0]);
  const seen = [0];
  let current = 0;
  for (let i = 0; i < 4; i++) { current = following(5, current, { shuffle: true, played, random: () => 0.5 }); played.add(current); seen.push(current); }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4]);
  assert.equal(following(5, current, { shuffle: true, played }), -1);
  assert.notEqual(following(5, current, { shuffle: true, repeat: true, played, random: () => 0 }), -1);
  assert.equal(following(3, 2, {}), -1);
  assert.equal(following(3, 2, { repeat: true }), 0);
});

test('Jukebox keeps music in the files service, plays it through the sound service, and moves on by itself', async t => {
  const live = await session(t, { width: 960, height: 540, options: { pixel: 1, open: ['music'] }, files: [[{ name: 'Pea Band - One.wav', data: wav(0.5) }, { name: 'Two.wav', data: wav(0.5) }]] });
  const { os } = live;
  const app = os.app('music');
  app.run('add-files');
  await live.frames(10);
  assert.deepEqual((await os.providers.files.route()).id, 'storage-files');
  assert.deepEqual((await (await os.providers.files.route()).list('music')).map(file => file.name), ['music/Pea Band - One.wav', 'music/Two.wav']);
  const [player] = live.players;
  assert.equal(player.state.value.status, 'playing');
  assert.equal(app.signal('play-text').value, '⏸');
  await live.frames(40);
  assert.match(app.refs.tracks.items[1].text, /^▶ 2\. Two/, 'the first track ended and the second began');
  player.remote.emit('previous');
  await live.frames(3);
  assert.match(app.refs.tracks.items[0].text, /^▶ 1\. Pea Band - One \(0:00\)/);
  app.signal('volume').set(25);
  app.run('volume');
  assert.equal(player.volumeLevel, 0.25);
  app.run('save-list');
  assert.match(live.downloads.at(-1).text, /<location>music\/Two\.wav<\/location>/);
  await new Promise(done => setTimeout(done, 450));
  assert.match(os.platform.storage.get('pea-os.doc.music'), /Pea%20Band%20-%20One\.wav/, 'the playlist is kept between runs');
  os.close('music');
  await live.frames(2);
  assert.notEqual(player.state.value.status, 'playing', 'closing Jukebox stops the music');
  assert.deepEqual(live.errors, []);
});

// ---- The browser's player ---------------------------------------------------------

function fakeBrowser({ mobile = false } = {}) {
  const listeners = new Map();
  const element = {
    currentTime: 0, duration: NaN, paused: true, ended: false, volume: 1, playbackRate: 1, src: '',
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: type => listeners.delete(type),
    load() {}, removeAttribute() {},
    play() { element.paused = false; queueMicrotask(() => listeners.get('playing')?.()); return Promise.resolve(); },
    pause() { element.paused = true; listeners.get('pause')?.(); },
    fire: type => listeners.get(type)?.()
  };
  const handlers = new Map();
  const mediaSession = { metadata: null, playbackState: 'none', setActionHandler: (action, fn) => (fn ? handlers.set(action, fn) : handlers.delete(action)), setPositionState() {} };
  let contexts = 0;
  class AudioContext {
    constructor() { contexts++; this.state = 'running'; this.destination = {}; }
    createMediaElementSource() { return { connect() {} }; }
    createAnalyser() { return { frequencyBinCount: 128, connect() {}, getByteFrequencyData: bins => bins.fill(200) }; }
    close() { return Promise.resolve(); }
  }
  let time = 0;
  const provider = webAudio({ createAudio: () => element, AudioContext, mediaSession, mobile, now: () => time });
  return { provider, element, handlers, mediaSession, contexts: () => contexts, tick: ms => { time += ms; } };
}

test('the browser player hands its controls to the lock screen, and keeps phones on the system player', async () => {
  globalThis.MediaMetadata ??= class { constructor(meta) { Object.assign(this, meta); } };
  const desk = fakeBrowser();
  assert.equal((await desk.provider.status()).ok, true);
  const player = desk.provider.player();
  const nexts = [];
  player.remote.on('next', () => nexts.push('next'));
  player.load({ url: 'blob:x', title: 'Garden Song', artist: 'Pea Band' });
  assert.equal(player.state.value.status, 'loading');
  desk.element.duration = 120;
  desk.element.fire('canplay');
  assert.equal(player.state.value.status, 'paused');
  player.play();
  await Promise.resolve();
  assert.equal(player.state.value.status, 'playing');
  assert.equal(desk.mediaSession.playbackState, 'playing');
  assert.equal(desk.mediaSession.metadata.title, 'Garden Song');
  desk.handlers.get('nexttrack')();
  desk.handlers.get('seekto')({ seekTime: 42 });
  assert.deepEqual(nexts, ['next']);
  assert.equal(desk.element.currentTime, 42);
  desk.handlers.get('pause')();
  assert.equal(player.state.value.status, 'paused');
  assert.equal(desk.contexts(), 1, 'a desktop browser draws the spectrum through Web Audio');
  player.dispose();
  assert.equal(desk.handlers.size, 0, 'a player gone lets go of the lock screen');

  const phone = fakeBrowser({ mobile: true });
  assert.match((await phone.provider.status()).reason, /keeps going with the screen off/);
  const pocket = phone.provider.player();
  pocket.load({ url: 'blob:y' });
  phone.element.fire('canplay');
  pocket.play();
  await Promise.resolve();
  assert.equal(phone.contexts(), 0, 'on a phone the sound never goes through Web Audio');
  assert.equal(pocket.spectrum(new Uint8Array(8)), false);
  pocket.dispose();
});

// ---- pos serve: disk files and ffmpeg ----------------------------------------------

test('disk files go through pos serve: list, ranges for players, all-or-nothing writes, and only for this computer', async t => {
  const { base, data } = await server(t);
  const [posServe, files, media] = servedProviders(base);
  assert.match((await posServe.status()).reason, /^Pea OS was opened from pos serve at http:\/\/127\.0\.0\.1:/);
  assert.equal((await posServe.describe()).name, 'services');
  assert.match((await files.status()).reason, /Files are kept in .*pea-media-/);
  assert.equal(media.files, files);
  await files.write('music/Song.wav', new Blob([wav(0.25)]));
  assert.deepEqual((await files.list('music')).map(file => [file.name, file.type]), [['music/Song.wav', 'audio/wav']]);
  assert.equal((await readFile(join(data, 'files', 'music', 'Song.wav'))).length, 44 + 4000);
  const range = await fetch(`${base}__pos/files/music/Song.wav`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'RIFF');
  assert.equal((await fetch(`${base}__pos/files/music/Song.wav`, { headers: { Range: 'bytes=99999-' } })).status, 416);
  assert.equal(byteRange('bytes=-10', 100).start, 90);
  assert.equal((await fetch(`${base}__pos/files/..%2Fsecret`)).status, 400);
  const elsewhere = await fetch(`${base}__pos/files`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(elsewhere.status, 403, 'another site cannot read the user\'s files');
  await files.remove('music/Song.wav');
  assert.deepEqual(await files.list(), []);
  await writeFile(join(data, 'files', '.half.part'), 'x');
  assert.deepEqual(await files.list(), [], 'files still being written are never listed');
});

test('on a static host, everything that requires the Pea server steps aside with one reason, and Pea adapts', async t => {
  const plain = createServer((request, response) => { response.writeHead(404); response.end('Not found'); });
  await new Promise(done => plain.listen(0, '127.0.0.1', done));
  t.after(() => plain.close());
  const live = await session(t, { providers: servedProviders(`http://127.0.0.1:${plain.address().port}/`) });
  const { os } = live;
  await os.ready;
  const { server, files, media, network } = os.providers;
  assert.equal(server.current.value, null);
  assert.match(await server.why(), /^pos serve: Not available here: this page was not opened from pos serve/);
  const disk = (await files.survey()).find(entry => entry.id === 'disk');
  assert.deepEqual([disk.ok, disk.reason, disk.requires], [false, 'Needs Pea server, which nothing here gives.', [{ service: 'server', title: 'Pea server', met: false }]]);
  assert.equal(files.current.value, 'storage-files', 'files are kept where they can be');
  assert.equal(media.current.value, null);
  assert.equal(network.current.value, null);
  assert.equal(os.software.installed('video'), false, 'no video editor without ffmpeg');
  assert.deepEqual(os.software.missing('video').map(need => need.title), ['Video tools']);
});

test('ffmpeg probes, shows pictures, measures loudness and renders a timeline with its music', { skip: !FFMPEG && 'ffmpeg is not installed here' }, async t => {
  const { base, data } = await server(t);
  const [, files, media] = servedProviders(base);
  const scratch = join(data, 'made');
  spawnSync('mkdir', ['-p', scratch]);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(scratch, 'clip.mp4')]);
  await files.write('video/clip.mp4', new Blob([await readFile(join(scratch, 'clip.mp4'))]));
  await files.write('music/tone.wav', new Blob([wav(3)]));
  assert.match((await media.status()).reason, /^ffmpeg \S+ renders (MP4|WEBM)/);
  const probe = await media.probe('video/clip.mp4');
  assert.deepEqual([probe.video.width, probe.video.height, Math.round(probe.duration)], [160, 120, 2]);
  assert.equal((await media.probe('music/tone.wav')).video, null);
  const picture = await media.frame('video/clip.mp4', 1, 80);
  assert.deepEqual([picture.width, picture.height, picture.data.length], [80, 60, 80 * 60 * 4]);
  assert.equal((await media.peaks('video/clip.mp4', 10)).length, 10);
  await assert.rejects(media.probe('video/none.mp4'), /There is no file/);

  const live = await session(t, { width: 960, height: 540, options: { pixel: 1, open: ['video'] }, providers: servedProviders(base) });
  const { os } = live;
  await os.ready;
  assert.equal(os.providers.media.current.value, 'ffmpeg-server');
  assert.equal(os.software.installed('video'), true);
  const app = os.app('video');
  const settle = async check => { for (let i = 0; i < 400 && !check(); i++) { await live.frames(1); await new Promise(done => setTimeout(done, 5)); } };
  app.run('stored-media');
  await settle(() => live.os.desktop.popups.children.length);
  const popup = os.desktop.popups.children.at(-1);
  popup.items.find(item => item.text === 'All 2').invoke();
  await settle(() => app.refs.sources.items.length === 2);
  // Stored files come in name order: music/tone.wav is s1, video/clip.mp4 is s2.
  app.signal('source-id').set('s2');
  app.signal('scrub').set(250); app.run('scrub'); app.run('mark-in');
  app.signal('scrub').set(750); app.run('scrub'); app.run('mark-out');
  app.run('make-clip');
  assert.match(app.refs.clips.items[0].detail, /0:00\.50 – 0:01\.50/);
  app.run('clip-to-video');
  app.run('source-to-timeline');
  app.signal('source-id').set('s1');
  app.run('source-to-timeline');
  assert.match(app.signal('timeline-info').value, /3 on the timeline · 0:03\.00/);

  // Dragging the second clip to the start of the timeline swaps them, in one undoable step.
  await live.frames(4);
  const { timeline } = app.refs;
  const press = (type, x, y) => timeline.events.emit(type, { x, y });
  const order = () => [...app.files.serialize().split('<video>')[1].split('</video>')[0].matchAll(/in="([\d.]+)" out="([\d.]+)"/g)].map(match => `${match[1]}-${match[2]}`);
  assert.deepEqual(order(), ['0.5-1.5', '0-2']);
  press('down', 12 + 30 * 2, 20); press('move', 14, 20); press('up', 14, 20);
  assert.deepEqual(order(), ['0-2', '0.5-1.5']);
  await app.run('undo');
  assert.deepEqual(order(), ['0.5-1.5', '0-2']);

  app.run('render');
  await settle(() => /Rendered|could not|stopped/.test(app.signal('status').value));
  assert.match(app.signal('status').value, /^Rendered renders\/Untitled\.(mp4|webm)/);
  const [render] = await files.list('renders');
  const made = await media.probe(render.name);
  assert.ok(Math.abs(made.duration - 3) < 0.15, `the render is as long as the timeline (${made.duration})`);
  assert.deepEqual([made.video.width, made.video.height, made.audio.channels], [1280, 720, 2]);
  app.run('watch');
  await settle(() => live.opened.length);
  assert.match(live.opened[0], /__pos\/files\/renders\/Untitled\./);
  assert.deepEqual(live.errors, []);
});

test('a render stops when asked, and leaves nothing half-written behind', { skip: !FFMPEG && 'ffmpeg is not installed here' }, async t => {
  const { base, data } = await server(t);
  const [, files, media] = servedProviders(base);
  await files.write('music/long.wav', new Blob([wav(1)]));
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(data, 'files', 'long.mp4')]);
  const project = `<videoproject version="1" name="Long" width="1920" height="1080" fps="60"><source id="s1" file="long.mp4" duration="20" video="true"/><video><item id="i1" source="s1" in="0" out="20"/></video></videoproject>`;
  const stop = new AbortController();
  const rendering = media.render(project, { signal: stop.signal, onProgress: () => stop.abort() });
  await assert.rejects(rendering, /abort/i);
  let left = [];
  for (let i = 0; i < 100; i++) {
    left = await readdir(join(data, 'files', 'renders')).catch(() => []);
    if (!left.length) break;
    await new Promise(done => setTimeout(done, 20));
  }
  assert.deepEqual(left, [], 'the hidden part file is removed');
  await assert.rejects(media.render(project.replace('out="20"', 'out="25"')), /past the end/);
});
