import { fileName } from './files.js';

/**
 * The video project language, read by the video editor and by whatever
 * renders it (pos serve's ffmpeg). One document holds the sources, the clips
 * cut from them, and the timeline:
 *
 *   <videoproject version="1" name="Holiday" width="1280" height="720" fps="30">
 *     <source id="s1" file="video/beach.mp4" duration="12.5" width="1920" height="1080" video="true" audio="true"/>
 *     <clip id="c1" source="s1" in="1.5" out="4" name="Waves"/>
 *     <video>                                  one item after another, no gaps
 *       <item id="i1" source="s1" in="1.5" out="4" name="Waves" volume="1" mute="false"/>
 *     </video>
 *     <audio>                                  music and sounds laid under it, from `at` seconds
 *       <item id="i2" source="s2" in="0" out="30" name="Song" at="0" volume="0.5"/>
 *     </audio>
 *   </videoproject>
 *
 * Times are seconds. A timeline item keeps its own in and out, so one clip
 * can be used twice and trimmed differently each time.
 */

export const SIZES = [[1920, 1080], [1280, 720], [854, 480], [640, 360], [1080, 1920], [720, 1280], [1080, 1080]];
export const RATES = [24, 25, 30, 50, 60];
export const LIMITS = { sources: 100, clips: 400, items: 400 };

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const round = value => Math.round(value * 1000) / 1000;

export const length = item => round(item.out - item.in);

/** The timeline's length: the video track's, which the audio track is cut to. */
export const duration = project => round(project.video.reduce((sum, item) => sum + length(item), 0));

/** Where each video item starts on the timeline: [{ item, start, end }]. */
export function placed(project) {
  let at = 0;
  return project.video.map(item => {
    const start = at;
    at = round(at + length(item));
    return { item, start, end: at };
  });
}

/** The video item playing at `time`, and the time inside its source: { item, index, source } or null. */
export function at(project, time) {
  const spans = placed(project);
  const index = spans.findIndex(span => time >= span.start && time < span.end);
  const found = index >= 0 ? index : time >= duration(project) && spans.length ? spans.length - 1 : -1;
  if (found < 0) return null;
  const { item, start } = spans[found];
  return { item, index: found, source: round(Math.min(item.out - 0.001, item.in + Math.max(0, time - start))) };
}

export function emptyProject(name = 'Untitled') {
  return { name, width: 1280, height: 720, fps: 30, sources: [], clips: [], video: [], audio: [] };
}

