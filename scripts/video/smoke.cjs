'use strict';
// Quick pipeline check: hover the first drive card and wheel the page a little.
exports.run = async (rec) => {
  await rec.sleep(300);
  await rec.moveTo({ sel: '.drive-card', text: 'C:' });
  await rec.sleep(600);
  await rec.moveTo({ sel: '.theme-toggle' });
  await rec.sleep(500);
};
