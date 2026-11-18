import { Widget } from '../ui/widget.js';
import { ease } from '../gfx/animator.js';
import { parseColor } from '../gfx/color.js';
import { makeBall, PEA } from '../gfx/art.js';

const TITLE = 'Pea OS';
const RAINBOW = ['#8fd95a', '#46b04a', '#ffd75e', '#ff9a3d', '#e8475a', '#63d2f0'].map(parseColor);
const NIGHT = ['#16161d', '#1b2036', '#243056'].map(parseColor);
const DOTS = 5;

/** The boot screen: a pea drops in, the name spells itself, the desk slides up. */
export class Splash extends Widget {
  interactive = true;
  #letters = 0;
  #dots = 0;
  #peaY = -60;
  #slide = 0;
  #skipped = false;
  #step = null;

  constructor(ui, { release }) {
    super(ui);
    this.release = release;
    this.pea = new ui.PIXI.Sprite(ui.spriteTexture(ui.sprites.get('pea-48').frames[0]));
    this.view.addChild(this.pea);
    this.dot = makeBall(2, PEA);
  }

  get #rest() {
    return (this.h >> 1) - 52;
  }

  arrange() {
    this.view.position.set(this.x, this.y - this.#slide);
    this.pea.position.set((this.w - 48) >> 1, Math.round(this.#peaY));
  }

  paint(bitmap, theme) {
    const { font } = this.ui;
    bitmap.gradient(0, 0, this.w, this.h, NIGHT.map(color => theme.lock(color)));

    const style = { scale: 3 };
    let x = (this.w - font.measure(TITLE, style)) >> 1;
    const y = (this.h >> 1) + 6;
    [...TITLE].forEach((ch, i) => {
      if (i < this.#letters) {
        font.draw(bitmap, ch, x + 2, y + 2, theme.lock(NIGHT[0]), style);
        font.draw(bitmap, ch, x, y, theme.lock(RAINBOW[i % RAINBOW.length]), style);
      }
      x += font.measure(ch, style) + font.spacing * style.scale;
    });

    if (this.#letters < TITLE.length) return;
    const tag = `release ${this.release}`;
    font.draw(bitmap, tag, (this.w - font.measure(tag)) >> 1, y + 34, theme.lock(RAINBOW[0]));
    for (let i = 0; i < this.#dots; i++) bitmap.blit(this.dot, (this.w >> 1) - DOTS * 4 + i * 8 + 1, y + 50);
  }

  pointer(type) {
    if (type !== 'down') return;
    this.#skipped = true;
    this.#step?.cancel();
  }

  /** Runs the sequence; resolves when the splash has left the screen. */
  async play() {
    const { anim } = this.ui;
    const run = async step => {
      if (this.#skipped) return;
      this.#step = step();
      await this.#step;
    };

    await run(() => anim.tween(700, t => {
      this.#peaY = -60 + (this.#rest + 60) * t;
      this.arrange();
    }, { easing: ease.bounce }));
    for (let i = 1; i <= TITLE.length; i++) {
      await run(() => anim.wait(75));
      this.#letters = i;
      this.invalidate();
    }
    for (let i = 1; i <= DOTS; i++) {
      await run(() => anim.wait(130));
      this.#dots = i;
      this.invalidate();
    }
    await run(() => anim.wait(350));

    this.#peaY = this.#rest;
    this.#letters = TITLE.length;
    this.arrange();
    this.invalidate();
    this.interactive = false;
    await anim.tween(320, t => {
      this.#slide = Math.round(this.h * t);
      this.arrange();
    }, { easing: ease.in });
  }
}
