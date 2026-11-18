/**
 * Pea Mind: good old-fashioned AI. Rules, word banks and little grammars, no
 * model and no network, so it works anywhere and gives the same answer to
 * the same question. It writes poems, stories along Kurt Vonnegut's shapes
 * of stories, songs, novel outlines and family plans, and it stands in for a
 * language model in Agent Flow: plan, ideate, solve, test, review, repair,
 * verify, summarize, write, classify and chat.
 *
 * Everything it says uses only characters the Pea font can draw.
 */

// ---- Chance, words and sounds -----------------------------------------------

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A seeded random source: the same seed, the same sequence. */
export function rng(seed) {
  let state = Number.isInteger(seed) ? seed >>> 0 : hash(String(seed));
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, list) => list[Math.floor(random() * list.length)];
function shuffled(random, list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const capital = text => (text ? text[0].toUpperCase() + text.slice(1) : text);
const titleCase = text => text.split(' ').map(word => (['a', 'an', 'the', 'of', 'and', 'in', 'on', 'to'].includes(word) ? word : capital(word))).join(' ');
const capitalStart = text => text.replace(/^(\s*)([a-z])/, (_, space, letter) => space + letter.toUpperCase());

/** Only what the Pea font can draw. */
const ALLOWED = /[^\x20-\x7e\n•…–—‘’“”✓×°·áàâäóòôöúùûüéèêëíñç]/g;
const clean = text => String(text).replace(/\t/g, '  ').replace(ALLOWED, '').replace(/[ ]+\n/g, '\n').trim();

const SYLLABLE_EXCEPTIONS = {
  quiet: 2, poem: 2, lion: 2, idea: 3, create: 2, being: 2, ocean: 2, piano: 3, radio: 3, every: 2, people: 2,
  fire: 1, hour: 1, our: 1, flower: 2, flowers: 2, tower: 2, power: 2, science: 2, violet: 3, area: 3, video: 3,
  something: 2, someone: 2, sometimes: 2, evening: 2, family: 3, beautiful: 3, little: 2, gentle: 2, purple: 2,
  orange: 2, garden: 2, giant: 2, diamond: 2, lantern: 2, morning: 2, brightly: 2, slowly: 2, lonely: 2, lovely: 2
};

/** Roughly how many syllables an English word has; never less than one. */
export function syllables(word) {
  let w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (SYLLABLE_EXCEPTIONS[w]) return SYLLABLE_EXCEPTIONS[w];
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouytd]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  return Math.max(1, (w.match(/[aeiouy]+/g) || []).length);
}
const lineSyllables = line => line.split(/[\s-]+/).filter(Boolean).reduce((sum, word) => sum + (/[a-z]/i.test(word) ? syllables(word) : 0), 0);

/**
 * Rhyme families, by part of speech so a line can end on the right kind of
 * word: n nouns (after "the"), a adjectives, v verbs in their plain form.
 */
const RHYMES = [
  { n: ['light', 'night', 'kite', 'sight', 'flight', 'height'], a: ['bright', 'white', 'right'], v: ['write', 'invite', 'ignite', 'unite'] },
  { n: ['day', 'way', 'bay', 'hay', 'clay', 'ray'], a: ['gray'], v: ['stay', 'play', 'sway', 'say', 'stray'] },
  { n: ['sea', 'tree', 'bee', 'key'], a: ['free'], v: ['see', 'be', 'agree'] },
  { n: ['star', 'car', 'jar', 'guitar'], a: ['far'], v: [] },
  { n: ['heart', 'art', 'cart', 'start'], a: ['smart'], v: ['start', 'depart'] },
  { n: ['moon', 'tune', 'spoon', 'noon', 'balloon', 'afternoon'], a: [], v: ['croon', 'swoon'] },
  { n: ['rain', 'lane', 'train', 'chain', 'grain'], a: ['plain'], v: ['remain', 'explain'] },
  { n: ['home', 'foam', 'comb', 'dome', 'gnome'], a: [], v: ['roam'] },
  { n: ['spring', 'wing', 'ring', 'string', 'king', 'swing'], a: [], v: ['sing', 'bring', 'swing', 'cling'] },
  { n: ['love', 'dove', 'glove'], a: [], v: [] },
  { n: ['dream', 'stream', 'beam', 'team', 'cream'], a: [], v: ['dream', 'gleam', 'beam'] },
  { n: ['sky', 'pie', 'butterfly', 'lullaby'], a: ['high', 'shy', 'dry'], v: ['fly', 'try', 'sigh'] },
  { n: ['song'], a: ['long', 'strong'], v: ['belong'] },
  { n: ['hand', 'land', 'sand', 'band'], a: ['grand'], v: ['stand', 'understand', 'land'] },
  { n: ['fire', 'choir', 'wire'], a: [], v: ['admire', 'inspire'] },
  { n: ['snow', 'glow', 'bow', 'crow', 'rainbow'], a: ['slow'], v: ['grow', 'know', 'go', 'glow', 'flow'] },
  { n: ['dew', 'view', 'shoe', 'zoo', 'canoe'], a: ['blue', 'new', 'true'], v: ['do', 'renew'] },
  { n: ['bed', 'bread', 'head', 'thread', 'shed'], a: ['red'], v: ['spread', 'tread'] },
  { n: ['peas', 'breeze', 'trees', 'seas', 'bees', 'keys', 'cheese'], a: [], v: ['please', 'freeze', 'sneeze'] },
  { n: ['hill', 'mill', 'windowsill'], a: ['still', 'chill'], v: ['fill', 'spill'] },
  { n: ['face', 'place', 'space', 'lace', 'race'], a: [], v: ['chase', 'embrace', 'race'] },
  { n: ['ground', 'sound', 'mound'], a: ['round'], v: [] },
  { n: ['year', 'ear', 'deer', 'pier'], a: ['clear', 'near', 'dear'], v: ['hear', 'steer', 'cheer', 'appear'] },
  { n: ['lake', 'cake', 'flake'], a: ['awake'], v: ['make', 'bake', 'take', 'wake', 'shake'] },
  { n: ['ball', 'wall', 'hall'], a: ['small', 'tall'], v: ['call', 'fall'] },
  { n: ['gold', 'fold'], a: ['old', 'bold', 'cold'], v: ['hold', 'unfold'] },
  { n: ['boat', 'coat', 'goat', 'note'], a: ['remote'], v: ['float', 'wrote'] },
  { n: ['bear', 'chair', 'air', 'stair', 'pear'], a: ['fair', 'rare'], v: ['share', 'care', 'dare'] }
];
const rhymeWords = family => [...new Set([...family.n, ...family.a, ...family.v])];

/** Words from the built-in families that rhyme with `word`. */
export function rhymes(word) {
  const w = String(word).toLowerCase().trim();
  const family = RHYMES.find(candidate => rhymeWords(candidate).includes(w));
  return family ? rhymeWords(family).filter(other => other !== w) : [];
}

const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just let lets like me more most my myself no nor not now of off on once only or other our ours ourselves out over own please same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also get gets got make makes made want wants need needs us one two way well much many really maybe thing things stuff tell give use using let's i'm it's don't can't won't im ive i've you're we're they're shall may might must every each into onto per via`.split(/\s+/));

/** The words that matter in a text, most frequent first. */
export function keywords(text, n = 6) {
  const counts = new Map();
  const words = String(text).toLowerCase().match(/[a-zà-ÿ][a-zà-ÿ'-]*/g) ?? [];
  words.forEach((raw, index) => {
    const word = raw.replace(/'s$/, '').replace(/^[-']+|[-']+$/g, '');
    if (word.length < 3 || STOPWORDS.has(word)) return;
    const entry = counts.get(word) ?? { count: 0, first: index };
    entry.count += 1;
    counts.set(word, entry);
  });
  return [...counts].sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first).slice(0, n).map(([word]) => word);
}

/** Words that ask for something rather than describe it. */
const TASK_WORDS = new Set(['write', 'poem', 'poems', 'story', 'stories', 'song', 'songs', 'lyrics', 'haiku', 'limerick', 'acrostic', 'tale', 'novel', 'about', 'please', 'short', 'create', 'compose', 'make', 'help', 'plan', 'ideas', 'idea', 'give', 'shape', 'outline', 'chapter', 'chapters', 'couplets', 'kids', 'family']);
const themeWords = (text, n = 4) => keywords(text, n + 8).filter(word => !TASK_WORDS.has(word)).slice(0, n);

// ---- Grammars -------------------------------------------------------------------

/** Reads lines of "symbol: option | option"; '#' starts a comment line. */
export function parseGrammar(text) {
  const grammar = Object.create(null); // any symbol name, "constructor" too, means only itself
  String(text).split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) throw new Error(`line ${index + 1}: expected "symbol: option | option", got "${line.slice(0, 40)}"`);
    const options = match[2].split('|').map(option => option.trim()).filter(Boolean);
    if (!options.length) throw new Error(`line ${index + 1}: "${match[1]}" has no options`);
    (grammar[match[1]] ??= []).push(...options);
  });
  return grammar;
}

const IRREGULAR_PLURALS = { child: 'children', mouse: 'mice', sheep: 'sheep', fish: 'fish', person: 'people', man: 'men', woman: 'women', foot: 'feet', tooth: 'teeth', leaf: 'leaves', wolf: 'wolves', knife: 'knives', deer: 'deer', goose: 'geese' };
const IRREGULAR_PAST = { go: 'went', see: 'saw', run: 'ran', make: 'made', find: 'found', fly: 'flew', sing: 'sang', come: 'came', take: 'took', give: 'gave', know: 'knew', grow: 'grew', eat: 'ate', swim: 'swam', write: 'wrote', say: 'said', bring: 'brought', think: 'thought', build: 'built', sit: 'sat', hold: 'held', draw: 'drew', ride: 'rode', fall: 'fell', sleep: 'slept', keep: 'kept', dig: 'dug', win: 'won', begin: 'began', wake: 'woke', shine: 'shone' };

function plural(word) {
  const lower = word.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) return IRREGULAR_PLURALS[lower];
  if (/[^aeiou]y$/.test(lower)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${word}es`;
  return `${word}s`;
}
function past(word) {
  const lower = word.toLowerCase();
  if (IRREGULAR_PAST[lower]) return IRREGULAR_PAST[lower];
  if (lower.endsWith('e')) return `${word}d`;
  if (/[^aeiou]y$/.test(lower)) return `${word.slice(0, -1)}ied`;
  return `${word}ed`;
}
function article(word) {
  const lower = word.trim().toLowerCase();
  const an = /^(hour|honest|heir)/.test(lower) || (/^[aeiou]/.test(lower) && !/^(uni|use|one|once|eu|ew)/.test(lower));
  return `${an ? 'an' : 'a'} ${word}`;
}
const MODIFIERS = { capitalize: capital, s: plural, a: article, ed: past, caps: text => text.toUpperCase() };

/**
 * Expands #symbol# references from a grammar. #sym.capitalize#, .s, .a and
 * .ed change the word; [name:#sym#] binds `name` once for the rest of the
 * expansion, so a hero keeps one name. Symbols it does not know show as
 * ((name)); recursion stops quietly after a few levels.
 */
export function expand(grammar, start = 'origin', random = Math.random) {
  const bound = Object.create(null);
  let budget = 4000;
  const run = (text, depth) => {
    let out = '';
    for (let i = 0; i < text.length && budget > 0; i++) {
      const ch = text[i];
      if (ch === '[') {
        const end = text.indexOf(']', i);
        const colon = text.indexOf(':', i);
        if (end > 0 && colon > i && colon < end) {
          const name = text.slice(i + 1, colon).trim();
          bound[name] = [run(text.slice(colon + 1, end), depth + 1)];
          i = end;
          continue;
        }
      }
      if (ch === '#') {
        const end = text.indexOf('#', i + 1);
        if (end > i) {
          out += symbol(text.slice(i + 1, end), depth);
          i = end;
          continue;
        }
      }
      out += ch;
      budget -= 1;
    }
    return out;
  };
  const symbol = (token, depth) => {
    const [name, ...mods] = token.split('.');
    const options = bound[name] ?? grammar[name];
    if (!options?.length) return `((${name}))`;
    let value = depth > 12 ? '' : bound[name] ? options[0] : run(pick(random, options), depth + 1);
    for (const mod of mods) value = MODIFIERS[mod] ? MODIFIERS[mod](value) : value;
    return value;
  };
  if (!grammar[start]) return `((${start}))`;
  return run(`#${start}#`, 0);
}

// ---- Word banks -------------------------------------------------------------------

