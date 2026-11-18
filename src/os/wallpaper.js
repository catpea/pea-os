import { Widget } from '../ui/widget.js';
import { Bitmap, bayer } from '../gfx/bitmap.js';
import { darken, lighten, mix } from '../gfx/color.js';
import { makeCloud, makePea, seeded } from '../gfx/art.js';
import { BAR_H } from '../gfx/skin.js';

/**
 * Themed, animated backdrops. Each kind paints a still scene once per resize
 * or theme change, and may add a few moving sprites on top of it. When motion
 * is off only the still scene remains.
 *
 * The last five are screen-saver scenes, made to be watched: a reef, a warp
 * through the stars, rain on a city, fireworks over a harbor and a squadron
 * of winged peas. Their movers come from pools made once, so a long evening
 * of watching allocates nothing.
 */

/** Paints a rolling ridge and returns its height at every x. */
function ridge(bitmap, w, h, { base, amp, seed, color, edge }) {
  const heights = [];
  for (let x = 0; x < w; x++) {
    const wave = Math.sin(x * 0.031 + seed) * 0.6 + Math.sin(x * 0.0117 + seed * 2.3) * 0.9 + Math.sin(x * 0.071 + seed * 5) * 0.15;
    const y = Math.round(h * (base + amp * wave));
    heights.push(y);
    bitmap.fill(x, y, 1, h - y, color);
    bitmap.set(x, y, edge);
    if (x & 1) bitmap.set(x, y + 1, edge);
  }
  return heights;
}

function stars(bitmap, w, h, color, seed) {
  const random = seeded(seed);
  for (let i = Math.round(w * h / 420); i > 0; i--) bitmap.set(Math.floor(random() * w), Math.floor(random() * h), color);
}

/** Receding grid lines for the arcade floor; `phase` in [0, 1) scrolls it toward the viewer. */
function drawGrid(bitmap, y, w, h, color, phase) {
  const cx = w >> 1;
  bitmap.fill(0, y, w, 1, color);
  const lanes = Math.ceil(w / 24) + 2;
  for (let k = -lanes; k <= lanes; k++) bitmap.line(cx + k * 12, y, cx + k * 12 * 6, y + h - 1, color);
  const rows = 7;
  for (let i = 0; i < rows; i++) {
    const t = (i + phase) / rows;
    bitmap.fill(0, y + Math.round(t * t * (h - 1)), w, 1, color);
  }
}

const sunsetHorizon = h => Math.round(h * 0.66);

/** A copy of `bitmap` facing the other way. */
function flipped(bitmap) {
  const copy = new Bitmap(bitmap.width, bitmap.height);
  copy.blit(bitmap, 0, 0, { flipX: true });
  return copy;
}

/** A one-color w x h block, the particle every scene below is made of. */
function block(w, h, color) {
  const bitmap = new Bitmap(w, h);
  bitmap.fill(0, 0, w, h, color);
  return bitmap;
}

/** A little fish facing right: a forked tail, an oval body with a band, an eye. */
function makeFish(length, body, band, ink) {
  const height = Math.max(5, Math.round(length * 0.55)) | 1;
  const bitmap = new Bitmap(length, height);
  const mid = height >> 1;
  const tail = Math.max(3, Math.round(length * 0.28));
  for (let x = 0; x < tail; x++) {
    const half = Math.round((tail - x) / tail * mid);
    bitmap.set(x, mid - half, band);
    bitmap.set(x, mid + half, band);
    if (x >= tail - 2) bitmap.fill(x, mid - half, 1, half * 2 + 1, band);
  }
  const cx = (tail - 1 + length - 1) / 2;
  const rx = (length - tail) / 2 + 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = tail - 1; x < length; x++) {
      const u = (x - cx) / rx;
      const v = (y - mid) / (mid + 0.4);
      if (u * u + v * v <= 1) bitmap.set(x, y, bayer(x, y) < 0.3 && y > mid ? mix(body, ink, 0.25) : body);
    }
  }
  const stripe = Math.round(cx + rx * 0.15);
  for (let y = 0; y < height; y++) if (bitmap.get(stripe, y)) bitmap.set(stripe, y, band);
  bitmap.set(length - Math.max(2, Math.round(length * 0.18)), mid - 1, ink);
  return bitmap;
}

