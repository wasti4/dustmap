'use strict';
// Compositor entry: renders a recording (frames.bin + events.json) into an MP4 with a
// moving camera, a drawn cursor and a backdrop. The drawing happens in compose.html
// (GPU canvas); frames are piped to ffmpeg from there.
//
//   electron scripts/video/compose.cjs --in=video-out/take --out=video-out/dustmap.mp4
//     [--from=s --to=s] [--crf=22] [--preset=slow] [--fps=60]

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || d;

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 200,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  const query = {
    in: path.resolve(arg('in', 'video-out/take')),
    out: path.resolve(arg('out', 'video-out/dustmap.mp4')),
    from: arg('from', ''),
    to: arg('to', ''),
    crf: arg('crf', '22'),
    preset: arg('preset', 'slow'),
    fps: arg('fps', '60'),
  };
  win.webContents.on('console-message', (e) => console.log(e.message ?? e));
  ipcMain.once('done', (_e, code) => app.exit(code));
  win.loadFile(path.join(__dirname, 'compose.html'), { query });
});
