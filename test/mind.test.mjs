import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  rng, syllables, rhymes, keywords, parseGrammar, expand, SHAPES, poem, story, song, novel,
  familyIdeas, SKILLS, skillFor, think
} from '../src/ai/gofai.js';

const lineSyllables = line => line.split(/[\s-]+/).filter(word => /[a-z]/i.test(word)).reduce((sum, word) => sum + syllables(word), 0);

// Every character the Pea font can draw, read from the font itself.
const GLYPHS = new Set([' ', '\n']);
const fontXml = readFileSync(new URL('../res/fonts/pea.xml', import.meta.url), 'utf8');
for (const [, ch] of fontXml.matchAll(/<glyph ch="([^"]*)"/g)) {
  GLYPHS.add(ch.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
}
const undrawable = text => [...new Set([...text].filter(ch => !GLYPHS.has(ch)))];

test('the same seed gives the same words', () => {
  const a = rng(42);
  const b = rng(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  assert.notDeepEqual([rng('pea')()], [rng('peas')()]);
  for (const make of [
    () => poem({ theme: 'peas in the garden', seed: 3 }),
    () => story({ prompt: 'a fox named Juniper', shape: 'cinderella', seed: 3 }),
    () => song({ theme: 'the sea', seed: 3 }),
    () => novel({ prompt: 'a lighthouse', seed: 3 }),
    () => familyIdeas({ prompt: 'rainy saturday', seed: 3 }),
    () => think({ skill: 'ideate', input: 'a school garden', angle: 'bold', seed: 3 })
  ]) assert.deepEqual(make(), make());
  assert.notEqual(poem({ theme: 'sea', seed: 1 }).text, poem({ theme: 'sea', seed: 2 }).text);
});

test('syllables are counted for familiar words', () => {
  for (const [word, count] of [['cat', 1], ['water', 2], ['apple', 2], ['beautiful', 3], ['syllable', 3], ['fire', 1], ['quiet', 2], ['the', 1], ['', 1]]) {
    assert.equal(syllables(word), count, word);
  }
});

test('rhymes come from the same family', () => {
  assert.ok(rhymes('night').includes('light'));
  assert.ok(!rhymes('night').includes('night'));
  assert.ok(rhymes('peas').includes('breeze'));
  assert.deepEqual(rhymes('orange'), []);
});

test('keywords skip the little words', () => {
  assert.deepEqual(keywords('The pea and the pod and the pea again', 2), ['pea', 'pod']);
});

test('haiku lines are 5, 7 and 5 syllables', () => {
  for (let seed = 1; seed <= 30; seed++) {
    for (const theme of ['', 'peas in the garden', 'the deep blue ocean', 'snow']) {
      const lines = poem({ theme, form: 'haiku', seed }).text.split('\n');
      assert.deepEqual(lines.map(lineSyllables), [5, 7, 5], `${theme} ${seed}: ${lines.join(' / ')}`);
    }
  }
});

test('a limerick has five lines, an acrostic spells its word', () => {
  for (let seed = 1; seed <= 10; seed++) {
    assert.equal(poem({ theme: 'a robot in the city', form: 'limerick', seed }).text.split('\n').length, 5);
  }
  const acrostic = poem({ theme: 'rain', form: 'acrostic', seed: 1 });
  assert.equal(acrostic.title, 'RAIN');
  assert.equal(acrostic.text.split('\n').map(line => line[0]).join(''), 'RAIN');
  assert.equal(poem({ form: 'couplets', seed: 1 }).text.split('\n').length, 8);
});

test('grammars report the line that is wrong', () => {
  const grammar = parseGrammar('# a comment\n\norigin: #greet#, #name#! | hi\ngreet: hello | hey\n');
  assert.deepEqual(grammar.greet, ['hello', 'hey']);
  assert.throws(() => parseGrammar('origin: a\nthis is not a rule'), /line 2:/);
  assert.throws(() => parseGrammar('\n\norigin: |  |'), /line 3:/);
});

test('expand binds actions once and survives recursion', () => {
  const grammar = parseGrammar([
    'origin: [hero:#name#]#hero# met #animal.a#. #hero.capitalize# liked #animal.s#. #hero# #go.ed# home.',
    'name: pip | mira | otto | juno',
    'animal: owl | fox | bee',
    'go: go | walk',
    'loop: #loop# and #loop#'
  ].join('\n'));
  for (let seed = 1; seed <= 20; seed++) {
    const text = expand(grammar, 'origin', rng(seed));
    const [, first, second, third] = /^(\w+) met an? \w+\. (\w+) liked \w+s\. (\w+) (?:went|walked) home\.$/.exec(text) ?? [];
    assert.ok(first, text);
    assert.equal(second.toLowerCase(), first);
    assert.equal(third, first);
  }
  assert.match(expand(grammar, 'loop', rng(1)), /and/);
  assert.equal(expand({ origin: ['#missing#'] }, 'origin', rng(1)), '((missing))');
  assert.equal(expand({}, 'origin'), '((origin))');
});

test('every shape gives a story whose points follow its fortunes', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    assert.ok(shape.title && shape.about, name);
    const told = story({ prompt: 'a kite named Lumi', shape: name, seed: 5 });
    assert.equal(told.shape, name);
    assert.deepEqual(told.points.map(point => point.fortune), shape.beats.map(beat => beat.fortune));
    assert.deepEqual(told.points.map(point => point.beat), shape.beats.map(beat => beat.kind));
    assert.equal(told.points[0].t, 0);
    assert.equal(told.points.at(-1).t, 1);
    assert.equal(told.text.split('\n\n').length, shape.beats.length);
    assert.ok(told.points.every(point => point.fortune >= -1 && point.fortune <= 1));
  }
  assert.match(story({ prompt: 'a story about a fox named Juniper' }).text, /Juniper/);
  const book = novel({ prompt: 'peas', chapters: 5, seed: 2 });
  assert.equal(book.points.length, 5);
  assert.equal((book.text.match(/^Chapter \d/gm) ?? []).length, 5);
});