/** The skyline of the rain scene. Painting and animating both ask, so their windows agree. */
function city(w, h) {
  const random = seeded(19);
  const ground = Math.round(h * 0.86);
  const towers = [];
  for (let x = -4; x < w;) {
    const width = 14 + Math.floor(random() * 30);
    const height = Math.round(h * (0.16 + random() * 0.38));
    const windows = [];
    for (let wy = ground - height + 4; wy < ground - 4; wy += 5) {
      for (let wx = x + 3; wx < x + width - 3; wx += 4) windows.push({ x: wx, y: wy, lit: random() < 0.28 });
    }
    towers.push({ x, width, top: ground - height, far: towers.length % 2 === 0, windows });
    x += width + (random() < 0.3 ? 3 + Math.floor(random() * 8) : 0);
  }
  return { ground, towers };
}

/** A winged pea at one point of its wingbeat: 0 up, 1 level, 2 down. */
function makeFlyer(size, beat, wing, shade, edge) {
  const pea = makePea(size);
  const span = Math.max(5, Math.round(size * 0.6));
  const bitmap = new Bitmap(size + span * 2 + 2, size + span + 2);
  const r = Math.floor(size * 0.36);
  const cx = span + 1 + Math.floor(size / 2) - 1;
  const cy = span + 1 + size - r - 1;
  const chord = Math.max(3, Math.round(size * 0.32));
  const sy = cy - Math.round(r * 0.45);
  const ty = sy + [-span * 0.8, -1, span * 0.5][beat];
  for (const side of [-1, 1]) {
    const sx = cx + side * Math.round(r * 0.5);
    const steps = r + span - Math.round(r * 0.5);
    // Column by column from the shoulder out: a leading edge to the tip, feathers hanging behind it.
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const top = Math.round(sy + (ty - sy) * t);
      const depth = Math.max(1, Math.round(chord * (1 - t * 0.7)) + (i % 3 === 2 ? 1 : 0));
      bitmap.fill(sx + side * i, top, 1, depth, wing);
      bitmap.set(sx + side * i, top + depth - 1, shade);
    }
  }
  // An outline keeps pale wings readable against a pale sky.
  const outline = [];
  for (let y = 0; y < bitmap.height; y++) {
    for (let x = 0; x < bitmap.width; x++) {
      if (bitmap.get(x, y)) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => bitmap.get(x + dx, y + dy))) outline.push([x, y]);
    }
  }
  for (const [x, y] of outline) bitmap.set(x, y, edge);
  bitmap.blit(pea, span + 1, span + 1);
  return bitmap;
}

