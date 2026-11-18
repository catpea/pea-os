/**
 * Pea Catch: steer the pod, catch the green peas, dodge the plum ones.
 * The whole game is drawn into one <canvas> with the Bitmap API; the score
 * labels in catch.xml follow the "score" and "best" signals by themselves.
 */

const GROUND = 8;
const POD_W = 24;
const POD_H = 7;
const PEA = 9;

export default function peaCatch(app) {
  const { Bitmap, parseColor, rgba, seeded } = app.gfx;
  const { field } = app.refs;
  const { font, sprites } = app;
  const score = app.signal('score');
  const best = app.signal('best');

  const sky = ['#141a33', '#2b3a8c', '#6d3fa8', '#ff9a3d'].map(parseColor);
  const grass = parseColor('#2e8b3a');
  const turf = parseColor('#8fd95a');
  const soil = parseColor('#1d4d2b');
  const cream = parseColor('#fbf7ea');
  const ink = parseColor('#16161d');
  const berry = parseColor('#e8475a');
  const sun = parseColor('#ffd75e');
  const flashColor = rgba(255, 255, 255, 70);

  let backdrop = null;
  let state = 'title'; // 'title' | 'play' | 'over'
  let lives = 3;
  let elapsed = 0;
  let spawnIn = 0;
  let shake = 0;
  let flash = 0;
  let peas = [];
  let sparks = [];
  let popups = [];
  const pod = { x: 0, target: 0, dip: 0 };

  function paintBackdrop() {
    const { w, h } = field;
    backdrop = new Bitmap(w, h);
    backdrop.gradient(0, 0, w, h - GROUND, sky);
    const random = seeded(3);
    for (let i = Math.round(w * h / 500); i > 0; i--) {
      backdrop.set(Math.floor(random() * w), Math.floor(random() * h * 0.45), cream);
    }
    backdrop.fill(0, h - GROUND, w, GROUND, grass);
    backdrop.fill(0, h - GROUND, w, 1, turf);
    for (let x = 0; x < w; x += 2) backdrop.set(x + (random() < 0.5 ? 0 : 1), h - GROUND + 2 + Math.floor(random() * (GROUND - 3)), soil);
    pod.x = pod.target = w / 2;
  }

  function start() {
    state = 'play';
    lives = 3;
    elapsed = 0;
    spawnIn = 500;
    peas = [];
    score.set(0);
  }

  function hurt() {
    lives -= 1;
    shake = 240;
    flash = 110;
    if (lives > 0) return;
    state = 'over';
    best.set(Math.max(best.value, score.value));
  }

  function update(dt) {
    const { w, h } = field;
    const seconds = dt / 1000;
    pod.target = Math.min(w - POD_W / 2, Math.max(POD_W / 2, pod.target));
    pod.x += (pod.target - pod.x) * Math.min(1, seconds * 16);
    pod.dip = Math.max(0, pod.dip - dt);
    shake = Math.max(0, shake - dt);
    flash = Math.max(0, flash - dt);
    sparks = sparks.filter(spark => (spark.age += dt) < 330);
    popups = popups.filter(popup => {
      popup.y -= 20 * seconds;
      return (popup.age += dt) < 700;
    });
    if (state !== 'play') return;

    elapsed += dt;
    spawnIn -= dt;
    if (spawnIn <= 0) {
      spawnIn = Math.max(340, 950 - elapsed / 60) * (0.7 + Math.random() * 0.6);
      peas.push({
        x: 4 + Math.random() * (w - PEA - 8),
        y: -PEA,
        speed: 26 + Math.min(70, elapsed / 800) + Math.random() * 14,
        bad: Math.random() < Math.min(0.35, 0.1 + elapsed / 150000)
      });
    }

    const rim = h - GROUND - POD_H;
    for (const pea of peas) {
      pea.speed += 46 * seconds;
      pea.y += pea.speed * seconds;
      const bottom = pea.y + PEA;
      if (bottom >= rim + 2 && bottom <= rim + POD_H + 6 && Math.abs(pea.x + PEA / 2 - pod.x) < POD_W / 2 + 1) {
        pea.gone = true;
        pod.dip = 90;
        if (pea.bad) {
          hurt();
        } else {
          score.update(points => points + 1);
          sparks.push({ x: pea.x + 1, y: rim - 6, age: 0 });
          popups.push({ x: pea.x, y: rim - 10, age: 0 });
        }
      } else if (bottom > h - GROUND + 3) {
        pea.gone = true;
        if (!pea.bad) hurt();
      }
    }
    peas = peas.filter(pea => !pea.gone);
  }

  function banner(bitmap, title, hint, time) {
    const { w, h } = field;
    const style = { scale: 2 };
    const x = (w - font.measure(title, style)) >> 1;
    const y = (h >> 1) - 22;
    font.draw(bitmap, title, x + 2, y + 2, ink, style);
    font.draw(bitmap, title, x, y, sun, style);
    if (Math.floor(time / 450) % 2) return;
    font.drawOutlined(bitmap, hint, (w - font.measure(hint)) >> 1, y + 26, cream, ink);
  }

  function draw(time) {
    const { bitmap, w, h } = field;
    if (!bitmap || !backdrop || backdrop.width !== bitmap.width || backdrop.height !== bitmap.height) return;
    bitmap.px.set(backdrop.px);
    const jolt = shake > 0 ? Math.round(Math.sin(time / 16) * 2) : 0;

    for (const pea of peas) bitmap.blit(sprites.get(pea.bad ? 'plum-9' : 'pea-9').frames[0], pea.x + jolt, pea.y);
    bitmap.blit(sprites.get('pod').frames[0], pod.x - POD_W / 2 + jolt, h - GROUND - POD_H + (pod.dip > 0 ? 1 : 0));

    const sparkle = sprites.get('sparkle').frames;
    for (const spark of sparks) bitmap.blit(sparkle[Math.min(sparkle.length - 1, Math.floor(spark.age / 85))], spark.x, spark.y);
    for (const popup of popups) font.drawOutlined(bitmap, '+1', Math.round(popup.x), Math.round(popup.y), sun, ink);
    for (let i = 0; i < lives; i++) font.drawOutlined(bitmap, '♥', w - 11 - i * 9, 3, berry, ink);

    if (flash > 0) bitmap.fill(0, 0, w, h, flashColor);
    if (state === 'title') banner(bitmap, 'PEA CATCH', 'Tap to play', time);
    if (state === 'over') banner(bitmap, 'GAME OVER', 'Tap to play again', time);
    field.commit();
  }

  const steer = point => { pod.target = point.x; };
  app.scope.on(field.events, 'resize', paintBackdrop);
  app.scope.on(field.events, 'move', steer);
  app.scope.on(field.events, 'down', point => {
    steer(point);
    if (state !== 'play') start();
  });
  app.scope.on(app.keys, 'down', ({ key }) => {
    if (key === 'ArrowLeft') pod.target -= 26;
    else if (key === 'ArrowRight') pod.target += 26;
    else if ((key === ' ' || key === 'Enter') && state !== 'play') start();
  });
  app.frame(({ dt, time }) => {
    update(dt);
    draw(time);
  });

  if (field.bitmap) paintBackdrop();
}
