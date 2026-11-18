/**
 * The NativeScript platform (Android, iOS).
 *
 * STATUS: a written-to-the-contract adapter that has not yet been run on a
 * device. It imports packages that exist only inside a NativeScript project,
 * which is built in Docker and never installed on the host. See README.md.
 *
 * Usage, from a page whose XML holds a <canvas:Canvas ready="onReady"/>:
 *
 *   import { start } from './pos/src/platform/nativescript.js';
 *   import * as calc from './pos/res/apps/calc.js';
 *   export const onReady = args => start(args.object, {
 *     'res/apps/calc.js': calc      // app scripts are bundled, so list them here
 *   });
 */
import '@nativescript/canvas-polyfill';
import * as PIXI from 'pixi.js';
import { ApplicationSettings, Screen, Utils, knownFolders } from '@nativescript/core';
import { DisposableScope } from '../core/reactive.js';
import { boot } from '../os/kernel.js';
import { androidPlayer, deviceFiles, pickFiles } from './nativescript-media.js';
import { nativeNetwork } from './network.js';

function attach(canvas, stage) {
  const scope = new DisposableScope();
  const scale = Screen.mainScreen.scale;

  const measure = () => {
    const { width, height } = canvas.getActualSize();
    stage.resize(width * scale, height * scale, scale);
  };
  canvas.on('layoutChanged', measure);
  scope.add(() => canvas.off('layoutChanged', measure));
  measure();

  const types = { down: 'down', move: 'move', up: 'up', cancel: 'cancel' };
  const touch = event => {
    const type = types[event.action];
    if (type) stage.pointer.emit(type, stage.toLogical(event.getX() * scale, event.getY() * scale));
  };
  canvas.on('touch', touch);
  scope.add(() => canvas.off('touch', touch));
  return scope;
}

export function start(canvas, modules = {}, options = {}) {
  const app = knownFolders.currentApp();
  return boot({
    name: 'nativescript',
    capabilities: { webgpu: false },
    PIXI,
    canvas,
    options,
    readText: path => app.getFile(`pos/${path}`).readText(),
    async importModule(path) {
      if (!modules[path]) throw new Error(`App script "${path}" was not bundled; pass it to start()`);
      return modules[path];
    },
    storage: {
      get: key => ApplicationSettings.getString(key, null),
      set: (key, value) => ApplicationSettings.setString(key, value),
      remove: key => ApplicationSettings.remove(key)
    },
    attach: stage => attach(canvas, stage),
    // Files live in the app's own folder, sound plays through Android's media service, and requests go straight out.
    providers: [deviceFiles(), androidPlayer(), nativeNetwork(fetch)],
    pickFiles,
    openUrl: url => Utils.openUrl(url)
  });
}
