import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Strict Content-Security-Policy for the packaged app. It is only added to
// production builds because the dev server injects inline scripts for HMR.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join('; ');

const csp = {
  name: 'csp-meta',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      if (ctx.server) return html;
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  },
};

// Renderer (UI) build. Main process, preload and the scan engine are bundled
// separately by esbuild in scripts/build.mjs.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), csp],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
