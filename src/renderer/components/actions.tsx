import { Copy, ExternalLink, FolderOpen, FolderSearch, Trash, X } from 'lucide-react';
import type { NodeInfo } from '../../shared/types';
import { api } from '../lib/api';
import { focusNode, pathsFor, setState, t, toast } from '../state';
import type { MenuItem } from './ui';

async function pathOf(node: NodeInfo): Promise<string | null> {
  const [p] = await pathsFor([node]);
  return p?.path ?? null;
}

export async function openNode(node: NodeInfo) {
  const p = await pathOf(node);
  if (p) await api.openPath(p);
}

export async function revealNode(node: NodeInfo) {
  const p = await pathOf(node);
  if (p) await api.reveal(p);
}

export function askRemove(items: NodeInfo[], mode: 'trash' | 'permanent') {
  if (items.length) setState({ dialog: { type: 'remove', items, mode } });
}

export function nodeMenu(node: NodeInfo, opts: { zoom?: boolean } = {}): MenuItem[] {
  const items: MenuItem[] = [
    { label: t('act.open'), icon: ExternalLink, onClick: () => void openNode(node) },
    { label: t('act.reveal'), icon: FolderOpen, onClick: () => void revealNode(node) },
    {
      label: t('act.copy'),
      icon: Copy,
      onClick: async () => {
        const p = await pathOf(node);
        if (p) {
          await api.copyText(p);
          toast(t('toast.copied'), 'success');
        }
      },
    },
  ];
  if (node.dir && opts.zoom !== false) items.push({ label: t('act.zoom'), icon: FolderSearch, onClick: () => focusNode(node.id) });
  items.push(
    { label: '', separator: true, onClick: () => undefined },
    { label: t('act.trash'), icon: Trash, onClick: () => askRemove([node], 'trash') },
    { label: t('act.delete'), icon: X, danger: true, onClick: () => askRemove([node], 'permanent') },
  );
  return items;
}
