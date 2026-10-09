/**
 * Motion primitives derived from Apple's fluid-interface model.
 *
 * Every easing here is a real damped-harmonic solution, not an eyeballed
 * cubic-bezier. `response` is the time constant (NOT a duration — a spring has
 * no fixed duration; its settle time emerges from the parameters), and `zeta`
 * is the damping ratio: 1.0 settles without overshoot, below 1.0 overshoots.
 *
 * Rule that governs when bounce is allowed: overshoot is earned by momentum.
 * A flick, a throw, a drag release already carried velocity, so a little
 * bounce reads as physical. A menu that merely faded in has no momentum, and
 * overshoot on it reads as a mistake.
 */

import type { Transition } from "framer-motion";

export type SpringName = "default" | "momentum" | "snappy" | "soft" | "drawer";

/** Apple's shipped parameters, expressed in the bounce/duration API. */
export const SPRINGS: Record<SpringName, Transition> = {
  // Move / reposition (e.g. PiP) — the house default.
  default: { type: "spring", bounce: 0, duration: 0.4 },
  // Drawer / sheet. Slight overshoot because a drawer is always a drag release.
  drawer: { type: "spring", bounce: 0.2, duration: 0.3 },
  // Press feedback. Must be fast enough to land inside the finger's own frame.
  snappy: { type: "spring", bounce: 0, duration: 0.25 },
  // Large surfaces: more presence, no bounce — nothing threw these.
  soft: { type: "spring", bounce: 0, duration: 0.5 },
  // A release that carried real velocity.
  momentum: { type: "spring", bounce: 0.2, duration: 0.3 }
};

/**
 * Momentum projection: where a flick would *naturally* coast to, so the
 * resting position can be chosen from the projection rather than from the
 * release point. This is what makes a throw feel like a throw.
 *
 * Exponential-deceleration form, as shipped in Apple's sample code — not the
 * physics-textbook v²/(2·decel).
 */
export function project(velocityPxPerSec: number, decelerationRate = 0.998): number {
  return (velocityPxPerSec / 1000) * decelerationRate / (1 - decelerationRate);
}

/** Choose the nearest resting point to the projected endpoint, not to release. */
export function nearestSnap(projected: number, points: number[]): number {
  return points.reduce((best, point) =>
    Math.abs(point - projected) < Math.abs(best - projected) ? point : best
  );
}

/**
 * Soft boundary resistance. A hard stop reads as "frozen"; progressively
 * increasing resistance reads as "responsive, but there is nothing more here".
 * `dimension` is the size of the travelling surface.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Roll a pointer's recent samples into a usable release velocity.
 * A single current-point delta is far too noisy to hand to a spring; sampling
 * a short history and fitting over the window is what removes the jitter.
 */
export class VelocityTracker {
  private samples: Array<{ position: number; time: number }> = [];
  private readonly window: number;

  constructor(windowMs = 90) {
    this.window = windowMs;
  }

  reset(position: number, time = performance.now()) {
    this.samples = [{ position, time }];
  }

  push(position: number, time = performance.now()) {
    this.samples.push({ position, time });
    const cutoff = time - this.window;
    while (this.samples.length > 2 && this.samples[0].time < cutoff) this.samples.shift();
  }

  /** px per second over the sampled window. */
  velocity(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const elapsed = last.time - first.time;
    if (elapsed <= 0) return 0;
    return ((last.position - first.position) / elapsed) * 1000;
  }
}

/** A press must feel like it happened on pointer-down, not on release. */
export const PRESS_SCALE = 0.97;

/** Drag-vs-tap hysteresis. Below this, the gesture is still a tap. */
export const DRAG_THRESHOLD_PX = 10;

/**
 * Target for a release with velocity: start from the current value and let the
 * spring inherit the gesture's velocity, so there is no seam between the drag
 * and the settle.
 */
export function handoff(current: number, velocity: number, targets: number[]): number {
  return nearestSnap(current + project(velocity), targets);
}
