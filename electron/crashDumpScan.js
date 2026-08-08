'use strict';
// Reads the CAUSE out of Crashpad minidumps so a native crash stops being an invisible file.
//
// Before this, a main-process SIGSEGV ran none of our JS (uncaughtException is JS-only,
// child-process-gone is children-only), so the app vanished and left a .dmp nobody read. The boot
// beacon shipped a lifetime cumulative COUNT, which cannot answer what crashed, when, or during
// what. This parses the minidump header itself, which is a documented binary format, and reports
// one record per NEW dump since the last boot.
//
// Deliberately parses only the header + stream directory + exception/misc streams. That is enough
// for cause and timing, costs a few KB of reads, and cannot be confused by a truncated tail.

const fs = require('fs');
const path = require('path');

const MINIDUMP_MAGIC = 0x504d444d; // 'MDMP'
const STREAM_EXCEPTION = 6;
const STREAM_SYSTEM_INFO = 7;
const STREAM_MISC_INFO = 15;

// Mach exception codes; the signal is what a user-facing report should say.
const MAC_EXC = {
  1: 'EXC_BAD_ACCESS (SIGSEGV/SIGBUS)',
  2: 'EXC_BAD_INSTRUCTION (SIGILL)',
  3: 'EXC_ARITHMETIC',
  5: 'EXC_BREAKPOINT (SIGTRAP)',
  6: 'EXC_SOFTWARE',
  10: 'EXC_CRASH (SIGABRT)',
};

function p_readStreams(fd, size) {
  const head = Buffer.alloc(32);
  fs.readSync(fd, head, 0, 32, 0);
  if (head.readUInt32LE(0) !== MINIDUMP_MAGIC) return null;
  const streamCount = head.readUInt32LE(8);
  const streamRva = head.readUInt32LE(12);
  const timeDateStamp = head.readUInt32LE(20);
  if (streamCount > 4096 || streamRva + streamCount * 12 > size) return null;
  const dir = Buffer.alloc(streamCount * 12);
  fs.readSync(fd, dir, 0, dir.length, streamRva);
  const streams = new Map();
  for (let i = 0; i < streamCount; i++) {
    const off = i * 12;
    streams.set(dir.readUInt32LE(off), {
      size: dir.readUInt32LE(off + 4),
      rva: dir.readUInt32LE(off + 8),
    });
  }
  return { streams, timeDateStamp };
}

function p_readExceptionStream(fd, s, fileSize) {
  if (!s || s.rva + 24 > fileSize) return null;
  const buf = Buffer.alloc(Math.min(s.size, 168));
  fs.readSync(fd, buf, 0, buf.length, s.rva);
  // MINIDUMP_EXCEPTION_STREAM: ThreadId(4) __align(4) then MINIDUMP_EXCEPTION
  const threadId = buf.readUInt32LE(0);
  const code = buf.readUInt32LE(8);
  const flags = buf.readUInt32LE(12);
  // ExceptionAddress is 8 bytes at offset 24 within the exception record
  let address = 0n;
  try { address = buf.readBigUInt64LE(24); } catch (_) { address = 0n; }
  return { threadId, code, flags, address: '0x' + address.toString(16) };
}

/** Parse one minidump for cause + timing. Returns null if the file is not a readable minidump. */
function readDump(file) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    fd = fs.openSync(file, 'r');
    const parsed = p_readStreams(fd, st.size);
    if (!parsed) return null;
    const exc = p_readExceptionStream(fd, parsed.streams.get(STREAM_EXCEPTION), st.size);
    const crashedAt = parsed.timeDateStamp ? new Date(parsed.timeDateStamp * 1000).toISOString() : null;
    return {
      file: path.basename(file),
      bytes: st.size,
      crashed_at: crashedAt || new Date(st.mtimeMs).toISOString(),
      mtime_ms: st.mtimeMs,
      has_exception_stream: !!exc,
      exception_code: exc ? exc.code : null,
      exception_name: exc ? (MAC_EXC[exc.code] || `code ${exc.code}`) : null,
      exception_address: exc ? exc.address : null,
      faulting_thread_id: exc ? exc.threadId : null,
      has_system_info: parsed.streams.has(STREAM_SYSTEM_INFO),
      has_misc_info: parsed.streams.has(STREAM_MISC_INFO),
    };
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/** Every .dmp under a Crashpad dir, newest first. */
function listDumps(crashpadDir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.dmp$/i.test(e.name)) out.push(p);
    }
  };
  walk(crashpadDir);
  return out.sort((a, b) => {
    try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch (_) { return 0; }
  });
}

/**
 * Dumps written since `sinceMs`, parsed. `sinceMs` is the previous boot's watermark, so a relaunch
 * reports only what actually happened while the user was away, not the lifetime pile.
 */
function newDumpsSince(crashpadDir, sinceMs, limit = 10) {
  const rows = [];
  for (const f of listDumps(crashpadDir)) {
    let mt = 0;
    try { mt = fs.statSync(f).mtimeMs; } catch (_) { continue; }
    if (mt <= sinceMs) break;
    const parsed = readDump(f);
    if (parsed) rows.push(parsed);
    if (rows.length >= limit) break;
  }
  return rows;
}

module.exports = { readDump, listDumps, newDumpsSince, MINIDUMP_MAGIC };