/** Themes for poems and songs, each found by the words it answers to. */
const THEMES = {
  garden: {
    tags: ['garden', 'pea', 'peas', 'flower', 'flowers', 'grow', 'green', 'plant', 'seed', 'seeds', 'spring', 'bloom', 'soil', 'vegetable'],
    nouns: ['pea', 'seed', 'sprout', 'bean', 'rose', 'daisy', 'snail', 'robin', 'trowel', 'leaf', 'vine', 'pod', 'puddle', 'bumblebee', 'tulip', 'sunflower', 'gate', 'path', 'worm', 'watering can'],
    adjs: ['green', 'tender', 'curly', 'golden', 'muddy', 'gentle', 'tiny', 'leafy', 'sunny', 'patient', 'busy', 'fresh']
  },
  sea: {
    tags: ['sea', 'ocean', 'beach', 'wave', 'waves', 'boat', 'ship', 'fish', 'shell', 'sail', 'tide', 'harbor', 'island', 'whale'],
    nouns: ['wave', 'shell', 'gull', 'lighthouse', 'sail', 'harbor', 'whale', 'crab', 'pebble', 'tide', 'anchor', 'driftwood', 'starfish', 'lantern', 'island', 'net'],
    adjs: ['salty', 'silver', 'restless', 'deep', 'sparkling', 'windy', 'foamy', 'wide', 'drifting', 'blue', 'calm', 'wild']
  },
  sky: {
    tags: ['sky', 'star', 'stars', 'moon', 'space', 'night', 'planet', 'rocket', 'sun', 'cloud', 'clouds', 'galaxy', 'comet', 'astronaut'],
    nouns: ['star', 'moon', 'comet', 'cloud', 'rocket', 'planet', 'owl', 'telescope', 'meteor', 'orbit', 'lantern', 'sunbeam', 'rainbow', 'constellation', 'kite'],
    adjs: ['shining', 'silver', 'endless', 'quiet', 'velvet', 'glowing', 'distant', 'twinkling', 'bright', 'starry', 'misty', 'midnight']
  },
  home: {
    tags: ['home', 'family', 'mom', 'mum', 'dad', 'mother', 'father', 'grandma', 'grandpa', 'kitchen', 'house', 'love', 'hug', 'sister', 'brother', 'baby'],
    nouns: ['kitchen', 'teapot', 'blanket', 'window', 'doorway', 'table', 'pillow', 'story', 'cookie', 'lamp', 'porch', 'sweater', 'photograph', 'garden', 'hug', 'cup'],
    adjs: ['warm', 'cozy', 'gentle', 'familiar', 'sleepy', 'kind', 'golden', 'soft', 'happy', 'patient', 'laughing', 'snug']
  },
  city: {
    tags: ['city', 'town', 'street', 'streets', 'bus', 'train', 'bridge', 'tower', 'market', 'cafe', 'subway', 'traffic', 'buildings'],
    nouns: ['street', 'bridge', 'bus', 'tower', 'market', 'cafe', 'pigeon', 'window', 'crossing', 'tram', 'rooftop', 'bicycle', 'lamppost', 'mural', 'corner', 'fountain'],
    adjs: ['busy', 'humming', 'neon', 'crowded', 'electric', 'rainy', 'bright', 'tall', 'restless', 'friendly', 'hurried', 'shining']
  },
  forest: {
    tags: ['forest', 'woods', 'tree', 'trees', 'fox', 'bear', 'owl', 'deer', 'mushroom', 'moss', 'wild', 'animal', 'animals', 'camping', 'hike'],
    nouns: ['fox', 'owl', 'fern', 'mushroom', 'acorn', 'pine', 'brook', 'hedgehog', 'badger', 'trail', 'campfire', 'squirrel', 'moss', 'stone', 'nest', 'woodpecker'],
    adjs: ['mossy', 'shady', 'wild', 'whispering', 'ancient', 'secret', 'green', 'hushed', 'tangled', 'brave', 'curious', 'rustling']
  },
  winter: {
    tags: ['winter', 'snow', 'ice', 'cold', 'frost', 'christmas', 'holiday', 'sled', 'scarf', 'mittens', 'snowman', 'december'],
    nouns: ['snowflake', 'mitten', 'sled', 'scarf', 'icicle', 'snowman', 'fireplace', 'cocoa', 'frost', 'pine', 'boot', 'candle', 'blanket', 'robin', 'window'],
    adjs: ['frosty', 'silent', 'white', 'sparkling', 'crisp', 'cozy', 'chilly', 'glittering', 'soft', 'sleepy', 'twinkling', 'snowy']
  },
  friends: {
    tags: ['friend', 'friends', 'friendship', 'school', 'play', 'team', 'together', 'class', 'teacher', 'game', 'games', 'birthday', 'party'],
    nouns: ['friend', 'game', 'secret', 'playground', 'swing', 'joke', 'adventure', 'treehouse', 'bicycle', 'sandwich', 'drawing', 'party', 'promise', 'map', 'ball'],
    adjs: ['loyal', 'silly', 'brave', 'kind', 'funny', 'clever', 'cheerful', 'trusty', 'lucky', 'giggling', 'bold', 'true']
  }
};

/** The theme that best answers to the given words, or one chosen by chance. */
function themeFor(words, random) {
  let best = null;
  let score = 0;
  for (const [name, theme] of Object.entries(THEMES)) {
    const hits = words.filter(word => theme.tags.includes(word) || theme.nouns.includes(word)).length;
    if (hits > score) { best = name; score = hits; }
  }
  return THEMES[best ?? pick(random, Object.keys(THEMES))];
}

const VERBISH = new Set(['grow', 'play', 'run', 'love', 'hug', 'fly', 'swim', 'sing', 'dance', 'go', 'see', 'learn', 'help', 'find', 'look', 'feel', 'think', 'know', 'try', 'like', 'tell']);
const nounish = word => /^[a-z]+$/.test(word) && !VERBISH.has(word) && !(word.length > 5 && /(?:ly|ing|ed|ful|ous|ive)$/.test(word));
const singular = word => (word.length < 4 || /(?:ss|us|is)$/.test(word) ? word : word.replace(/ies$/, 'y').replace(/(s|x|ch|sh)es$/, '$1').replace(/s$/, ''));
const fixArticles = text => text.replace(/\b([Aa]) (?=[aeio]|u(?!ni|s[eu]))/g, '$1n ');
const shorten = (text, n) => (text.length <= n ? text : `${text.slice(0, n).replace(/\s+\S*$/, '')}…`);

/** Words for a poem or song: the prompt's own nouns first, then a theme's. */
function wordBank(prompt, random) {
  const words = themeWords(prompt, 4);
  const theme = themeFor(words, random);
  const given = [...new Set(words.filter(word => nounish(word) && !theme.adjs.includes(word)).map(singular))];
  return { words, given, used: new Set(), nouns: [...given, ...given, ...theme.nouns.filter(noun => !given.includes(noun))], adjs: theme.adjs };
}

function familyWords(family) {
  const seen = new Map();
  for (const pos of ['n', 'a', 'v']) for (const word of family[pos]) if (!seen.has(word)) seen.set(word, pos);
  return [...seen];
}

/** Rhyme families, the ones that share words with the theme first. */
function rhymeOrder(bank, random) {
  const known = new Set([...bank.words, ...bank.nouns, ...bank.adjs]);
  const score = family => rhymeWords(family).filter(word => known.has(word)).length;
  return shuffled(random, RHYMES).sort((a, b) => score(b) - score(a));
}
const rhymePair = (family, random) => shuffled(random, familyWords(family)).slice(0, 2);

/** A line that ends on `end`, shaped for its part of speech. */
function endLine(end, pos, bank, random) {
  const noun = () => pick(random, bank.nouns);
  const adj = () => pick(random, bank.adjs);
  const lines = {
    n: [
      () => `I found a ${adj()} ${noun()} beside the ${end}`,
      () => `the ${noun()} went looking for the ${end}`,
      () => `we sang a ${adj()} song about the ${end}`,
      () => `and every ${noun()} remembers the ${end}`,
      () => `a ${adj()} wind is blowing past the ${end}`
    ],
    a: [
      () => `and all the ${plural(noun())} grow ${end}`,
      () => `till every ${noun()} feels ${end}`,
      () => `the ${adj()} morning, wide and ${end}`,
      () => `and the ${noun()} looks ${end}`
    ],
    v: [
      () => `and teach the ${plural(noun())} to ${end}`,
      () => `we wait for the ${noun()} to ${end}`,
      () => `the ${adj()} ${noun()} learns to ${end}`,
      () => `so come along and ${end}`
    ]
  };
  // A poem should not lean on one line shape; use each before repeating one.
  const fresh = lines[pos].map((make, i) => i).filter(i => !bank.used.has(`${pos}${i}`));
  const i = pick(random, fresh.length ? fresh : lines[pos].map((make, j) => j));
  bank.used.add(`${pos}${i}`);
  return fixArticles(lines[pos][i]());
}

function couplets(bank, random, families) {
  return families.flatMap(family => {
    const [[a, posA], [b, posB]] = rhymePair(family, random);
    return [`${capital(endLine(a, posA, bank, random))},`, `${capital(endLine(b, posB, bank, random))}.`];
  });
}

const FILLERS = ['now', 'still', 'and', 'so', 'oh', 'here', 'soft', 'slow'];

/** A line of exactly `target` syllables: the closest fit, padded with fillers. */
function fitLine(target, makers, random) {
  let best = { line: '', gap: target };
  for (let tries = 0; tries < 40 && best.gap > 0; tries++) {
    const line = fixArticles(pick(random, makers)());
    const gap = target - lineSyllables(line);
    if (gap >= 0 && gap < best.gap) best = { line, gap };
  }
  return [...shuffled(random, FILLERS).slice(0, best.gap), best.line].join(' ').trim();
}

function haiku(bank, random) {
  const n = () => pick(random, bank.nouns);
  const a = () => pick(random, bank.adjs);
  const short = [() => `${a()} ${n()} at dawn`, () => `the ${a()} ${n()}`, () => `a ${n()} in the rain`, () => `${n()} by the ${n()}`, () => `light on the ${n()}`, () => `the ${n()} is ${a()}`];
  const long = [() => `the ${a()} ${n()} waits for the ${n()}`, () => `a ${n()} hums beside the ${n()}`, () => `under the ${a()} ${n()}`, () => `the ${n()} and the ${n()} rest`, () => `we listen to the ${n()} grow`];
  return [capital(fitLine(5, short, random)), fitLine(7, long, random), fitLine(5, short, random)];
}

const WHO = ['gardener', 'robot', 'grandma', 'astronaut', 'inventor', 'baker', 'otter', 'dragon', 'owl', 'artist', 'explorer', 'uncle', 'elephant'];

function limerick(bank, random) {
  const families = rhymeOrder(bank, random);
  const aFamily = families.find(family => family.n.length >= 3);
  const bFamily = families.find(family => family !== aFamily);
  const [a1, a2, a3] = shuffled(random, aFamily.n);
  const [[b1, p1], [b2, p2]] = rhymePair(bFamily, random);
  const noun = () => pick(random, bank.nouns);
  const adj = () => pick(random, bank.adjs);
  const who = pick(random, WHO);
  const third = { n: `they went off to find the ${b1}`, a: `the ${noun()} was ${b1}`, v: `they started to ${b1}` };
  const fourth = { n: `and danced with the ${b2}`, a: `and the sky turned ${b2}`, v: `and learned how to ${b2}` };
  const lines = [
    `There once was ${article(who)} by the ${a1},`,
    `who kept ${article(`${adj()} ${noun()}`)} near the ${a2};`,
    `${capital(third[p1])},`,
    `${fourth[p2]},`,
    `so they sang ${article(adj())} song to the ${a3}.`
  ].map(line => capital(fixArticles(line)));
  return { title: `The ${capital(who)} by the ${capital(a1)}`, lines };
}

/** Line starters for acrostics, at least one for every letter. */
const ALPHA = {
  a: ['Always {a}, like a {n}', 'After the rain, a {n} sings'],
  b: ['Bright as a {a} {n}', 'Bring me a {n}'],
  c: ['Calm and {a}', 'Carry the {n} home'],
  d: ['Dancing with a {n}', 'Dreaming of {a} things'],
  e: ['Every {n} has a story', 'Early light on the {n}'],
  f: ['Found in the {n}', 'Full of {a} wonder'],
  g: ['Gently, the {n} grows', 'Golden as a {n}'],
  h: ['Hello, {a} {n}', 'Hold the {n} close'],
  i: ['In the {a} morning', 'Imagine a {n}'],
  j: ['Just a {a} {n}', 'Jump over the {n}'],
  k: ['Kind as a {n}', 'Keep the {n} safe'],
  l: ['Look at the {n}', 'Little {a} {n}'],
  m: ['Many {a} days', 'Make room for the {n}'],
  n: ['Now the {n} wakes', 'Never too {a}'],
  o: ['Over the {n}', 'Only a {a} {n}'],
  p: ['Patient as a {n}', 'Play by the {n}'],
  q: ['Quiet as a {n}', 'Quick, the {n} is here'],
  r: ['Ready for the {n}', 'Round and {a}'],
  s: ['Softly, a {n}', 'Sing to the {n}'],
  t: ['Tiny {a} {n}', 'Through the {n} we go'],
  u: ['Under the {n}', 'Up goes the {n}'],
  v: ['Very {a} indeed', 'Visit the {n}'],
  w: ['Waiting for the {n}', 'With a {a} {n}'],
  x: ['X marks the {n}', 'Xylophone songs for the {n}'],
  y: ['Yes to the {n}', 'Yellow as a {n}'],
  z: ['Zooming past the {n}', 'Zigzag, {a} {n}']
};

function acrostic(word, bank, random) {
  return [...word].map(letter => fixArticles(pick(random, ALPHA[letter])
    .replace(/\{n\}/g, () => pick(random, bank.nouns))
    .replace(/\{a\}/g, () => pick(random, bank.adjs))));
}

/** A poem: couplets, a 5-7-5 haiku, an AABBA limerick or an acrostic. */
export function poem({ theme = '', form = 'couplets', seed = 1 } = {}) {
  const random = rng(`poem:${form}:${theme}:${seed}`);
  const bank = wordBank(theme, random);
  const subject = bank.words[0] ?? pick(random, bank.nouns);
  let title;
  let lines;
  if (form === 'haiku') {
    title = `Haiku: ${capital(subject)}`;
    lines = haiku(bank, random);
  } else if (form === 'limerick') {
    ({ title, lines } = limerick(bank, random));
  } else if (form === 'acrostic') {
    const word = (bank.words[0] ?? '').replace(/[^a-z]/g, '').slice(0, 10) || 'pea';
    title = word.toUpperCase();
    lines = acrostic(word, bank, random);
  } else {
    title = titleCase(`${pick(random, bank.adjs)} ${subject}`);
    lines = couplets(bank, random, rhymeOrder(bank, random).slice(0, 4));
  }
  return { title: clean(title), text: clean(lines.join('\n')) };
}

