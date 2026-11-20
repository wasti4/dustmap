import type { StorageApi } from '../../shared/types';

declare global {
  interface Window {
    storage?: StorageApi;
  }
}

export let api: StorageApi;

/** Uses the Electron preload API, or an in-browser demo backend for UI development. */
export async function initApi(): Promise<boolean> {
  if (window.storage && !new URLSearchParams(location.search).has('demo')) {
    api = window.storage;
    return true;
  }
  const { createMockApi } = await import('./mock');
  api = createMockApi();
  return false;
}

export function engine<T>(method: string, params?: unknown): Promise<T> {
  return api.engine<T>(method, params);
}
