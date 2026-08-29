/** True on phones/tablets (finger primary). Desktop stays WASD-only. */
export function isTouchUi() {
  return window.matchMedia("(pointer: coarse)").matches;
}

export function bindJoystick(
  base: HTMLElement,
  knob: HTMLElement,
  onVec: (x: number, y: number) => void,
) {
  const max = 46;
  const dead = 0.12;
  let pointerId: number | null = null;

  const setKnob = (nx: number, ny: number) => {
    knob.style.transform = `translate(${nx * max}px, ${-ny * max}px)`;
  };

  const end = (e: PointerEvent) => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    pointerId = null;
    onVec(0, 0);
    setKnob(0, 0);
    base.releasePointerCapture(e.pointerId);
  };

  const move = (e: PointerEvent) => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const r = base.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = e.clientX - cx;
    let dy = cy - e.clientY;
    const len = Math.hypot(dx, dy) || 1;
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    let x = dx / max;
    let y = dy / max;
    if (Math.hypot(x, y) < dead) {
      x = 0;
      y = 0;
    }
    onVec(x, y);
    setKnob(x, y);
  };

  const start = (e: PointerEvent) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    base.setPointerCapture(e.pointerId);
    e.preventDefault();
    move(e);
  };

  base.addEventListener("pointerdown", start);
  base.addEventListener("pointermove", move);
  base.addEventListener("pointerup", end);
  base.addEventListener("pointercancel", end);
}
