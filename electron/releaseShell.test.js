// Every installed copy polls github.com/openswarm-ai/openswarm for updates, and the landing page links
// its downloads there. When the source moves to a private repo that public repo becomes a releases-only
// shell, so every path that publishes or downloads a build must name the shell, never "the repo I run in".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

const SHELL = 'openswarm-ai/openswarm';
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('electron-builder publishes into the shell', () => {
  assert.deepStrictEqual(pkg.build.publish, { provider: 'github', owner: 'openswarm-ai', repo: 'openswarm' });
});

test('both updater feeds in main.js point at the shell', () => {
  const main = read('electron/main.js');
  assert.ok(main.includes(`https://github.com/${SHELL}/releases/latest/download/RELEASES`), 'the Squirrel probe');
  assert.ok(main.includes(`setFeedURL({ url: 'https://github.com/${SHELL}/releases/latest/download/' })`), 'the Squirrel feed');
});

test('the Windows installer icon and alias upload name the shell', () => {
  const ps1 = read('scripts/build-app-win.ps1');
  assert.ok(ps1.includes(`https://raw.githubusercontent.com/${SHELL}/main/electron/build/icon.ico`), 'Squirrel reads the icon off the shell main branch');
  assert.ok(ps1.includes(`gh release upload "v$version" $AliasExe --repo ${SHELL} --clobber`));
  assert.ok(fs.existsSync(path.join(root, 'release-shell/electron/build/icon.ico')), 'the shell must keep the icon at that path');
});

test('every release workflow publishes with the shell token and names the shell', () => {
  for (const wf of ['release-macos.yml', 'release-windows.yml']) {
    const y = read(`.github/workflows/${wf}`);
    const check = y.indexOf('run: bash scripts/release/check-shell-token.sh');
    const build = y.indexOf('- name: Build app');
    assert.ok(check > 0 && check < build, `${wf}: the shell check runs before the build`);
    const buildEnv = y.slice(build, y.indexOf('run:', build));
    assert.ok(buildEnv.includes('GH_TOKEN: ${{ secrets.RELEASE_SHELL_TOKEN }}'), `${wf}: the build publishes with the shell token`);
    assert.ok(!y.includes('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), `${wf}: a workflow token only writes to its own repo`);
  }
  const win = read('.github/workflows/release-windows.yml');
  assert.ok(win.includes(`GH_REPO: ${SHELL}`), 'gh release calls on Windows land in the shell');
});

test('no download or gate path reads the repo it runs in', () => {
  for (const wf of ['promotion-gate.yml', 'intel-x64-verify.yml', 'smoke-windows-packaged.yml']) {
    const y = read(`.github/workflows/${wf}`);
    assert.ok(!y.includes('github.repository') && !y.includes('GITHUB_REPOSITORY'), `${wf} must name ${SHELL}`);
    assert.ok(y.includes(SHELL), `${wf} names the shell`);
  }
});

test('the source repo gate is by hand and the shell copy answers release events', () => {
  assert.ok(!read('.github/workflows/promotion-gate.yml').includes('\n  release:'), 'release events never fire in the build repo');
  const shellGate = read('release-shell/.github/workflows/promotion-gate.yml');
  assert.ok(shellGate.includes('\n  release:\n    types: [published, released, prereleased]'));
  assert.ok(shellGate.includes('node scripts/release/verify-release.js'));
});

test('the shell carries byte-identical copies of what its gate and installer need', () => {
  for (const rel of ['scripts/release/verify-release.js', 'electron/build/icon.ico']) {
    assert.ok(fs.readFileSync(path.join(root, rel)).equals(fs.readFileSync(path.join(root, 'release-shell', rel))), `${rel} drifted`);
  }
});

test('publish.sh sends releases and the ENG-319 tag guard to the shell, not to origin', () => {
  const sh = read('publish.sh');
  assert.ok(sh.includes(`export GH_REPO="\${GH_REPO:-${SHELL}}"`));
  assert.ok(sh.includes('gh api -X DELETE "repos/$GH_REPO/git/refs/tags/v$VERSION"'));
  assert.ok(!sh.includes('git push origin ":refs/tags/'), 'the build repo tag is not the feed tag');
});

test('a push runs only the Windows suite leg; Mac minutes are spent on purpose', () => {
  const y = read('.github/workflows/suites-matrix.yml');
  assert.ok(y.includes(`os: \${{ github.event_name == 'push' && fromJSON('["windows-latest"]') || fromJSON('["macos-latest", "macos-15-intel", "windows-latest"]') }}`));
});
