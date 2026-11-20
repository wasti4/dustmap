import {
  AppWindow,
  Archive,
  CodeXml,
  FileText,
  Film,
  Gamepad2,
  Headphones,
  Image,
  Layers,
  Settings,
  Shapes,
  Trash,
  type LucideIcon,
} from 'lucide-react';
import { CATEGORIES, type CategoryId } from '../../shared/types';

export interface CatMeta {
  id: CategoryId;
  dark: string;
  light: string;
  Icon: LucideIcon;
}

// Hues are spread around the wheel and ordered so neighbours in the bar contrast.
export const CAT_META: CatMeta[] = [
  { id: 'apps', dark: '#3b82f6', light: '#2563eb', Icon: AppWindow },
  { id: 'developer', dark: '#22c55e', light: '#16a34a', Icon: CodeXml },
  { id: 'photos', dark: '#ec4899', light: '#db2777', Icon: Image },
  { id: 'videos', dark: '#a855f7', light: '#9333ea', Icon: Film },
  { id: 'documents', dark: '#22d3ee', light: '#0891b2', Icon: FileText },
  { id: 'music', dark: '#facc15', light: '#ca8a04', Icon: Headphones },
  { id: 'archives', dark: '#d6a676', light: '#a16207', Icon: Archive },
  { id: 'games', dark: '#a3e635', light: '#65a30d', Icon: Gamepad2 },
  { id: 'system', dark: '#a1a1aa', light: '#71717a', Icon: Settings },
  { id: 'caches', dark: '#f97316', light: '#ea580c', Icon: Layers },
  { id: 'trash', dark: '#ef4444', light: '#dc2626', Icon: Trash },
  { id: 'other', dark: '#64748b', light: '#64748b', Icon: Shapes },
];

if (CAT_META.length !== CATEGORIES.length) throw new Error('category meta out of sync');

export const catColor = (cat: number, dark: boolean) => (dark ? CAT_META[cat]?.dark : CAT_META[cat]?.light) ?? '#888';

/** "#rrggbb" + alpha → "rgba(...)". */
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
