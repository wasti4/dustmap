'use strict';
// Cursor paths shared by the recorder (which moves the real mouse along them) and the
// compositor (which draws the cursor at exact frame times), so both agree to the pixel.

/** Minimum-jerk easing: the velocity profile of a relaxed human hand movement. */
const minJerk = (u) => u * u * u * (10 - 15 * u + 6 * u * u);

const lerp = (a, b, u) => a + (b - a) * u;

function bezier(m, u) {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return {
    x: a * m.p0.x + b * m.c1.x + c * m.c2.x + d * m.p1.x,
    y: a * m.p0.y + b * m.c1.y + c * m.c2.y + d * m.p1.y,
  };
}

/**
 * Builds a gently arched move from p0 to p1. The arc bends to one side by a share of the
 * distance, and the duration grows with distance like a real pointer movement.
 */
function planMove(p0, p1, opts = {}) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy);
  const dur = opts.dur ?? Math.min(1250, Math.max(420, 300 + dist * 0.62));
  const bend = (opts.arc ?? 0.12) * dist;
  // Perpendicular unit vector; arcs bow "upwards" for horizontal moves.
  const nx = dist ? -dy / dist : 0;
  const ny = dist ? dx / dist : 0;
  const side = ny > 0 ? -1 : 1;
  return {
    p0,
    p1,
    c1: { x: p0.x + dx * 0.3 + nx * bend * side, y: p0.y + dy * 0.3 + ny * bend * side },
    c2: { x: p0.x + dx * 0.75 + nx * bend * side * 0.6, y: p0.y + dy * 0.75 + ny * bend * side * 0.6 },
    dur,
  };
}

/** Position on a planned move at local time ms (clamped to the ends). */
function moveAt(m, ms) {
  const u = Math.min(1, Math.max(0, ms / m.dur));
  return bezier(m, minJerk(u));
}

/** Cursor position at time t given logged moves [{t0, ...move}] and a start point. */
function cursorAt(moves, start, t) {
  let pos = start;
  for (const m of moves) {
    if (t < m.t0) break;
    pos = moveAt(m, t - m.t0);
  }
  return pos;
}

/**
 * Critically damped spring step (exact solution for one time step), used for the camera:
 * it chases a moving target and settles without overshoot, easing out at the end.
 */
function springStep(x, v, target, omega, dt) {
  const d = x - target;
  const e = Math.exp(-omega * dt);
  const nx = target + (d + (v + omega * d) * dt) * e;
  const nv = (v - omega * (v + omega * d) * dt) * e;
  return [nx, nv];
}

module.exports = { minJerk, lerp, bezier, planMove, moveAt, cursorAt, springStep };