const KINDS = {
  garden: {
    paint(bitmap, theme, w, h) {
      bitmap.gradient(0, 0, w, h, [theme.color('wall-a'), theme.color('wall-b'), theme.color('wall-c')]);
      const sun = theme.color('wall-sun');
      const r = Math.round(Math.min(w, h) * 0.09);
      const sx = Math.round(w * 0.8);
      const sy = BAR_H + r + 14;
      bitmap.disc(sx, sy, r + 4, sun, { dither: true });
      bitmap.disc(sx, sy, r, sun);

      const far = theme.color('wall-far');
      const near = theme.color('wall-near');
      ridge(bitmap, w, h, { base: 0.66, amp: 0.06, seed: 1.3, color: far, edge: lighten(far, 0.35) });
      const meadow = ridge(bitmap, w, h, { base: 0.82, amp: 0.045, seed: 4.1, color: near, edge: lighten(near, 0.35) });

      const random = seeded(7);
      const petals = [theme.color('wall-cloud'), sun, lighten(near, 0.5)];
      for (let i = Math.round(w * h / 700); i > 0; i--) {
        const x = Math.floor(random() * w);
        const y = meadow[x] + 3 + Math.floor(random() * Math.max(1, h - meadow[x] - 3));
        bitmap.set(x, y, petals[i % petals.length]);
      }
    },
    animate(wallpaper, fx) {
      const { ui, w, h } = wallpaper;
      const theme = ui.theme.value;
      const random = seeded(21);
      const cloud = theme.color('wall-cloud');
      const shade = mix(cloud, theme.color('wall-b'), 0.4);
      const clouds = Array.from({ length: Math.max(2, Math.round(w / 90)) }, () => {
        const bitmap = makeCloud(22 + Math.floor(random() * 26), 9 + Math.floor(random() * 6), cloud, shade, random);
        return {
          sprite: wallpaper.sprite(fx, bitmap),
          width: bitmap.width,
          x: random() * w,
          y: BAR_H + 6 + Math.floor(random() * h * 0.3),
          speed: 2.5 + random() * 5
        };
      });
      fx.on(ui.stage.frame, 'tick', ({ dt }) => {
        for (const item of clouds) {
          item.x += item.speed * dt / 1000;
          if (item.x > w) item.x = -item.width;
          item.sprite.position.set(Math.round(item.x), item.y);
        }
      });
    }
  },

  sunset: {
    paint(bitmap, theme, w, h) {
      const horizon = sunsetHorizon(h);
      bitmap.gradient(0, 0, w, horizon, ['wall-a', 'wall-b', 'wall-c', 'wall-d'].map(role => theme.color(role)));
      stars(bitmap, w, Math.round(horizon * 0.5), theme.color('wall-star'), 11);

      const sun = theme.color('wall-sun');
      const glow = theme.color('wall-grid');
      const unit = Math.min(w, h);
      const r = Math.round(unit * 0.2);
      const cx = w >> 1;
      const cy = horizon - Math.round(r * 0.55);
      for (let dy = -r; dy <= r && cy + dy < horizon; dy++) {
        const gap = Math.min(3, 1 + (Math.floor(dy / 5) >> 1));
        if (dy > 0 && dy % 5 >= 5 - gap) continue;
        const half = Math.round(Math.sqrt(r * r - dy * dy));
        const t = (dy + r) / (2 * r);
        for (let dx = -half; dx <= half; dx++) bitmap.set(cx + dx, cy + dy, bayer(cx + dx, cy + dy) < t ? glow : sun);
      }

      const far = theme.color('wall-far');
      const saw = x => Math.abs(((x % 2) + 2) % 2 - 1);
      for (let x = 0; x < w; x++) {
        const peak = Math.round(unit * (0.02 + saw(x * 0.021 + 0.4) * 0.09 + saw(x * 0.057 + 1.1) * 0.04));
        bitmap.fill(x, horizon - peak, 1, peak, far);
      }

      bitmap.fill(0, horizon, w, h - horizon, theme.color('wall-near'));
      drawGrid(bitmap, horizon, w, h - horizon, glow, 0);
    },
    animate(wallpaper, fx) {
      const { ui, w, h } = wallpaper;
      const theme = ui.theme.value;
      const horizon = sunsetHorizon(h);
      const floor = new Bitmap(w, h - horizon);
      const sprite = wallpaper.sprite(fx, floor);
      sprite.position.set(0, horizon);
      const ground = theme.color('wall-near');
      const glow = theme.color('wall-grid');
      fx.on(ui.stage.frame, 'tick', ({ time }) => {
        floor.clear(ground);
        drawGrid(floor, 0, w, floor.height, glow, (time / 1100) % 1);
        sprite.texture.source.update();
      });
    }
  },

  night: {
    paint(bitmap, theme, w, h) {
      bitmap.gradient(0, 0, w, h, [theme.color('wall-a'), theme.color('wall-b'), theme.color('wall-c')]);
      stars(bitmap, w, Math.round(h * 0.6), theme.color('wall-star'), 5);
      const moon = theme.color('wall-sun');
      const r = Math.round(Math.min(w, h) * 0.07);
      const mx = Math.round(w * 0.78);
      const my = BAR_H + r + 16;
      bitmap.disc(mx, my, r + 5, mix(moon, theme.color('wall-a'), 0.6), { dither: true });
      bitmap.disc(mx, my, r, moon);
      const crater = mix(moon, theme.color('wall-b'), 0.3);
      bitmap.disc(mx - Math.round(r * 0.3), my - Math.round(r * 0.2), Math.max(1, r >> 2), crater);
      bitmap.disc(mx + Math.round(r * 0.35), my + Math.round(r * 0.3), Math.max(1, r >> 3), crater);
      const far = theme.color('wall-far');
      const near = theme.color('wall-near');
      ridge(bitmap, w, h, { base: 0.7, amp: 0.07, seed: 2.2, color: far, edge: lighten(far, 0.12) });
      ridge(bitmap, w, h, { base: 0.85, amp: 0.04, seed: 6.4, color: near, edge: lighten(near, 0.1) });
    },
    animate(wallpaper, fx) {
      const { ui, w, h } = wallpaper;
      const star = ui.theme.value.color('wall-star');
      const twinkle = new Bitmap(3, 3);
      twinkle.fill(1, 0, 1, 3, star);
      twinkle.fill(0, 1, 3, 1, star);
      const random = seeded(33);
      const sparks = Array.from({ length: Math.min(36, Math.round(w * h / 2600)) }, () => {
        const sprite = wallpaper.sprite(fx, twinkle);
        sprite.position.set(Math.floor(random() * w), BAR_H + Math.floor(random() * h * 0.5));
        return { sprite, rate: 500 + random() * 1400, phase: random() * 6.28 };
      });
      fx.on(ui.stage.frame, 'tick', ({ time }) => {
        for (const { sprite, rate, phase } of sparks) {
          sprite.alpha = Math.round((0.5 + 0.5 * Math.sin(time / rate + phase)) * 3) / 3;
        }
      });
    }
  },

  reef: {
    paint(bitmap, theme, w, h) {
      bitmap.gradient(0, 0, w, h, [theme.color('wall-a'), theme.color('wall-b'), theme.color('wall-c')]);
      // Sunlight falls in slanted dithered shafts that fade with depth.
      const light = lighten(theme.color('wall-a'), 0.3);
      for (let y = 0; y < h * 0.75; y++) {
        const fade = 0.22 * (1 - y / (h * 0.75));
        for (let x = 0; x < w; x++) {
          const shaft = Math.sin((x + y * 0.45) * 0.035) + Math.sin((x + y * 0.45) * 0.011 + 1.7);
          if (shaft > 1.15 && bayer(x, y) < fade) bitmap.set(x, y, light);
        }
      }
      const rock = theme.color('wall-far');
      const sand = theme.color('wall-near');
      const random = seeded(41);
      for (let i = Math.max(3, Math.round(w / 70)); i > 0; i--) {
        const r = Math.round(h * (0.04 + random() * 0.05));
        bitmap.disc(Math.floor(random() * w), Math.round(h * 0.9), r, rock);
      }
      const floor = ridge(bitmap, w, h, { base: 0.9, amp: 0.02, seed: 3.3, color: sand, edge: lighten(sand, 0.25) });
      for (let i = Math.round(w * h / 500); i > 0; i--) {
        const x = Math.floor(random() * w);
        const y = floor[x] + 2 + Math.floor(random() * Math.max(1, h - floor[x] - 2));
        bitmap.set(x, y, darken(sand, 0.2));
      }
      // Kelp: stalks that lean as if the current had just let go of them.
      const kelp = theme.color('wall-grid');
      for (let i = Math.max(4, Math.round(w / 45)); i > 0; i--) {
        const root = Math.floor(random() * w);
        const tall = Math.round(h * (0.2 + random() * 0.3));
        const lean = random() * 6.28;
        for (let y = 0; y < tall; y++) {
          const x = root + Math.round(Math.sin(y * 0.07 + lean) * y * 0.06);
          bitmap.fill(x, floor[Math.max(0, Math.min(w - 1, root))] - y, 2, 1, y % 7 < 2 ? lighten(kelp, 0.2) : kelp);
          if (y % 9 === 4) bitmap.fill(x + (y % 18 < 9 ? 2 : -3), floor[Math.max(0, Math.min(w - 1, root))] - y, 3, 1, kelp);
        }
      }
    },
    animate(wallpaper, fx) {
      const { ui, w, h } = wallpaper;
      const theme = ui.theme.value;
      const random = seeded(5);
      const ink = theme.color('ink');
      const looks = [['wall-sun', 'wall-cloud'], ['wall-cloud', 'wall-star'], ['wall-star', 'wall-sun']].map(([body, band]) => [theme.color(body), theme.color(band)]);
      const fish = Array.from({ length: Math.max(4, Math.min(18, Math.round(w * h / 9000))) }, (_, i) => {
        const [body, band] = looks[i % looks.length];
        const right = makeFish(9 + Math.floor(random() * 12), body, band, ink);
        const sprites = [wallpaper.sprite(fx, right), wallpaper.sprite(fx, flipped(right))];
        const item = { sprites, width: right.width, phase: random() * 6.28 };
        swim(item, random() * w);
        return item;
      });
      function swim(item, x = null) {
        item.dir = random() < 0.5 ? 1 : -1;
        item.speed = 6 + random() * 16;
        item.x = x ?? (item.dir > 0 ? -item.width : w);
        item.y = BAR_H + 10 + random() * (h * 0.78 - BAR_H - 10);
        item.sprites[0].visible = item.dir > 0;
        item.sprites[1].visible = item.dir < 0;
      }
      const bead = block(1, 1, theme.color('wall-star'));
      const ring = new Bitmap(3, 3);
      for (const [x, y] of [[1, 0], [0, 1], [2, 1], [1, 2]]) ring.set(x, y, theme.color('wall-star'));
      const bubbles = Array.from({ length: Math.max(8, Math.min(40, Math.round(w / 12))) }, (_, i) => {
        const item = { sprite: wallpaper.sprite(fx, i % 3 ? bead : ring), x: random() * w, y: random() * h, speed: 10 + random() * 14, phase: random() * 6.28 };
        item.sprite.alpha = 0.75;
        return item;
      });
      fx.on(ui.stage.frame, 'tick', ({ dt, time }) => {
        for (const item of fish) {
          item.x += item.dir * item.speed * dt / 1000;
          if (item.x > w + 2 || item.x < -item.width - 2) swim(item);
          const y = Math.round(item.y + Math.sin(time / 900 + item.phase) * 2);
          for (const sprite of item.sprites) sprite.position.set(Math.round(item.x), y);
        }
        for (const item of bubbles) {
          item.y -= item.speed * dt / 1000;
          if (item.y < BAR_H) { item.y = h * (0.86 + random() * 0.1); item.x = random() * w; }
          item.sprite.position.set(Math.round(item.x + Math.sin(time / 400 + item.phase)), Math.round(item.y));
        }
      });
    }
  },

  warp: {
    paint(bitmap, theme, w, h) {
      bitmap.gradient(0, 0, w, h, [theme.color('wall-a'), theme.color('wall-b'), theme.color('wall-a')]);
      const random = seeded(77);
      // Nebulas: dithered glows that thin out toward their edges.
      const nebula = theme.color('wall-c');
      for (let i = 0; i < 3; i++) {
        const nx = Math.floor(random() * w);
        const ny = Math.floor(random() * h);
        const r = Math.round(Math.min(w, h) * (0.15 + random() * 0.2));
        for (let y = Math.max(0, ny - r); y < Math.min(h, ny + r); y++) {
          for (let x = Math.max(0, nx - r); x < Math.min(w, nx + r); x++) {
            const fall = 1 - Math.hypot((x - nx) / r, (y - ny) / r * 1.4);
            if (fall > 0 && bayer(x, y) < fall * fall * 0.6) bitmap.set(x, y, nebula);
          }
        }
      }
      stars(bitmap, w, h, theme.color('wall-far'), 13);
    },
    animate(wallpaper, fx) {
      const { ui, w, h } = wallpaper;
      const theme = ui.theme.value;
      const star = theme.color('wall-star');
      const sky = theme.color('wall-a');
      // Far stars are dim and single; near ones are bright, doubled, with a fading trail behind.
      const shades = [mix(star, sky, 0.4), theme.color('wall-sun'), star].map(color => block(1, 1, color));
      for (const shade of shades) wallpaper.texture(fx, shade);
      const random = seeded(8);
      const cx = w / 2;
      const cy = BAR_H + (h - BAR_H) / 2;
      const focal = Math.min(w, h) * 0.5;
      const spawn = (item, z = 0.25 + random() * 0.75) => {
        const angle = random() * Math.PI * 2;
        const spread = 0.03 + random() * 0.8;
        item.x = Math.cos(angle) * spread;
        item.y = Math.sin(angle) * spread * 0.75;
        item.z = z;
      };
      const project = (item, z) => ({ x: cx + item.x / z * focal, y: cy + item.y / z * focal });
      const field = Array.from({ length: Math.max(30, Math.min(150, Math.round(w * h / 1300))) }, () => {
        const item = { parts: [0, 1, 2].map(() => wallpaper.sprite(fx, shades[0])) };
        spawn(item, 0.02 + random());
        return item;
      });
      fx.on(ui.stage.frame, 'tick', ({ dt }) => {
        for (const item of field) {
          item.z -= 0.36 * dt / 1000;
          let head = project(item, Math.max(0.02, item.z));
          if (item.z <= 0.02 || head.x < -4 || head.x > w + 4 || head.y < -4 || head.y > h + 4) {
            spawn(item, 1);
            head = project(item, item.z);
          }
          const near = item.z < 0.3 ? 2 : item.z < 0.65 ? 1 : 0;
          item.parts.forEach((sprite, k) => {
            const at = k ? project(item, item.z + k * 0.02 * (1 + near)) : head;
            sprite.visible = k === 0 || near > 0;
            sprite.position.set(Math.round(at.x), Math.round(at.y));
            sprite.scale.set(k === 0 && near === 2 ? 2 : 1);
            sprite.alpha = k === 0 ? 1 : 0.6 / k;
          });
          wallpaper.retexture(fx, item.parts[0], shades[near]);
          wallpaper.retexture(fx, item.parts[1], shades[Math.max(0, near - 1)]);
          wallpaper.retexture(fx, item.parts[2], shades[0]);
        }
      });
    }
  },

  rain: {
    paint(bitmap, theme, w, h) {
      bitmap.gradient(0, 0, w, h, [theme.color('wall-a'), theme.color('wall-b'), theme.color('wall-c')]);
      const { ground, towers } = city(w, h);
      const dark = theme.color('wall-near');
      const lit = theme.color('wall-sun');
      const unlit = mix(lit, theme.color('wall-far'), 0.82);
      for (const tower of towers) {
        bitmap.fill(tower.x, tower.top, tower.width, ground - tower.top, tower.far ? theme.color('wall-far') : dark);
        bitmap.fill(tower.x, tower.top, tower.width, 1, lighten(theme.color('wall-far'), 0.15));
        for (const spot of tower.windows) bitmap.fill(spot.x, spot.y, 2, 2, spot.lit ? lit : unlit);
      }
      // The wet street mirrors the lit windows in broken, dithered streaks.
      bitmap.fill(0, ground, w, h - ground, dark);
      for (const tower of towers) {
        for (const spot of tower.windows) {
          if (!spot.lit) continue;
          const y = ground + (ground - spot.y) * 0.35;
          if (y >= h) continue;
          for (let x = spot.x - 1; x <= spot.x + 2; x++) if (bayer(x, Math.round(y)) < 0.5) bitmap.set(x, Math.round(y), mix(lit, dark, 0.55));
        }
      }
    },
    animate(wallpaper, fx) {
      const { ui, w, h } = wallpaper;
      const theme = ui.theme.value;
      const random = seeded(64);
      const { ground, towers } = city(w, h);
      const streak = block(1, 4, theme.color('wall-star'));
      const splash = block(3, 1, theme.color('wall-star'));
      const drops = Array.from({ length: Math.max(30, Math.min(260, Math.round(w * h / 900))) }, () => {
        const item = { sprite: wallpaper.sprite(fx, streak), splash: wallpaper.sprite(fx, splash), x: random() * w, y: random() * h, speed: 220 + random() * 160, wet: 0 };
        item.sprite.alpha = 0.55;
        item.splash.alpha = 0.6;
        item.splash.visible = false;
        return item;
      });
      // Now and then someone switches a light on or off.
      const glow = block(2, 2, theme.color('wall-sun'));
      const spots = towers.flatMap(tower => tower.windows.filter(spot => !spot.lit));
      const lamps = Array.from({ length: Math.min(spots.length, 30) }, () => {
        const spot = spots[Math.floor(random() * spots.length)];
        const sprite = wallpaper.sprite(fx, glow);
        sprite.position.set(spot.x, spot.y);
        sprite.visible = random() < 0.5;
        return { sprite, next: random() * 9000 };
      });
      fx.on(ui.stage.frame, 'tick', ({ dt }) => {
        for (const item of drops) {
          const step = item.speed * dt / 1000;
          item.y += step;
          item.x -= step * 0.18;
          const floor = ground + (item.speed - 220) / 160 * (h - ground);
          if (item.y > floor) {
            item.splash.position.set(Math.round(item.x) - 1, Math.round(floor));
            item.splash.visible = true;
            item.wet = 120;
            item.y = BAR_H - random() * 40;
            item.x = random() * (w + 40);
          }
          if (item.wet > 0 && (item.wet -= dt) <= 0) item.splash.visible = false;
          item.sprite.position.set(Math.round(item.x), Math.round(item.y));
        }
        for (const lamp of lamps) {
          if ((lamp.next -= dt) > 0) continue;
          lamp.sprite.visible = !lamp.sprite.visible;
          lamp.next = 2500 + random() * 9000;
        }
      });
    }
  },

  fireworks: {
    paint(bitmap, theme, w, h) {
      const horizon = Math.round(h * 0.8);
      bitmap.gradient(0, 0, w, horizon, [theme.color('wall-a'), theme.color('wall-b'), theme.color('wall-c')]);
      stars(bitmap, w, Math.round(horizon * 0.7), theme.color('wall-star'), 23);
      const water = theme.color('wall-far');
      bitmap.fill(0, horizon, w, h - horizon, water);
      for (let y = horizon + 2; y < h; y += 3) {
        for (let x = 0; x < w; x++) if (bayer(x, y) < 0.3) bitmap.set(x, y, lighten(water, 0.12));
      }
      const random = seeded(52);
      const shore = theme.color('wall-near');
      for (let x = 0; x < w;) {
        const width = 6 + Math.floor(random() * 22);
        const tall = 4 + Math.floor(random() * h * 0.09);
        bitmap.fill(x, horizon - tall, width, tall, shore);
        if (random() < 0.15) bitmap.fill(x + (width >> 1), horizon - tall - 8, 1, 8, shore);
        x += width;
      }
    },
    animate(wallpaper, fx) {
      const { ui, w, h } = wallpaper;
      const theme = ui.theme.value;
      const random = seeded(90);
      const horizon = Math.round(h * 0.8);
      const colors = ['wall-sun', 'wall-cloud', 'wall-grid', 'accent', 'wall-star'].map(role => block(1, 1, theme.color(role)));
      for (const color of colors) wallpaper.texture(fx, color);
      const trail = block(1, 2, theme.color('wall-sun'));
      const SPARKS = 36;
      const shells = Array.from({ length: 5 }, () => ({
        rocket: wallpaper.sprite(fx, trail),
        sparks: Array.from({ length: SPARKS }, () => ({ sprite: wallpaper.sprite(fx, colors[0]), vx: 0, vy: 0, x: 0, y: 0 })),
        state: 'waiting',
        wait: random() * 2500
      }));
      for (const shell of shells) {
        shell.rocket.visible = false;
        for (const spark of shell.sparks) spark.sprite.visible = false;
      }
      const launch = shell => {
        shell.state = 'rising';
        shell.x = w * (0.1 + random() * 0.8);
        shell.y = horizon;
        shell.top = BAR_H + 20 + random() * (horizon - BAR_H) * 0.45;
        shell.vx = (random() - 0.5) * 18;
        shell.rocket.visible = true;
      };
      const burst = shell => {
        shell.state = 'bursting';
        shell.age = 0;
        shell.rocket.visible = false;
        const color = colors[Math.floor(random() * colors.length)];
        const second = colors[Math.floor(random() * colors.length)];
        const power = 45 + random() * 40;
        shell.sparks.forEach((spark, i) => {
          const angle = i / SPARKS * Math.PI * 2 + random() * 0.15;
          const speed = power * (i % 2 ? 0.8 + random() * 0.2 : 0.2 + random() * 0.6);
          Object.assign(spark, { x: shell.x, y: shell.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed });
          wallpaper.retexture(fx, spark.sprite, i % 2 ? color : second);
          spark.sprite.visible = true;
        });
      };
      fx.on(ui.stage.frame, 'tick', ({ dt }) => {
        const s = dt / 1000;
        for (const shell of shells) {
          if (shell.state === 'waiting' && (shell.wait -= dt) <= 0) launch(shell);
          if (shell.state === 'rising') {
            shell.y -= 95 * s;
            shell.x += shell.vx * s;
            shell.rocket.position.set(Math.round(shell.x), Math.round(shell.y));
            if (shell.y <= shell.top) burst(shell);
          }
          if (shell.state !== 'bursting') continue;
          shell.age += dt;
          const life = 1 - shell.age / 2200;
          for (const spark of shell.sparks) {
            spark.vy += 26 * s;
            spark.vx *= 1 - 0.6 * s;
            spark.x += spark.vx * s;
            spark.y += spark.vy * s;
            spark.sprite.position.set(Math.round(spark.x), Math.round(spark.y));
            spark.sprite.scale.set(shell.age < 350 ? 2 : 1);
            spark.sprite.alpha = Math.max(0, Math.ceil(life * 4) / 4);
            spark.sprite.visible = life > 0 && spark.y < horizon;
          }
          if (life <= 0) { shell.state = 'waiting'; shell.wait = 400 + random() * 2200; }
        }
      });
    }
  },

  squadron: {
    paint(bitmap, theme, w, h) {
      bitmap.gradient(0, 0, w, h, [theme.color('wall-a'), theme.color('wall-b'), theme.color('wall-c')]);
      stars(bitmap, w, Math.round(h * 0.4), theme.color('wall-star'), 31);
      const random = seeded(17);
      const cloud = mix(theme.color('wall-cloud'), theme.color('wall-c'), 0.45);
      const shade = mix(cloud, theme.color('wall-b'), 0.4);
      for (let i = Math.max(2, Math.round(w / 140)); i > 0; i--) {
        const puff = makeCloud(30 + Math.floor(random() * 40), 10 + Math.floor(random() * 8), cloud, shade, random);
        bitmap.blit(puff, Math.floor(random() * w), Math.round(h * (0.55 + random() * 0.35)));
      }
      ridge(bitmap, w, h, { base: 0.94, amp: 0.025, seed: 5.5, color: theme.color('wall-far'), edge: lighten(theme.color('wall-far'), 0.2) });
    },
    animate(wallpaper, fx) {
      const { ui, w, h } = wallpaper;
      const theme = ui.theme.value;
      const random = seeded(12);
      const wing = theme.color('wall-cloud');
      const shade = mix(wing, theme.color('wall-far'), 0.45);
      const edge = theme.color('ink');
      // Three sizes fly at three distances: the small ones behind and slower.
      const sizes = [12, 16, 22].map(size => {
        const beats = [0, 1, 2].map(beat => makeFlyer(size, beat, wing, shade, edge));
        for (const beat of beats) wallpaper.texture(fx, beat);
        return { size, beats, width: beats[0].width, height: beats[0].height, speed: size * 1.6 };
      });
      const count = Math.max(4, Math.min(24, Math.round(w * h / 8000)));
      const cycle = [0, 1, 2, 1];
      const flock = Array.from({ length: count }, (_, i) => {
        const kind = sizes[i < count * 0.4 ? 0 : i < count * 0.75 ? 1 : 2];
        const item = { kind, sprite: wallpaper.sprite(fx, kind.beats[0]), phase: Math.floor(random() * 4), rate: 110 + random() * 60 };
        enter(item, true);
        return item;
      });
      // They come in over the top or right edge and leave at the bottom or left, as a flock does.
      function enter(item, anywhere = false) {
        if (anywhere) { item.x = random() * (w + h); item.y = random() * h - item.kind.height; return; }
        const along = random() * (w + h);
        item.x = along < w ? along + item.kind.width : w + 2;
        item.y = along < w ? -item.kind.height : along - w - item.kind.height;
      }
      fx.on(ui.stage.frame, 'tick', ({ dt, time }) => {
        for (const item of flock) {
          const step = item.kind.speed * dt / 1000;
          item.x -= step;
          item.y += step * 0.55;
          if (item.x < -item.kind.width || item.y > h) enter(item);
          wallpaper.retexture(fx, item.sprite, item.kind.beats[cycle[(Math.floor(time / item.rate) + item.phase) % 4]]);
          item.sprite.position.set(Math.round(item.x), Math.round(item.y));
        }
      });
    }
  },

  dither: {
    paint(bitmap, theme, w, h) {
      bitmap.checker(0, 0, w, h, theme.color('wall-a'), theme.color('wall-b'));
    }
  }
};

