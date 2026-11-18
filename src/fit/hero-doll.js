/**
 * Procedural pixel hero for the Hero Designer. Pure data: a look plus a pose
 * become rectangles in art pixels, drawn later with solid Graphics fills only
 * (WebGL, NativeScript and the web Canvas2D fallback all support them).
 *
 * Art space: x is centred on the body (0), y grows downward and the soles rest
 * on y = FEET. The pivot is therefore (0, FEET).
 */
export const FEET = 48;

const swatch = (id, label, color) => Object.freeze({ id, label, color });
const PALETTE = Object.freeze([
  swatch('crimson', 'CRIMSON', 0xE23D53), swatch('coral', 'CORAL', 0xFF7A5C),
  swatch('sunny', 'SUNNY', 0xFFC43D), swatch('lime', 'LIME', 0x8BE04E),
  swatch('mint', 'MINT', 0x4FD6B4), swatch('sky', 'SKY', 0x4FA8FF),
  swatch('cobalt', 'COBALT', 0x3557D6), swatch('violet', 'VIOLET', 0x8A5CF0),
  swatch('magenta', 'MAGENTA', 0xE05BC8), swatch('bubblegum', 'BUBBLEGUM', 0xFF9ACD),
  swatch('snow', 'SNOW', 0xF2EEF5), swatch('charcoal', 'CHARCOAL', 0x3A3448),
  swatch('gold', 'GOLD', 0xF5B82E), swatch('neon', 'NEON', 0x39FFB0),
]);

export const HERO_OPTIONS = Object.freeze({
  name: Object.freeze(['NOVA', 'RIO', 'KAI', 'SKYE', 'JUNO', 'REMY', 'ZARA', 'DEX', 'MIKA', 'LUMI',
    'ASH', 'VEGA', 'PIXEL', 'BLAZE', 'SOL', 'ECHO', 'IVY', 'ORION', 'TAMSIN', 'MARLO']),
  skin: Object.freeze([
    swatch('porcelain', 'PORCELAIN', 0xFFE0CC), swatch('peach', 'PEACH', 0xF6C9A2),
    swatch('honey', 'HONEY', 0xE0A872), swatch('caramel', 'CARAMEL', 0xC18352),
    swatch('umber', 'UMBER', 0x93603A), swatch('ebony', 'EBONY', 0x63402A),
  ]),
  build: Object.freeze(['slim', 'regular', 'strong']),
  hair: Object.freeze(['short', 'spiky', 'bob', 'long', 'ponytail', 'bun', 'curly', 'braids', 'buzz']),
  hairColor: Object.freeze([
    swatch('ink', 'INK', 0x231A22), swatch('chestnut', 'CHESTNUT', 0x5C3421),
    swatch('copper', 'COPPER', 0xB4532A), swatch('ruby', 'RUBY RED', 0xD8402E),
    swatch('blonde', 'BLONDE', 0xE7BE5C), swatch('silver', 'SILVER', 0xD9D6E0),
    swatch('bubblegum', 'BUBBLEGUM', 0xFF8CC8), swatch('ocean', 'OCEAN', 0x4FA8FF),
    swatch('lilac', 'LILAC', 0xB49CFF), swatch('neon', 'NEON', 0x39FFB0),
  ]),
  top: Object.freeze(['tee', 'tank', 'hoodie', 'jacket', 'crop', 'gi']),
  topColor: PALETTE,
  bottoms: Object.freeze(['pants', 'shorts', 'leggings', 'track', 'skort']),
  bottomColor: PALETTE,
  shoes: PALETTE,
  accessory: Object.freeze(['none', 'headband', 'glasses', 'wristbands', 'gloves', 'scarf', 'cape', 'crown']),
  accent: PALETTE,
});

