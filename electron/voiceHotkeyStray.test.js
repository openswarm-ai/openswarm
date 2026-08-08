'use strict';
const assert = require('assert');
const { strayFnWatcherPids } = require('./voiceHotkey');

// The fn watcher holds a GLOBAL keyboard tap. Its only reaper is app.on('will-quit'), which never
// runs on a crash or a force-quit, so bad exits strand one forever (found alive after 2h35m on a dev
// box, with a second live one, which means fn fires twice and dictation double-toggles). We sweep at
// spawn, the one moment any other fn-watcher is provably not ours. Every case here is about NOT
// killing something that isn't a stray, because this sends SIGKILL.

const BIN = '/Users/x/Library/Application Support/openswarm/fn-watcher-bin/fn-watcher';

function ps(lines) { return lines.join('\n'); }

{ // the actual field case: one orphan, one of ours
  const out = ps([
    ` 16541 ${BIN}`,
    ` 47069 ${BIN}`,
    '  1234 /usr/bin/some-other-app',
  ]);
  assert.deepEqual(strayFnWatcherPids(out, BIN, 47069), [16541], 'must reap the orphan, keep ours');
}

{ // nothing stray
  assert.deepEqual(strayFnWatcherPids(ps([` 47069 ${BIN}`]), BIN, 47069), []);
}

{ // never match an unrelated binary that merely has a similar name
  const out = ps([' 900 /opt/other/fn-watcher', ' 901 /usr/bin/fn-watcher-clone']);
  assert.deepEqual(strayFnWatcherPids(out, BIN, 1), [], 'path match must be exact, not by basename');
}

{ // pid 1 is never a candidate, whatever ps says
  assert.deepEqual(strayFnWatcherPids(ps([`     1 ${BIN}`]), BIN, 999), []);
}

{ // a missing binary path must never turn into "kill everything"
  assert.deepEqual(strayFnWatcherPids(ps([` 16541 ${BIN}`]), '', 999), []);
  assert.deepEqual(strayFnWatcherPids(ps([` 16541 ${BIN}`]), null, 999), []);
}

{ // restricted/absent ps output degrades to a no-op
  assert.deepEqual(strayFnWatcherPids('', BIN, 999), []);
  assert.deepEqual(strayFnWatcherPids(null, BIN, 999), []);
}

{ // several strays accumulated across several bad exits
  const out = ps([` 100 ${BIN}`, ` 200 ${BIN}`, ` 300 ${BIN}`, ` 400 ${BIN}`]);
  assert.deepEqual(strayFnWatcherPids(out, BIN, 300), [100, 200, 400]);
}

console.log('voiceHotkeyStray: all assertions passed');