// ---- Stories ------------------------------------------------------------------------

const shapeOf = (title, about, beats) => ({ title, about, beats: beats.map(([kind, fortune]) => ({ kind, fortune })) });

/**
 * Kurt Vonnegut's shapes of stories: good fortune (1) and ill fortune (-1)
 * from the beginning of a story to its end, one beat at a time.
 */
export const SHAPES = {
  'man-in-hole': shapeOf('Man in Hole', 'Someone falls into trouble and climbs out, a little better off.',
    [['ordinary', 0.3], ['trouble', -0.3], ['fall', -0.7], ['struggle', -0.4], ['rescue', 0.2], ['triumph', 0.6], ['ending', 0.5]]),
  'boy-meets-girl': shapeOf('Boy Meets Girl', 'Someone finds something wonderful, loses it, then gets it back for good.',
    [['ordinary', 0], ['gift', 0.6], ['triumph', 0.7], ['loss', -0.6], ['struggle', -0.3], ['reunion', 0.6], ['ending', 0.8]]),
  cinderella: shapeOf('Cinderella', 'A hard start, a magical lift, a sudden fall, then joy ever after.',
    [['ordinary', -0.6], ['gift', -0.2], ['gift', 0.3], ['triumph', 0.6], ['fall', -0.5], ['rescue', 0.4], ['triumph', 0.9], ['ending', 1]]),
  'from-bad-to-worse': shapeOf('From Bad to Worse', 'Things start badly and keep getting worse.',
    [['ordinary', -0.3], ['trouble', -0.5], ['worse', -0.7], ['worse', -0.85], ['confusion', -0.9], ['ending', -1]]),
  'which-way-is-up': shapeOf('Which Way Is Up?', 'Good news or bad news? As in real life, it is hard to tell.',
    [['ordinary', 0], ['gift', 0.3], ['trouble', -0.3], ['gift', 0.2], ['confusion', -0.2], ['rescue', 0.3], ['confusion', -0.1], ['ending', 0]]),
  creation: shapeOf('Creation Story', 'Gift after gift, a world is made, step by step.',
    [['ordinary', 0], ['creation', 0.2], ['creation', 0.4], ['gift', 0.55], ['creation', 0.7], ['triumph', 0.85], ['ending', 0.9]]),
  'old-testament': shapeOf('Old Testament', 'Gifts from above, then a great fall.',
    [['ordinary', 0.1], ['gift', 0.4], ['creation', 0.6], ['triumph', 0.8], ['trouble', 0.2], ['fall', -0.8], ['ending', -0.5]]),
  'new-testament': shapeOf('New Testament', 'Gifts, a great fall, then a rise higher than ever.',
    [['ordinary', 0.1], ['gift', 0.4], ['triumph', 0.7], ['trouble', 0], ['fall', -0.8], ['rescue', 0.6], ['triumph', 1], ['ending', 1]])
};

const SHAPE_CUES = {
  'man-in-hole': /\bman[- ]in[- ](?:a[- ])?hole\b|\bin a hole\b/,
  'boy-meets-girl': /\bboy[- ]meets[- ]girl\b/,
  cinderella: /\bcinderella\b/,
  'from-bad-to-worse': /\bbad[- ]to[- ]worse\b/,
  'which-way-is-up': /\bwhich[- ]way\b/,
  creation: /\bcreation\b/,
  'old-testament': /\bold[- ]testament\b/,
  'new-testament': /\bnew[- ]testament\b/
};
const shapeIn = text => Object.keys(SHAPE_CUES).find(key => SHAPE_CUES[key].test(String(text).toLowerCase()));
const SHAPE_NOISE = new Set(['man', 'hole', 'boy', 'meets', 'girl', 'cinderella', 'bad', 'worse', 'which', 'way', 'creation', 'old', 'new', 'testament', 'vonnegut', 'kurt', 'bedtime', 'fable', 'named', 'called']);

const HEROES = ['Pip', 'Mira', 'Otto', 'Juno', 'Bea', 'Finn', 'Nell', 'Ravi', 'Ada', 'Milo', 'Kiko', 'Sol'];
const FRIENDS = [
  { first: 'Moss the old tortoise', later: 'Moss' },
  { first: 'Bolt the tin robot', later: 'Bolt' },
  { first: 'Wren the clever crow', later: 'Wren' },
  { first: 'Fig the striped cat', later: 'Fig' },
  { first: 'Pebble the shy dragon', later: 'Pebble' },
  { first: 'Tam from next door', later: 'Tam' }
];
const PLACES = ['garden', 'forest', 'woods', 'sea', 'ocean', 'beach', 'city', 'town', 'village', 'moon', 'island', 'mountain', 'mountains', 'school', 'castle', 'river', 'lake', 'desert', 'library', 'farm', 'kitchen', 'park', 'jungle', 'cave', 'meadow', 'harbor', 'zoo', 'museum', 'valley'];
const PLACE_BANK = [
  { first: 'a little seaside town', later: 'the town' },
  { first: 'a garden full of peas', later: 'the garden' },
  { first: 'a cottage at the edge of the woods', later: 'the cottage' },
  { first: 'a city of bridges', later: 'the city' },
  { first: 'a valley of windmills', later: 'the valley' }
];
/** Who a story is about, never the thing they carry. */
const CREATURES = new Set(['fox', 'owl', 'cat', 'dog', 'bear', 'rabbit', 'bunny', 'mouse', 'dragon', 'robot', 'bird', 'girl', 'boy', 'kid', 'child', 'princess', 'prince', 'knight', 'frog', 'unicorn', 'puppy', 'kitten', 'hedgehog', 'badger', 'squirrel', 'deer', 'whale', 'crab', 'turtle', 'tortoise', 'pig', 'duck', 'hero', 'friend', 'giant', 'witch', 'wizard', 'monster', 'penguin', 'lion', 'tiger', 'elephant', 'otter', 'goat', 'sheep']);
const OBJECTS = ['lantern', 'map', 'kite', 'paper boat', 'seed', 'compass', 'music box', 'key', 'umbrella'];
const WISHES = ['to see the sea', 'to grow the biggest pea in the world', 'to find out where the wind goes', 'to build a boat that could fly', 'to hear the stars sing', 'to make a friend who really understood them'];
const TROUBLES = [
  { first: 'a storm', later: 'the storm' },
  { first: 'a thick gray fog', later: 'the fog' },
  { first: 'a grumpy giant', later: 'the giant' },
  { first: 'a flood', later: 'the flood' },
  { first: 'a long, dark winter', later: 'the winter' },
  { first: 'a terrible rumor', later: 'the rumor' }
];

/** A capitalized word that is not the start of a sentence, read as a name. */
function properName(text) {
  for (const match of text.matchAll(/\b[A-Z][a-z]+\b/g)) {
    const before = text.slice(0, match.index).trim();
    const lower = match[0].toLowerCase();
    if (!before || /[.!?:]$/.test(before)) continue;
    if (STOPWORDS.has(lower) || TASK_WORDS.has(lower) || SHAPE_NOISE.has(lower) || PLACES.includes(lower) || lower === 'pea') continue;
    return match[0];
  }
  return null;
}

/** Words for people, who can be in a story but are not the thing it is about. */
const PEOPLE = /^(?:keeper|teacher|girl|boy|man|men|woman|women|king|queen|child|children|kid|friend|grandma|grandpa|granny|mother|father|mom|mum|dad|sister|brother|baby|princess|prince|farmer|doctor|pirate|knight|wizard|witch|neighbour|neighbor|family|people|person)s?$/;

/** The people, place and things of a story, chosen once and kept. */
function castFor(prompt, random) {
  const text = String(prompt);
  const named = /\b(?:named|called)\s+([A-Za-z][a-z]+)/i.exec(text)?.[1];
  const hero = capital((named ?? properName(text) ?? pick(random, HEROES)).toLowerCase());
  const words = themeWords(text, 6).filter(word => word !== hero.toLowerCase() && !SHAPE_NOISE.has(word));
  const placeWord = words.find(word => PLACES.includes(word));
  // The last word of a phrase such as "a brave little boat" is its thing; the words before only describe it.
  const heads = [...text.matchAll(/\b(?:a|an|the|my|our|your|his|her|its|their)\s+(?:[a-z]+\s+){0,3}?([a-z]+)\b(?=\s+(?:a|an|the|in|on|at|who|that|with|and|of|from|to|by|for)\b|\s*[.,!?;]|\s*$)/gi)].map(match => match[1].toLowerCase());
  const objectWord = [...heads, ...words].find(word => word !== placeWord && word !== hero.toLowerCase() && !STOPWORDS.has(word) && !TASK_WORDS.has(word) && nounish(word) && !CREATURES.has(singular(word)) && !PEOPLE.test(word));
  return {
    hero,
    place: placeWord ? `the ${placeWord}` : pick(random, PLACE_BANK),
    object: objectWord ? singular(objectWord) : pick(random, OBJECTS),
    friend: pick(random, FRIENDS.filter(friend => friend.later !== hero)),
    wish: pick(random, WISHES),
    trouble: pick(random, TROUBLES)
  };
}

/** What happens in each kind of beat. The hero is they, and mostly named. */
const BEATS = {
  ordinary: [
    '{Hero} lived in {place}, where every day was a lot like the one before. More than anything, {hero} wanted {wish}.',
    'In {place} there lived {hero}, who was small and curious and wished, every single night, {wish}.'
  ],
  gift: [
    'One morning {friend} came by with {objectA}. "This is for you," they said. "It might help."',
    '{Hero} found {objectA} tucked under a stone. It hummed softly, as if it knew a secret.',
    'Something good happened: {friend} showed {hero} a trick that made everything a little easier.'
  ],
  trouble: [
    'But then {trouble} came to {place}, and nothing felt easy anymore.',
    'Then, without warning, {trouble} arrived. {Hero} held the {object} tight and tried to be brave.'
  ],
  fall: [
    'Things got worse. The {object} was lost, and {hero} sat down in the dark and felt very small.',
    '{Hero} tried and failed, and tried and failed again. It seemed the wish would never come true.'
  ],
  struggle: [
    '{Hero} did not give up. Step by step, they kept going, even when their legs were tired.',
    'So {hero} made a plan. It was not a very good plan, but it was a start, and {hero} started.'
  ],
  rescue: [
    'Just then, {friend} appeared. "You do not have to do this alone," they said, and stood right beside {hero}.',
    'A small light flickered. It was the {object}, shining again and pointing the way.'
  ],
  triumph: [
    'At last, after everything, {hero} got the chance {wish}, and it was even better than they had dreamed.',
    'Everyone in {place} cheered. {Hero} laughed out loud, and the {object} glowed like a little sun.'
  ],
  loss: [
    'But good things can slip away. One windy night the {object} was gone, and {friend} had gone too.',
    '{Hero} and {friend} had a silly argument, and for a long time neither of them said a word.'
  ],
  reunion: [
    '{Hero} searched everywhere, and there, waiting by the gate, was {friend}. "I missed you," they both said at once.',
    'The {object} came back, a little scratched but whole, and {hero} hugged it close.'
  ],
  worse: [
    'And then it got worse. {Trouble} grew bigger, and the path home disappeared.',
    'Even {friend} could not help this time. The wind took the {object} far away.'
  ],
  confusion: [
    'Nobody knew which way was up anymore. Was this good news or bad? {Hero} could not tell.',
    '{Hero} sat with the {object} in their lap and wondered what any of it meant.'
  ],
  creation: [
    '{Hero} gathered string and bark and a little starlight, and began to make something new.',
    'Little by little, {place} filled with new things: a path, a song, a small green sprout.',
    'Each day {hero} added one more piece, and each day the world grew a little bigger.'
  ]
};
const ENDINGS = {
  happy: [
    'And from then on, whenever anyone in {place} felt small, they remembered {hero}, and felt a little braver. The end.',
    'That night {hero} fell asleep smiling, with the {object} close by. The end.'
  ],
  sad: [
    'Some stories end in rain. {Hero} still keeps the {object} on the windowsill, and on quiet nights it glows. The end.',
    '{Hero} never did get the chance {wish}. But they learned how to keep going, and that mattered too. The end.'
  ],
  open: [
    '{Hero} still is not sure if it all ended well. But they are sure it was worth it, and maybe that is enough. The end.',
    'Was it a happy ending? {Hero} thinks about that sometimes, holding the {object}. The end.'
  ]
};

/** Fills a beat template from the cast; a friend or trouble is introduced once. */
function teller(cast) {
  const seen = new Set();
  return template => capitalStart(template.replace(/\{(\w+)\}/g, (_, key) => {
    const name = key.toLowerCase();
    let value = name === 'objecta' ? article(cast.object) : cast[name];
    if (value && typeof value === 'object') {
      value = seen.has(name) ? value.later : value.first;
      seen.add(name);
    }
    return /^[A-Z]/.test(key) ? capital(value) : value;
  }));
}

function beatTeller(cast, random) {
  const tell = teller(cast);
  const used = new Set();
  return (kind, fortune) => {
    const options = kind === 'ending' ? ENDINGS[fortune > 0.2 ? 'happy' : fortune < -0.2 ? 'sad' : 'open'] : BEATS[kind];
    const fresh = options.filter(option => !used.has(option));
    const template = pick(random, fresh.length ? fresh : options);
    used.add(template);
    return tell(template);
  };
}