/** Designer field order. Labels are pixel-font safe. */
export const HERO_FIELDS = Object.freeze([
  ['name', 'NAME'], ['skin', 'SKIN'], ['build', 'BUILD'], ['hair', 'HAIR'], ['hairColor', 'HAIR COLOR'],
  ['top', 'TOP'], ['topColor', 'TOP COLOR'], ['bottoms', 'BOTTOMS'], ['bottomColor', 'LEG COLOR'],
  ['shoes', 'SHOES'], ['accessory', 'EXTRA'], ['accent', 'ACCENT'],
].map(([id, label]) => Object.freeze({ id, label })));

/** Cosmetics earned through journey levels. Everything else is open from the start. */
export const HERO_UNLOCKS = Object.freeze({
  hairColor: Object.freeze({ neon: 3 }),
  top: Object.freeze({ gi: 2 }),
  accessory: Object.freeze({ cape: 4, crown: 6 }),
  accent: Object.freeze({ gold: 5, neon: 3 }),
  topColor: Object.freeze({ gold: 5, neon: 3 }),
  bottomColor: Object.freeze({ gold: 5, neon: 3 }),
  shoes: Object.freeze({ gold: 5, neon: 3 }),
});

export const DEFAULT_LOOK = Object.freeze({
  name: 'NOVA', skin: 'peach', build: 'regular', hair: 'ponytail', hairColor: 'copper',
  top: 'jacket', topColor: 'violet', bottoms: 'leggings', bottomColor: 'charcoal',
  shoes: 'mint', accessory: 'headband', accent: 'sunny',
});

const valueId = value => typeof value === 'string' ? value : value.id;
export function optionIds(field) {
  const values = HERO_OPTIONS[field];
  if (!values) throw new RangeError(`Unknown hero field: ${field}`);
  return values.map(valueId);
}
export function optionLevel(field, id) { return HERO_UNLOCKS[field]?.[id] ?? 1; }
export function optionLabel(field, id) {
  const entry = HERO_OPTIONS[field]?.find(value => valueId(value) === id);
  if (!entry) return '?';
  return typeof entry === 'string' ? entry.toUpperCase() : entry.label;
}
function colorOf(field, id) { return HERO_OPTIONS[field].find(entry => entry.id === id).color; }

/** Unknown, locked or malformed values fall back to the default look. */
export function normalizeLook(input, { level = Infinity } = {}) {
  const look = {};
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const { id: field } of HERO_FIELDS) {
    const value = Object.hasOwn(source, field) ? source[field] : undefined;
    const ids = optionIds(field);
    look[field] = typeof value === 'string' && ids.includes(value) && optionLevel(field, value) <= level
      ? value : DEFAULT_LOOK[field];
  }
  return Object.freeze(look);
}

/** Step to the next value the player has unlocked, wrapping around the list. */
export function stepLook(look, field, direction, { level = Infinity } = {}) {
  const ids = optionIds(field);
  let index = ids.indexOf(look[field]);
  for (let attempt = 0; attempt < ids.length; attempt++) {
    index = (index + (direction < 0 ? -1 : 1) + ids.length) % ids.length;
    if (optionLevel(field, ids[index]) <= level) return Object.freeze({ ...look, [field]: ids[index] });
  }
  return look;
}

export function randomLook(random = Math.random, { level = Infinity } = {}) {
  const look = {};
  for (const { id: field } of HERO_FIELDS) {
    const ids = optionIds(field).filter(id => optionLevel(field, id) <= level);
    const roll = Math.min(.999999, Math.max(0, Number(random()) || 0));
    look[field] = ids[Math.floor(roll * ids.length)];
  }
  return Object.freeze(look);
}

/** The next cosmetic the player will earn, or null once everything is open. */
export function nextUnlock(level) {
  let best = null;
  for (const [field, entries] of Object.entries(HERO_UNLOCKS)) {
    for (const [id, needed] of Object.entries(entries)) {
      if (needed > level && (!best || needed < best.level)) best = { field, id, level: needed, label: optionLabel(field, id) };
    }
  }
  return best;
}

