/**
 * NativeScript providers: phone storage, choosing files, and Android's own
 * media player.
 *
 * STATUS: written to the contract and to Android's documented APIs, but not
 * yet run on a device, like the rest of the NativeScript adapter.
 *
 * The player is what keeps music going with the screen off. Android stops
 * an app it thinks is idle, so playback runs the way Android asks music
 * players to:
 *   - android.media.MediaPlayer with USAGE_MEDIA attributes and a partial
 *     wake lock (setWakeMode), so the CPU stays up while it plays;
 *   - a foreground service of type mediaPlayback, started on Play, with a
 *     media notification, so Android does not stop the app in the background;
 *   - a MediaSession, so the lock screen, headsets, cars and watches can
 *     control it;
 *   - audio focus, pausing for calls and ducking for navigation prompts, and
 *     pausing when headphones are pulled out (AUDIO_BECOMING_NOISY).
 *
 * The app's AndroidManifest.xml must declare, inside <manifest>:
 *   <uses-permission android:name="android.permission.WAKE_LOCK"/>
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
 *   <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"/>
 *   <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
 * and inside <application>:
 *   <service android:name="org.peaos.PlaybackService" android:exported="false"
 *            android:foregroundServiceType="mediaPlayback"/>
 */
import { Application, File, Folder, Utils, isAndroid, knownFolders, path as paths } from '@nativescript/core';
import { Signal, EventEmitter } from '../core/reactive.js';
import { fileName, typeOf } from '../os/files.js';

const NOTIFICATION = 7301;
const CHANNEL = 'pea-os-player';

/** The player that last started owns the service's notification. */
let playing = null;

// The foreground service holds no state: it shows the playing player's notification.
// Its class is generated at build time from this call, by NativeScript's binding generator.
const PlaybackService = isAndroid ? android.app.Service.extend('org.peaos.PlaybackService', {
  onStartCommand() {
    const notification = playing?.notification();
    if (notification) {
      if (android.os.Build.VERSION.SDK_INT >= 29) this.startForeground(NOTIFICATION, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
      else this.startForeground(NOTIFICATION, notification);
    } else this.stopSelf();
    return android.app.Service.START_NOT_STICKY;
  },
  onBind() { return null; }
}) : null;

const context = () => Utils.android.getApplicationContext();

/** Copies a Java InputStream into a file, in 64 KB steps. */
function copyStream(input, target) {
  const output = new java.io.FileOutputStream(target);
  try {
    const buffer = Array.create('byte', 65536);
    for (let n = input.read(buffer); n > 0; n = input.read(buffer)) output.write(buffer, 0, n);
  } finally {
    output.close();
    input.close();
  }
}

/** Phone storage: Pea OS's own folder in the app's documents. */
export function deviceFiles() {
  const root = () => knownFolders.documents().getFolder('pea-files');
  const where = name => paths.join(root().path, ...fileName(name).split('/'));
  const entry = (file, name) => ({ name, size: file.size, type: typeOf(name), modified: file.lastModified.getTime() });
  return {
    service: 'files',
    id: 'device-files',
    title: 'Phone storage',
    kind: 'device',
    about: 'Keeps files in Pea OS\'s own folder on the phone or tablet.',
    async status() { return { ok: true, reason: `Files are kept in ${root().path}.` }; },
    async list(folder = '') {
      const found = [];
      const add = async (prefix, place) => {
        for (const item of await place.getEntities()) {
          if (item.name.startsWith('.')) continue;
          const name = prefix ? `${prefix}/${item.name}` : item.name;
          if (Folder.exists(item.path) && !prefix) await add(name, Folder.fromPath(item.path));
          else if (File.exists(item.path) && !Folder.exists(item.path)) found.push(entry(File.fromPath(item.path), name));
        }
      };
      await add(folder ? fileName(folder) : '', folder ? root().getFolder(fileName(folder)) : root());
      return found.sort((a, b) => a.name.localeCompare(b.name));
    },
    async read(name) {
      return new Uint8Array(await File.fromPath(where(name)).read());
    },
    async write(name, data) {
      const target = where(name);
      Folder.fromPath(target.slice(0, target.lastIndexOf('/'))); // makes the folder when it is missing
      if (data?.copyTo) await data.copyTo(target);
      else {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
        const native = Array.create('byte', bytes.length);
        for (let i = 0; i < bytes.length; i++) native[i] = bytes[i] << 24 >> 24;
        await File.fromPath(target).write(native);
      }
      return { name: fileName(name), size: File.fromPath(target).size };
    },
    async remove(name) {
      if (File.exists(where(name))) await File.fromPath(where(name)).remove();
    },
    async source(name) {
      return { url: where(name), release() {} };
    }
  };
}

/**
 * Lets the user choose files through Android's document picker. Each one is
 * Blob-like: { name, type, size, data: { arrayBuffer(), copyTo(path) } }, so
 * phone storage copies it straight to disk without holding it in memory.
 */
export function pickFiles(accept = '', { multiple = false } = {}) {
  if (!isAndroid) return Promise.reject(new Error('Choosing files is not built for this device yet.'));
  const Intent = android.content.Intent;
  const intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
  intent.addCategory(Intent.CATEGORY_OPENABLE);
  const types = accept.split(',').map(item => item.trim()).filter(item => item.includes('/'));
  intent.setType(types.length === 1 ? types[0] : '*/*');
  if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
  intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
  const code = 7302;
  return new Promise(resolve => {
    const done = args => {
      if (args.requestCode !== code) return;
      Application.android.off('activityResult', done);
      if (args.resultCode !== android.app.Activity.RESULT_OK || !args.intent) { resolve([]); return; }
      const resolver = context().getContentResolver();
      const uris = [];
      const clip = args.intent.getClipData();
      if (clip) for (let i = 0; i < clip.getItemCount(); i++) uris.push(clip.getItemAt(i).getUri());
      else if (args.intent.getData()) uris.push(args.intent.getData());
      resolve(uris.map(uri => {
        let name = String(uri.getLastPathSegment() ?? 'file');
        let size = 0;
        const cursor = resolver.query(uri, null, null, null, null);
        if (cursor?.moveToFirst()) {
          name = cursor.getString(cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)) ?? name;
          size = Number(cursor.getLong(cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)));
        }
        cursor?.close();
        const data = {
          size,
          type: resolver.getType(uri) ?? typeOf(name),
          async copyTo(target) { copyStream(resolver.openInputStream(uri), new java.io.File(target)); },
          async arrayBuffer() {
            const scratch = paths.join(knownFolders.temp().path, `pick-${Date.now()}`);
            await data.copyTo(scratch);
            const bytes = await File.fromPath(scratch).read();
            await File.fromPath(scratch).remove();
            return new Uint8Array(bytes).buffer;
          }
        };
        return { name: name.replace(/[/\\]/g, '-'), type: data.type, size, data };
      }));
    };
    Application.android.on('activityResult', done);
    Application.android.foregroundActivity.startActivityForResult(intent, code);
  });
}