test('a song has verses, a repeating chorus and a bridge', () => {
  const { text } = song({ theme: 'winter snow', seed: 4 });
  assert.deepEqual(text.match(/^\[[^\]]+\]$/gm), ['[Verse 1]', '[Chorus]', '[Verse 2]', '[Chorus]', '[Bridge]', '[Chorus]']);
  const choruses = text.split('\n\n').filter(part => part.startsWith('[Chorus]'));
  assert.equal(new Set(choruses).size, 1);
});

test('family ideas honour rain and a free budget', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { text } = familyIdeas({ prompt: 'a rainy day with the kids, something free', seed });
    const activities = text.split('\n').filter(line => /^\d\. /.test(line));
    assert.equal(activities.length, 3, text);
    for (const line of activities) {
      assert.match(line, /· (?:indoors|in or out) · free ·/, line);
    }
    assert.match(text, /Snack: /);
    assert.match(text, /Learn together: /);
  }
  const snowy = familyIdeas({ prompt: 'snow day', seed: 1 }).text;
  assert.match(snowy, /in the snow/);
});

test('every skill says something', () => {
  for (const skill of SKILLS) {
    for (const input of ['', 'Plan a picnic in the park for the family. It must be cheap.']) {
      const out = think({ skill, instructions: `${skill} this`, input, seed: 1 });
      assert.equal(typeof out, 'string');
      assert.ok(out.trim().length > 0, `${skill} said nothing`);
    }
  }
  assert.match(think({ skill: 'test', instructions: 'about peas', input: 'Peas grow. 1. Plant\n2. Water' }), /^Checks: \d\/5 passed/);
  assert.match(think({ skill: 'verify', input: 'short' }), /^Needs work: /);
  assert.match(think({ skill: 'chat', input: 'are you a robot?' }), /rule-based/);
  assert.match(think({ skill: 'write', input: 'write a haiku about rain' }), /^Haiku: Rain/);
});

test('skills are found from the words of a request', () => {
  assert.equal(skillFor('please brainstorm some ideas'), 'ideate');
  assert.equal(skillFor('summarize this article'), 'summarize');
  assert.equal(skillFor('write a poem'), 'write');
  assert.equal(skillFor('family ideas for sunday'), 'write');
  assert.equal(skillFor('how are you'), 'chat');
});

test('classify picks one of the given labels', () => {
  const instructions = 'Classify the text. Labels: fruit, animal, vehicle';
  assert.equal(think({ skill: 'classify', instructions, input: 'The cat chased a mouse under the bed' }), 'animal');
  assert.equal(think({ skill: 'classify', instructions, input: 'A red truck drove past the train station' }), 'vehicle');
  assert.equal(think({ skill: 'classify', instructions, input: 'nothing to see here' }), 'fruit');
  assert.equal(think({ skill: 'classify', input: 'I love this, it was wonderful!' }), 'positive');
});

test('repair drops a repeated sentence and splits long ones', () => {
  const fixed = think({ skill: 'repair', input: 'The pea grows. The pea grows. It is very green.' });
  assert.equal((fixed.match(/The pea grows\./g) ?? []).length, 1);
  assert.doesNotMatch(fixed, /very/);
  const long = 'We walked down to the river with our lunch and our boots and a map of the hills, but the rain came early and we ran back home laughing all the way.';
  assert.ok(think({ skill: 'repair', input: long }).split(/(?<=\.)\s/).length >= 2);
});

test('solve picks an idea and plans its steps', () => {
  const ideas = think({ skill: 'ideate', input: 'a quieter bedtime for the kids', angle: 'simple', seed: 2 });
  assert.equal((ideas.match(/^\d\. /gm) ?? []).length, 3);
  const solved = think({ skill: 'solve', instructions: 'pick the best idea for bedtime', input: ideas });
  assert.match(solved, /^Solution: /);
  assert.match(solved, /Steps:\n1\. /);
});

