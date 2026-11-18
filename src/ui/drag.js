import { Widget } from './widget.js';

/**
 * Drag and drop between widgets.
 *
 * A source starts a drag from its own pointer handler, once a press has
 * moved far enough: `ui.drag(payload, { label, sprite })`. From then on the
 * pointer belongs to the drag and the source forgets its press. A ghost of
 * the label follows the pointer. A widget under the pointer that answers
 * `accepts(payload)` with true shows a "copy" cursor; on release, the nearest
 * widget under the pointer that accepts the payload takes it with
 * `drop(payload, event)`. Anywhere else the drag simply ends.
 *
 * A payload is plain data, such as { kind: 'node-type', value: 'clock' }.
 */
export class DragGhost extends Widget {
  constructor(ui, { label, sprite, zoom }) {
    super(ui);
    this.label = label;
    this.picture = sprite && ui.sprites.has(sprite) ? ui.sprites.get(sprite).frames[0] : null;
    this.zoom = zoom;
    this.accepted = false;
  }

  content() {
    return { w: this.ui.font.measure(this.label) + (this.picture ? this.picture.width + 4 : 0) + 12, h: 15 };
  }

  setAccepted(accepted) {
    if (accepted === this.accepted) return;
    this.accepted = accepted;
    this.invalidate();
  }

  paint(bitmap, theme) {
    const face = theme.color(this.accepted ? 'accent' : 'panel');
    bitmap.roundFill(0, 0, this.w, this.h, 2, face);
    bitmap.roundFrame(0, 0, this.w, this.h, 2, theme.color('ink'));
    let x = 6;
    if (this.picture) { bitmap.blit(this.picture, x, (this.h - this.picture.height) >> 1); x += this.picture.width + 4; }
    this.ui.font.draw(bitmap, this.label, x, 4, theme.color(this.accepted ? 'accent-ink' : 'panel-ink'));
  }
}
