// Geometry of the Dustmap mark: a disk platter made of dots whose used sector
// is lit up in category colours. Coordinates are in a 128x128 box.
// scripts/make-icon.mjs draws the same mark for the app icon.
export interface LogoDot {
  x: number;
  y: number;
  r: number;
  color: string | null;
}

const SECTORS: [number, number, string][] = [
  [-90, -10, '#3b82f6'],
  [-10, 40, '#22c55e'],
  [40, 85, '#ec4899'],
  [85, 125, '#a855f7'],
  [125, 160, '#f97316'],
];

export const LOGO_DOTS: LogoDot[] = (
  [
    [18, 8],
    [32, 14],
    [46, 20],
  ] as const
).flatMap(([rad, n]) =>
  Array.from({ length: n }, (_, i) => {
    const a = -90 + (360 / n) * i;
    const s = SECTORS.find(([a0, a1]) => a >= a0 && a < a1);
    return {
      x: 64 + rad * Math.cos((a * Math.PI) / 180),
      y: 64 + rad * Math.sin((a * Math.PI) / 180),
      r: rad === 46 ? 4.4 : 4,
      color: s ? s[2] : null,
    };
  }),
);