/** A short story that follows one of the SHAPES, one paragraph per beat. */
export function story({ prompt = '', shape = 'man-in-hole', seed = 1 } = {}) {
  const key = SHAPES[shape] ? shape : 'man-in-hole';
  const random = rng(`story:${key}:${prompt}:${seed}`);
  const cast = castFor(prompt, random);
  const beat = beatTeller(cast, random);
  const { beats } = SHAPES[key];
  const points = beats.map(({ kind, fortune }, i) => ({ t: beats.length > 1 ? i / (beats.length - 1) : 0, fortune, beat: kind }));
  const text = beats.map(({ kind, fortune }) => beat(kind, fortune)).join('\n\n');
  return { title: clean(`${cast.hero} and the ${titleCase(cast.object)}`), text: clean(text), shape: key, points };
}

const CHAPTERS = {
  ordinary: ['At Home', 'An Ordinary Day'], gift: ['The {Object}', 'A Surprise'], trouble: ['Clouds Gather', 'Trouble Comes'],
  fall: ['The Bottom of the Hole', 'Lost'], struggle: ['One Step More', 'The Plan'], rescue: ['A Hand in the Dark', 'Help Arrives'],
  triumph: ['The Bright Day', 'Hooray'], loss: ['What Slipped Away', 'Gone'], reunion: ['Found Again', 'Together'],
  worse: ['Further Down', 'Even Worse'], confusion: ['Which Way Is Up', 'Good News, Bad News'], creation: ['Making Something', 'New Things'],
  ending: ['The Last Page', 'Afterwards']
};

/** A novel outline: the shape stretched over `chapters` chapters. */
export function novel({ prompt = '', shape = 'cinderella', chapters = 8, seed = 1 } = {}) {
  const key = SHAPES[shape] ? shape : 'cinderella';
  const count = Math.max(1, Math.min(40, Math.round(Number(chapters)) || 8));
  const random = rng(`novel:${key}:${count}:${prompt}:${seed}`);
  const cast = castFor(prompt, random);
  const beat = beatTeller(cast, random);
  const { beats, title: shapeTitle, about } = SHAPES[key];
  const titled = new Map();
  const points = [];
  const parts = [`A novel in ${count} chapter${count === 1 ? '' : 's'}, shaped like ${shapeTitle}: ${about.charAt(0).toLowerCase()}${about.slice(1)}`];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const at = t * (beats.length - 1);
    const lo = Math.floor(at);
    const hi = Math.min(beats.length - 1, lo + 1);
    const fortune = Math.round((beats[lo].fortune + (beats[hi].fortune - beats[lo].fortune) * (at - lo)) * 100) / 100;
    const kind = i === count - 1 ? 'ending' : beats[Math.round(at)].kind;
    points.push({ t, fortune, beat: kind });
    const seen = titled.get(kind) ?? 0;
    titled.set(kind, seen + 1);
    const heading = CHAPTERS[kind][seen % CHAPTERS[kind].length].replace('{Object}', titleCase(cast.object));
    const mood = fortune >= 0.6 ? ` ${cast.hero} felt like they could fly.` : fortune <= -0.6 ? ` It was one of the hardest days ${cast.hero} had ever known.` : '';
    parts.push(`Chapter ${i + 1} · ${heading}\n${beat(kind, fortune)}${kind === 'ending' ? '' : mood}`);
  }
  return { title: clean(`${cast.hero} and the ${titleCase(cast.object)}`), text: clean(parts.join('\n\n')), points };
}

// ---- Songs ------------------------------------------------------------------------

/** Lyrics: verse, chorus, verse, chorus, bridge, chorus. */
export function song({ theme = '', seed = 1 } = {}) {
  const random = rng(`song:${theme}:${seed}`);
  const bank = wordBank(theme, random);
  const families = rhymeOrder(bank, random);
  const hook = `${pick(random, bank.adjs)} ${bank.given[0] ?? pick(random, bank.nouns)}`;
  const chorus = [`${capital(hook)}, ${hook},`, ...couplets(bank, random, [families[0]]), `${capital(hook)}, oh ${hook}.`];
  const sections = [
    ['Verse 1', couplets(bank, random, families.slice(1, 3))],
    ['Chorus', chorus],
    ['Verse 2', couplets(bank, random, families.slice(3, 5))],
    ['Chorus', chorus],
    ['Bridge', couplets(bank, random, families.slice(5, 6))],
    ['Chorus', chorus]
  ];
  return { title: clean(titleCase(hook)), text: clean(sections.map(([label, lines]) => `[${label}]\n${lines.join('\n')}`).join('\n\n')) };
}

// ---- Family ideas ------------------------------------------------------------------------

const ACTIVITIES = [
  ['Blanket fort reading den', 'indoor', 'free', 2, 12, 1, 60, 'Build a fort from chairs and blankets; read by flashlight.'],
  ['Kitchen volcano', 'indoor', 'cheap', 4, 12, 2, 30, 'Baking soda, vinegar and a drop of dish soap in a cup.'],
  ['Living room obstacle course', 'indoor', 'free', 3, 10, 3, 45, 'Pillows to hop, a table to crawl under, tape to balance on.'],
  ['Cardboard box city', 'indoor', 'free', 3, 10, 2, 90, 'Turn boxes into houses and shops; draw windows and roads.'],
  ['Family bake-off', 'indoor', 'some', 4, 99, 1, 90, 'Bake simple muffins; everyone decorates and names one.'],
  ['Shadow puppet show', 'indoor', 'free', 3, 12, 1, 45, 'A lamp, a wall and your hands: make animals, tell a tale.'],
  ['Board game tournament', 'indoor', 'free', 5, 99, 1, 120, 'Pick three games, keep score, award a paper medal.'],
  ['Draw-and-pass comic', 'indoor', 'free', 5, 99, 1, 30, 'Each person draws one panel, then passes it on.'],
  ['Sock puppet theater', 'indoor', 'cheap', 3, 10, 1, 60, 'Buttons and yarn for faces; a table on its side for a stage.'],
  ['Indoor picnic', 'indoor', 'cheap', 1, 99, 1, 60, 'Spread a blanket on the floor and eat lunch like it is summer.'],
  ['Freeze dance party', 'indoor', 'free', 2, 12, 3, 20, 'Play music; when it stops, everyone freezes like a statue.'],
  ['Plant a pea in a jar', 'indoor', 'cheap', 3, 12, 1, 20, 'A wet paper towel, a jar and a pea: watch the roots grow.'],
  ['Family talent show', 'indoor', 'free', 3, 99, 2, 60, 'Everyone takes a turn: a song, a joke, a trick.'],
  ['Homemade pizza night', 'indoor', 'some', 4, 99, 1, 90, 'Everyone tops their own small pizza.'],
  ['Letter to a grandparent', 'indoor', 'free', 4, 99, 1, 30, 'Write and draw a letter; tuck in a leaf or a photo.'],
  ['Fruit rainbow sticks', 'indoor', 'cheap', 3, 99, 1, 20, 'Thread fruit onto sticks in rainbow order.'],
  ['Paper airplane contest', 'either', 'free', 4, 99, 2, 30, 'Fold three designs and see which one flies farthest.'],
  ['Story stones', 'either', 'free', 3, 10, 1, 30, 'Draw pictures on stones; pull three to start a story.'],
  ['Library adventure', 'either', 'free', 2, 99, 1, 60, 'Each person picks a book for someone else.'],
  ['Museum mystery hunt', 'either', 'some', 5, 99, 2, 120, 'Everyone picks one object and invents its secret story.'],
  ['Nature scavenger hunt', 'outdoor', 'free', 3, 12, 2, 60, 'Find something soft, something round, something red.'],
  ['Bike or scooter loop', 'outdoor', 'free', 4, 99, 3, 60, 'Pick a safe loop in the park and time a lap together.'],
  ['Picnic in the park', 'outdoor', 'cheap', 1, 99, 1, 90, 'Pack sandwiches, fruit and a ball; find a shady tree.'],
  ['Sidewalk chalk gallery', 'outdoor', 'cheap', 2, 12, 1, 45, 'Draw a gallery on the sidewalk and title each picture.'],
  ['Cloud watching', 'outdoor', 'free', 2, 99, 1, 20, 'Lie on the grass and name the shapes drifting by.'],
  ['Bug safari', 'outdoor', 'free', 3, 10, 2, 45, 'Look under leaves and stones, gently, and count tiny animals.'],
  ['Backyard camping', 'outdoor', 'some', 4, 99, 2, 180, 'Pitch a tent, tell stories, listen for night sounds.'],
  ['Bird spotting walk', 'outdoor', 'free', 4, 99, 1, 45, 'Count birds on a walk; listen first, then look.'],
  ['Water balloon relay', 'outdoor', 'cheap', 4, 12, 3, 30, 'Pass a balloon down the line without dropping it.'],
  ['Garden helpers', 'outdoor', 'free', 3, 99, 2, 45, 'Water plants, pull weeds, look for snails and worms.'],
  ['Stargazing night', 'outdoor', 'free', 4, 99, 1, 45, 'Wait for dark; find the Moon and one bright planet.'],
  ['Build a snow family', 'snow', 'free', 3, 99, 2, 60, 'Make a snow person for each of you, with sticks and hats.'],
  ['Snow angels and tracks', 'snow', 'free', 2, 99, 2, 30, 'Make snow angels, then guess who left the tracks you find.']
].map(([name, setting, cost, minAge, maxAge, energy, minutes, how]) => ({ name, setting, cost, minAge, maxAge, energy, minutes, how }));

const SNACKS = ['apple slices with cinnamon', 'popcorn in paper cones', 'yogurt with berries', 'cucumber coins and hummus', 'cheese and cracker towers', 'banana pancakes', 'warm cocoa', 'a bowl of sweet green peas'];
const STARTERS = [
  'If you could talk to one animal, which one, and what would you ask?',
  'What made you laugh today?',
  'If our family had a flag, what would be on it?',
  'What is something hard you did this week?',
  'If you invented a holiday, how would we celebrate it?',
  'What would you do with a pocket full of peas?'
];
const FACTS = [
  'An octopus has three hearts.',
  'A day on Venus is longer than its whole year.',
  'Bananas are berries, but strawberries are not.',
  'Butterflies taste with their feet.',
  'Gregor Mendel discovered how traits pass from parents to children by growing peas.',
  'Light from the Sun takes about 8 minutes to reach Earth.',
  'A group of flamingos is called a flamboyance.',
  'Hummingbirds can fly backwards.',
  'Snowflakes usually have six sides.',
  'The Moon has moonquakes.'
];
const WHERE = { indoor: 'indoors', outdoor: 'outdoors', either: 'in or out', snow: 'in the snow' };
const PRICE = { free: 'free', cheap: 'cheap', some: 'costs a little' };

/** Three activities, a snack, a question for dinner and a fact to learn. */
export function familyIdeas({ prompt = '', seed = 1 } = {}) {
  const text = String(prompt).toLowerCase();
  const random = rng(`family:${text}:${seed}`);
  const rainy = /\b(rain|rainy|raining|wet|storm|stormy|indoors?|inside)\b/.test(text);
  const snowy = /\b(snow|snowy|snowing)\b/.test(text);
  const sunny = !rainy && /\b(sun|sunny|warm|outdoors?|outside|park|summer)\b/.test(text);
  const ages = /\bages?\b|\byears?[- ]?olds?\b|\byrs?\b/.test(text) ? (text.match(/\b\d{1,2}\b/g) ?? []).map(Number).filter(age => age <= 18) : [];
  if (/\btoddlers?\b/.test(text)) ages.push(2);
  if (/\bteens?\b|\bteenagers?\b/.test(text)) ages.push(13);
  const cost = /\b(free|no money|no cost)\b/.test(text) ? ['free'] : /\b(cheap|inexpensive|budget|low cost)\b/.test(text) ? ['free', 'cheap'] : null;
  const hours = /(\d+)\s*hours?\b/.exec(text);
  const minutes = hours ? Number(hours[1]) * 60 : /\bhour\b/.test(text) ? 60 : /\bevening\b/.test(text) ? 120 : /\bafternoon\b/.test(text) ? 180 : Infinity;
  const energy = /\b(calm|quiet|tired|chill|cozy|relaxed)\b/.test(text) ? 'low' : /\b(energy|energetic|active|burn|wild)\b/.test(text) ? 'high' : null;
  const settings = rainy ? ['indoor', 'either'] : sunny ? ['outdoor', 'either'] : ['indoor', 'outdoor', 'either'];
  if (snowy) settings.push('snow');

  // Where and what it costs always hold; the rest give way if too few fit.
  const fits = [
    activity => settings.includes(activity.setting),
    activity => !cost || cost.includes(activity.cost),
    activity => !ages.length || (activity.minAge <= Math.min(...ages) && activity.maxAge >= Math.max(...ages)),
    activity => activity.minutes <= minutes,
    activity => !energy || (energy === 'low' ? activity.energy <= 1 : activity.energy >= 2)
  ];
  const chosen = [];
  for (let keep = fits.length; keep >= 2 && chosen.length < 3; keep--) {
    const pool = shuffled(random, ACTIVITIES).filter(activity => !chosen.includes(activity) && fits.slice(0, keep).every(fit => fit(activity)));
    if (snowy) pool.sort((a, b) => (b.setting === 'snow') - (a.setting === 'snow'));
    chosen.push(...pool.slice(0, 3 - chosen.length));
  }

  const asked = [rainy && 'rainy', snowy && 'snowy', sunny && 'sunny', cost && cost.join(' or '), ages.length && `ages ${Math.min(...ages)}${ages.length > 1 ? `-${Math.max(...ages)}` : ''}`, Number.isFinite(minutes) && `up to ${minutes} min`, energy && `${energy} energy`].filter(Boolean);
  const lines = [];
  if (asked.length) lines.push(`Picked for: ${asked.join(', ')}`, '');
  chosen.forEach((activity, i) => lines.push(`${i + 1}. ${activity.name} · ${WHERE[activity.setting]} · ${PRICE[activity.cost]} · ${activity.minutes} min`, `   ${activity.how}`));
  lines.push('', `Snack: ${pick(random, SNACKS)}.`, `Ask everyone: ${pick(random, STARTERS)}`, `Learn together: ${pick(random, FACTS)}`);
  const day = rainy ? ' for a rainy day' : snowy ? ' for a snowy day' : sunny ? ' for a sunny day' : '';
  return { title: clean(`Family ideas${day}`), text: clean(lines.join('\n')) };
}

