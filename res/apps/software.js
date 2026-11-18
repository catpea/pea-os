import { CATEGORIES } from '../../src/os/app.js';

/**
 * Software: what is installed, and who provides what.
 *
 * Apps all ship inside Pea OS, so installing one only shows it again;
 * nothing is downloaded. Each app's page says which services it requires or
 * uses, and who gives each one here.
 *
 * Providers is one tree of every service: under each, every provider Pea OS
 * knows of, in the order they are tried, with what it requires in turn. A
 * provider that cannot work here says plainly why, and can be turned on or
 * off.
 */
export default function software(app) {
  const { os } = app;
  const { apps, providers } = app.refs;
  const appId = app.signal('app-id');
  const entry = app.signal('entry');
  const services = os.providers.services;
  /** What each row of the tree stands for, by its value. */
  let rows = new Map();

  const lower = text => text.charAt(0).toLowerCase() + text.slice(1);
  const list = words => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

  // ---- Apps -------------------------------------------------------------------

  function listApps() {
    apps.items = [...os.apps.values()]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(definition => {
        const missing = os.software.missing(definition.id);
        const state = missing.length ? `Needs ${list(missing.map(need => lower(need.title)))}` : os.software.installed(definition.id) ? 'Installed' : 'Not installed';
        return { value: definition.id, text: definition.title, detail: `${state} · ${CATEGORIES[definition.category]}${os.software.keep.has(definition.id) ? ' · part of Pea OS' : ''}` };
      });
    if (!appId.value) appId.set(apps.items[0]?.value ?? '');
    showApp();
  }

  function showApp() {
    const definition = os.apps.get(appId.value);
    if (!definition) return;
    const installed = os.software.installed(definition.id);
    const kept = os.software.keep.has(definition.id);
    const missing = os.software.missing(definition.id);
    const removed = os.software.removed.value.includes(definition.id);
    const needs = os.software.needs(definition.id).map(need =>
      `${need.required ? 'Needs' : 'Uses'} ${lower(need.title)}: ${need.provider ?? 'nothing here gives it'}.`);
    const about = missing.length
      ? `See Providers for how to get ${lower(list(missing.map(need => need.title)))}.`
      : kept ? 'Part of Pea OS: it always stays.' : installed ? 'Removing it hides it from the desktop and Start; its documents stay.' : 'Installing it puts it back on the desktop and in Start.';
    app.signal('app-title').set(definition.title);
    app.signal('app-about').set([`${definition.summary || CATEGORIES[definition.category]}.`, ...needs, about].join(' '));
    app.signal('app-action').set(installed || (missing.length && !removed) ? 'Remove' : 'Install');
    app.signal('app-can').set(!kept && !(missing.length && removed));
  }

  app.scope.subscribe(os.software.changed, listApps);
  app.scope.subscribe(appId, showApp, { immediate: false });
  app.command('toggle-app', () => {
    const id = appId.value;
    try { os.software.install(id, os.software.removed.value.includes(id)); }
    catch (error) { app.report(error); }
  });
  app.command('open-app', () => os.open(appId.value));

  // ---- Providers --------------------------------------------------------------

  /** One word or two for a provider's state, and the mark beside it. */
  function state(provider, inUse) {
    if (inUse) return { word: 'In use', mark: 'mark-on' };
    if (provider.ok) return { word: 'Ready', mark: 'mark-ready' };
    if (provider.setup) return { word: 'Can be set up', mark: 'mark-ready' };
    if (!provider.installed && provider.ready) return { word: 'Turned off', mark: 'mark-off' };
    const missing = provider.requires.filter(need => !need.met);
    if (missing.length) return { word: `Needs ${list(missing.map(need => lower(need.title)))}`, mark: 'mark-warn' };
    return { word: provider.reason.split(':')[0], mark: provider.placeholder ? 'mark-off' : 'mark-warn' };
  }

  function serviceRow(name, set, depth, value = `service:${name}`, text = set.title) {
    const current = set.providers.get(set.current.value);
    return { value, text, depth, detail: current ? current.title : 'Nothing here gives it', sprite: current ? 'mark-on' : 'mark-warn', kind: 'service', service: name };
  }

  let surveys = 0;
  async function refresh() {
    const mine = ++surveys;
    const answers = await Promise.all(Object.entries(services).map(async ([name, set]) => [name, set, await set.survey()]));
    // Surveys can finish out of order; only the newest one describes things as they are.
    if (app.scope.disposed || mine !== surveys) return;
    const items = [];
    for (const [name, set, survey] of answers) {
      items.push(serviceRow(name, set, 0));
      const order = set.settings.value.order;
      survey.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      for (const provider of survey) {
        const { word, mark } = state(provider, set.current.value === provider.id);
        items.push({ value: `provider:${name}:${provider.id}`, text: provider.title, detail: word, sprite: mark, depth: 1, kind: 'provider', service: name, provider });
        for (const need of provider.requires) {
          items.push(serviceRow(need.service, services[need.service], 2, `needs:${name}:${provider.id}:${need.service}`, `Requires ${lower(need.title)}`));
        }
      }
    }
    rows = new Map(items.map(item => [item.value, item]));
    providers.items = items;
    if (!rows.has(entry.value)) entry.set(items[0]?.value ?? '');
    show();
  }

  /** Who depends on a service: the apps that declare it and the providers that require it. */
  function dependents(name) {
    const definitions = [...os.apps.values()];
    const by = attr => definitions.filter(definition => definition[attr].includes(name)).map(definition => definition.title);
    const requiring = Object.values(services).flatMap(set => [...set.providers.values()]
      .filter(provider => provider.requires?.includes(name)).map(provider => provider.title));
    return [
      by('requires').length && `Required by ${list(by('requires'))}.`,
      by('uses').length && `Used by ${list(by('uses'))}.`,
      requiring.length && `${list(requiring)} ${requiring.length > 1 ? 'require' : 'requires'} it.`
    ].filter(Boolean).join(' ');
  }

  let shows = 0;
  async function show() {
    const row = rows.get(entry.value);
    if (!row) return;
    const mine = ++shows;
    const set = services[row.service];
    if (row.kind === 'service') {
      const current = set.providers.get(set.current.value);
      const why = current ? '' : await set.why();
      if (app.scope.disposed || mine !== shows) return;
      app.signal('entry-title').set(set.title);
      app.signal('entry-state').set(current ? `Given by ${current.title}.` : `Nothing here gives ${lower(set.title)}. ${why}`);
      app.signal('entry-about').set(dependents(row.service) || 'Nothing depends on it yet.');
      app.signal('entry-action').set('Install');
      app.signal('entry-can').set(false);
      app.signal('has-home').set(false);
      return;
    }
    const { provider } = row;
    const catalog = os.providers.catalog.get(provider.id);
    app.signal('entry-title').set(provider.title);
    app.signal('entry-state').set(provider.ok ? `Ready. ${provider.reason}` : !provider.ready ? provider.reason : 'Not installed. Install it to use it.');
    app.signal('entry-about').set([provider.about, catalog && `By ${catalog.by}. Licence: ${catalog.license}.`, catalog && `Needs: ${catalog.needs}`].filter(Boolean).join('\n'));
    // A provider that cannot work here cannot be installed; one only waiting for setup or a download can.
    const possible = provider.ready || provider.setup || /^Not set up/.test(provider.reason);
    app.signal('entry-action').set(provider.setup ? 'Install' : provider.installed ? 'Remove' : 'Install');
    app.signal('entry-can').set(provider.id !== set.always && !provider.placeholder && (provider.installed || possible));
    app.signal('has-home').set(Boolean(catalog?.home));
  }

  // Any service's choices, changes, or provider in use bring the tree up to date.
  for (const set of Object.values(services)) {
    for (const signal of [set.settings, set.changed, set.current]) app.scope.subscribe(signal, () => refresh(), { immediate: false });
  }
  refresh();
  app.scope.subscribe(entry, show, { immediate: false });
  app.command('toggle-provider', () => {
    const row = rows.get(entry.value);
    if (row?.kind !== 'provider') return;
    const set = services[row.service];
    const { id, setup } = row.provider;
    // A provider that must be fetched first (the browser's model) is set up by its own maker, not by Pea OS.
    if (setup) { set.setup(id).catch(error => app.report(error)); return; }
    try { set.install(id, !set.installed(id)); }
    catch (error) { app.report(error); }
  });
  app.command('provider-home', () => {
    const row = rows.get(entry.value);
    const home = row?.provider && os.providers.catalog.get(row.provider.id)?.home;
    if (home) app.openUrl(home);
  });
  app.command('survey', () => os.providers.refresh().then(refresh));
}
