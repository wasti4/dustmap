'use strict';
// The README demo: scan drive C: against a stopwatch, then tour the results.
// Targets are found in the live DOM, so the script survives layout changes.

exports.run = async (rec) => {
  const pause = rec.sleep;

  // 1. Home screen, then pick drive C:.
  rec.camera({ mode: 'overview' });
  await pause(900);
  rec.camera({ mode: 'follow', zoom: 1.45, pan: 3.0, zs: 2.6 });
  await rec.moveTo({ sel: '.drive-card', text: 'C:', at: [0.7, 0.62] });
  await pause(380);
  rec.mark('scanStart');
  await rec.click();

  // 2. The scan, framed on the storage widget while the stopwatch runs.
  await rec.waitFor('.widget');
  const widget = await rec.rect({ sel: '.widget' });
  // Frame the widget together with the live file and folder counters to its right.
  const scanView = { x: widget.x, y: widget.y, w: widget.w + 400, h: widget.h + 40 };
  rec.camera({ mode: 'focus', rect: scanView, max: 1.6, pan: 3.2, zs: 2.8 });
  await rec.moveTo({ x: widget.x + widget.w * 0.86, y: widget.y + widget.h + 70 }, { dur: 900 });
  await rec.waitFor('.widget-tools', 'Rescan', 120000);
  rec.mark('scanEnd');
  await pause(2000);

  // 3. Hover the category bar: each segment explains itself in the status line.
  const bar = await rec.rect({ sel: '.dotbar' });
  rec.camera({ mode: 'follow', zoom: 1.75, pan: 2.8, dy: 30 });
  await rec.moveTo({ x: bar.x + bar.w * 0.12, y: bar.y + bar.h * 0.55 });
  await pause(700);
  await rec.moveTo({ x: bar.x + bar.w * 0.4, y: bar.y + bar.h * 0.45 }, { dur: 950, arc: 0.04 });
  await pause(750);

  // 4. Explorer: open the biggest folder.
  rec.camera({ mode: 'follow', zoom: 1.5, pan: 2.6, zs: 2.4 });
  await rec.moveTo({ sel: '.tr[role="row"]', index: 0, at: [0.18, 0.5] });
  await pause(300);
  await rec.click({ double: true });
  await pause(900);

  // 5. Full treemap.
  await rec.moveTo({ sel: 'button[title="Map"]' });
  await pause(150);
  await rec.click();
  await pause(200);
  const map = await rec.rect({ sel: '.treemap' });
  rec.camera({ mode: 'focus', rect: map, zoom: 1.28, pan: 2.4, zs: 2.2 });
  await rec.moveTo({ x: map.x + map.w * 0.24, y: map.y + map.h * 0.42 });
  await pause(650);
  await rec.moveTo({ x: map.x + map.w * 0.62, y: map.y + map.h * 0.58 }, { dur: 1000 });
  await pause(650);

  // 6. Largest files.
  rec.camera({ mode: 'follow', zoom: 1.55, pan: 2.8, dy: 120 });
  await rec.moveTo({ sel: '.tab', text: 'Largest files' });
  await pause(150);
  await rec.click();
  await pause(700);
  await rec.moveTo({ sel: '.li', index: 1, at: [0.35, 0.5] }, { dur: 750 });
  await rec.scroll(240, 850);
  await pause(400);

  // 7. Files nobody has opened for a long time: loosen the size filter, pick two.
  await rec.moveTo({ sel: '.tab', text: 'Forgotten' });
  await pause(150);
  await rec.click();
  await pause(600);
  // What counts as forgotten depends on the machine: shorten the period, then the size,
  // until something shows up.
  let found = false;
  for (const filter of ['=3 months', '=10 MB']) {
    await rec.moveTo({ sel: '.segmented button', text: filter }, { dur: 700 });
    await pause(150);
    await rec.click();
    found = await rec.waitFor('.li .check', '', 3500).then(() => true, () => false);
    if (found) break;
  }
  if (found) {
    await pause(400);
    await rec.moveTo({ sel: '.li .check', index: 0 }, { dur: 750 });
    await rec.click();
    await pause(280);
    await rec.moveTo({ sel: '.li .check', index: 1 }, { dur: 420 });
    await rec.click();
    await pause(1100);
  }

  // 8. Back home and flip the theme.
  rec.camera({ mode: 'follow', zoom: 1.5, pan: 2.8 });
  await rec.moveTo({ sel: '.tb-btn', text: 'All drives' });
  await pause(150);
  await rec.click();
  await pause(600);
  rec.camera({ mode: 'follow', zoom: 1.9, pan: 2.6, zs: 2.4 });
  await rec.moveTo({ sel: '.theme-toggle' });
  await pause(300);
  await rec.click();
  await pause(1400);
  rec.camera({ mode: 'overview', pan: 2.2, zs: 2.0 });
  await rec.moveTo({ x: rec.size.width * 0.6, y: rec.size.height * 0.8 }, { dur: 1100 });
  await pause(1600);
};