export const WALLPAPERS = Object.keys(KINDS);

export class Wallpaper extends Widget {
  #fx = null;
  #textures = new Map();

  constructor(ui) {
    super(ui);
    this.scope.subscribe(ui.theme, () => this.#restart(), { immediate: false });
    this.scope.subscribe(ui.motion, () => this.#restart(), { immediate: false });
  }

  resized() {
    this.#restart();
  }

  paint(bitmap, theme) {
    KINDS[theme.wallpaper].paint(bitmap, theme, this.w, this.h);
  }

  /** The texture of a bitmap, made once and owned by the effect scope `fx`. */
  texture(fx, bitmap) {
    const theme = this.ui.theme.value;
    let texture = this.#textures.get(bitmap);
    if (!texture) {
      if (theme.palette) bitmap.remap(color => theme.lock(color));
      texture = this.ui.stage.texture(bitmap);
      this.#textures.set(bitmap, texture);
      fx.add(() => {
        this.#textures.delete(bitmap);
        texture.destroy(true);
      });
    }
    return texture;
  }

  /** Shows another bitmap in a sprite made by `sprite()`: a wingbeat, a spark's color. */
  retexture(fx, sprite, bitmap) {
    const texture = this.texture(fx, bitmap);
    if (sprite.texture !== texture) sprite.texture = texture;
  }

  /** A sprite above the still scene, owned by the effect scope `fx`. */
  sprite(fx, bitmap) {
    const sprite = new this.ui.PIXI.Sprite(this.texture(fx, bitmap));
    this.view.addChild(sprite);
    fx.add(() => sprite.destroy());
    return sprite;
  }

  #restart() {
    if (this.#fx) this.scope.release(this.#fx);
    this.#fx = null;
    const kind = KINDS[this.ui.theme.value.wallpaper];
    if (!kind.animate || !this.ui.motion.value || this.w < 1 || this.h < 1) return;
    this.#fx = this.scope.child();
    kind.animate(this, this.#fx);
  }
}