test('everything Pea Mind writes can be drawn by the Pea font', () => {
  const outputs = [];
  for (let seed = 1; seed <= 6; seed++) {
    for (const form of ['couplets', 'haiku', 'limerick', 'acrostic']) {
      const { title, text } = poem({ theme: 'peas in the garden café', form, seed });
      outputs.push(title, text);
    }
    for (const shape of Object.keys(SHAPES)) {
      const told = story({ prompt: 'a brave owl named Zoë', shape, seed });
      outputs.push(told.title, told.text);
    }
    outputs.push(...Object.values(song({ theme: 'stars', seed })), ...Object.values(familyIdeas({ prompt: 'sunny afternoon ages 4 and 7', seed })));
    outputs.push(novel({ prompt: 'a rocket 🚀', seed }).text);
    for (const skill of SKILLS) outputs.push(think({ skill, instructions: 'Labels: good, bad. Write a story', input: 'Smart “quotes” and emoji 🎉 everywhere. Tabs\there.', seed }));
  }
  for (const text of outputs) assert.deepEqual(undrawable(text), [], text);
});

test('Agent Flow sections: repair returns the improved work, verify answers the ask', () => {
  const solution = 'Solution: Grow herbs in pots on the windowsill.\nSteps:\n1. Buy seeds.\n2. Water them daily daily.';
  const reviewed = 'Review: 1 finding\nFindings:\n- Missing: compost.\nSuggestions:\n- Add a line about each missing word.';
  const fixed = think({ skill: 'repair', input: `From Solve:\n${solution}\n\nFrom Review:\n${reviewed}` });
  assert.doesNotMatch(fixed, /^From /m);
  assert.doesNotMatch(fixed, /^Review:/m);
  assert.match(fixed, /^Solution: Grow herbs/);
  assert.match(fixed, /^3\. Do not forget the compost\.$/m);
  assert.doesNotMatch(fixed, /daily daily/);

  const ask = 'Our class wants to grow herbs, but we only have a windowsill.';
  const good = think({ skill: 'verify', input: `From Ask:\n${ask}\n\nFrom Repair:\nGrow herbs in pots on the class windowsill.` });
  assert.match(good, /^Looks good: /);
  assert.doesNotMatch(good, /aim for 20/);
  assert.match(think({ skill: 'verify', input: `From Ask:\n${ask}\n\nFrom Repair:\nBake a cake for the teacher today.` }), /^Needs work: it misses /);
});

test('review picks one section when asked to pick, and headers are not words', () => {
  const ideas = ['Funny', 'Kind', 'Brave'].map(angle => `From ${angle}:\n${think({ skill: 'ideate', input: 'A name and a motto for our family band', angle: angle.toLowerCase() })}`).join('\n\n');
  const picked = think({ skill: 'review', instructions: 'Pick the best idea and say why.', input: ideas });
  assert.match(picked, /^Best: The \w+ \w+, motto "/);
  assert.match(picked, /^From: (?:Funny|Kind|Brave)$/m);
  assert.match(picked, /^Why: /m);
  const plain = think({ skill: 'review', input: 'From A:\nOne line here.\n\nFrom B:\nAnother line there.\n\nFrom C:\nA third line.' });
  assert.doesNotMatch(plain, /\bfrom \(/i);
});

test('write honours a Check retry: mentions and a word target', () => {
  const first = think({ skill: 'write', input: 'A thank-you note to our neighbour for the apples', seed: 3 });
  assert.match(first, /apples/);
  assert.match(first, /Thank you/);
  const retry = 'Please improve this. It has 12 words; it needs at least 60. Mention pears, garden.\n\nThank you for the apples. They were lovely.';
  const better = think({ skill: 'write', input: `From Ask:\nA thank-you note\n\nFrom Check:\n${retry}`, seed: 3 });
  assert.match(better, /pears/);
  assert.match(better, /garden/);
  assert.ok(better.split(/\s+/).length >= 60, better);
  assert.doesNotMatch(better, /Please improve/);
});

test('repair treats warmer and shorter as style, and plans use noun phrases', () => {
  const speech = think({ skill: 'write', input: "A short speech for my grandmother's 80th birthday", seed: 1 });
  const polished = think({ skill: 'repair', instructions: 'Make it warmer and shorter.', input: speech, seed: 1 });
  assert.doesNotMatch(polished, /Still to cover|warmer|shorter/);
  assert.ok(polished.split(/\s+/).length < speech.split(/\s+/).length + 2, polished);
  assert.notEqual(polished, speech);
  const planned = think({ skill: 'plan', input: 'Our class wants to grow vegetables, but we only have a sunny windowsill.' });
  assert.doesNotMatch(planned, /Gather what you need:/);
  assert.match(planned, /^1\. List what the vegetables need\.$/m);
});
