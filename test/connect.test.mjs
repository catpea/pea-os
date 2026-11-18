import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { parseXml } from '../src/core/xml.js';
import { relay, readOrder, relayRefusal, isLoopback } from '../cli/relay.mjs';
import { parseFeed, htmlToText, discoverFeed, readOpml, writeOpml, when } from '../res/apps/feeds.js';
import { completionReader, wrapText } from '../res/apps/chat.js';
import { escapeXml } from '../src/core/xml.js';
import { handler } from '../cli/serve.mjs';
import { loadManifest, ROOT } from '../cli/project.mjs';
import { session } from './helpers.mjs';

const RSS = `<?xml version="1.0"?>
<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd">
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Garden &amp; Co</title>
    <link>https://garden.example/</link>
    <item>
      <title>Peas &nbsp;are up</title>
      <link>https://garden.example/peas</link>
      <guid isPermaLink="false">g-1</guid>
      <pubDate>Tue, 10 Nov 2026 08:00:00 GMT</pubDate>
      <dc:creator>Robin</dc:creator>
      <description>short</description>
      <content:encoded><![CDATA[<p>First <b>shoots</b> today &mdash; finally.</p><script>alert(1)</script><ul><li>water</li><li>wait</li></ul>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="html">Pea &lt;b&gt;Log&lt;/b&gt;</title>
  <link rel="self" href="https://log.example/feed"/><link href="https://log.example/"/>
  <entry><id>tag:log,1</id><title>Hello</title><link rel="alternate" href="https://log.example/1"/>
    <updated>2026-11-01T10:00:00Z</updated><author><name>Ana</name></author><summary>Hi there</summary></entry>
</feed>`;

test('foreign XML skips doctypes and keeps unknown entities; Pea XML stays strict', () => {
  const root = parseXml(RSS, 'feed', { foreign: true });
  assert.equal(root.name, 'rss');
  assert.throws(() => parseXml(RSS, 'feed'), /doctype/);
  assert.throws(() => parseXml('<a>&nbsp;</a>', 'strict'), /unknown entity/);
  assert.equal(parseXml('<a>x &nbsp; y &amp; z & w</a>', 'feed', { foreign: true }).text, 'x &nbsp; y & z & w');
});

test('feeds read RSS, Atom and RDF into plain readable articles', () => {
  const rss = parseFeed(parseXml, RSS, 'rss');
  assert.equal(rss.title, 'Garden & Co');
  const [item] = rss.items;
  assert.equal(item.id, 'g-1');
  assert.equal(item.title, 'Peas are up');
  assert.equal(item.author, 'Robin');
  assert.equal(item.date, Date.parse('2026-11-10T08:00:00Z'));
  assert.equal(item.text, 'First shoots today — finally.\n\n• water\n• wait', 'content:encoded wins, scripts and tags go');

  const atom = parseFeed(parseXml, ATOM, 'atom');
  assert.equal(atom.title, 'Pea Log');
  assert.equal(atom.link, 'https://log.example/');
  assert.deepEqual({ ...atom.items[0], date: 0 }, { id: 'tag:log,1', title: 'Hello', link: 'https://log.example/1', date: 0, author: 'Ana', text: 'Hi there' });

  const rdf = parseFeed(parseXml, `<rdf:RDF xmlns:rdf="r" xmlns="p"><channel><title>Old</title></channel><item rdf:about="https://x/1"><title>One</title><link>https://x/1</link></item></rdf:RDF>`);
  assert.equal(rdf.items[0].id, 'https://x/1');
  assert.throws(() => parseFeed(parseXml, '<html><body/></html>'), /not a feed/);
  assert.equal(htmlToText('a<br>b&#8217;s &amp; c'), 'a\nb’s & c');
});

