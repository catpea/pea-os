import { Signal, DisposableScope, persist } from '../core/reactive.js';

/**
 * Which apps are installed. Every app ships inside Pea OS, so installing
 * never fetches anything: removing an app hides it from the desktop and
 * Start and keeps its documents, and installing it shows it again. The
 * catalog, res/data/software.xml, names the apps that always stay.
 *
 * An app that requires a service (<app requires="media">) is installed only
 * where a provider gives that service: the video editor is there when
 * ffmpeg is, and leaves quietly when it is not. Services an app only uses
 * do not decide whether it is installed.
 */
export class Software {
  scope = new DisposableScope();
  /** Ids of removed apps, remembered between runs. */
  removed = new Signal([]);
  /** Counts up whenever what is installed may have changed: a removal, or a service coming or going. */
  changed = new Signal(0);

  constructor(os, catalog) {
    this.os = os;
    catalog.expect({ attrs: ['version'], children: ['keep', 'provider'] });
    this.keep = new Set(catalog.all('keep').map(item => {
      item.expect({ attrs: ['app'] });
      const id = item.need('app');
      if (!os.apps.has(id)) item.fail(`app="${id}" is not an app. Apps: ${[...os.apps.keys()].join(', ')}`);
      return id;
    }));
    const accept = value => Array.isArray(value) && value.length <= 200 && value.every(id => typeof id === 'string');
    this.scope.add(persist(this.removed, { key: 'pea-os.software', storage: os.platform.storage, accept, onError: error => os.report(error) }));
    this.removed.set(this.removed.value.filter(id => os.apps.has(id) && !this.keep.has(id)));
    const bump = () => this.changed.set(this.changed.value + 1);
    this.scope.subscribe(this.removed, bump, { immediate: false });
    const declared = new Set([...os.apps.values()].flatMap(app => [...app.requires, ...app.uses]));
    for (const service of declared) this.scope.subscribe(os.providers.service(service).current, bump, { immediate: false });
  }

  /**
   * The services an app declares and who gives each here:
   * [{ service, title, required, provider }], where provider is the title of
   * the one doing the work, or null when nothing here gives it.
   */
  needs(id) {
    const app = this.os.apps.get(id);
    if (!app) return [];
    return [...app.requires.map(service => [service, true]), ...app.uses.map(service => [service, false])].map(([service, required]) => {
      const set = this.os.providers.service(service);
      return { service, title: set.title, required, provider: set.providers.get(set.current.value)?.title ?? null };
    });
  }

  /** The services an app requires that nothing here gives. */
  missing(id) {
    return this.needs(id).filter(need => need.required && !need.provider);
  }

  installed(id) {
    return this.os.apps.has(id) && !this.removed.value.includes(id) && !this.missing(id).length;
  }

  /** Installs (shows) or removes (hides) an app. */
  install(id, on) {
    if (!this.os.apps.has(id)) throw new Error(`There is no app "${id}"`);
    const { title } = this.os.apps.get(id);
    if (!on && this.keep.has(id)) throw new Error(`${title} is part of Pea OS and always stays.`);
    const missing = this.missing(id);
    if (on && missing.length) throw new Error(`${title} needs ${missing.map(item => item.title.toLowerCase()).join(' and ')}, and nothing here gives ${missing.length > 1 ? 'them' : 'it'}. See Software › Providers.`);
    const others = this.removed.value.filter(other => other !== id);
    this.removed.set(on ? others : [...others, id]);
  }

  dispose() {
    this.scope.dispose();
  }
}
