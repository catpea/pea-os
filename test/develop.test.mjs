import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMatches, replaceAll, compile } from '../res/apps/regex.js';
import { outline, sortKeys, locate, errorOffset, childPath } from '../res/apps/json.js';
import { diffLines, displayRows, unified } from '../res/apps/diff.js';
import { parseHeaders, readable } from '../res/apps/http.js';
import { transform } from '../res/apps/codec.js';
import { session, walk } from './helpers.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));

test('Regex Lab lists every match with its groups, whatever the flags, and replaces as the flags say', () => {
  const found = findMatches('(?<first>\\w)(\\w*)', '', 'Pea pod');
  assert.deepEqual(found.map(match => [match.index, match.text, match.named.first]), [[0, 'Pea', 'P'], [4, 'pod', 'p']]);
  assert.equal(findMatches('x*', 'g', 'ab').length, 3, 'empty matches move on instead of looping');
  assert.equal(findMatches('a', 'g', 'a'.repeat(900)).length, 500, 'at most 500 are listed');
  assert.equal(replaceAll('o', '', 'foo', '0'), 'f0o', 'without g only the first');
  assert.equal(replaceAll('o', 'g', 'foo', '0'), 'f00');
  assert.throws(() => compile('a', 'gq'), /Unknown flag "q"/);
  assert.throws(() => compile('a', 'gg'), /twice/);
  assert.throws(() => compile('(', ''), SyntaxError);
});

test('JSON Lens finds where text stops being JSON, lists paths with their formatted lines, and sorts keys', () => {
  for (const [text, line, column] of [['{"a":1,\n "b": }', 2, 7], ['[1,2', 1, 5], ['{"a" 1}', 1, 6], ['[01]', 1, 3], ['"x\\q"', 1, 4], ['[1] x', 1, 5], ['  ', 1, 3]]) {
    assert.throws(() => JSON.parse(text));
    let error;
    try { JSON.parse(text); } catch (caught) { error = caught; }
    const where = locate(text, error);
    assert.deepEqual([where.line, where.column], [line, column], text);
    assert.doesNotMatch(where.message, /position|is not valid JSON/, 'the engine\'s own position is not repeated');
  }
  for (const text of ['{"a":[true,false,null,-1.5e3,"\\u00e9"]}', '[]', '"x"', ' 0 ']) assert.equal(errorOffset(text), null, text);

  const value = { a: { b: 1, c: [] }, d: [1, { e: 2 }], 'x y': null };
  const lines = JSON.stringify(value, null, 2).split('\n');
  const rows = outline(value);
  assert.deepEqual(rows.map(row => row.path), ['$', '$.a', '$.a.b', '$.a.c', '$.d', '$.d[0]', '$.d[1]', '$.d[1].e', '$["x y"]']);
  assert.deepEqual(rows.map(row => row.line), [1, 2, 3, 4, 6, 7, 8, 9, 12], 'closing brackets take lines of their own');
  assert.deepEqual(rows.map(row => lines[row.line - 1].trim()), ['{', '"a": {', '"b": 1,', '"c": []', '"d": [', '1,', '{', '"e": 2', '"x y": null']);
  assert.equal(rows.deepest, 3);
  assert.equal(childPath('$', 'ok_1'), '$.ok_1');
  assert.equal(JSON.stringify(sortKeys({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } })), '{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}');
});