test('web pages announce feeds, and subscriptions travel as OPML', () => {
  const html = '<html><head><link rel="stylesheet" href="x.css"><link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml"></head></html>';
  assert.equal(discoverFeed(html, 'https://site.example/blog/'), 'https://site.example/feed.xml');
  assert.equal(discoverFeed('<html></html>', 'https://site.example/'), null);
  const feeds = [{ url: 'https://a.example/rss?x=1&y=2', title: 'A "quoted" feed' }, { url: 'pea:pea-news', title: 'Pea' }];
  assert.deepEqual(readOpml(parseXml, writeOpml(escapeXml, feeds)), feeds);
  assert.equal(when(Date.now() - 3 * 3600_000), '3 h ago');
});

test('the relay validates orders and answers only same-origin loopback pages', () => {
  assert.deepEqual(readOrder(JSON.stringify({ url: 'https://example.com/a', headers: { Accept: 'x', Cookie: 'secret', Host: 'evil' } })),
    { url: 'https://example.com/a', method: 'GET', headers: { accept: 'x' }, body: undefined });
  assert.throws(() => readOrder(JSON.stringify({ url: 'file:///etc/passwd' })), /http and https/);
  assert.throws(() => readOrder(JSON.stringify({ url: 'https://u:p@example.com/' })), /credentials/);
  assert.throws(() => readOrder(JSON.stringify({ url: 'https://example.com/', method: 'DELETE' })), /not relayed/);
  assert.throws(() => readOrder(JSON.stringify({ url: 'https://example.com/', headers: { 'X-A': 'one\r\nInjected: yes' } })), /not valid/);
  assert.ok(isLoopback('::ffff:127.0.0.1') && isLoopback('::1') && !isLoopback('192.168.1.4'));
  const request = (remote, headers) => ({ socket: { remoteAddress: remote }, headers: { host: '127.0.0.1:8080', ...headers } });
  assert.equal(relayRefusal(request('127.0.0.1', { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:8080' })), null);
  assert.match(relayRefusal(request('10.0.0.2', {})), /only this computer/);
  assert.match(relayRefusal(request('127.0.0.1', { host: 'attacker.example:8080' })), /127\.0\.0\.1 or localhost/);
  assert.match(relayRefusal(request('127.0.0.1', { 'sec-fetch-site': 'cross-site' })), /Pea OS pages only/);
  assert.match(relayRefusal(request('127.0.0.1', { origin: 'http://localhost:9999' })), /Pea OS pages only/);
});

test('the relay passes requests, statuses and streamed bodies through', async t => {
  const upstream = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.url === '/missing') { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('nope'); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ method: request.method, auth: request.headers.authorization, cookie: request.headers.cookie ?? null, body })}\n\n`);
      setTimeout(() => { response.write('data: [DONE]\n\n'); response.end(); }, 20);
    });
  });
  const pea = createServer((request, response) => relay(request, response));
  await Promise.all([new Promise(done => upstream.listen(0, '127.0.0.1', done)), new Promise(done => pea.listen(0, '127.0.0.1', done))]);
  t.after(() => { upstream.close(); pea.close(); });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const ask = order => fetch(`http://127.0.0.1:${pea.address().port}/__pos/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(order) });

  const response = await ask({ url: `${base}/chat`, method: 'POST', headers: { Authorization: 'Bearer k', Cookie: 'c=1' }, body: '{"q":1}' });
  assert.equal(response.headers.get('x-pea-relay'), 'ok');
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const text = await response.text();
  assert.deepEqual(JSON.parse(text.split('\n')[0].slice(6)), { method: 'POST', auth: 'Bearer k', cookie: null, body: '{"q":1}' });
  assert.match(text, /\[DONE\]/);

  const missing = await ask({ url: `${base}/missing` });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-pea-relay'), 'ok');
  const refused = await ask({ url: 'ftp://example.com/' });
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get('x-pea-relay'), 'error');
  const unreachable = await ask({ url: 'http://127.0.0.1:1/' });
  assert.equal(unreachable.status, 502);
  assert.match(await unreachable.text(), /Could not reach/);
});

