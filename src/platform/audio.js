import { Signal, EventEmitter } from '../core/reactive.js';

/**
 * The web-audio provider: the browser's own media player (an HTML audio
 * element) with the Media Session API, so playback shows on the lock screen
 * and in the notification shade, and answers media keys and headsets.
 *
 * It is careful where it runs. On a phone, sound goes straight from the media
 * element to the system, never through Web Audio: Android keeps an ordinary
 * media element playing with the screen off, under its media notification,
 * while sound routed through an AudioContext can be suspended in the
 * background. So the spectrum (an AnalyserNode) is a desktop nicety only.
 * Where the browser has the Audio Session API (Safari), the session is marked
 * "playback", as a music player's should be.
 *
 * env: { createAudio, AudioContext, mediaSession, audioSession, mobile, now }
 * comes from the browser; tests pass stand-ins.
 */
export function webAudio(env) {
  const { createAudio, AudioContext, mediaSession, audioSession, mobile = false, now = () => performance.now() } = env;
  /** The player that last started playing owns the lock-screen controls. */
  let owner = null;

  function player() {
    const element = createAudio();
    element.preload = 'auto';
    const state = new Signal({ status: 'empty', position: 0, at: now(), duration: 0, error: '' });
    const remote = new EventEmitter();
    let meta = {};
    let graph = null;
    let bins = null;
    const finite = value => (Number.isFinite(value) ? value : 0);
    const publish = patch => state.set({ ...state.value, position: finite(element.currentTime), at: now(), duration: finite(element.duration), ...patch });

    function session() {
      if (!mediaSession || owner !== api) return;
      const { status, duration, position } = state.value;
      mediaSession.playbackState = status === 'playing' ? 'playing' : status === 'empty' ? 'none' : 'paused';
      try {
        if (duration > 0) mediaSession.setPositionState({ duration, position: Math.min(duration, position), playbackRate: element.playbackRate || 1 });
      } catch { /* Some browsers refuse a position state while loading. */ }
    }

    function claim() {
      if (!mediaSession || owner === api) return;
      owner = api;
      const actions = {
        play: () => api.play(),
        pause: () => api.pause(),
        stop: () => api.stop(),
        previoustrack: () => remote.emit('previous'),
        nexttrack: () => remote.emit('next'),
        seekto: details => api.seek(details.seekTime),
        seekbackward: details => api.seek(element.currentTime - (details.seekOffset || 10)),
        seekforward: details => api.seek(element.currentTime + (details.seekOffset || 10))
      };
      for (const [action, handler] of Object.entries(actions)) {
        try { mediaSession.setActionHandler(action, handler); } catch { /* not every action exists everywhere */ }
      }
      describe();
    }

    function describe() {
      if (!mediaSession || owner !== api || !globalThis.MediaMetadata) return;
      mediaSession.metadata = new globalThis.MediaMetadata({ title: meta.title ?? '', artist: meta.artist ?? '', album: meta.album ?? 'Pea OS' });
    }

    const events = {
      playing: () => { claim(); publish({ status: 'playing', error: '' }); },
      pause: () => { if (!element.ended) publish({ status: 'paused' }); },
      ended: () => publish({ status: 'ended' }),
      waiting: () => { if (!element.paused) publish({ status: 'loading' }); },
      canplay: () => { if (state.value.status === 'loading') publish({ status: element.paused ? 'paused' : 'playing' }); },
      seeked: () => publish({}),
      durationchange: () => publish({}),
      ratechange: () => publish({}),
      error: () => {
        const codes = { 1: 'loading was stopped', 2: 'the network failed', 3: 'the file is damaged', 4: 'this browser cannot play this kind of file' };
        publish({ status: 'error', error: `This could not be played: ${codes[element.error?.code] ?? 'unknown error'}.` });
      }
    };
    for (const [type, listener] of Object.entries(events)) element.addEventListener(type, listener);
    const stopSession = state.subscribe(session, { immediate: false });

    // The analyser is built on the first press of Play, when the browser allows sound.
    function analyse() {
      if (graph || mobile || !AudioContext) return;
      try {
        const context = new AudioContext();
        const source = context.createMediaElementSource(element);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.7;
        source.connect(analyser);
        analyser.connect(context.destination);
        graph = { context, source, analyser };
        bins = new Uint8Array(analyser.frequencyBinCount);
      } catch { graph = false; }
    }

    const api = {
      state,
      remote,
      now,
      load({ url, title = '', artist = '', album = '' }) {
        meta = { title, artist, album };
        element.src = url;
        element.load();
        publish({ status: 'loading', position: 0, duration: 0, error: '' });
        describe();
      },
      play() {
        if (state.value.status === 'empty') return;
        analyse();
        if (graph?.context.state === 'suspended') graph.context.resume().catch(() => {});
        element.play()?.catch?.(error => {
          if (error.name === 'AbortError') return; // a newer load or pause replaced this play
          publish({ status: 'paused', error: error.name === 'NotAllowedError' ? 'Press Play to start the sound.' : error.message });
        });
      },
      pause() { element.pause(); },
      stop() {
        element.pause();
        if (state.value.status !== 'empty') element.currentTime = 0;
        publish({ status: state.value.status === 'empty' ? 'empty' : 'paused', position: 0 });
      },
      seek(seconds) {
        const duration = finite(element.duration);
        element.currentTime = Math.max(0, duration ? Math.min(duration, seconds) : seconds);
        publish({ position: finite(element.currentTime) });
      },
      volume(level) { element.volume = Math.max(0, Math.min(1, level)); },
      /** Fills `out` with loudness per band, low to high; false where there is no analyser. */
      spectrum(out) {
        if (!graph || state.value.status !== 'playing') return false;
        graph.analyser.getByteFrequencyData(bins);
        // Bands widen with pitch, as hearing does.
        const usable = Math.floor(bins.length * 0.75);
        for (let i = 0; i < out.length; i++) {
          const from = Math.floor(usable * (2 ** (i / out.length * 7) - 1) / 127);
          const to = Math.max(from + 1, Math.floor(usable * (2 ** ((i + 1) / out.length * 7) - 1) / 127));
          let peak = 0;
          for (let j = from; j < to && j < bins.length; j++) peak = Math.max(peak, bins[j]);
          out[i] = peak;
        }
        return true;
      },
      dispose() {
        stopSession();
        for (const [type, listener] of Object.entries(events)) element.removeEventListener(type, listener);
        element.pause();
        element.removeAttribute('src');
        element.load();
        if (graph) graph.context.close().catch(() => {});
        if (owner === api) {
          owner = null;
          for (const action of ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward']) {
            try { mediaSession.setActionHandler(action, null); } catch { /* not every action exists */ }
          }
          mediaSession.metadata = null;
          mediaSession.playbackState = 'none';
        }
        remote.dispose();
        state.dispose();
      }
    };
    return api;
  }

  return {
    service: 'audio',
    id: 'web-audio',
    title: 'Browser audio',
    kind: 'browser',
    about: 'Plays through the browser\'s own media player, which shows on the lock screen and answers media keys and headsets.',
    async status() {
      if (!createAudio) return { ok: false, reason: 'Not available: this browser has no audio element.' };
      if (audioSession) {
        try { audioSession.type = 'playback'; } catch { /* only a hint */ }
      }
      return {
        ok: true,
        reason: mobile
          ? 'Plays through the phone\'s media player, so it keeps going with the screen off. The spectrum is left out on phones to keep it that way.'
          : `Plays in this browser${mediaSession ? ', with media keys and system controls' : ''}.`
      };
    },
    player
  };
}