/** Android's media player, kept awake by a foreground media service. */
export function androidPlayer() {
  function player() {
    const ctx = context();
    const now = () => android.os.SystemClock.elapsedRealtime();
    const state = new Signal({ status: 'empty', position: 0, at: now(), duration: 0, error: '' });
    const remote = new EventEmitter();
    const AudioAttributes = android.media.AudioAttributes;
    const AudioManager = android.media.AudioManager;
    const PlaybackState = android.media.session.PlaybackState;
    const attributes = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
    const media = new android.media.MediaPlayer();
    media.setAudioAttributes(attributes);
    media.setWakeMode(ctx, android.os.PowerManager.PARTIAL_WAKE_LOCK);
    let meta = {};
    let level = 1;
    let prepared = false;
    let resumeAfterLoss = false;

    const position = () => (prepared ? media.getCurrentPosition() / 1000 : 0);
    const publish = patch => state.set({ ...state.value, position: position(), at: now(), ...patch });

    // ---- The media session: lock screen, notification, headset buttons ----
    const session = new android.media.session.MediaSession(ctx, 'PeaOS');
    const Callback = android.media.session.MediaSession.Callback.extend({
      onPlay: () => api.play(),
      onPause: () => api.pause(),
      onStop: () => api.stop(),
      onSkipToNext: () => remote.emit('next'),
      onSkipToPrevious: () => remote.emit('previous'),
      onSeekTo: ms => api.seek(Number(ms) / 1000)
    });
    session.setCallback(new Callback());
    function describe() {
      const { status, duration } = state.value;
      const actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP
        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_SEEK_TO;
      const code = { playing: PlaybackState.STATE_PLAYING, loading: PlaybackState.STATE_BUFFERING, error: PlaybackState.STATE_ERROR, empty: PlaybackState.STATE_NONE }[status] ?? PlaybackState.STATE_PAUSED;
      session.setPlaybackState(new PlaybackState.Builder().setActions(actions).setState(code, Math.round(position() * 1000), status === 'playing' ? 1 : 0).build());
      const MediaMetadata = android.media.MediaMetadata;
      session.setMetadata(new MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, meta.title ?? '')
        .putString(MediaMetadata.METADATA_KEY_ARTIST, meta.artist ?? '')
        .putLong(MediaMetadata.METADATA_KEY_DURATION, Math.round(duration * 1000))
        .build());
      if (playing === api) context().getSystemService(android.content.Context.NOTIFICATION_SERVICE).notify(NOTIFICATION, api.notification());
    }
    const stopDescribing = state.subscribe(describe, { immediate: false });

    // ---- Audio focus and noisy headphones ----
    const audio = ctx.getSystemService(android.content.Context.AUDIO_SERVICE);
    const focus = new android.media.AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
      .setAudioAttributes(attributes)
      .setOnAudioFocusChangeListener(new AudioManager.OnAudioFocusChangeListener({
        onAudioFocusChange(change) {
          if (change === AudioManager.AUDIOFOCUS_LOSS) { resumeAfterLoss = false; api.pause(); }
          else if (change === AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) { resumeAfterLoss = state.value.status === 'playing'; api.pause(); }
          else if (change === AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) media.setVolume(level * 0.2, level * 0.2);
          else if (change === AudioManager.AUDIOFOCUS_GAIN) {
            media.setVolume(level, level);
            if (resumeAfterLoss) { resumeAfterLoss = false; api.play(); }
          }
        }
      })).build();
    const noisy = () => api.pause();
    Application.android.registerBroadcastReceiver(AudioManager.ACTION_AUDIO_BECOMING_NOISY, noisy);

    media.setOnPreparedListener(new android.media.MediaPlayer.OnPreparedListener({
      onPrepared: () => { prepared = true; publish({ status: 'paused', duration: media.getDuration() / 1000 }); }
    }));
    media.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener({
      onCompletion: () => { publish({ status: 'ended', position: state.value.duration }); release(); }
    }));
    media.setOnSeekCompleteListener(new android.media.MediaPlayer.OnSeekCompleteListener({ onSeekComplete: () => publish({}) }));
    media.setOnErrorListener(new android.media.MediaPlayer.OnErrorListener({
      onError: (_, what) => { prepared = false; publish({ status: 'error', error: `Android could not play this (error ${what}).` }); release(); return true; }
    }));

    /** Lets Android stop the service once nothing plays; the notification stays until then. */
    function release() {
      if (playing !== api) return;
      playing = null;
      ctx.stopService(new android.content.Intent(ctx, PlaybackService.class));
      audio.abandonAudioFocusRequest(focus);
    }

    const api = {
      state,
      remote,
      now,
      notification() {
        const manager = ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        if (android.os.Build.VERSION.SDK_INT >= 26 && !manager.getNotificationChannel(CHANNEL)) {
          manager.createNotificationChannel(new android.app.NotificationChannel(CHANNEL, 'Music', android.app.NotificationManager.IMPORTANCE_LOW));
        }
        const launch = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        return new android.app.Notification.Builder(ctx, CHANNEL)
          .setSmallIcon(ctx.getApplicationInfo().icon)
          .setContentTitle(meta.title || 'Pea OS')
          .setContentText(meta.artist ?? '')
          .setOngoing(state.value.status === 'playing')
          .setContentIntent(android.app.PendingIntent.getActivity(ctx, 0, launch, android.app.PendingIntent.FLAG_IMMUTABLE))
          .setStyle(new android.app.Notification.MediaStyle().setMediaSession(session.getSessionToken()))
          .build();
      },
      load({ url, title = '', artist = '' }) {
        meta = { title, artist };
        prepared = false;
        media.reset();
        media.setAudioAttributes(attributes);
        try {
          media.setDataSource(url);
          media.prepareAsync();
          publish({ status: 'loading', position: 0, duration: 0, error: '' });
        } catch (error) {
          publish({ status: 'error', error: `Android could not open this: ${error.message}` });
        }
      },
      play() {
        if (!prepared) return;
        if (audio.requestAudioFocus(focus) !== AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return;
        session.setActive(true);
        playing = api;
        // Started before the sound, so Android knows a media service is running.
        ctx.startForegroundService(new android.content.Intent(ctx, PlaybackService.class));
        media.start();
        publish({ status: 'playing', error: '' });
      },
      pause() {
        if (prepared && media.isPlaying()) media.pause();
        if (state.value.status === 'playing') publish({ status: 'paused' });
        release();
      },
      stop() {
        if (prepared) { media.pause(); media.seekTo(0); }
        publish({ status: prepared ? 'paused' : state.value.status, position: 0 });
        release();
      },
      seek(seconds) {
        if (prepared) media.seekTo(Math.round(Math.max(0, Math.min(state.value.duration, seconds)) * 1000));
      },
      volume(value) {
        level = Math.max(0, Math.min(1, value));
        media.setVolume(level, level);
      },
      // Android's Visualizer needs the microphone permission; a music player should not ask for it.
      spectrum() { return false; },
      dispose() {
        release();
        stopDescribing();
        Application.android.unregisterBroadcastReceiver(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        media.release();
        session.setActive(false);
        session.release();
        remote.dispose();
        state.dispose();
      }
    };
    return api;
  }

  return {
    service: 'audio',
    id: 'android-player',
    title: 'Android media player',
    kind: 'device',
    about: 'Plays through Android\'s media player in a foreground media service, so Android does not put it to sleep, with lock-screen controls.',
    async status() {
      if (!isAndroid) return { ok: false, reason: 'Not built yet: on iOS, Pea OS needs AVAudioSession and the Now Playing center.' };
      if (android.os.Build.VERSION.SDK_INT < 26) return { ok: false, reason: 'Incompatible: needs Android 8 or newer.' };
      return { ok: true, reason: 'Plays in a media service, with lock-screen and headset controls.' };
    },
    player
  };
}
