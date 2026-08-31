// Always-on history pruning at the one wire we own (ENG-418 item 2, the hermes lift).
//
// The CLI resends the whole transcript every request and its own KEEP-RECENT microcompact is
// feature-gated off with no override, so old tool results pile up until the autocompact cliff
// (ENG-385: 100-292 tool-call chats dying at 80-160K). This module runs inside 9router via the
// same `node --require` patch that fixes GPT-5 max_tokens, and clears the BODIES of old
// tool_result blocks on the wire only: the CLI's transcript on disk stays complete, so nothing
// is destroyed, and a fresh session or a resume still has every byte.
//
// Rules, each one earned:
// - Newest KEEP_RECENT big results stay verbatim (the CLI's own microcompact keeps 5).
// - Small results are never touched: `git status` says "nothing to commit" in 200 bytes and that
//   whole content IS the answer (the OmniRoute lesson: ratio bought by deleting answers is a sin).
// - Below ENGAGE_BYTES the body passes through BYTE-IDENTICAL, so short sessions keep their
//   prompt-cache prefix and this module is provably a no-op where context is not scarce.
// - The stub is PASSIVE and carries no path and no instruction: an imperative inside tool output
//   reads as an injection attempt and manufactures a security warning (drilled 2026-08-27).
// - Exact duplicates of a newer big result collapse even inside the keep window (hermes's rule).
// - Only tool_result CONTENT is replaced; ids, roles, ordering, assistant blocks and thinking
//   signatures are untouched, so the API contract (every tool_use answered) cannot break.
// - Any parse trouble returns the body unchanged: fail-open, availability first.

'use strict';

const KEEP_RECENT = 5;
const MIN_STUB_BYTES = 2000;
const ENGAGE_BYTES = 300000;

const OFF = String(process.env.OSW_HISTORY_PRUNE || '').toLowerCase() === 'off';
const DEBUG = process.env.OSW_HISTORY_PRUNE_DEBUG === '1';

function log(msg) {
  try { process.stderr.write('[history-prune] ' + msg + '\n'); } catch (_) {}
}

function blockText(block) {
  // tool_result content is a string or a list of blocks; concatenate the text parts.
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let out = '';
    for (const p of c) {
      if (p && p.type === 'text' && typeof p.text === 'string') out += p.text;
    }
    return out;
  }
  return '';
}

function blockHasImage(block) {
  const c = block.content;
  if (!Array.isArray(c)) return false;
  for (const p of c) if (p && p.type === 'image') return true;
  return false;
}

function stubFor(block, reason) {
  const n = blockText(block).length;
  const img = blockHasImage(block);
  let text;
  if (reason === 'duplicate') {
    text = '[Duplicate tool output: same content as a more recent result.]';
  } else if (img && n < MIN_STUB_BYTES) {
    text = '[Old screenshot cleared by OpenSwarm to keep this long chat inside the model\'s context window.]';
  } else {
    text = '[Old tool output cleared by OpenSwarm to keep this long chat inside the model\'s context window: '
      + n + ' characters from an earlier step' + (img ? ', plus a screenshot' : '') + '.]';
  }
  return [{ type: 'text', text }];
}

// bodyStr -> { body: string, stats } ; body === input means untouched.
function pruneBody(bodyStr) {
  const none = { body: bodyStr, stats: null };
  if (OFF) return none;
  if (typeof bodyStr !== 'string' || bodyStr.length < ENGAGE_BYTES) return none;
  let data;
  try { data = JSON.parse(bodyStr); } catch (_) { return none; }
  if (!data || !Array.isArray(data.messages)) return none;

  // Collect every prunable tool_result in transcript order.
  const candidates = [];
  for (const msg of data.messages) {
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || block.type !== 'tool_result') continue;
      const size = blockText(block).length;
      if (size >= MIN_STUB_BYTES || blockHasImage(block)) candidates.push(block);
    }
  }
  if (candidates.length <= KEEP_RECENT) return none;

  const keepFrom = candidates.length - KEEP_RECENT;
  const seenNewestFirst = new Set();
  // Walk newest-first so a duplicate always collapses toward its most recent copy.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const b = candidates[i];
    const text = blockText(b);
    if (i >= keepFrom) {
      if (text) seenNewestFirst.add(text);
      continue;
    }
    b.content = stubFor(b, seenNewestFirst.has(text) ? 'duplicate' : 'old');
  }

  let out;
  try { out = JSON.stringify(data); } catch (_) { return none; }
  const stats = {
    stubbed: keepFrom,
    kept: KEEP_RECENT,
    savedBytes: bodyStr.length - out.length,
  };
  return { body: out, stats };
}

function maybePrune(bodyStr) {
  try {
    const { body, stats } = pruneBody(bodyStr);
    if (stats && DEBUG) {
      log('engaged: stubbed=' + stats.stubbed + ' kept=' + stats.kept + ' saved=' + stats.savedBytes + 'B');
    }
    return body;
  } catch (_) {
    return bodyStr;
  }
}

module.exports = { pruneBody, maybePrune, KEEP_RECENT, MIN_STUB_BYTES, ENGAGE_BYTES };