// ---- Thinking skills ------------------------------------------------------------------------

export const SKILLS = ['plan', 'ideate', 'solve', 'test', 'review', 'repair', 'verify', 'summarize', 'write', 'classify', 'chat'];

const SKILL_CUES = {
  plan: ['plan', 'planning', 'steps', 'schedule', 'roadmap', 'organize', 'prepare', 'agenda'],
  ideate: ['ideate', 'brainstorm', 'ideas', 'invent', 'imagine', 'options', 'alternatives'],
  solve: ['solve', 'solution', 'choose', 'decide', 'pick', 'best'],
  test: ['test', 'tests', 'check', 'checks', 'criteria'],
  review: ['review', 'critique', 'feedback', 'improve', 'proofread'],
  repair: ['repair', 'fix', 'rewrite', 'revise', 'edit', 'correct'],
  verify: ['verify', 'confirm', 'validate', 'approve'],
  summarize: ['summarize', 'summarise', 'summary', 'tldr', 'shorten', 'recap', 'gist'],
  write: ['write', 'poem', 'story', 'song', 'lyrics', 'novel', 'haiku', 'limerick', 'acrostic', 'tale', 'family', 'kids', 'weekend', 'letter', 'note', 'speech'],
  classify: ['classify', 'categorize', 'categorise', 'category', 'label', 'labels', 'tag']
};
const CUE_WEIGHT = { family: 2, poem: 2, story: 2, song: 2, haiku: 2, limerick: 2, novel: 2, lyrics: 2 };

const wordsOf = text => String(text).toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
const sentencesOf = text => String(text).split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.trim()).filter(Boolean);
const norm = sentence => sentence.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const joinAnd = list => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+/;

/** Which skill a request asks for, by its words; 'chat' when none stands out. */
export function skillFor(text) {
  let best = 'chat';
  let score = 0;
  const words = wordsOf(text);
  for (const skill of SKILLS) {
    const cues = SKILL_CUES[skill] ?? [];
    const hits = words.reduce((sum, word) => sum + (cues.includes(word) ? CUE_WEIGHT[word] ?? 1 : 0), 0);
    if (hits > score) { best = skill; score = hits; }
  }
  return best;
}

/** Instructions that say how to change a text, not what it is about. */
const STYLES = {
  shorter: /\b(?:short|shorter|shorten|brief|briefer|tighter|concise|trim)\b/,
  simpler: /\b(?:simple|simpler|easier|clearer|plainer|plain)\b/,
  warmer: /\b(?:warm|warmer|kinder|friendlier|sweeter|loving)\b/,
  funnier: /\b(?:funny|funnier|sillier|silly|playful)\b/,
  longer: /\b(?:longer|expand|lengthen|fuller)\b/
};
const STYLE_WORDS = new Set([...Object.values(STYLES).flatMap(pattern => pattern.source.match(/[a-z]+/g)), 'better', 'nicer', 'tone', 'polish', 'improve', 'daring', 'surprising', 'careful', 'safe', 'bold', 'brave', 'kind']);

/** Words that name the job rather than the subject. */
const SKILL_WORDS = new Set([...SKILLS, ...Object.values(SKILL_CUES).flat(), 'draft', 'text', 'input', 'output', 'step', 'below', 'above', 'following', 'answer', 'based', 'given', 'list', 'short', 'sure', 'result', 'results', 'ideas', 'idea', 'goal', 'angle', 'say', 'why', 'tell', 'explain', 'reason', 'judge', 'pick', 'choose', 'best']);
const subjectWord = word => !SKILL_WORDS.has(word) && !TASK_WORDS.has(word) && !STYLE_WORDS.has(word);
const goalWords = (text, n = 5) => keywords(text, n + 12).filter(subjectWord).slice(0, n);
const stemOf = word => word.slice(0, Math.max(4, word.length - 2));
const covers = (text, word) => wordsOf(text).some(other => other.startsWith(stemOf(word)));

// ---- What flows in: sections, a retry's note, the goal --------------------------------------

/** "From Plan:" sections, as Agent Flow joins several inputs. */
const SECTION = /(?:^|\n\n)From ([^\n:]{1,40}):\n/g;

/** A Check node's retry: "Please improve this. It has 12 words; it needs at least 25. Mention apples." */
function feedbackOf(text) {
  const match = /^Please improve this\.([^\n]*)(?:\n+|$)/.exec(text);
  if (!match) return null;
  const note = match[1];
  return {
    rest: text.slice(match[0].length).trim(),
    mention: (/Mention ([^.]+)\./.exec(note)?.[1] ?? '').split(',').map(word => word.trim()).filter(Boolean),
    min: Number(/at least (\d+)/.exec(note)?.[1] ?? 0),
    max: Number(/keep it to (\d+)/.exec(note)?.[1] ?? 0)
  };
}

function sectionsOf(text) {
  const all = String(text);
  const marks = [...all.matchAll(SECTION)];
  const parts = [];
  const lead = all.slice(0, marks[0]?.index ?? all.length).trim();
  if (lead) parts.push({ from: '', text: lead });
  marks.forEach((mark, i) => parts.push({ from: mark[1].trim(), text: all.slice(mark.index + mark[0].length, marks[i + 1]?.index ?? all.length).trim() }));
  for (const part of parts) {
    const feedback = feedbackOf(part.text);
    if (feedback) { part.feedback = feedback; part.text = feedback.rest; }
  }
  return parts;
}

const goalLine = text => /^Goal:\s*(.+)$/m.exec(text)?.[1].trim() ?? null;
const isReview = part => /^Review:/m.test(part.text) || /review|judge|critic/i.test(part.from);
const isTest = part => /^Checks: \d/m.test(part.text) || /^test/i.test(part.from);
const isAsk = part => /^(?:ask|request|question|goal|task|you)$/i.test(part.from);
const isPlan = part => /^Goal:/m.test(part.text);

/** The piece of work among the sections: not the ask, a review or a test. */
function workOf(parts) {
  const rest = parts.filter(part => !isReview(part) && !isTest(part) && !isAsk(part));
  return rest.find(part => /solve|draft|write|writer|work|answer|repair|polish/i.test(part.from)) ?? rest.at(-1) ?? parts.at(-1) ?? { from: '', text: '' };
}

/** What the work is for: the ask's words, a plan's goal and the instructions. */
function goalTextOf({ parts, instructions }) {
  return [instructions, ...parts.filter(isAsk).map(part => part.text), ...parts.map(part => goalLine(part.text)).filter(Boolean)].join('\n');
}

// ---- Editing helpers ------------------------------------------------------------------------

function sentenceScore(sentence, freq) {
  const words = wordsOf(sentence);
  return words.reduce((sum, word) => sum + (freq.get(word) ?? 0), 0) / Math.sqrt(words.length || 1);
}
function frequencies(text) {
  const freq = new Map();
  for (const word of wordsOf(text)) if (word.length > 2 && !STOPWORDS.has(word)) freq.set(word, (freq.get(word) ?? 0) + 1);
  return freq;
}

/** Splits a long sentence at the conjunction nearest its middle. */
function splitLong(sentence) {
  if (wordsOf(sentence).length <= 22) return [sentence];
  const marks = [...sentence.matchAll(/,\s+(?:and|but|so|because|while)\s+|;\s+/g)];
  if (!marks.length) return [sentence];
  const middle = sentence.length / 2;
  const mark = marks.reduce((a, b) => (Math.abs(b.index - middle) < Math.abs(a.index - middle) ? b : a));
  const joiner = /^,\s+(but|so)\s+$/.exec(mark[0])?.[1];
  const tail = sentence.slice(mark.index + mark[0].length).trim();
  return [`${sentence.slice(0, mark.index).trim()}.`, capital(joiner ? `${joiner} ${tail}` : tail)];
}

const VAGUE = ['thing', 'things', 'stuff', 'very', 'really', 'nice', 'good', 'bad', 'somehow', 'etc', 'whatever', 'basically'];
const VAGUE_FIX = [
  [/\b(?:very|really|basically) (?=\w)/gi, ''],
  [/\b(?:kind|sort) of /gi, ''],
  [/\ba lot of\b/gi, 'many'],
  [/\bstuff\b/gi, 'materials'],
  [/\bthings\b/gi, 'parts'],
  [/\bthing\b/gi, 'part'],
  [/\bnice\b/gi, 'pleasant']
];
const devague = sentence => capitalStart(VAGUE_FIX.reduce((text, [pattern, swap]) => text.replace(pattern, swap), sentence));

/** Drops repeated sentences and doubled words, splits long sentences, sharpens vague words. */
function tidy(text) {
  const seen = new Set();
  const lines = [];
  for (const line of text.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1').split('\n')) {
    const lead = LIST_ITEM.exec(line)?.[0] ?? '';
    const body = line.slice(lead.length);
    if (!body.trim()) {
      if (lines.length && lines.at(-1) !== '') lines.push('');
      continue;
    }
    const kept = sentencesOf(body).filter(sentence => {
      const key = norm(sentence);
      if (key.split(' ').length < 2) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).flatMap(splitLong).map(devague);
    if (kept.length) lines.push(lead + kept.join(' '));
  }
  return lines.join('\n').trim();
}

const SYNONYMS = { good: 'fine', great: 'wonderful', big: 'large', small: 'little', happy: 'glad', make: 'build', help: 'support', idea: 'plan', ideas: 'plans', start: 'begin', use: 'try', show: 'share' };

/** Past its second use, an overused word gives way to a synonym, when there is one. */
function varyRepeats(text, words) {
  let out = text;
  for (const word of words) {
    if (!SYNONYMS[word]) continue;
    let seen = 0;
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), match => (++seen > 2 ? SYNONYMS[word] : match));
  }
  return out;
}

/** The paragraph that carries the body of a text, not a greeting or a sign-off. */
function proseIndex(paragraphs) {
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (!LIST_ITEM.test(paragraphs[i]) && wordsOf(paragraphs[i]).length >= 8) return i;
  }
  return paragraphs.length - 1;
}
function addSentences(text, sentences) {
  if (!sentences.length) return text;
  const paragraphs = text.split('\n\n');
  const i = Math.max(0, proseIndex(paragraphs));
  paragraphs[i] = `${(paragraphs[i] ?? '').trimEnd()} ${sentences.join(' ')}`.trim();
  return paragraphs.join('\n\n');
}

/** A sentence that brings in a word the work was asked to mention. */
function mentionOf(word) {
  if (/^thank/i.test(word)) return 'Thank you so much.';
  if (/^(?:love|sorry|please|hello|welcome|congratulations)$/i.test(word)) return `${capital(word.toLowerCase())}!`;
  return `And not to forget: the ${word}.`;
}

/** Adds what is missing: a step to a list of steps, a sentence to prose. */
function addMissing(text, words) {
  if (!words.length) return text;
  const lines = text.split('\n');
  const last = lines.findLastIndex(line => /^\s*\d+[.)]\s/.test(line));
  if (last >= 0) {
    const n = Number(/\d+/.exec(lines[last])[0]);
    lines.splice(last + 1, 0, `${n + 1}. Do not forget the ${joinAnd(words)}.`);
    return lines.join('\n');
  }
  return addSentences(text, words.map(mentionOf));
}

/** Drops the least telling middle sentences until the text is about `ratio` of its length. */
function trimText(text, ratio) {
  const lines = text.split('\n');
  const total = wordsOf(text).length;
  const target = Math.ceil(total * ratio);
  const freq = frequencies(text);
  const split = lines.map(line => (LIST_ITEM.test(line) ? null : sentencesOf(line)));
  const candidates = [];
  split.forEach((sentences, li) => {
    if (!sentences || sentences.length < 3) return;
    sentences.forEach((sentence, si) => {
      if (si > 0 && si < sentences.length - 1) candidates.push({ li, si, words: wordsOf(sentence).length, score: sentenceScore(sentence, freq) });
    });
  });
  candidates.sort((a, b) => a.score - b.score || b.words - a.words);
  let count = total;
  const drop = new Set();
  for (const candidate of candidates) {
    if (count <= target) break;
    drop.add(`${candidate.li}:${candidate.si}`);
    count -= candidate.words;
  }
  return lines.map((line, li) => (split[li] ? split[li].filter((_, si) => !drop.has(`${li}:${si}`)).join(' ') : line)).join('\n');
}

const MORE = [
  'It made a real difference to us.',
  'We will remember it for a long time.',
  'Every part of it was done with care.',
  'We hope you know how much it meant.',
  'It was a small thing that made a big difference.',
  'There is always more to say, but this is the heart of it.',
  'We are grateful, today and every day.',
  'Thank you for being part of our story.'
];
/** Grows a text past `min` words with sentences it does not have yet. */
function extend(text, min, random) {
  let out = text;
  for (const sentence of shuffled(random, MORE)) {
    if (wordsOf(out).length >= min) break;
    if (!out.includes(sentence)) out = addSentences(out, [sentence]);
  }
  return out;
}

