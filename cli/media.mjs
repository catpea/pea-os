import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { escapeXml, parseXml } from '../src/core/xml.js';
import { fileName } from '../src/os/files.js';
import { duration, length, parseProject } from '../src/os/video-project.js';

/**
 * The media provider's server half: the ffmpeg and ffprobe already on this
 * computer, run by pos serve on files in its store. Pea OS is a front end to
 * ffmpeg, as Shotcut is; nothing is installed or downloaded.
 *
 *   GET  /__pos/media/probe?name=      <probe duration><video width height fps/><audio rate channels/></probe>
 *   GET  /__pos/media/frame?name=&t=&w=   one picture as RGBA bytes; X-Pea-Width and X-Pea-Height
 *   GET  /__pos/media/peaks?name=&n=   n loudness bytes, 0-255
 *   POST /__pos/media/render           a <videoproject>; answers with lines as it works:
 *                                      "progress 0.42", then "done renders/name.mp4" or "error why"
 *
 * Programs are started without a shell, with arguments built from checked
 * names and numbers only. Closing the request stops the render.
 */

export const MEDIA_PATH = '/__pos/media';
const PROJECT_LIMIT = 1024 * 1024;
const FRAME_LIMIT = 640 * 1280 * 4;

/** Runs a program to the end: { code, stdout: Buffer, stderr: string }. stdout past `limit` stops it. */
export function run(command, args, { signal, limit = 64 * 1024 * 1024, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal }); }
    catch (error) { reject(error); return; }
    const chunks = [];
    let size = 0;
    let stderr = '';
    child.stdout.on('data', chunk => {
      if (onStdout) return onStdout(chunk);
      size += chunk.length;
      if (size > limit) child.kill('SIGKILL');
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim() }));
  });
}

const lastLine = text => text.split('\n').filter(Boolean).at(-1) ?? '';

export class MediaTools {
  #tools = null;