/** Reads and checks a <videoproject>; every mistake names its line. */
export function parseProject(xml, text, source = 'project') {
  const root = xml.parseXml(text, source);
  if (root.name !== 'videoproject') root.fail('must be <videoproject>');
  root.expect({ attrs: ['version', 'name', 'width', 'height', 'fps'], children: ['source', 'clip', 'video', 'audio'] });
  if (root.need('version') !== '1') root.fail('version must be "1"');
  const number = (node, name, { min = 0, max = 86400, fallback } = {}) => {
    const value = fallback === undefined ? (node.need(name), node.num(name)) : node.num(name, fallback);
    if (!Number.isFinite(value) || value < min || value > max) node.fail(`${name}="${node.attr(name)}" must be a number from ${min} to ${max}`);
    return value;
  };
  const id = node => {
    const value = node.need('id');
    if (!ID.test(value)) node.fail(`id="${value}" must be lowercase letters, digits and "-"`);
    return value;
  };
  const project = {
    name: root.attr('name', 'Untitled').slice(0, 120),
    width: number(root, 'width', { min: 16, max: 3840, fallback: 1280 }),
    height: number(root, 'height', { min: 16, max: 3840, fallback: 720 }),
    fps: number(root, 'fps', { min: 1, max: 120, fallback: 30 }),
    sources: [], clips: [], video: [], audio: []
  };
  if (project.width % 2 || project.height % 2) root.fail('width and height must be even numbers');
  const sources = new Map();
  for (const node of root.all('source')) {
    node.expect({ attrs: ['id', 'file', 'duration', 'width', 'height', 'video', 'audio'] });
    const item = { id: id(node), file: '', duration: number(node, 'duration'), width: number(node, 'width', { max: 16384, fallback: 0 }), height: number(node, 'height', { max: 16384, fallback: 0 }), video: node.flag('video', false), audio: node.flag('audio', false) };
    try { item.file = fileName(node.need('file')); } catch (error) { node.fail(error.message); }
    if (sources.has(item.id)) node.fail(`id="${item.id}" is used twice`);
    sources.set(item.id, item);
    project.sources.push(item);
  }
  const span = (node, extra) => {
    const sourceId = node.need('source');
    const from = sources.get(sourceId);
    if (!from) node.fail(`source="${sourceId}" is not a source of this project`);
    const item = { id: id(node), source: sourceId, in: number(node, 'in'), out: number(node, 'out'), name: node.attr('name', '').slice(0, 80), ...extra };
    if (!(item.out > item.in)) node.fail(`out="${item.out}" must come after in="${item.in}"`);
    if (item.out > from.duration + 0.05) node.fail(`out="${item.out}" is past the end of ${from.file} (${from.duration} s)`);
    return item;
  };
  for (const node of root.all('clip')) {
    node.expect({ attrs: ['id', 'source', 'in', 'out', 'name'] });
    project.clips.push(span(node, {}));
  }
  for (const [track, attrs] of [['video', ['volume', 'mute']], ['audio', ['at', 'volume']]]) {
    const nodes = root.all(track);
    if (nodes.length > 1) nodes[1].fail(`there is one <${track}> track`);
    for (const node of nodes[0]?.expect({ children: ['item'] }).all('item') ?? []) {
      node.expect({ attrs: ['id', 'source', 'in', 'out', 'name', ...attrs] });
      const item = span(node, { volume: number(node, 'volume', { max: 4, fallback: 1 }) });
      if (track === 'video') {
        item.mute = node.flag('mute', false);
        if (!sources.get(item.source).video) node.fail(`${sources.get(item.source).file} has no picture, so it belongs on the audio track`);
      } else {
        item.at = number(node, 'at', { fallback: 0 });
        if (!sources.get(item.source).audio) node.fail(`${sources.get(item.source).file} has no sound`);
      }
      project[track].push(item);
    }
  }
  const ids = [...project.sources, ...project.clips, ...project.video, ...project.audio].map(item => item.id);
  if (new Set(ids).size !== ids.length) root.fail('every source, clip and item needs its own id');
  if (project.sources.length > LIMITS.sources || project.clips.length > LIMITS.clips || project.video.length + project.audio.length > LIMITS.items) {
    root.fail(`a project holds at most ${LIMITS.sources} sources, ${LIMITS.clips} clips and ${LIMITS.items} timeline items`);
  }
  return project;
}

export function serializeProject(xml, project) {
  const e = xml.escapeXml;
  const span = item => `id="${e(item.id)}" source="${e(item.source)}" in="${round(item.in)}" out="${round(item.out)}" name="${e(item.name)}"`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<videoproject version="1" name="${e(project.name)}" width="${project.width}" height="${project.height}" fps="${project.fps}">`,
    ...project.sources.map(source => `  <source id="${e(source.id)}" file="${e(source.file)}" duration="${round(source.duration)}" width="${source.width}" height="${source.height}" video="${source.video}" audio="${source.audio}"/>`),
    ...project.clips.map(clip => `  <clip ${span(clip)}/>`),
    '  <video>',
    ...project.video.map(item => `    <item ${span(item)} volume="${round(item.volume)}" mute="${item.mute}"/>`),
    '  </video>',
    '  <audio>',
    ...project.audio.map(item => `    <item ${span(item)} at="${round(item.at)}" volume="${round(item.volume)}"/>`),
    '  </audio>',
    '</videoproject>'
  ];
  return `${lines.join('\n')}\n`;
}
