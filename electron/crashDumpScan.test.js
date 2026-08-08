'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readDump, listDumps, newDumpsSince, MINIDUMP_MAGIC } = require('./crashDumpScan');

// Builds a minimal but REAL minidump: header + stream directory + exception stream. Synthetic
// fixtures are the only way to assert the unhappy paths (truncated, wrong magic) deterministically.
function makeDump(file, { code = 1, address = 0x10n, threadId = 7, ts = 1754400000 } = {}) {
  const excRva = 32 + 12; // header + one directory entry
  const exc = Buffer.alloc(168);
  exc.writeUInt32LE(threadId, 0);
  exc.writeUInt32LE(code, 8);
  exc.writeUInt32LE(0, 12);
  exc.writeBigUInt64LE(address, 24);

  const header = Buffer.alloc(32);
  header.writeUInt32LE(MINIDUMP_MAGIC, 0);
  header.writeUInt32LE(0xa793, 4);
  header.writeUInt32LE(1, 8);   // stream count
  header.writeUInt32LE(32, 12); // stream directory rva
  header.writeUInt32LE(ts, 20);

  const dir = Buffer.alloc(12);
  dir.writeUInt32LE(6, 0);          // ExceptionStream
  dir.writeUInt32LE(exc.length, 4);
  dir.writeUInt32LE(excRva, 8);

  fs.writeFileSync(file, Buffer.concat([header, dir, exc]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crashscan-'));
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + ': ' + e.message); process.exitCode = 1; }
}

t('reads exception code, address and thread from a real header', () => {
  const f = path.join(tmp, 'a.dmp');
  makeDump(f, { code: 1, address: 0x10n, threadId: 42 });
  const r = readDump(f);
  assert.strictEqual(r.exception_code, 1);
  assert.strictEqual(r.exception_address, '0x10');
  assert.strictEqual(r.faulting_thread_id, 42);
  assert.match(r.exception_name, /EXC_BAD_ACCESS/);
});

t('a null-pointer crash reports address 0x0, not a missing field', () => {
  const f = path.join(tmp, 'null.dmp');
  makeDump(f, { code: 1, address: 0x0n });
  assert.strictEqual(readDump(f).exception_address, '0x0');
});

t('crash time comes from the dump header, not the file mtime', () => {
  const f = path.join(tmp, 'ts.dmp');
  makeDump(f, { ts: 1700000000 });
  assert.strictEqual(readDump(f).crashed_at, new Date(1700000000 * 1000).toISOString());
});

t('a non-minidump file is refused rather than half-parsed', () => {
  const f = path.join(tmp, 'junk.dmp');
  fs.writeFileSync(f, Buffer.from('not a minidump at all, really'));
  assert.strictEqual(readDump(f), null);
});

t('a truncated dump does not throw', () => {
  const f = path.join(tmp, 'trunc.dmp');
  makeDump(f);
  const buf = fs.readFileSync(f).subarray(0, 20);
  fs.writeFileSync(f, buf);
  assert.strictEqual(readDump(f), null);
});

t('a missing file is refused', () => {
  assert.strictEqual(readDump(path.join(tmp, 'nope.dmp')), null);
});

t('newDumpsSince reports only dumps newer than the watermark', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const older = path.join(d, 'old.dmp');
  const newer = path.join(d, 'new.dmp');
  makeDump(older); makeDump(newer);
  const t0 = Date.now() - 60000;
  fs.utimesSync(older, new Date(t0 - 60000), new Date(t0 - 60000));
  fs.utimesSync(newer, new Date(), new Date());
  const rows = newDumpsSince(d, t0);
  assert.strictEqual(rows.length, 1, 'only the dump after the watermark counts');
  assert.strictEqual(rows[0].file, 'new.dmp');
});

t('a watermark in the future reports nothing (no false crash storm)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cp2-'));
  makeDump(path.join(d, 'x.dmp'));
  assert.strictEqual(newDumpsSince(d, Date.now() + 600000).length, 0);
});

t('listDumps walks nested Crashpad layout (completed/, pending/)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cp3-'));
  fs.mkdirSync(path.join(d, 'completed'), { recursive: true });
  makeDump(path.join(d, 'completed', 'deep.dmp'));
  assert.strictEqual(listDumps(d).length, 1);
});

t('a missing Crashpad dir is empty, not a throw', () => {
  assert.deepStrictEqual(listDumps(path.join(tmp, 'does-not-exist')), []);
});

console.log(`\n${passed} passed`);