test('the relay keeps characters split between chunks, and the terminal log takes only this computer\'s Pea pages', async t => {
  const upstream = createServer(async (request, response) => {
    const bytes = Buffer.from('héllo 🍐');
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    // Split inside the two-byte é and the four-byte pear.
    for (const part of [bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)]) { response.write(part); await new Promise(done => setTimeout(done, 5)); }
    response.end();
  });
  const printed = [];
  const pea = createServer(handler(await loadManifest(ROOT), ROOT, { write: text => printed.push(text) }));
  await Promise.all([new Promise(done => upstream.listen(0, '127.0.0.1', done)), new Promise(done => pea.listen(0, '127.0.0.1', done))]);
  t.after(() => { upstream.close(); pea.close(); });
  const at = path => `http://127.0.0.1:${pea.address().port}${path}`;
  const answer = await fetch(at('/__pos/relay'), { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ url: `http://127.0.0.1:${upstream.address().port}/` }) });
  assert.equal(await answer.text(), 'héllo 🍐');

  const elsewhere = await fetch(at('/__pos/log'), { method: 'POST', headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, body: 'hi' });
  assert.equal(elsewhere.status, 403);
  const ours = await fetch(at('/__pos/log'), { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' }, body: Buffer.from('\x1b[31mred\x1b[0m é\n\tat line 2') });
  assert.equal(ours.status, 204);
  assert.deepEqual(printed, ['browser: [31mred[0m é\n\tat line 2\n'], 'escape characters are dropped, so the terminal only prints');
});

test('Pea Feeds fetches every feed, survives failures, and remembers what was read', async t => {
  const calls = [];
  const request = async ({ url }) => {
    calls.push(url);
    if (url.includes('hnrss')) return { status: 200, ok: true, type: 'application/rss+xml', text: RSS };
    return { status: 500, ok: false, type: 'text/plain', text: 'boom' };
  };
  const stored = new Map();
  const live = await session(t, { width: 640, height: 360, stored, request, options: { open: ['feeds'] } });
  await live.frames(10);
  const app = live.os.app('feeds');
  const { feedList, itemList } = app.refs;
  assert.deepEqual(calls.sort(), ['https://hnrss.org/frontpage', 'https://www.nasa.gov/news-release/feed/']);
  assert.match(feedList.items.find(item => item.value.includes('nasa')).detail, /⚠ The server answered 500/);
  assert.equal(feedList.items[0].detail, '7 unread', 'six bundled articles and one fetched');
  assert.deepEqual(itemList.items.map(item => item.text).slice(0, 2), ['Meet Pea Flow: objects that travel', 'Pea Records keeps a card file'], 'newest first across all feeds');
  app.signal('item').set(itemList.items.find(item => item.text === 'Peas are up').value);
  assert.equal(app.signal('headline').value, 'Peas are up');
  assert.equal(app.signal('byline').value.split(' · ').slice(0, 2).join(' · '), 'Garden & Co · Robin');
  assert.equal(feedList.items[0].detail, '6 unread');
  app.run('open-link');
  assert.deepEqual(live.opened, ['https://garden.example/peas']);
  app.run('mark-read');
  assert.equal(feedList.items[0].detail, 'All read');
  assert.match(stored.get('pea-os.feeds.opml'), /xmlUrl="pea:pea-news"/);
  assert.deepEqual(live.errors, [], 'network failures are shown in the reader, not raised');
});

test('chat replies stream in, tool calls run, and errors are readable', async t => {
  const pieces = [];
  const reader = completionReader(text => pieces.push(text));
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"open_","arguments":"{\\"app\\":"}}]}}]}\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"app","arguments":"\\"paint\\"}"}}]}}]}\n',
    'data: [DONE]'
  ].join('');
  for (let i = 0; i < sse.length; i += 7) reader.feed(sse.slice(i, i + 7));
  const result = reader.finish();
  assert.equal(result.content, 'Hello');
  assert.equal(pieces.join(''), 'Hello');
  assert.deepEqual(result.toolCalls, [{ id: 'c1', type: 'function', function: { name: 'open_app', arguments: '{"app":"paint"}' } }]);

  const whole = completionReader();
  whole.feed('{"choices":[{"message":{"role":"assistant","content":"Hi"}}]}');
  assert.equal(whole.finish().content, 'Hi');
  const broken = completionReader();
  broken.feed('{"error":{"message":"model not found"}}');
  assert.throws(() => broken.finish(), /model not found/);

  const font = { measure: text => text.length * 5 };
  assert.deepEqual(wrapText(font, 'see https://example.com/very/long/address now', 40), ['see', 'https://', 'example.', 'com/very', '/long/ad', 'dress', 'now']);
});

