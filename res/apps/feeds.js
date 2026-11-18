/**
 * Pea Feeds: an RSS and Atom reader.
 *
 * Subscriptions are an OPML document, the format every feed reader shares,
 * kept in preferences and exported or imported as a file. Articles fetched
 * from each feed are cached (bounded) so the reader opens with something to
 * read; which articles were read is remembered too. A feed address may also
 * be "pea:<data id>", a feed that ships inside Pea OS.
 *
 * Feeds come over the internet service and are fetched again when they
 * are older than a quarter of an hour: when the window opens, and on the
 * schedule service, which here runs while Pea OS is open. Refresh fetches
 * them all now. Where nothing gives the internet, the status line says why,
 * and the feeds that ship with Pea OS still work.
 */

const OPML_KEY = 'pea-os.feeds.opml';
const CACHE_KEY = 'pea-os.feeds.cache.v1';
const ALL = '*';
const ITEMS_PER_FEED = 40;
const TEXT_LIMIT = 2400;
const READ_LIMIT = 2000;
const STALE_MS = 15 * 60 * 1000;
const TIMEOUT_MS = 25000;
const MAX_FEEDS = 60;
const DEFAULT_FEEDS = [
  { title: 'Pea OS News', url: 'pea:pea-news' },
  { title: 'Hacker News', url: 'https://hnrss.org/frontpage' },
  { title: 'NASA Breaking News', url: 'https://www.nasa.gov/news-release/feed/' }
];

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ', deg: '°', times: '×', euro: '€', pound: '£' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED[name.toLowerCase()] ?? match;
  });
}

/** Readable plain text from a feed's HTML: paragraphs and line breaks kept, tags and scripts gone. */
export function htmlToText(html) {
  const text = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    // Only what looks like a tag goes; "2 < 3 and 5 > 4" is text.
    .replace(/<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(\s[^<>]*)?\/?>/gi, '');
  return decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const local = node => node.name.slice(node.name.indexOf(':') + 1).toLowerCase();
const child = (node, name) => node?.children.find(candidate => local(candidate) === name);
const children = (node, name) => node?.children.filter(candidate => local(candidate) === name) ?? [];
const textOf = (node, name) => child(node, name)?.text.trim() ?? '';

/** Atom's type="xhtml" content is markup inside the feed itself: its text, in order, with paragraphs kept. */
function xhtmlText(node) {
  const lead = node.text.slice(0, node.text.length - node.children.reduce((sum, item) => sum + item.tail.length, 0));
  const inner = node.children.map(item => {
    const name = local(item);
    const body = name === 'br' ? '\n' : name === 'li' ? `\n• ${xhtmlText(item)}` : xhtmlText(item);
    return (/^(p|div|h[1-6]|blockquote|pre|tr)$/.test(name) ? `${body}\n\n` : body) + item.tail;
  }).join('');
  return lead + inner;
}
// Escaped first, so htmlToText only tidies the spacing of text that was never HTML source.
const xhtmlContent = node => (node?.attrs.type === 'xhtml' ? htmlToText(xhtmlText(node).replace(/&/g, '&amp;').replace(/</g, '&lt;')) : '');

/** Reads RSS 2.0, RSS 1.0 (RDF) or Atom into { title, link, items: [{ id, title, link, date, author, text }] }. */
export function parseFeed(parseXml, text, source = 'feed') {
  const root = parseXml(text, source, { foreign: true });
  const kind = local(root);
  const items = [];
  let title = '';
  let link = '';
  if (kind === 'rss' || kind === 'rdf') {
    const channel = child(root, 'channel');
    if (!channel) throw new Error('This RSS document has no <channel>.');
    title = textOf(channel, 'title');
    link = textOf(channel, 'link');
    for (const item of [...children(channel, 'item'), ...children(root, 'item')]) {
      const body = textOf(item, 'encoded') || textOf(item, 'description');
      const itemLink = textOf(item, 'link') || (/^https?:/.test(textOf(item, 'guid')) ? textOf(item, 'guid') : '');
      items.push({
        id: textOf(item, 'guid') || item.attrs['rdf:about'] || itemLink || textOf(item, 'title'),
        title: htmlToText(textOf(item, 'title')) || 'Untitled',
        link: itemLink,
        date: Date.parse(textOf(item, 'pubdate') || textOf(item, 'date')) || 0,
        author: htmlToText(textOf(item, 'creator') || textOf(item, 'author')),
        text: htmlToText(body)
      });
    }
  } else if (kind === 'feed') {
    title = textOf(root, 'title');
    const pick = node => {
      const links = children(node, 'link');
      return (links.find(candidate => (candidate.attrs.rel ?? 'alternate') === 'alternate') ?? links[0])?.attrs.href ?? '';
    };
    link = pick(root);
    for (const entry of children(root, 'entry')) {
      items.push({
        id: textOf(entry, 'id') || pick(entry) || textOf(entry, 'title'),
        title: htmlToText(textOf(entry, 'title')) || 'Untitled',
        link: pick(entry),
        date: Date.parse(textOf(entry, 'published') || textOf(entry, 'updated')) || 0,
        author: htmlToText(textOf(child(entry, 'author'), 'name')),
        text: xhtmlContent(child(entry, 'content')) || htmlToText(textOf(entry, 'content') || textOf(entry, 'summary'))
      });
    }
  } else {
    throw new Error(`This is not a feed: its root element is <${root.name}>.`);
  }
  return { title: htmlToText(title), link, items };
}

/** A web page may announce its feed: <link rel="alternate" type="application/rss+xml" href="...">. */
export function discoverFeed(html, base) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attr = name => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
    if (/alternate/i.test(attr('rel') ?? '') && /(rss|atom)\+xml/i.test(attr('type') ?? '') && attr('href')) {
      try { return new URL(decodeEntities(attr('href')), base).href; } catch { /* try the next one */ }
    }
  }
  return null;
}