const WARM = ['It means more than words can say.', 'Our hearts are full.', 'We are so grateful for you.', 'You make every day a little brighter.'];
const JOKES = ['And yes, someone will still try to sing.', 'No peas were harmed in the making of this.', 'We promise the next one will have fewer puns.', 'The cat has approved this message.'];
const PLAIN = { utilize: 'use', utilise: 'use', purchase: 'buy', approximately: 'about', assist: 'help', additional: 'more', numerous: 'many', however: 'but', therefore: 'so', commence: 'start', sufficient: 'enough', regarding: 'about', individuals: 'people' };

/** Changes the tone or size of a text, as instructions like "warmer and shorter" ask. */
function restyle(text, styles, random) {
  let out = text;
  if (styles.includes('shorter')) out = trimText(out, 0.7);
  if (styles.includes('simpler')) out = out.replace(/\b[A-Za-z]+\b/g, word => (PLAIN[word.toLowerCase()] ? (/^[A-Z]/.test(word) ? capital(PLAIN[word.toLowerCase()]) : PLAIN[word.toLowerCase()]) : word));
  if (styles.includes('longer')) out = extend(out, Math.ceil(wordsOf(out).length * 1.3), random);
  if (styles.includes('warmer')) {
    out = out.replace(/\b(?:Regards|Sincerely|Best wishes),/g, 'With love,').replace(/\bHello everyone\b/g, 'Hello, dear family and friends');
    out = addSentences(out, [pick(random, WARM.filter(line => !out.includes(line)))]);
  }
  if (styles.includes('funnier')) out = addSentences(out, [pick(random, JOKES)]);
  return out;
}
const stylesIn = instructions => Object.keys(STYLES).filter(style => STYLES[style].test(instructions.toLowerCase()));

/** Meets what a Check asked for: words to mention and a word count. */
function meet(text, needs, random) {
  let out = text;
  const missing = needs.mention.filter(word => !out.toLowerCase().includes(word.toLowerCase()));
  out = addSentences(out, missing.map(mentionOf));
  if (needs.min) out = extend(out, needs.min + 3, random);
  if (needs.max) for (let tries = 0; tries < 4 && wordsOf(out).length > needs.max; tries++) out = trimText(out, (needs.max - 2) / wordsOf(out).length);
  return out;
}

/** "Mention apples, thank" and "at least 25 words" in a node's own instructions. */
function needsIn(instructions, feedback) {
  const asked = /\bmention\s+([^.\n]+)/i.exec(instructions)?.[1] ?? '';
  return {
    mention: [...new Set([...(feedback?.mention ?? []), ...asked.split(/,|\band\b/).map(word => word.trim()).filter(Boolean)])],
    min: Math.max(feedback?.min ?? 0, Number(/at least (\d+) words/i.exec(instructions)?.[1] ?? 0)),
    max: feedback?.max || Number(/(?:at most|no more than|under) (\d+) words/i.exec(instructions)?.[1] ?? 0)
  };
}

// ---- The skills ------------------------------------------------------------------------

/** The subject's things: of its leading words, the longer tend to be things, not people. */
const things = subject => keywords(subject, 10).filter(word => nounish(word) && subjectWord(word)).slice(0, 4).sort((a, b) => b.length - a.length);

function plan(task) {
  const { instructions, input } = task;
  const subject = goalLine(input) ?? (input.trim() || instructions.trim());
  const goal = shorten((sentencesOf(subject)[0] ?? 'Make something good together').replace(LIST_ITEM, '').replace(/[.!?]+$/, ''), 90);
  const constraints = sentencesOf(`${instructions}\n${subject}`)
    .filter(sentence => /\b(must|should|only|without|no more than|under|before|budget|deadline|at most|at least|less than|need to|cannot|can't|don't)\b/i.test(sentence))
    .slice(0, 4);
  const listed = subject.split('\n').filter(line => LIST_ITEM.test(line)).map(line => line.replace(LIST_ITEM, '').trim());
  const [k1, k2] = things(subject);
  const needs = k1 && /[^s]s$/.test(k1) ? 'need' : 'needs';
  const steps = listed.length >= 2 ? listed : [
    k1 ? `List what the ${k1} ${needs}.` : 'List what you will need.',
    k2 ? `Think about the ${k2} and what matters most.` : 'Decide what matters most.',
    'Try a small first version.',
    'Check it against the goal and the constraints.',
    'Fix what fell short, then share it.'
  ];
  return [
    `Goal: ${goal}.`,
    'Constraints:',
    ...(constraints.length ? constraints.map(sentence => `- ${sentence}`) : ['- None stated.']),
    'Steps:',
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    'Done when: the goal is met and every constraint holds.'
  ].join('\n');
}

const SWAPS = ['game', 'song', 'map', 'checklist', 'picture', 'story', 'timer'];
const MODELS = ['beehive', 'library', 'recipe', 'relay race', 'garden', 'orchestra', 'treasure hunt'];
const FIRST_STEPS = ['sketch it on paper', 'try it for ten minutes', 'ask one person what they think', 'build the smallest version', 'list what it needs'];
const SCAMPER = {
  substitute: (k1, k2, random) => `Substitute: swap the ${k1} for ${article(pick(random, SWAPS))} and see what changes.`,
  combine: (k1, k2) => `Combine: join the ${k1} with the ${k2}, so one does the work of two.`,
  adapt: (k1, k2, random) => `Adapt: borrow the way ${article(pick(random, MODELS))} works and use it for the ${k1}.`,
  magnify: k1 => `Magnify: make the ${k1} ten times bigger, louder or more often.`,
  'other use': (k1, k2) => `Other use: use the ${k2} in a new way, to help the ${k1}.`,
  eliminate: (k1, k2) => `Eliminate: cut everything but the ${k1} and the ${k2}, then add back only what you miss.`,
  reverse: (k1, k2) => `Reverse: start from the ${k2} and work back toward the ${k1}.`
};
const ANGLES = [
  ['simple', /simple|small|easy|safe|cheap|careful|kind|gentle/, ['eliminate', 'adapt', 'substitute']],
  ['bold', /bold|wild|big|daring|crazy|brave|funny|silly/, ['magnify', 'reverse', 'combine']]
];

const NAME_ADJS = {
  funny: ['Wobbly', 'Giggling', 'Sneezing', 'Bouncy', 'Silly', 'Jolly'],
  kind: ['Gentle', 'Cozy', 'Kindly', 'Sunny', 'Helping', 'Warm'],
  brave: ['Bold', 'Brave', 'Fearless', 'Roaring', 'Mighty', 'Thunder'],
  other: ['Bright', 'Merry', 'Little', 'Lucky', 'Golden', 'Starry']
};
const NAME_NOUNS = ['Peas', 'Pickles', 'Penguins', 'Teapots', 'Socks', 'Rockets', 'Lanterns', 'Owls', 'Pancakes', 'Comets', 'Foxes', 'Kettles'];
const MOTTOS = {
  funny: ['Mistakes are just bonus fun.', 'Loud, proud and a little bit silly.', 'We came, we saw, we tripped over the cat.'],
  kind: ['Every voice belongs.', 'Listen closely, act kindly.', 'Better together, always.'],
  brave: ['Louder than thunder.', 'We never skip the hard part.', 'Fear less, try more.'],
  other: ['Together we shine.', 'Small group, big heart.', 'One more time, with feeling!']
};

/** Names, and mottos when asked: what "a name for our band" needs, not SCAMPER. */
function nameIdeas(subject, angle, head, random) {
  const mood = /funny|silly/.test(angle) ? 'funny' : /kind|gentle|careful|safe/.test(angle) ? 'kind' : /brave|bold|daring/.test(angle) ? 'brave' : 'other';
  const adjs = shuffled(random, NAME_ADJS[mood]);
  const nouns = shuffled(random, NAME_NOUNS);
  const mottos = shuffled(random, MOTTOS[mood]);
  const motto = /\b(?:motto|mottos|slogan|slogans)\b/i.test(subject);
  const ideas = [0, 1, 2].map(i => `${i + 1}. The ${adjs[i]} ${nouns[i]}${motto ? `\n   Motto: "${mottos[i]}"` : ''}`);
  return [...(head.length ? [head.join('\n')] : []), ...ideas].join('\n\n');
}

function ideate({ instructions, input, angle, random }) {
  const subject = goalLine(input) ?? (input.trim() || instructions.trim());
  const head = [];
  if (subject) head.push(`Ideas for: ${shorten(sentencesOf(subject)[0], 60)}`);
  if (angle) head.push(`Angle: ${angle}`);
  if (/\b(?:name|names|motto|mottos|slogan|title|titles)\b/i.test(subject)) return nameIdeas(subject, angle, head, random);
  const words = things(subject);
  const k1 = words[0] ?? 'idea';
  const k2 = words[1] ?? 'helper';
  const prefer = ANGLES.find(([, pattern]) => pattern.test(angle))?.[2] ?? [];
  const order = [...shuffled(random, prefer).slice(0, 2), ...shuffled(random, Object.keys(SCAMPER).filter(key => !prefer.includes(key)))];
  const firsts = shuffled(random, FIRST_STEPS);
  const ideas = order.slice(0, 3).map((key, i) => `${i + 1}. ${SCAMPER[key](k1, k2, random)}\n   First step: ${firsts[i]}.`);
  return [...(head.length ? [head.join('\n')] : []), ...ideas].join('\n\n');
}

/** The words ideate's own templates bring, which say nothing about an idea. */
const SCAFFOLD = new Set(wordsOf([...Object.entries(SCAMPER).map(([key, make]) => `${key} ${make('', '', () => 0)}`), ...FIRST_STEPS, 'first step motto'].join(' ')));
for (const word of [...SWAPS, ...MODELS].flatMap(wordsOf)) SCAFFOLD.delete(word);
const STRATEGY = /^(substitute|combine|adapt|magnify|other use|eliminate|reverse):\s*/i;

