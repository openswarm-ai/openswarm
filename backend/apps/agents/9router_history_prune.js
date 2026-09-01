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
// Small results are sacred while they are RECENT ("nothing to commit" IS the answer), but a
// 735-tool chat carries hundreds of them and they became the floor: measured on the real thrashing
// chat, small results were 32.0% (91,407 tokens) of everything the pruner left, more than any other
// bucket. A status line from four hundred turns ago is stale state, not an answer. Newest
// SMALL_KEEP_RECENT stay untouched; older ones collapse to a one-line stub that keeps nothing to
// re-run because the tool_use above them already carries the command.
const SMALL_KEEP_RECENT = 30;
const ENGAGE_BYTES = 300000;
// The CEILING, which is the property hermes has and an age-based cut does not. Clearing only OLD
// results is a discount: measured on five real sessions it took 1.6M tokens to 422K, but the
// deepest still landed at ~126K, close enough to the 180K compaction trigger that one more burst
// of tool work refills it and autocompact thrashes. A user on a build that ALREADY caps every
// single result still hit that (2026-09-01), because hundreds of capped results still add up.
// So keep going past the age rule until the body is under a target, oldest first.
const TARGET_BYTES = 120000;
// Argument fields that carry a whole file rather than a command. `file_path`, `command` and the rest
// are identity and always survive: dropping those would leave the model unable to say what it did.
const BULKY_INPUT_FIELDS = ['content', 'new_string', 'old_string', 'new_str', 'old_str'];
// ...but never below this many verbatim, whatever the pressure. The newest results are what the
// model is actually working from; a ceiling that eats those buys context by deleting the answer,
// which is the one trade this file exists to refuse.
const KEEP_FLOOR = 2;

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

  // Collect every prunable tool_result in transcript order; small ones age on their own track.
  const candidates = [];
  const smalls = [];
  for (const msg of data.messages) {
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || block.type !== 'tool_result') continue;
      const size = blockText(block).length;
      if (size >= MIN_STUB_BYTES || blockHasImage(block)) candidates.push(block);
      else if (size > 80) smalls.push(block);
    }
  }
  const smallKeepFrom = Math.max(0, smalls.length - SMALL_KEEP_RECENT);
  for (let i = 0; i < smallKeepFrom; i++) {
    smalls[i].content = [{ type: 'text', text: '[Old result cleared by OpenSwarm: '
      + blockText(smalls[i]).length + ' characters from an earlier step.]' }];
  }
  if (candidates.length <= KEEP_RECENT && smallKeepFrom === 0) return none;
  if (candidates.length <= KEEP_RECENT) {
    let outSmall;
    try { outSmall = JSON.stringify(data); } catch (_) { return none; }
    return { body: outSmall, stats: { stubbed: smallKeepFrom, kept: KEEP_RECENT, savedBytes: bodyStr.length - outSmall.length } };
  }

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

  // The other half of the weight, and the bigger one: a Write or Edit call carries the WHOLE file
  // in its arguments, and those were being kept verbatim forever. Measured on a real 211-tool
  // session, tool_use inputs were 35.9% of everything left after the result pass, more than the
  // results themselves. Old ones lose their bulk and keep their identity, so the model still knows
  // which file it wrote and can re-read it; the newest are untouched like the results are.
  const uses = [];
  for (const msg of data.messages) {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && block.type === 'tool_use') uses.push(block);
    }
  }
  const useKeepFrom = Math.max(0, uses.length - KEEP_RECENT);
  for (let i = 0; i < useKeepFrom; i++) {
    const b = uses[i];
    const input = b.input;
    if (!input || typeof input !== 'object') continue;
    for (const field of BULKY_INPUT_FIELDS) {
      const v = input[field];
      if (typeof v === 'string' && v.length >= MIN_STUB_BYTES) {
        input[field] = `[${v.length} characters, cleared by OpenSwarm; re-read the file if you need them]`;
      }
    }
  }

  let out;
  try { out = JSON.stringify(data); } catch (_) { return none; }


  const stats = {
    stubbed: keepFrom,
    kept: KEEP_RECENT,
    inputsCleared: useKeepFrom,
    underTarget: out.length <= TARGET_BYTES,
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

module.exports = { pruneBody, maybePrune, KEEP_RECENT, MIN_STUB_BYTES, ENGAGE_BYTES, TARGET_BYTES, KEEP_FLOOR };