  constructor(store, { ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
    this.store = store;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.rendering = null;
  }

  /** What this computer has: { ffmpeg: version | null, reason, video, audio, format }, looked up once. */
  tools() {
    this.#tools ??= (async () => {
      const version = async command => {
        try {
          const { code, stdout } = await run(command, ['-hide_banner', '-version'], { limit: 64 * 1024 });
          return code === 0 ? /version\s+(\S+)/.exec(stdout.toString())?.[1] ?? 'unknown' : null;
        } catch { return null; }
      };
      const [ffmpeg, ffprobe] = await Promise.all([version(this.ffmpeg), version(this.ffprobe)]);
      if (!ffmpeg || !ffprobe) return { ffmpeg: null, reason: `${[!ffmpeg && 'ffmpeg', !ffprobe && 'ffprobe'].filter(Boolean).join(' and ')} not found on this computer. Install the ffmpeg package, then restart pos serve.` };
      const { stdout } = await run(this.ffmpeg, ['-hide_banner', '-encoders'], { limit: 1024 * 1024 });
      const has = name => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(stdout.toString());
      // H.264 in MP4 plays everywhere; VP9 in WebM is the free fallback.
      const video = ['libx264', 'libopenh264', 'h264_v4l2m2m', 'mpeg4'].find(has);
      if (video && has('aac')) return { ffmpeg, video, audio: 'aac', format: 'mp4' };
      if (has('libvpx-vp9') && has('libopus')) return { ffmpeg, video: 'libvpx-vp9', audio: 'libopus', format: 'webm' };
      return { ffmpeg: null, reason: `ffmpeg ${ffmpeg} is here, but it has no H.264, MPEG-4 or VP9 encoder to render with.` };
    })();
    return this.#tools;
  }

  async #need() {
    const tools = await this.tools();
    if (!tools.ffmpeg) throw Object.assign(new Error(tools.reason), { status: 503 });
    return tools;
  }

  async #file(name) {
    name = fileName(name);
    if (!await this.store.info(name)) throw Object.assign(new Error(`There is no file "${name}".`), { status: 404 });
    return this.store.path(name);
  }

  /** { duration, video: { width, height, fps } | null, audio: { rate, channels } | null } */
  async probe(name) {
    await this.#need();
    const path = await this.#file(name);
    const { code, stdout, stderr } = await run(this.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', path], { limit: 4 * 1024 * 1024 });
    if (code !== 0) throw Object.assign(new Error(`ffprobe could not read ${name}: ${lastLine(stderr) || 'not a media file'}`), { status: 422 });
    const info = JSON.parse(stdout.toString());
    // Cover art in a music file is a picture stream, not video.
    const video = info.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
    const audio = info.streams?.find(stream => stream.codec_type === 'audio');
    const rate = text => {
      const [a, b] = String(text ?? '0/1').split('/').map(Number);
      return b ? Math.round(a / b * 1000) / 1000 : 0;
    };
    const seconds = Number(info.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
    if (!video && !audio) throw Object.assign(new Error(`${name} has neither picture nor sound.`), { status: 422 });
    return {
      duration: Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : 0,
      video: video ? { width: video.width, height: video.height, fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate), codec: video.codec_name } : null,
      audio: audio ? { rate: Number(audio.sample_rate), channels: audio.channels, codec: audio.codec_name } : null
    };
  }

  /** One picture at `seconds`, `width` pixels wide: { width, height, data } in RGBA. */
  async frame(name, seconds, width) {
    await this.#need();
    const path = await this.#file(name);
    const w = Math.max(8, Math.min(640, Math.round(width / 2) * 2));
    const t = Math.max(0, Number(seconds) || 0);
    const { code, stdout, stderr } = await run(this.ffmpeg, ['-v', 'error', '-ss', String(t), '-i', path, '-frames:v', '1', '-vf', `scale=${w}:-2:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { limit: FRAME_LIMIT });
    if (code !== 0 || !stdout.length || stdout.length % (w * 4)) throw Object.assign(new Error(stdout.length ? `ffmpeg could not show ${name}: ${lastLine(stderr)}` : `${name} has no picture at ${t.toFixed(2)} s.`), { status: 422 });
    return { width: w, height: stdout.length / (w * 4), data: stdout };
  }

  /** How loud `name` is across its length, in `count` steps of 0-255. */
  async peaks(name, count) {
    const n = Math.max(1, Math.min(4000, Math.round(count)));
    const { duration: seconds, audio } = await this.probe(name);
    const peaks = new Uint8Array(n);
    if (!audio || !seconds) return peaks;
    const RATE = 2000;
    const per = Math.max(1, (seconds * RATE) / n);
    let index = 0;
    let carry = null;
    const { code, stderr } = await run(this.ffmpeg, ['-v', 'error', '-i', this.store.path(fileName(name)), '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], {
      onStdout(chunk) {
        if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
        if (chunk.length % 2) { carry = chunk.subarray(chunk.length - 1); chunk = chunk.subarray(0, chunk.length - 1); }
        for (let i = 0; i < chunk.length; i += 2, index++) {
          const bucket = Math.min(n - 1, Math.floor(index / per));
          const level = Math.min(255, Math.abs(chunk.readInt16LE(i)) >> 7);
          if (level > peaks[bucket]) peaks[bucket] = level;
        }
      }
    });
    if (code !== 0) throw Object.assign(new Error(`ffmpeg could not read the sound of ${name}: ${lastLine(stderr)}`), { status: 422 });
    return peaks;
  }

  /**
   * The ffmpeg arguments that render a project into `output`, and its length.
   * Every source is probed again here, so the project's own claims are only hints.
   */
  async plan(project, output) {
    const tools = await this.#need();
    if (!project.video.length) throw Object.assign(new Error('Put a clip on the video track first.'), { status: 422 });
    const probes = new Map();
    for (const source of project.sources) {
      if ([...project.video, ...project.audio].some(item => item.source === source.id)) probes.set(source.id, { file: source.file, path: await this.#file(source.file), ...await this.probe(source.file) });
    }
    const { width: W, height: H, fps } = project;
    const args = ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-y'];
    const filters = [];
    const inputs = [];
    const input = (item, path) => {
      // Seeking before -i is fast, and accurate when the input is decoded again.
      args.push('-ss', String(item.in), '-t', String(length(item)), '-i', path);
      inputs.push(item);
      return inputs.length - 1;
    };
    project.video.forEach((item, i) => {
      const probe = probes.get(item.source);
      if (!probe.video) throw Object.assign(new Error(`${probe.file} has no picture, so it cannot go on the video track.`), { status: 422 });
      const k = input(item, probe.path);
      const d = length(item);
      filters.push(`[${k}:v:0]setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,trim=duration=${d}[v${i}]`);
      filters.push(probe.audio && !item.mute
        ? `[${k}:a:0]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${item.volume},apad=whole_dur=${d},atrim=duration=${d}[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a${i}]`);
    });
    filters.push(`${project.video.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${project.video.length}:v=1:a=1[vout][aseq]`);
    const total = duration(project);
    const under = project.audio.filter(item => item.at < total);
    under.forEach((item, j) => {
      const probe = probes.get(item.source);
      if (!probe.audio) throw Object.assign(new Error(`${probe.file} has no sound, so it cannot go on the audio track.`), { status: 422 });
      const k = input(item, probe.path);
      const delay = Math.round(item.at * 1000);
      filters.push(`[${k}:a:0]asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${item.volume},adelay=delays=${delay}:all=1[b${j}]`);
    });
    if (under.length) filters.push(`[aseq]${under.map((_, j) => `[b${j}]`).join('')}amix=inputs=${under.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`);
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', under.length ? '[aout]' : '[aseq]', '-t', String(total));
    if (tools.format === 'mp4') {
      const quality = tools.video === 'libx264' ? ['-preset', 'veryfast', '-crf', '22'] : ['-b:v', `${Math.round(W * H * fps / 10000)}k`];
      args.push('-c:v', tools.video, ...quality, '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-f', 'mp4', output);
    } else {
      args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '33', '-row-mt', '1', '-c:a', 'libopus', '-b:a', '128k', '-f', 'webm', output);
    }
    return { args, total, format: tools.format };
  }

  /** Renders a project into renders/; resolves to the new file's name. One render runs at a time. */
  async render(text, { onProgress = () => {}, signal } = {}) {
    if (this.rendering) throw Object.assign(new Error('A render is already running. Let it finish, or stop it, first.'), { status: 409 });
    const project = parseProject({ parseXml, escapeXml }, text, 'project');
    const tools = await this.#need();
    const base = (project.name || 'Untitled').replace(/[^\w .()-]+/g, '-').replace(/^[.\s-]+/, '').slice(0, 60).trim() || 'Untitled';
    const name = await this.store.unique(`renders/${base}.${tools.format}`);
    const part = await this.store.scratch(name);
    this.rendering = name;
    try {
      const { args, total } = await this.plan(project, part);
      let last = -1;
      let pending = '';
      const { code, stderr } = await run(this.ffmpeg, args, {
        signal,
        onStdout(chunk) {
          pending += chunk.toString();
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) {
            const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
            if (!match) continue;
            const done = Math.min(0.999, Number(match[1]) / 1e6 / total);
            if (done - last >= 0.01) { last = done; onProgress(done); }
          }
        }
      }).catch(error => {
        if (signal?.aborted) throw Object.assign(new Error('The render was stopped.'), { status: 499 });
        throw error;
      });
      if (signal?.aborted) throw Object.assign(new Error('The render was stopped.'), { status: 499 });
      if (code !== 0) throw Object.assign(new Error(`ffmpeg could not render: ${lastLine(stderr) || `it stopped with code ${code}`}`), { status: 422 });
      await rename(part, this.store.path(name));
      onProgress(1);
      return name;
    } finally {
      this.rendering = null;
      await rm(part, { force: true });
    }
  }
}

const servicesXml = (tools, root) => `<services>\n  <files root="${escapeXml(root)}"/>\n  <relay/>\n  ${tools.ffmpeg
  ? `<media ffmpeg="${escapeXml(tools.ffmpeg)}" video="${escapeXml(tools.video)}" format="${tools.format}"/>`
  : `<media missing="${escapeXml(tools.reason)}"/>`}\n</services>\n`;

/** GET /__pos/services: what this server gives, for the providers' status. */
export async function serveServices(media, response, send) {
  return send(response, 200, 'application/xml; charset=utf-8', servicesXml(await media.tools(), media.store.root));
}

/** Answers one /__pos/media request. */
export async function serveMedia(media, request, response, path, query, send, readBody) {
  const verb = path.slice(MEDIA_PATH.length + 1);
  const text = (status, message) => send(response, status, 'text/plain; charset=utf-8', `${message}\n`);
  try {
    if (verb === 'render') {
      if (request.method !== 'POST') return text(405, 'Method not allowed');
      const body = await readBody(request, PROJECT_LIMIT);
      if (body === null) return text(413, 'This project is too large.');
      const stop = new AbortController();
      response.on('close', () => { if (!response.writableFinished) stop.abort(); });
      // Checks that can fail fast answer with a status; after that, progress streams.
      await media.tools();
      if (media.rendering) return text(409, 'A render is already running. Let it finish, or stop it, first.');
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      try {
        const name = await media.render(body, { signal: stop.signal, onProgress: done => response.write(`progress ${done.toFixed(3)}\n`) });
        response.end(`done ${name}\n`);
      } catch (error) {
        response.end(`error ${String(error.message).replace(/\n/g, ' ')}\n`);
      }
      return;
    }
    if (request.method !== 'GET') return text(405, 'Method not allowed');
    const name = query.get('name') ?? '';
    if (verb === 'probe') {
      const probe = await media.probe(name);
      const video = probe.video ? `\n  <video width="${probe.video.width}" height="${probe.video.height}" fps="${probe.video.fps}" codec="${escapeXml(probe.video.codec ?? '')}"/>` : '';
      const audio = probe.audio ? `\n  <audio rate="${probe.audio.rate}" channels="${probe.audio.channels}" codec="${escapeXml(probe.audio.codec ?? '')}"/>` : '';
      return send(response, 200, 'application/xml; charset=utf-8', `<probe name="${escapeXml(fileName(name))}" duration="${probe.duration}">${video}${audio}\n</probe>\n`);
    }
    if (verb === 'frame') {
      const frame = await media.frame(name, Number(query.get('t')), Number(query.get('w') ?? 160));
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': frame.data.length, 'X-Pea-Width': frame.width, 'X-Pea-Height': frame.height, 'Cache-Control': 'no-store' });
      return response.end(frame.data);
    }
    if (verb === 'peaks') {
      const peaks = await media.peaks(name, Number(query.get('n') ?? 200));
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': peaks.length, 'Cache-Control': 'no-store' });
      return response.end(peaks);
    }
    return text(404, `There is no media verb "${verb}".`);
  } catch (error) {
    if (response.headersSent) return response.end();
    if (error.status || error.name === 'XmlError' || /file name Pea can keep/.test(error.message)) return text(error.status ?? 400, error.message);
    throw error;
  }
}
