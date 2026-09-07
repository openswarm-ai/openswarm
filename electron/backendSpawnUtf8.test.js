const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// 46 reads in backend/apps open text files without naming an encoding; on Windows the default is
// cp1252 and the first non-Latin byte raises. The packaged spawn declares UTF-8, and the CI suites
// run under the same declaration (suites-matrix.yml), so the two must not drift apart.
test('every backend spawn in main.js declares PYTHONUTF8=1', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const spawns = main.match(/PYTHONUTF8: '1'/g) || [];
  assert.ok(spawns.length >= 2, `expected the dev and packaged spawn envs to carry PYTHONUTF8, found ${spawns.length}`);
});