/** Idea blocks: split at blank lines, headings and numbered or bulleted lines. */
function ideaBlocks(text) {
  const blocks = [];
  let current = [];
  const flush = () => {
    if (current.length) blocks.push(current.join(' '));
    current = [];
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^(?:#+\s|\d+[.)]\s|[-*•]\s|idea\b)/i.test(line)) flush();
    current.push(line);
  }
  flush();
  return blocks
    .map(block => block.replace(/^(?:#+\s*|\d+[.)]\s*|[-*•]\s*)/, '').trim())
    .filter(block => wordsOf(block).length >= 3 && !/^(?:ideas for|angle)\s*:/i.test(block));
}

function scoreIdea(block, goal) {
  const words = wordsOf(block);
  let score = goal.filter(word => covers(block, word)).length * 3;
  if (words.length >= 3 && words.length <= 50) score += 2;
  if (/\d|first step|\btry\b|\bbuild\b|\bstart\b|\btest\b/i.test(block)) score += 1;
  if (/\b(?:eliminate|simple|small|adapt)\b/i.test(block)) score += 1;
  return score;
}
const ideaText = block => block.replace(/\s*First step:.*$/i, '').replace(STRATEGY, '').replace(/\s+Motto:\s*/, ', motto ').trim();

function solve(task) {
  const { parts, instructions } = task;
  const goalText = parts.map(part => goalLine(part.text)).find(Boolean) ?? parts.filter(isAsk).map(part => part.text).join(' ');
  const ideasIn = parts.filter(part => !isPlan(part) && !isAsk(part)).map(part => part.text).join('\n\n');
  const blocks = ideaBlocks(ideasIn || task.input);
  if (!blocks.length) return 'Solution: nothing to choose from yet.\nGive me some ideas to compare.';
  const goal = goalWords(`${instructions}\n${goalText}`);
  const ranked = blocks.map((block, index) => ({ block, index, score: scoreIdea(block, goal) })).sort((a, b) => b.score - a.score || a.index - b.index);
  const [best, runner] = ranked;
  const strategy = STRATEGY.exec(best.block)?.[1].toLowerCase();
  const matching = goal.filter(word => covers(best.block, word));
  const borrowed = runner && keywords(runner.block, 12).find(word => !covers(best.block, word) && !SKILL_WORDS.has(word) && !SCAFFOLD.has(word));
  const first = /first step:\s*([^.\n]+)/i.exec(best.block)?.[1];
  const lines = [];
  if (goalText) lines.push(`Goal: ${shorten(goalText.replace(/[.!?]+$/, ''), 90)}.`);
  lines.push(
    `Solution: ${capital(shorten(ideaText(best.block), 140))}`,
    `Why: it ranked first of ${ranked.length} idea${ranked.length === 1 ? '' : 's'}${matching.length ? ` and fits ${joinAnd(matching)}` : ''}${strategy ? `; it ${strategy === 'other use' ? 'finds another use' : `is the ${strategy} idea`}` : ''}.`
  );
  if (borrowed) lines.push(`Borrowed: keep the ${borrowed} from the runner-up.`);
  lines.push(
    'Steps:',
    `1. Start small: ${first ?? 'try it once, for ten minutes'}.`,
    `2. ${borrowed ? `Fold in the ${borrowed}.` : 'Note what worked and what did not.'}`,
    `3. Check the result against the goal${goal.length ? `: ${joinAnd(goal.slice(0, 3))}` : ''}.`
  );
  return lines.join('\n');
}

/** The checks that test runs: does the work cover the goal, and read well? */
function checks(text, goal) {
  const words = wordsOf(text);
  const covered = goal.filter(word => covers(text, word));
  const missing = goal.filter(word => !covered.includes(word));
  const seen = new Set();
  const repeats = sentencesOf(text).filter(sentence => {
    const key = norm(sentence);
    if (key.split(' ').length < 3) return false;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  const first = text.split('\n')[0].trim();
  return [
    { pass: !goal.length || covered.length * 2 >= goal.length, yes: goal.length ? `covers the goal: ${joinAnd(covered)}` : 'no goal words to cover', no: `misses the goal: ${missing.join(', ')}` },
    { pass: /^\s*(?:\d+[.)]|[-*•])\s/m.test(text) || /\bsteps?\b/i.test(text), yes: 'has steps to follow', no: 'has no steps or list' },
    { pass: words.length >= 20 && words.length <= 600, yes: `a sensible length, ${words.length} words`, no: `${words.length} words; aim for 20 to 600` },
    { pass: !repeats.length, yes: 'no repeated sentences', no: `repeats: "${shorten(repeats[0] ?? '', 40)}"` },
    { pass: first.length > 0 && first.length <= 80, yes: 'a clear first line', no: first ? 'the first line runs long' : 'the first line is empty' }
  ];
}
const checkLine = check => `${check.pass ? '✓' : '×'} ${check.pass ? check.yes : check.no}`;

function test(task) {
  const work = workOf(task.parts);
  const results = checks(work.text, goalWords(goalTextOf(task), 4));
  return [`Checks: ${results.filter(check => check.pass).length}/${results.length} passed`, ...results.map(checkLine)].join('\n');
}

/** Does the answer do what was asked? A plain verdict first, then the reasons. */
function verify(task) {
  const { parts } = task;
  const ask = parts.find(isAsk) ?? (parts.length > 1 ? parts[0] : null);
  const answer = parts.filter(part => part !== ask && !isReview(part) && !isTest(part)).at(-1)?.text ?? task.input;
  const goal = goalWords([task.instructions, ask?.text ?? '', goalLine(answer) ?? ''].join('\n'), 5);
  const words = wordsOf(answer);
  const covered = goal.filter(word => covers(answer, word));
  const missing = goal.filter(word => !covered.includes(word));
  const seen = new Set();
  const repeat = sentencesOf(answer).find(sentence => {
    const key = norm(sentence);
    if (key.split(' ').length < 3) return false;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  const results = [
    { pass: words.length >= 5, yes: `it says enough, ${words.length} words`, no: words.length ? `it is too short to judge, ${words.length} word${words.length === 1 ? '' : 's'}` : 'there is no answer yet' },
    { pass: !goal.length || covered.length * 2 >= goal.length, yes: goal.length ? `it answers ${joinAnd(covered)}` : 'there were no goal words to check', no: `it misses ${joinAnd(missing)}` },
    { pass: !repeat, yes: 'it does not repeat itself', no: `it repeats "${shorten(repeat ?? '', 40)}"` },
    { pass: !/\(\([\w-]+\)\)|^From [^\n:]+:$|^Please improve this\./m.test(answer), yes: 'nothing is left unfinished', no: 'it has unfinished parts' },
    { pass: words.length <= 600, yes: 'it is not too long', no: `it runs long, ${words.length} words` }
  ];
  const failing = results.filter(check => !check.pass);
  const verdict = failing.length ? `Needs work: ${failing.map(check => check.no).join('; ')}.` : `Looks good: ${results.slice(0, 3).map(check => check.yes).join(', ')}.`;
  return [verdict, ...results.map(checkLine)].join('\n');
}

/** Review, when asked to pick: the best idea among the sections, and why. */
function judge(task) {
  const { parts, random } = task;
  const ideaParts = parts.filter(part => !isAsk(part) && !isPlan(part));
  const heads = parts.map(part => /^Ideas for:\s*(.+)$/m.exec(part.text)?.[1]).filter(Boolean);
  const goal = goalWords([goalTextOf(task), ...heads].join('\n'));
  const candidates = ideaParts.flatMap(part => ideaBlocks(part.text).map(block => ({ block, from: part.from, score: scoreIdea(block, goal) + random() })));
  if (!candidates.length) return 'Nothing to pick from yet.';
  const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
  const text = ideaText(best.block);
  const reasons = [];
  const matching = goal.filter(word => covers(best.block.replace(/\bMotto:/i, ''), word));
  if (matching.length) reasons.push(`it fits ${joinAnd(matching)}`);
  if (wordsOf(text).length <= 14) reasons.push('it is short and easy to remember');
  if (best.from) reasons.push(`it brings ${article(best.from.toLowerCase())} touch`);
  if (/first step/i.test(best.block)) reasons.push('it comes with a first step to try');
  if (!reasons.length) reasons.push('it is the clearest of the ideas');
  return [`Best: ${text}`, ...(best.from ? [`From: ${best.from}`] : []), `Why: ${joinAnd(reasons)}.`].join('\n');
}

function review(task) {
  if (/\b(?:pick|choose|best|judge|winner|favou?rite)\b/i.test(task.instructions)) return judge(task);
  const { parts } = task;
  const text = workOf(parts).text;
  if (!text) return 'Nothing to review yet.';
  const words = wordsOf(text);
  const findings = [];
  const suggestions = [];
  const doubled = text.match(/\b(\w+)\s+\1\b/i);
  if (doubled) {
    findings.push(`Doubled word: "${doubled[0]}".`);
    suggestions.push('Remove the doubled word.');
  }
  const counts = frequencies(text);
  const overused = [...counts].filter(([word, count]) => word.length >= 4 && count >= 3 && count / words.length > 0.03).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (overused.length) {
    findings.push(`Overused: ${overused.map(([word, count]) => `${word} (${count} times)`).join(', ')}.`);
    suggestions.push('Swap a few repeats for fresh words.');
  }
  const long = sentencesOf(text).filter(sentence => wordsOf(sentence).length > 22);
  if (long.length) {
    findings.push(`${long.length} long sentence${long.length === 1 ? '' : 's'}, like "${shorten(long[0], 40)}"`);
    suggestions.push('Split sentences over 22 words.');
  }
  const vague = [...new Set(words.filter(word => VAGUE.includes(word)))];
  if (vague.length) {
    findings.push(`Vague words: ${vague.join(', ')}.`);
    suggestions.push('Name the real thing instead of a vague word.');
  }
  const missing = goalWords(goalTextOf(task), 4).filter(word => !covers(text, word));
  if (missing.length) {
    findings.push(`Missing: ${missing.join(', ')}.`);
    suggestions.push('Add a line about each missing word.');
  }
  for (const line of (parts.find(isTest)?.text ?? '').split('\n').filter(line => line.startsWith('×'))) findings.push(`Test: ${line.slice(1).trim()}.`);
  if (!findings.length) return 'Review: no findings\nIt reads clearly.\nSuggestions:\n- Read it aloud once and trust your ear.';
  if (!suggestions.length) suggestions.push('Fix what the test found.');
  return [`Review: ${findings.length} finding${findings.length === 1 ? '' : 's'}`, 'Findings:', ...findings.map(line => `- ${line}`), 'Suggestions:', ...suggestions.map(line => `- ${line}`)].join('\n');
}

/** The work, improved: what the review found fixed, in the style asked for. */
function repair(task) {
  const { parts, instructions, random } = task;
  const work = workOf(parts);
  if (!work.text.trim()) return 'Nothing to repair yet.';
  const notes = [parts.find(isReview)?.text ?? '', parts.find(isTest)?.text ?? ''].join('\n');
  let text = tidy(work.text);
  text = varyRepeats(text, [...notes.matchAll(/(\w+) \(\d+ times\)/g)].map(match => match[1]));
  const missing = new Set([
    ...(/^- Missing: ([^.\n]+)/m.exec(notes)?.[1].split(/,\s*/) ?? []),
    ...(/misses the goal: ([^.\n]+)/.exec(notes)?.[1].split(/,\s*/) ?? []),
    ...goalWords(instructions, 4)
  ].map(word => word.trim()).filter(word => word && subjectWord(word) && !covers(text, word)));
  text = addMissing(text, [...missing]);
  text = restyle(text, stylesIn(instructions), random);
  return meet(text, needsIn(instructions, work.feedback), random);
}

function summarize({ instructions, input }) {
  const text = input.trim() || instructions.trim();
  const sentences = sentencesOf(text).filter(sentence => wordsOf(sentence).length >= 3);
  if (!sentences.length) return 'Nothing to summarize yet.';
  const freq = frequencies(text);
  const want = /\bone sentence\b/i.test(instructions) ? 1 : Math.max(1, Math.min(3, Math.ceil(sentences.length / 4)));
  const top = sentences
    .map((sentence, index) => ({ sentence, index, score: sentenceScore(sentence, freq) + (index === 0 ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, want)
    .sort((a, b) => a.index - b.index)
    .map(({ sentence }) => (/[.!?]$/.test(sentence) ? sentence : `${sentence}.`).replace(LIST_ITEM, ''));
  return `${top.join(' ')}\n\nKey words: ${keywords(text, 5).join(', ')}`;
}

/** A plain descriptive paragraph, when no form was asked for. */
function describe(text, random) {
  const bank = wordBank(text, random);
  const subject = bank.words[0] ?? pick(random, bank.nouns);
  const a = () => pick(random, bank.adjs);
  const n = () => pick(random, bank.nouns);
  const sentences = [
    `Think of ${article(`${a()} ${subject}`)}.`,
    `It sits somewhere between the ${n()} and the ${n()}, ${a()} and a little ${a()}.`,
    `Up close you notice small things: ${article(n())}, ${article(n())}, the way the light changes.`,
    `That is the heart of ${subject}: paying attention, and sharing what you find.`
  ];
  return { title: titleCase(`${a()} ${subject}`), text: fixArticles(sentences.join(' ')) };
}

const KIN = { grandmother: 'Grandma', grandma: 'Grandma', granny: 'Granny', grandfather: 'Grandpa', grandpa: 'Grandpa', mother: 'Mum', mum: 'Mum', mom: 'Mom', father: 'Dad', dad: 'Dad', aunt: 'Auntie', auntie: 'Auntie' };
const RECIPIENT = /\b(?:to|for)\s+(?:our|my|the|a|your)?\s*(neighbou?rs?|grandmother|grandma|granny|grandfather|grandpa|teachers?|mum|mom|mother|dad|father|friends?|aunt|auntie|uncle|coach|nurse|doctor|class|team|family|sister|brother|cousin|librarian)\b/;
const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
const LETTER = /\b(?:note|letter|card|speech|toast|thank|thanks|thank-you|invitation|invite|message|email|apology|sorry)\b/;

/** Notes, cards, letters and speeches: thanks, birthdays, sorry, invitations. */
function letter(request, random) {
  const lower = request.toLowerCase();
  const who = RECIPIENT.exec(lower)?.[1];
  const name = who ? KIN[who] ?? capital(who) : null;
  const age = /\b(\d{1,3})(?:st|nd|rd|th)?\s+birthday\b/.exec(lower)?.[1];
  const birthday = age ? `${ordinal(Number(age))} birthday` : 'birthday';
  const reasonMatch = [...lower.matchAll(/\bfor\s+((?:the|our|my|your|all the|those|these|all)\s+)?([a-z][a-z' -]{1,30}?)\s*(?=[.,!?\n]|$)/g)]
    .filter(match => !RECIPIENT.test(`for ${match[2]}`)).at(-1);
  const reason = reasonMatch ? `${reasonMatch[1] ?? (/ing\b/.test(reasonMatch[2]) ? '' : 'the ')}${reasonMatch[2]}`.trim() : null;
  const near = /neighbou?r/.test(who ?? '') ? 'next door' : 'in our lives';
  const sign = /neighbou?r/.test(who ?? '') ? 'Your neighbours' : 'From all of us';
  const speech = /\b(?:speech|toast)\b/.test(lower);
  const memories = shuffled(random, [
    `${name ?? 'You'} taught us how to laugh at a burnt cake and how to really listen.`,
    `${name ?? 'You'} always had a story, a snack and a hug ready, usually in that order.`,
    `Whenever one of us needed help, ${name ?? 'you'} was there first, with a cup of tea and a kind word.`,
    `${age ? `${age} years` : 'All these years'} of stories, songs and good advice, and we hope for many more.`
  ].map(line => line.replace(/\bYou was\b|\byou was\b/, match => match.replace('was', 'were'))));
  if (/\bbirthday\b/.test(lower) && speech) {
    const honoree = name ?? 'our guest of honour';
    return {
      title: 'Birthday speech',
      text: [
        'Hello everyone, and thank you all for coming.',
        [`Today we celebrate ${honoree}'s ${birthday}.`, ...memories.slice(0, 3)].join(' '),
        `So please raise your glasses. Happy ${birthday}, ${capital(honoree)}! We love you.`
      ].join('\n\n')
    };
  }
  if (/\bbirthday\b/.test(lower)) {
    return { title: 'Birthday card', text: [`Dear ${name ?? 'friend'},`, [`Happy ${birthday}!`, ...memories.slice(0, 2), 'We hope today is full of cake and laughter.'].join(' '), `With love,\n${sign}`].join('\n\n') };
  }
  if (/\bthank/.test(lower)) {
    const thing = reason ?? 'everything you do';
    const plural = /[^s]s$/.test(thing) && !/ing$/.test(thing);
    const them = plural ? 'them' : 'it';
    const body = [
      `Thank you so much for ${thing}.`,
      pick(random, ['It was such a kind surprise, and it made our whole week brighter.', `We were so happy to get ${them}, and we have been smiling ever since.`]),
      plural ? `We shared ${them} around the table, and everyone agreed ${plural ? 'they were' : 'it was'} wonderful.` : 'Little kindnesses like this make everything feel like home.',
      pick(random, [`We feel lucky to have you ${near}.`, 'We hope we can do something just as kind for you soon.'])
    ];
    return { title: 'Thank-you note', text: [`Dear ${name ?? 'friend'},`, body.join(' '), `With thanks and warm wishes,\n${sign}`].join('\n\n') };
  }
  const topic = goalWords(request, 3).filter(word => !/^(?:note|letter|card|speech|toast|message|email|invitation|invite|sorry|apology)$/.test(word) && !RECIPIENT.test(`to ${word}`));
  const about = topic.length ? ` about the ${joinAnd(topic)}` : '';
  if (speech) {
    return { title: 'A short speech', text: ['Hello everyone, and thank you for being here.', `I want to say a few words${about}. It matters to all of us, and it would not be the same without each of you. Thank you for your help, your patience and your good humor.`, 'Let us enjoy today together.'].join('\n\n') };
  }
  if (/\b(?:sorry|apology|apologi[sz]e)\b/.test(lower)) {
    return { title: 'A note to say sorry', text: [`Dear ${name ?? 'friend'},`, `I am sorry${about}. I did not mean to upset you, and I have been thinking about it a lot. I hope we can talk soon and make it right.`, 'With love,\nMe'].join('\n\n') };
  }
  if (/\binvit/.test(lower)) {
    return { title: 'Invitation', text: [`Dear ${name ?? 'friend'},`, `You are invited${about}! There will be good food, good company and plenty of laughter. Please let us know if you can come.`, `Hope to see you there,\n${sign}`].join('\n\n') };
  }
  return { title: `A note for ${name ?? 'you'}`, text: [`Dear ${name ?? 'friend'},`, `I wanted to send you a little note${about}. You have been on my mind, and I hope you are well. It would be lovely to see you soon.`, `Warm wishes,\n${sign}`].join('\n\n') };
}

/** Picks what to write from the request's words: a form, a story, a note, a plan for the family. */
function compose(text, random, seed) {
  const lower = text.toLowerCase();
  const form = ['haiku', 'limerick', 'acrostic'].find(name => lower.includes(name));
  const shape = shapeIn(lower);
  if (form) return poem({ theme: text, form, seed });
  if (/\b(song|songs|lyrics|chorus)\b/.test(lower)) return song({ theme: text, seed });
  if (/\b(poem|poems|rhyme|rhymes|verse|couplets?)\b/.test(lower)) return poem({ theme: text, form: 'couplets', seed });
  if (LETTER.test(lower)) return letter(text, random);
  if (/\b(novel|chapters?|book)\b/.test(lower)) return novel({ prompt: text, shape: shape ?? 'cinderella', chapters: Number(/(\d+)\s+chapters?/.exec(lower)?.[1] ?? 8), seed });
  if (/\b(story|stories|tale|fable|bedtime)\b/.test(lower) || shape) return story({ prompt: text, shape: shape ?? 'man-in-hole', seed });
  if (/\b(family|kids|children|weekend|activities|activity)\b/.test(lower)) return familyIdeas({ prompt: text, seed });
  return describe(text, random);
}

/** Writes what was asked; on a Check's retry, improves the last try until it meets the rules. */
function write(task) {
  const { parts, instructions, random, seed } = task;
  const retry = parts.find(part => part.feedback);
  const asked = parts.filter(part => part !== retry && !isReview(part) && !isTest(part)).map(part => goalLine(part.text) ?? part.text).join('\n');
  let out;
  if (retry?.text.trim()) out = retry.text.trim();
  else {
    const piece = compose(`${instructions}\n${asked}`.trim(), random, seed);
    out = `${piece.title}\n\n${piece.text}`;
  }
  return meet(out, needsIn(instructions, retry?.feedback), random);
}

/** Words that lean toward a label, for labels people often use. */
const AFFINITY = {
  positive: ['good', 'great', 'love', 'loved', 'happy', 'wonderful', 'fun', 'like', 'enjoy', 'enjoyed', 'excellent', 'best', 'amazing', 'thanks', 'glad'],
  negative: ['bad', 'sad', 'hate', 'awful', 'terrible', 'angry', 'broken', 'worst', 'boring', 'problem', 'disappointed', 'poor', 'wrong'],
  neutral: ['okay', 'fine', 'average', 'normal', 'maybe'],
  question: ['how', 'what', 'why', 'when', 'where', 'who', 'which'],
  urgent: ['now', 'asap', 'urgent', 'immediately', 'emergency', 'quickly', 'today'],
  bug: ['error', 'crash', 'crashes', 'broken', 'fails', 'failed', 'bug', 'freeze', 'freezes', 'wrong'],
  feature: ['add', 'wish', 'request', 'idea', 'could', 'would', 'support', 'new'],
  spam: ['winner', 'click', 'prize', 'offer', 'free', 'money', 'win', 'lottery'],
  animal: ['cat', 'dog', 'bird', 'fish', 'mouse', 'horse', 'cow', 'fox', 'owl', 'bear', 'lion', 'rabbit', 'pet', 'chased', 'barked', 'purred'],
  food: ['eat', 'ate', 'dinner', 'lunch', 'breakfast', 'cake', 'bread', 'soup', 'apple', 'pea', 'peas', 'pizza', 'tasty', 'recipe'],
  fruit: ['apple', 'banana', 'pear', 'grape', 'orange', 'berry', 'berries', 'cherry', 'plum', 'mango'],
  vehicle: ['car', 'bus', 'train', 'bike', 'bicycle', 'truck', 'boat', 'plane', 'drive', 'drove', 'wheels', 'engine'],
  sport: ['ball', 'goal', 'team', 'match', 'score', 'race', 'run', 'soccer', 'football', 'tennis', 'swim'],
  weather: ['rain', 'snow', 'sun', 'sunny', 'cloud', 'cloudy', 'wind', 'storm', 'cold', 'hot', 'forecast'],
  music: ['song', 'sing', 'guitar', 'piano', 'drum', 'melody', 'band', 'tune'],
  school: ['homework', 'teacher', 'class', 'lesson', 'test', 'math', 'reading', 'school']
};
const LABELS = /labels?\s*:\s*([^\n.]+)/i;

function classify({ instructions, input }) {
  const spec = LABELS.exec(instructions)?.[1] ?? LABELS.exec(input)?.[1];
  const labels = spec ? spec.split(/,|\/|\||\bor\b/).map(label => label.trim().toLowerCase()).filter(Boolean) : ['positive', 'negative', 'neutral'];
  const subject = (input.trim() || instructions).replace(new RegExp(LABELS.source, 'gi'), '');
  const words = wordsOf(subject);
  let best = labels[0];
  let score = 0;
  for (const label of labels) {
    const cues = [...label.split(/\s+/), ...(AFFINITY[label] ?? [])];
    let hits = words.filter(word => cues.some(cue => word === cue || (cue.length > 3 && word.startsWith(cue.slice(0, -1))))).length;
    if (label === 'question' && subject.includes('?')) hits += 1;
    if (hits > score) { best = label; score = hits; }
  }
  return best;
}

const REFLECT = { i: 'you', me: 'you', my: 'your', mine: 'yours', am: 'are', myself: 'yourself', "i'm": "you're", you: 'I', your: 'my', yours: 'mine', yourself: 'myself', "you're": "I'm", we: 'you', our: 'your', us: 'you' };
const reflect = text => text.replace(/[.!?]+$/, '').split(/\s+/).map(word => REFLECT[word] ?? word).join(' ');
const SUGGESTIONS = ['"write a haiku about rain"', '"tell a cinderella story about a fox"', '"family ideas for a rainy day"', '"plan a picnic"', '"write a song about the sea"'];

function chat({ instructions, input, random }) {
  const said = input.trim() || instructions.trim();
  const lower = said.toLowerCase();
  let match;
  let reply;
  if (!said) reply = 'Hello! What shall we make today?';
  else if (/\b(?:who|what) are you\b|\bare you (?:real|human|an? ai|a robot|alive|a person)\b/.test(lower)) reply = 'I am Pea Mind, a rule-based helper. I work offline from rules and word lists, not a language model, so I am simple, but I am honest about it.';
  else if (/^(?:hi|hello|hey|good (?:morning|afternoon|evening))\b/.test(lower)) reply = 'Hello! I am Pea Mind, a rule-based helper that works offline.';
  else if ((match = /\b(sad|lonely|scared|worried|angry|upset|nervous)\b/.exec(lower))) reply = `It is okay to feel ${match[1]}. Talking with someone you trust can help. What happened?`;
  else if ((match = /\bi feel (.+)/.exec(lower))) reply = `Why do you feel ${reflect(match[1])}?`;
  else if ((match = /\bi(?: am|'m) (.+)/.exec(lower))) reply = `How long have you been ${reflect(match[1])}?`;
  else if ((match = /\bi (?:want|need|wish) (.+)/.exec(lower))) reply = `Why do you want ${reflect(match[1])}?`;
  else if ((match = /\bmy (\w+)/.exec(lower))) reply = `Tell me more about your ${match[1]}.`;
  else if (/\bbecause\b/.test(lower)) reply = 'Is that the only reason?';
  else if (/\?\s*$/.test(said)) reply = 'Good question. I am only rules and word lists, so I may not know. What do you think?';
  else reply = pick(random, ['Tell me more.', 'That is interesting. What happens next?', 'How does that make you feel?', 'Go on, I am listening.']);
  return `${reply}\n\nI am Pea Mind, offline and rule-based. Try ${pick(random, SUGGESTIONS)}.`;
}

const MINDS = { plan, ideate, solve, test, review, repair, verify, summarize, write, classify, chat };

/**
 * One thinking step, the way an Agent Flow node asks for it: a skill, the
 * node's own instructions, the text flowing in and an optional angle such as
 * "simple" or "bold". Several inputs arrive as "From Name:" sections, and a
 * Check's retry starts with "Please improve this."; each skill reads the
 * sections it needs and no header counts as a word. Returns plain text.
 */
export function think({ skill = 'chat', instructions = '', input = '', angle = '', seed = 1 } = {}) {
  const chosen = SKILLS.includes(skill) ? skill : skillFor(`${instructions} ${input}`);
  const own = String(instructions ?? '');
  const parts = sectionsOf(String(input ?? ''));
  const task = {
    instructions: own.replace(/angle:\s*\w+\.?/gi, '').trim(),
    input: parts.map(part => part.text).join('\n\n'),
    parts,
    angle: String(angle || /angle:\s*(\w+)/i.exec(own)?.[1] || '').toLowerCase().trim(),
    seed
  };
  task.random = rng(`${chosen}:${task.angle}:${seed}:${own}:${input}`);
  return clean(MINDS[chosen](task)) || 'Pea Mind has nothing to add yet.';
}

// ---- Answer forms ---------------------------------------------------------------

/**
 * Fills an answer form from a prompt, by rules (`topic`, the words filled
 * into the prompt, says what it is about when given): a field asking for a story,
 * poem, song, ideas, plan or summary gets one made from the prompt; a title
 * takes the title of what was made; a field the prompt itself answers ("her
 * first name is Ada" for firstName) takes that; anything else gets the first
 * sentence of a plain reply. Returns "name: value" lines, as a model would.
 */
export function fillForm({ prompt = '', topic = '', fields = [], seed = 1 } = {}) {
  const made = {};
  const about = topic || prompt; // what the prompt was filled in with, when known, says best what it is about
  const piece = kind => made[kind] ??= kind === 'poem' ? poem({ theme: about, form: /haiku/i.test(prompt) ? 'haiku' : 'couplets', seed })
    : kind === 'song' ? song({ theme: about, seed })
      : story({ prompt: about, shape: 'man-in-hole', seed });
  const said = (name) => {
    const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
    const match = new RegExp(`\\b${words.replace(/\s+/g, '\\s*')}\\s*(?:is|was|:|=)\\s*([^.,;\\n]+?)(?=\\s+(?:and|but)\\b|[.,;\\n]|$)`, 'i').exec(prompt);
    return match?.[1].trim();
  };
  const firstSentence = text => (String(text).split('\n').find(line => line.trim() && !/^(?:goal|ideas for|angle)\s*:/i.test(line)) ?? '').trim().replace(/^(\d+[.)]|[-*•])\s*/, '');
  const value = ({ name, example }) => {
    const hint = `${name} ${example}`.toLowerCase();
    if (/title|headline|heading/.test(hint)) return (Object.values(made)[0] ?? piece('story')).title;
    if (/story|tale/.test(hint)) return piece('story').text.replace(/\n+/g, ' ');
    if (/poem|haiku|verse|rhyme/.test(hint)) return piece('poem').text.replace(/\n/g, ' / ');
    if (/song|lyric|chorus/.test(hint)) return piece('song').text.split('\n').filter(line => line && !line.startsWith('[')).slice(0, 2).join(' / ');
    const own = said(name);
    if (own) return own;
    // A one-word example (alice123, happy) asks for a word of the same shape, made from the prompt.
    if (example && !/\s/.test(example)) {
      // A name in the prompt (a capital word that does not start a sentence) first, else its main word.
      const proper = /(?<![.!?]\s|^)\b([A-Z][a-z]+)\b/m.exec(prompt.replace(/^\s*\w+/, ''))?.[1];
      const word = proper?.toLowerCase() ?? keywords(prompt, 4).find(candidate => !TASK_WORDS.has(candidate)) ?? 'pea';
      const digits = (example.match(/\d+/) ?? [''])[0].length;
      const random = rng(seed + name.length);
      return `${word}${digits ? String(Math.floor(random() * 10 ** digits)).padStart(digits, '7') : ''}`;
    }
    const skill = /idea/.test(hint) ? 'ideate' : /plan|step/.test(hint) ? 'plan' : /summar/.test(hint) ? 'summarize' : 'chat';
    return firstSentence(think({ skill, input: prompt, seed })) || example;
  };
  return clean(fields.map(field => `${field.name}: ${String(value(field)).replace(/\s*\n\s*/g, ' ')}`).join('\n'));
}