test('Text Diff finds the fewest lines to take out and put in, folds what did not change, and writes a unified diff', () => {
  // Every result must rebuild the new text, keep both texts in order, and keep as many lines as their longest common run.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 400; round++) {
    const a = Array.from({ length: Math.floor(random() * 10) }, () => 'abc'[Math.floor(random() * 3)]);
    const b = Array.from({ length: Math.floor(random() * 10) }, () => 'abc'[Math.floor(random() * 3)]);
    const ops = diffLines(a, b);
    assert.deepEqual(ops.filter(op => op.kind !== 'del').map(op => op.b), b.map((_, i) => i));
    assert.deepEqual(ops.filter(op => op.kind !== 'add').map(op => op.a), a.map((_, i) => i));
    for (const op of ops.filter(op => op.kind === 'same')) assert.equal(a[op.a], b[op.b]);
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    assert.equal(ops.filter(op => op.kind === 'same').length, lcs[0][0]);
  }
  assert.deepEqual(diffLines(['a  b'], ['a b'], { ignoreSpace: true }).map(op => op.kind), ['same']);
  assert.throws(() => diffLines(Array.from({ length: 2100 }, (_, i) => `a${i}`), Array.from({ length: 2100 }, (_, i) => `b${i}`)), /more than 2000 lines/);

  const a = 'abcdefghijk'.split('');
  const b = 'abXdefghijkl'.split('');
  const ops = diffLines(a, b);
  assert.deepEqual(displayRows(ops).map(row => row.kind === 'fold' ? `fold${row.count}` : row.kind), ['same', 'same', 'del', 'add', 'same', 'same', 'same', 'fold2', 'same', 'same', 'same', 'add']);
  assert.equal(unified(a, b, ops), ['--- before', '+++ after', '@@ -1,6 +1,6 @@', ' a', ' b', '-c', '+X', ' d', ' e', ' f', '@@ -9,3 +9,4 @@', ' i', ' j', ' k', '+l'].join('\n'));
});

test('HTTP Probe reads header lines and makes JSON answers readable', () => {
  assert.deepEqual(parseHeaders('Accept: application/json\n\n# a comment\nX-Token:  a:b '), { Accept: 'application/json', 'X-Token': 'a:b' });
  assert.throws(() => parseHeaders('Accept application/json'), /line 1/);
  assert.equal(readable('application/json', '{"a":[1]}'), '{\n  "a": [\n    1\n  ]\n}');
  assert.equal(readable('text/plain', 'plain {'), 'plain {');
});