function shade(color, factor) {
  const channel = shift => Math.max(0, Math.min(255, Math.round(((color >> shift) & 255) * factor)));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

const OUTLINE = 0x1A1024, EYE = 0x241631, MOUTH = 0xB5475B, SOLE = 0xF4EEE6;
const IRON = 0x3B3550, BAR = 0xA9B0C2;
const ARMS = {
  down: L => ({ upper: [L - 3, 18, 3, 6], fore: [L - 3, 24, 3, 5], hand: [L - 3, 29, 3, 2] }),
  curlUp: L => ({ upper: [L - 3, 18, 3, 6], fore: [L - 2, 19, 3, 5], hand: [L - 2, 16, 3, 3] }),
  pressLow: L => ({ upper: [L - 6, 18, 6, 3], fore: [L - 6, 12, 3, 6], hand: [L - 6, 9, 3, 3] }),
  pressHigh: L => ({ upper: [L - 3, 11, 3, 7], fore: [L - 3, 5, 3, 6], hand: [L - 3, 2, 3, 3] }),
  lateralUp: L => ({ upper: [L - 6, 18, 6, 3], fore: [L - 11, 18, 5, 3], hand: [L - 14, 18, 3, 3] }),
  guard: L => ({ upper: [L - 3, 18, 3, 5], fore: [L - 2, 15, 3, 7], hand: [L - 1, 12, 4, 3] }),
  hips: L => ({ upper: [L - 3, 18, 3, 4], elbow: [L - 4, 21, 3, 3], fore: [L - 3, 24, 3, 2], hand: [L - 1, 25, 2, 3] }),
  fist: L => ({ upper: [L - 3, 11, 3, 7], fore: [L - 3, 5, 3, 6], hand: [L - 4, 2, 4, 3] }),
};

/** Pose ids. weights adds dumbbells; bob lowers the upper body for breathing/bounce. */
export const HERO_POSES = Object.freeze({
  stand: { left: 'down', right: 'down' },
  guard: { left: 'guard', right: 'guard', stance: 'wide' },
  guardBob: { left: 'guard', right: 'guard', stance: 'wide', bob: 1 },
  curlDown: { left: 'down', right: 'down', weights: true },
  curlUp: { left: 'curlUp', right: 'curlUp', weights: true },
  pressLow: { left: 'pressLow', right: 'pressLow', weights: true },
  pressHigh: { left: 'pressHigh', right: 'pressHigh', weights: true },
  lateralDown: { left: 'down', right: 'down', weights: true },
  lateralUp: { left: 'lateralUp', right: 'lateralUp', weights: true },
  rest: { left: 'hips', right: 'hips' },
  restBreath: { left: 'hips', right: 'hips', bob: 1 },
  victory: { left: 'hips', right: 'fist', stance: 'wide' },
  victoryAlt: { left: 'fist', right: 'hips', stance: 'wide' },
});

/** [rest pose, alternate pose] for a phase or exercise, matching the sprite cast. */
export function heroPosePair(phase, exerciseId = null) {
  if (phase === 'workout') {
    if (exerciseId === 'overhead-press') return ['pressHigh', 'pressLow'];
    if (exerciseId === 'lateral-raise') return ['lateralUp', 'lateralDown'];
    return ['curlUp', 'curlDown'];
  }
  if (phase === 'rest') return ['rest', 'restBreath'];
  if (phase === 'cooldown') return ['victory', 'victoryAlt'];
  if (phase === 'stand') return ['stand', 'stand'];
  return ['guard', 'guardBob'];
}

const HAIR = {
  short: { front: [[-5, 6, 10, 3], [-5, 9, 1, 3], [4, 9, 1, 3], [-4, 9, 5, 1]] },
  spiky: { front: [[-5, 6, 10, 3], [-5, 4, 2, 2], [-2, 3, 2, 3], [1, 4, 2, 2], [4, 5, 1, 2], [-5, 9, 1, 2], [4, 9, 1, 2], [-4, 9, 3, 1], [0, 9, 2, 1]] },
  bob: { front: [[-5, 6, 10, 3], [-6, 8, 2, 9], [4, 8, 2, 9], [-4, 9, 8, 1], [-4, 10, 2, 1]] },
  long: { back: [[-6, 9, 12, 15]], front: [[-5, 6, 10, 3], [-6, 8, 2, 10], [4, 8, 2, 10], [-4, 9, 6, 1]] },
  ponytail: { back: [[5, 7, 3, 3], [6, 10, 3, 8], [6, 18, 2, 3]], front: [[-5, 6, 10, 3], [-5, 9, 1, 2], [4, 9, 1, 3], [-4, 9, 4, 1]], tie: [4, 8, 2, 2] },
  bun: { front: [[-3, 3, 6, 2], [-2, 2, 4, 4], [-5, 6, 10, 3], [-5, 9, 1, 2], [4, 9, 1, 2], [-4, 9, 8, 1]] },
  curly: { back: [[-7, 6, 14, 10]], front: [[-6, 5, 12, 4], [-7, 9, 2, 6], [5, 9, 2, 6], [-4, 9, 8, 1]], texture: true },
  braids: { front: [[-5, 6, 10, 3], [-6, 9, 2, 12], [4, 9, 2, 12], [-4, 9, 8, 1]], braids: true },
  buzz: { front: [[-4, 7, 8, 2], [-5, 8, 1, 2], [4, 8, 1, 2]], dark: true },
};

/**
 * Build the hero as ordered rectangles. Silhouette parts receive a one-pixel
 * outline pass first, so every look reads clearly over busy stages.
 */
export function heroRects(lookInput, poseId = 'stand') {
  const look = normalizeLook(lookInput);
  const pose = HERO_POSES[poseId] ?? HERO_POSES.stand;
  const skin = colorOf('skin', look.skin), skinShade = shade(skin, .82);
  const hairBase = colorOf('hairColor', look.hairColor);
  const hair = HAIR[look.hair].dark ? shade(hairBase, .8) : hairBase;
  const top = colorOf('topColor', look.topColor), topShade = shade(top, .78);
  const bottom = colorOf('bottomColor', look.bottomColor), bottomShade = shade(bottom, .75);
  const shoe = colorOf('shoes', look.shoes), accent = colorOf('accent', look.accent);
  const half = look.build === 'slim' ? 4 : look.build === 'strong' ? 6 : 5;
  const L = -half, bob = pose.bob ?? 0, wide = pose.stance === 'wide';
  const silhouette = [], details = [];
  const put = (list, [x, y, w, h], c, upper = true) => {
    if (w > 0 && h > 0) list.push({ x, y: y + (upper ? bob : 0), w, h, c });
  };
  const body = (rect, c, upper) => put(silhouette, rect, c, upper);
  const detail = (rect, c, upper) => put(details, rect, c, upper);
  const mirror = ([x, y, w, h]) => [-x - w, y, w, h];

  // Back layers: cape, long hair, ponytail and hood sit behind the body.
  if (look.accessory === 'cape') {
    body([L - 2, 18, half * 2 + 4, 22], shade(accent, .7));
    detail([L - 1, 19, 2, 20], shade(accent, .85));
  }
  for (const rect of HAIR[look.hair].back ?? []) body(rect, hair);
  if (look.top === 'hoodie') body([-4, 16, 8, 2], topShade);

  // Legs and shoes. A wide stance spreads the lower legs by one pixel.
  const legShift = wide ? 1 : 0;
  const legs = [[-4 - legShift, 31, 4, 13], [legShift, 31, 4, 13]];
  const bareLegs = look.bottoms === 'shorts' || look.bottoms === 'skort';
  for (const leg of legs) body(leg, bareLegs ? skin : bottom, false);
  body([-4, 28, 8, 3], bottom, false);
  if (look.bottoms === 'shorts') for (const [x] of legs) body([x, 31, 4, 6], bottom, false);
  if (look.bottoms === 'skort') body([-5, 29, 10, 5], bottom, false);
  detail([-1, 32, 1, 12], bareLegs ? skinShade : bottomShade, false);
  if (look.bottoms === 'leggings' || look.bottoms === 'track') {
    const stripe = look.bottoms === 'track' ? SOLE : accent;
    detail([legs[0][0], 31, 1, 13], stripe, false); detail([legs[1][0] + 3, 31, 1, 13], stripe, false);
  }
  const shoes = [[-5 - legShift, 44, 4, 3], [1 + legShift, 44, 4, 3]];
  for (const [x] of shoes) {
    body([x, 44, 4, 3], shoe, false);
    body([x, 47, 4, 1], SOLE, false);
    detail([x + 1, 44, 2, 1], shade(shoe, 1.25), false);
  }

  // Torso and garment details.
  const longSleeves = look.top === 'hoodie' || look.top === 'jacket';
  body([L, 18, half * 2, 9], top);
  detail([half - 1, 19, 1, 8], topShade);
  if (look.top === 'crop') {
    detail([L, 23, half * 2, 4], skin); detail([half - 1, 23, 1, 4], skinShade);
  }
  if (look.top === 'tee') { detail([-1, 18, 2, 1], skin); detail([-1, 21, 2, 2], accent); }
  if (look.top === 'tank') detail([-2, 18, 4, 2], skin);
  if (look.top === 'hoodie') {
    detail([-3, 24, 6, 2], topShade); detail([-2, 19, 1, 3], SOLE); detail([1, 19, 1, 3], SOLE);
  }
  if (look.top === 'jacket') { detail([-2, 18, 4, 9], accent); detail([-3, 18, 1, 9], topShade); detail([2, 18, 1, 9], topShade); }
  if (look.top === 'gi') { detail([-1, 18, 2, 2], skin); detail([0, 20, 1, 2], skinShade); }
  detail([L, 27, half * 2, 1], look.top === 'gi' ? accent : bottomShade, false);
  if (look.top === 'gi') { detail([-2, 28, 1, 3], accent, false); detail([1, 28, 1, 3], accent, false); }

  // Arms. Sleeves follow the garment; the right arm mirrors the left.
  const weights = [];
  for (const [side, armId] of [['left', pose.left], ['right', pose.right]]) {
    const arm = ARMS[armId](L);
    const place = rect => side === 'left' ? rect : mirror(rect);
    const sleeve = longSleeves ? ['upper', 'elbow', 'fore'] : look.top === 'gi' ? ['upper', 'elbow'] : look.top === 'tee' ? ['upper'] : [];
    for (const part of ['upper', 'elbow', 'fore']) {
      if (!arm[part]) continue;
      const rect = place(arm[part]);
      const covered = sleeve.includes(part);
      // A tee sleeve covers only the top of the upper arm.
      if (part === 'upper' && look.top === 'tee' && armId !== 'lateralUp' && armId !== 'pressLow') {
        body(rect, skin);
        body([rect[0], armId === 'pressHigh' || armId === 'fist' ? rect[1] + rect[3] - 3 : rect[1], rect[2], 3], top);
      } else body(rect, covered ? top : skin);
    }
    const hand = place(arm.hand);
    body(hand, look.accessory === 'gloves' ? accent : skin);
    if (look.accessory === 'wristbands') {
      const fore = place(arm.fore);
      const vertical = fore[3] >= fore[2];
      detail(vertical ? [fore[0], hand[1] > fore[1] ? fore[1] + fore[3] - 1 : fore[1], fore[2], 1]
        : [hand[0] > fore[0] ? fore[0] + fore[2] - 1 : fore[0], fore[1], 1, fore[3]], accent);
    }
    if (pose.weights) weights.push(hand);
  }

  // Head, face and hair.
  body([-1, 17, 2, 1], skin);
  body([-5, 12, 1, 2], skinShade); body([4, 12, 1, 2], skinShade);
  body([-4, 8, 8, 9], skin);
  detail([3, 9, 1, 8], skinShade);
  if (look.accessory === 'scarf') { body([-4, 17, 8, 2], accent); body([2, 19, 2, 4], accent); detail([2, 21, 2, 1], shade(accent, .8)); }
  detail([-3, 12, 1, 2], EYE); detail([2, 12, 1, 2], EYE);
  detail([-3, 11, 2, 1], shade(hairBase, .7)); detail([1, 11, 2, 1], shade(hairBase, .7));
  detail([-4, 14, 1, 1], shade(skin, .9)); detail([3, 14, 1, 1], shade(skin, .9));
  detail([-1, 15, 2, 1], MOUTH);
  const style = HAIR[look.hair];
  for (const rect of style.front) body(rect, hair);
  if (look.hair !== 'buzz') detail([-3, 6, 3, 1], shade(hair, 1.25));
  if (style.tie) detail(style.tie, accent);
  if (style.texture) for (let x = -6; x < 6; x += 2) detail([x, 6 + ((x / 2) & 1), 1, 1], shade(hair, 1.25));
  if (style.braids) for (let y = 11; y < 21; y += 2) { detail([-6, y, 2, 1], shade(hair, .75)); detail([4, y, 2, 1], shade(hair, .75)); }
  if (style.braids) { detail([-6, 20, 2, 1], accent); detail([4, 20, 2, 1], accent); }
  if (look.accessory === 'headband') { body([-5, 9, 10, 1], accent); body([5, 9, 2, 1], accent); body([6, 10, 1, 2], accent); }
  if (look.accessory === 'glasses') { detail([-4, 12, 3, 1], EYE); detail([1, 12, 3, 1], EYE); detail([-1, 12, 2, 1], EYE); detail([-4, 12, 1, 1], 0x7FD8FF); detail([1, 12, 1, 1], 0x7FD8FF); }
  if (look.accessory === 'crown') { body([-3, 4, 6, 2], 0xF5C02E); body([-3, 2, 1, 2], 0xF5C02E); body([0, 2, 1, 2], 0xF5C02E); body([2, 2, 1, 2], 0xF5C02E); detail([-1, 4, 1, 1], 0xE23D53); }

  // Dumbbells: a short bar with plates centred on each hand.
  for (const [hx, hy, hw, hh] of weights) {
    const cx = hx + Math.floor(hw / 2), cy = hy + Math.floor(hh / 2);
    body([cx - 3, cy, 7, 1], BAR);
    body([cx - 4, cy - 1, 2, 3], IRON); body([cx + 3, cy - 1, 2, 3], IRON);
    detail([cx - 4, cy - 1, 1, 1], BAR); detail([cx + 3, cy - 1, 1, 1], BAR);
  }

  const outline = silhouette.map(({ x, y, w, h }) => ({ x: x - 1, y: y - 1, w: w + 2, h: h + 2, c: OUTLINE }));
  const rects = [...outline, ...silhouette, ...details];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y, w, h } of outline) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  }
  return { rects, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}

/** Tallest and widest silhouettes across every pose, for a pose-stable scale. */
export function heroExtent(look) {
  let width = 0, top = FEET;
  for (const pose of Object.keys(HERO_POSES)) {
    const { bounds } = heroRects(look, pose);
    width = Math.max(width, Math.max(-bounds.x, bounds.x + bounds.width) * 2);
    top = Math.min(top, bounds.y);
  }
  return { width, height: FEET + 1 - top };
}

/** Paint rectangles into a Pixi Graphics object at one art pixel per unit. */
export function drawHero(graphics, rects) {
  graphics.clear();
  for (const { x, y, w, h, c } of rects) graphics.rect(x, y, w, h).fill(c);
  return graphics;
}
