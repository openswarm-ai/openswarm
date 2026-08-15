// Run: node --test electron/crashRecoveryFallback.test.js
//
// ENG-265: "the app sometimes dies when submitting the default onboarding input." The issue names
// three ways the app can actually die, and one of them is this: the crash-recovery DIALOG throws, and
// the handler answers by quitting. That throws the user's whole session away for a reason that says
// nothing about whether the app could have recovered, and it leaves no window and no explanation,
// which is exactly what "it just died" looks like from the outside.
//
// main.js is a single 5k-line module with no export surface, so this asserts the shape of the path
// rather than executing it. The properties that matter: the failure is recorded, recovery is
// attempted before quitting, and the attempt is one-shot so a broken recreate cannot loop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const start = src.indexOf('async function showCrashRecoveryOverlay');
const body = src.slice(start, src.indexOf('\n}', src.indexOf('crash-recovery-dialog-failed')) + 2);

test('the dialog failure is written down before anything else happens', () => {
  // A dead stdout eats console lines (ENG-264), so the console.error alone left this unexplainable.
  assert.match(body, /writeCrashReport\('crash-recovery-dialog-failed'/);
});

test('a failed dialog attempts recovery before it quits', () => {
  const failurePath = body.slice(body.indexOf('crash-recovery-dialog-failed'));
  assert.match(failurePath, /recreateMainWindow\(\)/, 'quitting on a dialog failure is a session thrown away for nothing');
  assert.ok(
    failurePath.indexOf('recreateMainWindow()') < failurePath.lastIndexOf('app.quit()'),
    'the recovery attempt must come before the quit, not after it',
  );
});

test('the fallback is one-shot, so a broken recreate cannot become a crash loop', () => {
  assert.match(src, /let p_crashDialogFallbackUsed = false;/);
  const failurePath = body.slice(body.indexOf('crash-recovery-dialog-failed'));
  assert.match(failurePath, /if \(p_crashDialogFallbackUsed\)/, 'second time through must just quit');
  assert.match(failurePath, /p_crashDialogFallbackUsed = true;/);
});

test('a recreate that throws is recorded too, and then quits', () => {
  const failurePath = body.slice(body.indexOf('crash-recovery-dialog-failed'));
  assert.match(failurePath, /writeCrashReport\('crash-recovery-recreate-failed'/);
});

test('the user-chose-quit branch is untouched', () => {
  // Both directions: recovering harder must not take away the user's explicit Quit.
  assert.match(body, /result\.response === 0[\s\S]*?app\.quit\(\)/, 'Quit must still quit when the user picks it');
});