test('Agent Chat talks to a v1 server and lets the agent use Pea tools', async t => {
  const bodies = [];
  const request = async ({ url, body, headers, onText }) => {
    bodies.push({ url, body: JSON.parse(body), headers });
    const reply = bodies.length === 1
      ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"create_sticky_note","arguments":"{\\"text\\":\\"Water the basil\\"}"}}]}}]}\n\ndata: [DONE]\n'
      : 'data: {"choices":[{"delta":{"content":"Done! "}}]}\n\ndata: {"choices":[{"delta":{"content":"Note written."}}]}\n\ndata: [DONE]\n';
    for (const line of reply.split('\n\n')) onText?.(`${line}\n\n`);
    return { status: 200, ok: true, type: 'text/event-stream', text: reply };
  };
  const stored = new Map();
  const live = await session(t, { width: 640, height: 360, stored, request, options: { open: ['chat'] } });
  await live.frames(5);
  const app = live.os.app('chat');
  assert.equal(app.signal('page').value, 'setup', 'with no model chosen, Setup comes first');
  app.signal('base-url').set('http://127.0.0.1:9/v1/');
  app.signal('api-key').set('sk-test');
  app.signal('model').set('tiny');
  app.signal('draft').set('Remind me to water the basil');
  await app.run('chat-send');
  await live.frames(5);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].url, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(bodies[0].headers.Authorization, 'Bearer sk-test');
  assert.equal(bodies[0].body.model, 'tiny');
  assert.equal(bodies[0].body.messages[0].role, 'system');
  assert.ok(bodies[0].body.tools.some(tool => tool.function.name === 'open_app'));
  const second = bodies[1].body.messages;
  assert.deepEqual(second.slice(-2).map(message => message.role), ['assistant', 'tool']);
  assert.equal(second.at(-1).tool_call_id, 't1');
  assert.equal(live.os.desktop.notes.state.value.notes.at(-1).text, 'Water the basil');
  const history = JSON.parse(stored.get('pea-os.chat.history.v1')).entries;
  assert.equal(history.at(-1).content, 'Done! Note written.');
  assert.ok(!stored.get('pea-os.chat.history.v1').includes('sk-test'));
  await new Promise(done => setTimeout(done, 350));
  assert.equal(JSON.parse(stored.get('pea-os.chat.v1')).model, 'tiny', 'setup is remembered');
  assert.deepEqual(live.errors, []);
});

test('Agent Chat explains server errors instead of failing silently', async t => {
  const request = async () => ({ status: 404, ok: false, type: 'application/json', text: '{"error":{"message":"model \\"x\\" not found"}}' });
  const live = await session(t, { width: 640, height: 360, request, options: { open: ['chat'] } });
  const app = live.os.app('chat');
  app.signal('model').set('x');
  app.signal('draft').set('hi');
  await app.run('chat-send');
  const transcript = JSON.parse(live.os.platform.storage.get('pea-os.chat.history.v1')).entries;
  assert.equal(transcript.at(-1).role, 'error');
  assert.match(transcript.at(-1).content, /404: model "x" not found\. Check the base URL/);
  assert.equal(app.signal('send-label').value, 'Send');
});