export function readOpml(parseXml, text) {
  const root = parseXml(text, 'OPML', { foreign: true });
  if (root.name !== 'opml') throw new Error('This is not an OPML file.');
  const feeds = [];
  const visit = node => {
    for (const outline of children(node, 'outline')) {
      const url = outline.attrs.xmlUrl ?? outline.attrs.xmlurl;
      if (url && !feeds.some(feed => feed.url === url)) feeds.push({ url, title: outline.attrs.title || outline.attrs.text || url });
      visit(outline);
    }
  };
  visit(child(root, 'body'));
  return feeds;
}

export function writeOpml(escapeXml, feeds) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head><title>Pea Feeds</title></head>',
    '  <body>',
    ...feeds.map(feed => `    <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.url)}"/>`),
    '  </body>',
    '</opml>',
    ''
  ].join('\n');
}

export function when(date, now = Date.now()) {
  if (!date) return '';
  const minutes = Math.round((now - date) / 60000);
  if (minutes < -5) return new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.round(minutes / 1440)} d ago`;
  return new Date(date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function feeds(app) {
  const storage = app.os.platform.storage;
  const { parseXml, escapeXml } = app.xml;
  const { feedList, itemList, more, article } = app.refs;
  const feed = app.signal('feed');
  const item = app.signal('item');
  const status = app.signal('status');

  let subscriptions = [];
  let cache = {};             // url -> { title, fetched, error, items }
  let read = new Set();       // "url|id"
  let shown = [];             // the articles of the selected feed, newest first
  let refreshing = false;
  let saveProblem = '';
  let offline = '';           // why the internet cannot be reached here, or ''
  const network = app.service('network');

  // ---- What is remembered -----------------------------------------------------

  try { subscriptions = storage.get(OPML_KEY) ? readOpml(parseXml, storage.get(OPML_KEY)) : DEFAULT_FEEDS.slice(); }
  catch { subscriptions = DEFAULT_FEEDS.slice(); }
  try {
    const saved = JSON.parse(storage.get(CACHE_KEY) ?? 'null');
    if (saved?.version === 1) {
      cache = saved.feeds && typeof saved.feeds === 'object' ? saved.feeds : {};
      read = new Set(Array.isArray(saved.read) ? saved.read.filter(key => typeof key === 'string') : []);
    }
  } catch { /* A damaged cache is only a cache: feeds are fetched again. */ }

  function save() {
    try {
      storage.set(OPML_KEY, writeOpml(escapeXml, subscriptions));
      const keep = {};
      for (const { url } of subscriptions) if (cache[url]) keep[url] = cache[url];
      cache = keep;
      storage.set(CACHE_KEY, JSON.stringify({ version: 1, feeds: cache, read: [...read].slice(-READ_LIMIT) }));
      saveProblem = '';
    } catch (error) {
      saveProblem = `Feeds could not be remembered: ${error.message}`;
    }
  }

  const keyOf = (url, entry) => `${url}|${entry.id}`.slice(0, 400);
  const unread = url => (cache[url]?.items ?? []).filter(entry => !read.has(keyOf(url, entry))).length;

  // ---- Showing ----------------------------------------------------------------

  function refreshFeedList() {
    const total = subscriptions.reduce((sum, { url }) => sum + unread(url), 0);
    feedList.items = [
      { value: ALL, text: 'All articles', detail: total ? `${total} unread` : 'All read', sprite: 'mini-feeds' },
      ...subscriptions.map(({ url, title }) => {
        const entry = cache[url];
        const count = unread(url);
        const detail = entry?.error ? `⚠ ${entry.error}` : !entry ? 'Not loaded yet' : `${count ? `${count} unread · ` : ''}${when(entry.fetched)}`;
        return { value: url, text: entry?.title || title, detail };
      })
    ];
    if (feed.value !== ALL && !subscriptions.some(sub => sub.url === feed.value)) feed.set(ALL);
    app.signal('has-feed').set(feed.value !== ALL);
  }

  function refreshItems() {
    const urls = feed.value === ALL ? subscriptions.map(sub => sub.url) : [feed.value];
    shown = urls.flatMap(url => (cache[url]?.items ?? []).map(entry => ({ ...entry, url, key: keyOf(url, entry) })))
      .sort((a, b) => b.date - a.date);
    itemList.items = shown.map(entry => ({
      value: entry.key,
      text: entry.title,
      detail: [feed.value === ALL ? cache[entry.url]?.title : '', when(entry.date)].filter(Boolean).join(' · '),
      sprite: read.has(entry.key) ? 'mark-read' : 'mark-unread'
    }));
    if (!shown.some(entry => entry.key === item.value)) item.set('');
    showArticle();
  }

  function showArticle() {
    const entry = shown.find(candidate => candidate.key === item.value);
    app.signal('has-item').set(Boolean(entry));
    app.signal('has-link').set(Boolean(entry?.link));
    if (!entry) {
      const source = cache[feed.value];
      app.signal('headline').set(feed.value === ALL ? 'Pea Feeds' : source?.title || 'Feed');
      app.signal('byline').set(shown.length ? `${shown.length} articles` : '');
      app.signal('article').set(source?.error ? `This feed could not be loaded.\n\n${source.error}` : shown.length ? 'Choose an article to read it here.' : 'Press Refresh to fetch the newest articles, or Add feed… to subscribe to another.');
      return;
    }
    app.signal('headline').set(entry.title);
    app.signal('byline').set([cache[entry.url]?.title, entry.author, when(entry.date)].filter(Boolean).join(' · '));
    app.signal('article').set(entry.text || (entry.link ? 'This article has no text in the feed. Open it in the browser to read it.' : ''));
    article.setSelection(0);
    article.scrollY = 0;
    if (!read.has(entry.key)) {
      read.add(entry.key);
      save();
      refreshFeedList();
      const row = itemList.items.find(candidate => candidate.value === entry.key);
      if (row) { row.sprite = 'mark-read'; itemList.invalidate(); }
    }
  }

  function report() {
    const total = subscriptions.reduce((sum, { url }) => sum + unread(url), 0);
    const failed = subscriptions.filter(({ url }) => cache[url]?.error).length;
    status.set(saveProblem || offline || [`${subscriptions.length} feeds`, total ? `${total} unread` : 'all read', failed ? `${failed} could not be loaded` : ''].filter(Boolean).join(' · '));
  }

  // ---- Fetching ---------------------------------------------------------------

  async function download(url) {
    if (url.startsWith('pea:')) return { text: app.os.dataText(url.slice(4)), url };
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    const response = await app.request({ url, signal, headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.5, */*;q=0.3' } });
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    return { text: response.text, url };
  }

  /** Fetches and parses one feed. A web page that announces a feed is followed once. */
  async function load(url) {
    let { text } = await download(url);
    let address = url;
    let parsed;
    try {
      parsed = parseFeed(parseXml, text, url);
    } catch (error) {
      const found = /<html[\s>]/i.test(text) ? discoverFeed(text, url) : null;
      if (!found) throw new Error(/<html[\s>]/i.test(text) ? 'This is a web page without a feed.' : error.message);
      address = found;
      ({ text } = await download(found));
      parsed = parseFeed(parseXml, text, found);
    }
    return { address, parsed };
  }

  function store(url, parsed) {
    cache[url] = {
      title: parsed.title,
      fetched: Date.now(),
      error: '',
      items: parsed.items.slice(0, ITEMS_PER_FEED).map(entry => ({ ...entry, id: String(entry.id).slice(0, 300), title: entry.title.slice(0, 300), text: entry.text.length > TEXT_LIMIT ? `${entry.text.slice(0, TEXT_LIMIT)}…` : entry.text }))
    };
  }

  async function refresh(urls = subscriptions.map(sub => sub.url)) {
    if (refreshing) return;
    refreshing = true;
    app.signal('busy').set(true);
    app.signal('idle').set(false);
    let done = 0;
    status.set(`Refreshing ${urls.length} feed${urls.length === 1 ? '' : 's'}…`);
    const queue = urls.slice();
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift();
        try {
          const { parsed } = await load(url);
          store(url, parsed);
        } catch (error) {
          const message = String(error?.message ?? error).split('\n')[0].slice(0, 140);
          cache[url] = { ...(cache[url] ?? { title: '', items: [] }), fetched: Date.now(), error: message };
        }
        done += 1;
        if (!app.scope.disposed) status.set(`Refreshing… ${done} of ${urls.length}`);
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
    } finally {
      refreshing = false;
      if (!app.scope.disposed) {
        app.signal('busy').set(false);
        app.signal('idle').set(true);
        save();
        refreshFeedList();
        refreshItems();
        report();
      }
    }
  }

  // ---- Commands ---------------------------------------------------------------

  app.command('refresh', () => refresh());

  app.command('add-feed', async () => {
    const answer = await app.os.dialogs.prompt({ title: 'Add a feed', message: 'Paste the address of a feed, or of a web page that has one.', value: 'https://', acceptLabel: 'Add' });
    if (answer === null) return;
    let url = answer.trim();
    if (!url || url === 'https://') return;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    if (!url.startsWith('pea:')) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('x');
        url = parsed.href;
      } catch {
        await app.os.dialogs.alert({ title: 'Add a feed', message: `“${answer}” is not a web address.` });
        return;
      }
    }
    if (subscriptions.length >= MAX_FEEDS) { status.set(`Pea Feeds follows up to ${MAX_FEEDS} feeds.`); return; }
    status.set('Looking for the feed…');
    try {
      const { address, parsed } = await load(url);
      if (subscriptions.some(sub => sub.url === address)) { status.set('You already follow this feed.'); feed.set(address); return; }
      subscriptions.push({ url: address, title: parsed.title || new URL(address).host });
      store(address, parsed);
      save();
      refreshFeedList();
      feed.set(address);
      report();
    } catch (error) {
      status.set('');
      await app.os.dialogs.alert({ title: 'Add a feed', message: `That feed could not be added. ${error.message}` });
    }
  });

  app.command('mark-read', () => {
    const urls = feed.value === ALL ? subscriptions.map(sub => sub.url) : [feed.value];
    for (const url of urls) for (const entry of cache[url]?.items ?? []) read.add(keyOf(url, entry));
    save();
    refreshFeedList();
    refreshItems();
    report();
  });

  app.command('open-link', () => {
    const entry = shown.find(candidate => candidate.key === item.value);
    if (!entry?.link) return;
    try { app.openUrl(entry.link); } catch (error) { status.set(error.message); }
  });

  const step = direction => {
    const index = shown.findIndex(entry => entry.key === item.value);
    const next = shown[Math.max(0, Math.min(shown.length - 1, index + direction))];
    if (next) item.set(next.key);
  };
  app.command('item-previous', () => step(-1));
  app.command('item-next', () => step(1));

  async function rename() {
    const sub = subscriptions.find(candidate => candidate.url === feed.value);
    if (!sub) return;
    const name = await app.os.dialogs.prompt({ title: 'Rename feed', value: cache[sub.url]?.title || sub.title, acceptLabel: 'Rename' });
    if (!name?.trim()) return;
    sub.title = name.trim().slice(0, 80);
    if (cache[sub.url]) cache[sub.url].title = sub.title;
    save();
    refreshFeedList();
  }

  async function remove() {
    const sub = subscriptions.find(candidate => candidate.url === feed.value);
    if (!sub) return;
    const answer = await app.os.dialogs.confirm({ title: 'Remove feed', message: `Stop following “${cache[sub.url]?.title || sub.title}”?`, buttons: [{ value: 'cancel', text: 'Cancel' }, { value: 'remove', text: 'Remove' }] });
    if (answer !== 'remove') return;
    subscriptions = subscriptions.filter(candidate => candidate !== sub);
    delete cache[sub.url];
    feed.set(ALL);
    save();
    refreshFeedList();
    refreshItems();
    report();
  }

  async function importOpml() {
    try {
      const file = await app.pick('.opml,.xml,text/xml,application/xml');
      if (!file) return;
      const incoming = readOpml(parseXml, file.text).filter(sub => !subscriptions.some(existing => existing.url === sub.url));
      const room = MAX_FEEDS - subscriptions.length;
      subscriptions.push(...incoming.slice(0, room));
      save();
      refreshFeedList();
      status.set(`Imported ${Math.min(room, incoming.length)} feeds${incoming.length > room ? `; ${incoming.length - room} did not fit` : ''}.`);
      await refresh(incoming.slice(0, room).map(sub => sub.url));
    } catch (error) {
      await app.os.dialogs.alert({ title: 'Import feeds', message: `The OPML file could not be read. ${error.message}` });
    }
  }

  app.command('more', () => {
    const selected = feed.value !== ALL;
    const at = more.toScreen(0, more.h);
    app.os.desktop.popupMenu([
      { text: 'Refresh this feed', icon: 'glyph-refresh', disabled: !selected || refreshing, invoke: () => refresh([feed.value]) },
      { text: 'Rename feed…', icon: 'glyph-pencil', disabled: !selected, invoke: rename },
      { text: 'Remove feed…', icon: 'glyph-bin', disabled: !selected, invoke: remove },
      { separator: true },
      { text: 'Import OPML…', icon: 'glyph-import', invoke: importOpml },
      { text: 'Export OPML…', icon: 'glyph-export', invoke: () => app.download('pea-feeds.opml', writeOpml(escapeXml, subscriptions), 'text/x-opml') }
    ], at);
  });

  // ---- Wiring -----------------------------------------------------------------

  app.scope.subscribe(feed, () => { app.signal('has-feed').set(feed.value !== ALL); refreshItems(); }, { immediate: false });
  app.scope.subscribe(item, showArticle, { immediate: false });
  app.scope.on(app.keys, 'down', event => {
    if (event.key === 'j' || event.key === 'n') step(1);
    else if (event.key === 'k' || event.key === 'p') step(-1);
    else if (event.key === 'r' && !event.ctrl) refresh();
  });
  const stale = () => subscriptions.some(({ url }) => !cache[url] || Date.now() - (cache[url].fetched ?? 0) > STALE_MS);
  app.scope.subscribe(app.visible, visible => { if (visible && stale()) refresh(); });
  app.service('schedule').use().then(schedule => {
    if (!app.scope.disposed) app.scope.add(schedule.every(STALE_MS, () => (stale() ? refresh() : undefined)));
  }, error => app.report(error));
  let looks = 0;
  app.scope.subscribe(network.ready, async () => {
    const mine = ++looks;
    const why = await network.why();
    // Looks can finish out of order; only the newest one describes things as they are.
    if (app.scope.disposed || mine !== looks) return;
    offline = why;
    report();
  });

  refreshFeedList();
  refreshItems();
  report();
}
