// Shared esbuild options for the Node-side bundles (main, preload, engine, cli).
export function nodeBundles({ engineOnly = false } = {}) {
  return {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    external: ['electron'],
    logLevel: 'warning',
    outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' },
    entryPoints: engineOnly
      ? { engine: 'src/engine/index.ts', cli: 'src/engine/cli.ts' }
      : {
          main: 'src/main/main.ts',
          preload: 'src/main/preload.ts',
          engine: 'src/engine/index.ts',
          cli: 'src/engine/cli.ts',
        },
  };
}