test('Codec Bench round-trips text and hashes as the standards say', async () => {
  const text = 'Pea ♥ ü & <ok>';
  for (const [there, back] of [['base64-encode', 'base64-decode'], ['url-encode', 'url-decode'], ['hex-encode', 'hex-decode'], ['html-escape', 'html-unescape']]) {
    assert.equal(await transform(back, await transform(there, text)), text, there);
  }
  assert.equal(await transform('base64-encode', 'hi?>'), 'aGk/Pg==');
  assert.equal(await transform('base64-decode', 'aGk_Pg'), 'hi?>', 'url-safe and unpadded Base64 too');
  assert.equal(await transform('sha-256', 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await transform('sha-1', 'abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(await transform('html-unescape', '&#x1F95C; &#233; &bogus;'), '🥜 é &bogus;');
  await assert.rejects(transform('base64-decode', 'not base64!'), /not Base64/);
  await assert.rejects(transform('hex-decode', 'abc'), /pairs/);
  const token = ['{"alg":"HS256"}', '{"sub":"pea","exp":1}'].map(part => Buffer.from(part).toString('base64url')).join('.') + '.sig';
  const jwt = await transform('jwt', token);
  assert.match(jwt, /"sub": "pea"/);
  assert.match(jwt, /"exp": "1970-01-01T00:00:01.000Z"/);
  assert.match(jwt, /expired/);
  assert.match(await transform('time', '1700000000'), /^2023-11-14T22:13:20\.000Z/);
  assert.match(await transform('time', '1700000000000'), /milliseconds/);
  assert.equal((await transform('time', '2023-11-14T22:13:20Z')).split('\n')[0], '1700000000');
  assert.match(await transform('uuid', ''), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the developer apps run on the desktop: typing updates them, and HTTP Probe uses the network it is given', async t => {
  const sent = [];
  const request = async order => {
    sent.push(order);
    return { status: 200, ok: true, type: 'application/json', text: '{"data":[{"id":"pea-1"}]}' };
  };
  const live = await session(t, { width: 960, height: 540, request, options: { pixel: 1, open: ['regex', 'json', 'diff', 'http', 'codec'] } });
  const { os } = live;
  await live.frames(10);
  for (const id of ['regex', 'json', 'diff', 'http', 'codec']) assert.equal(os.app(id).definition.category, 'develop');

  const regex = os.app('regex');
  regex.signal('pattern').set('p(o)d');
  await pause(200);
  assert.equal(regex.refs.matches.items.length, 2);
  assert.match(regex.signal('status').value, /^2 matches/);
  regex.signal('match').set('1');
  regex.run('show-match');
  const second = regex.signal('sample').value.indexOf('pod', regex.signal('sample').value.indexOf('pod') + 1);
  assert.deepEqual(regex.refs.sample.selection, { start: second, end: second + 3 });
  regex.signal('pattern').set('(');
  await pause(200);
  assert.match(regex.signal('status').value, /Unterminated group/);

  const json = os.app('json');
  assert.equal(json.signal('valid').value, true);
  json.run('minify');
  assert.ok(!json.signal('source').value.includes('\n'));
  json.run('format');
  json.signal('node').set('$.pixels.chunky');
  json.run('show-node');
  const { start, end } = json.refs.editor.selection;
  assert.equal(json.signal('source').value.slice(start, end), '    "chunky": 6');
  json.signal('source').set('{"a": }');
  await pause(250);
  assert.equal(json.signal('valid').value, false);
  assert.match(json.signal('status').value, /^Not JSON: line 1, column 7/);

  const diff = os.app('diff');
  assert.equal(diff.signal('status').value, '+3 −2 lines');
  diff.run('swap');
  assert.equal(diff.signal('status').value, '+2 −3 lines');
  await live.frames(2);
  assert.ok(diff.refs.view.bitmap.width > 100, 'the differences are drawn');

  const http = os.app('http');
  http.signal('url').set('https://example.com/v1/models');
  http.signal('headers').set('Accept: application/json\nAuthorization: Bearer k');
  await http.run('send-request');
  assert.deepEqual(sent.map(order => [order.method, order.url, order.headers.Authorization]), [['GET', 'https://example.com/v1/models', 'Bearer k']]);
  assert.equal(http.signal('answer').value, '{\n  "data": [\n    {\n      "id": "pea-1"\n    }\n  ]\n}');
  assert.match(http.signal('status').value, /^200 OK/);
  assert.match(http.refs.history.items[0].detail, /^200 · \d+ ms · 25 B$/);
  http.signal('headers').set('no colon here');
  await http.run('send-request');
  assert.equal(sent.length, 1, 'a header it cannot read is not sent');
  assert.equal(http.signal('page').value, 'request');

  const codec = os.app('codec');
  await pause(20);
  assert.equal(codec.signal('output').value, 'UGVhIE9TIOKZpSBwaXhlbHM=');
  codec.run('use-output');
  codec.signal('operation').set('base64-decode');
  await pause(20);
  assert.equal(codec.signal('output').value, 'Pea OS ♥ pixels');
  assert.deepEqual(live.errors, []);
});

test('the Sticky Notes list is what grows when the window does', async t => {
  const live = await session(t, { width: 960, height: 540, options: { pixel: 1, open: ['notes'] } });
  const { os } = live;
  await live.frames(4);
  const list = os.app('notes').refs.notesList;
  const win = os.model.window('notes');
  const before = list.h;
  os.model.resize('notes', { x: win.x, y: win.y, w: win.w, h: win.h + 120 });
  await live.frames(2);
  assert.equal(list.h, before + 120, 'every new pixel of height goes to the list');
  const label = [...walk(os.app('notes').view)].find(widget => widget.props?.text && String(widget.props.text).includes('notes'));
  assert.ok(!label || label.y + label.h <= os.app('notes').view.h, 'the status stays inside the window');
});
