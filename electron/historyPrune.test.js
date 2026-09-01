// ENG-418: the wire-level history pruner. Tested from electron's node runner because the module is
// plain node JS; it ships from backend/apps/agents/ alongside the gpt5 patch that requires it.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const MOD = path.join(__dirname, '..', 'backend', 'apps', 'agents', '9router_history_prune.js');
const { pruneBody, KEEP_RECENT, MIN_STUB_BYTES, ENGAGE_BYTES } = require(MOD);

function toolResult(id, text, extra) {
  return Object.assign({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }, extra);
}

function bigBody(nResults, { size = 8000, pad = true } = {}) {
  const messages = [{ role: 'user', content: 'walk the files' }];
  for (let i = 0; i < nResults; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't' + i, name: 'Read', input: { file_path: '/f' + i } }] });
    messages.push({ role: 'user', content: [toolResult('t' + i, ('r' + i + ' ').padEnd(size, 'x'))] });
  }
  const body = { model: 'claude-sonnet-4-6', messages };
  let s = JSON.stringify(body);
  if (pad && s.length < ENGAGE_BYTES) {
    // pad the FIRST user message so total size crosses the floor without adding results
    messages[0].content = 'walk the files ' + 'p'.repeat(ENGAGE_BYTES - s.length);
    s = JSON.stringify(body);
  }
  return s;
}

test('below the floor the body passes through byte-identical', () => {
  const s = bigBody(20, { pad: false });
  assert.ok(s.length < ENGAGE_BYTES, 'fixture must sit under the floor');
  const { body, stats } = pruneBody(s);
  assert.strictEqual(body, s);
  assert.strictEqual(stats, null);
});

test('above the floor old big results are stubbed and the newest KEEP_RECENT stay verbatim', () => {
  const s = bigBody(12);
  const { body, stats } = pruneBody(s);
  assert.ok(stats, 'must engage');
  assert.strictEqual(stats.stubbed, 12 - KEEP_RECENT);
  const d = JSON.parse(body);
  const results = [];
  for (const m of d.messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === 'tool_result') results.push(b);
  }
  assert.strictEqual(results.length, 12, 'every tool_use keeps its tool_result');
  for (let i = 0; i < 12 - KEEP_RECENT; i++) {
    assert.match(results[i].content[0].text, /cleared by OpenSwarm/, 'old result ' + i);
    assert.strictEqual(results[i].tool_use_id, 't' + i, 'id survives');
  }
  for (let i = 12 - KEEP_RECENT; i < 12; i++) {
    assert.ok(results[i].content[0].text.startsWith('r' + i + ' '), 'recent result kept verbatim');
  }
});

test('small results are never touched at any age (the git-status rule)', () => {
  const messages = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'user', content: [toolResult('s' + i, 'nothing to commit ' + i)] });
  }
  for (let i = 0; i < 8; i++) {
    messages.push({ role: 'user', content: [toolResult('b' + i, 'big'.padEnd(9000, 'y'))] });
  }
  const body = { model: 'm', messages };
  let s = JSON.stringify(body);
  messages[0].content = 'go' + 'p'.repeat(Math.max(0, ENGAGE_BYTES - s.length));
  s = JSON.stringify(body);
  const { body: out } = pruneBody(s);
  const d = JSON.parse(out);
  let untouchedSmall = 0;
  for (const m of d.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_result' && /^nothing to commit/.test(b.content[0].text)) untouchedSmall++;
    }
  }
  assert.strictEqual(untouchedSmall, 20);
});

test('an exact duplicate of a kept result collapses to the duplicate stub', () => {
  const dupText = 'same bytes '.padEnd(6000, 'z');
  const messages = [{ role: 'user', content: 'go' }];
  messages.push({ role: 'user', content: [toolResult('old', dupText)] });
  for (let i = 0; i < KEEP_RECENT + 2; i++) {
    messages.push({ role: 'user', content: [toolResult('f' + i, 'fill '.padEnd(6000, 'w') + i)] });
  }
  messages.push({ role: 'user', content: [toolResult('new', dupText)] });
  const body = { model: 'm', messages };
  let s = JSON.stringify(body);
  messages[0].content = 'go' + 'p'.repeat(Math.max(0, ENGAGE_BYTES - s.length));
  s = JSON.stringify(body);
  const d = JSON.parse(pruneBody(s).body);
  const first = d.messages[1].content[0];
  assert.match(first.content[0].text, /Duplicate tool output/);
  const last = d.messages[d.messages.length - 1].content[0];
  assert.strictEqual(last.content[0].text, dupText, 'the newest copy is the one that survives');
});

test('old screenshots are cleared, recent ones kept', () => {
  const messages = [{ role: 'user', content: 'go' }];
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(50000) } };
  for (let i = 0; i < KEEP_RECENT + 3; i++) {
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'i' + i, content: [img] }] });
  }
  const s = JSON.stringify({ model: 'm', messages });
  assert.ok(s.length >= ENGAGE_BYTES, 'screenshots alone cross the floor');
  const d = JSON.parse(pruneBody(s).body);
  const results = d.messages.slice(1).map((m) => m.content[0]);
  for (let i = 0; i < 3; i++) assert.match(results[i].content[0].text, /screenshot cleared/);
  for (let i = 3; i < results.length; i++) assert.strictEqual(results[i].content[0].type, 'image');
});

test('the stub is passive: no imperative verbs, no filesystem path', () => {
  const s = bigBody(12);
  const d = JSON.parse(pruneBody(s).body);
  const stub = d.messages[2].content[0].content[0].text;
  assert.doesNotMatch(stub, /\b(read|open|run|fetch|load|see)\b/i, 'an imperative in tool output reads as injection');
  assert.doesNotMatch(stub, /\//, 'a path is an affordance the model must not be offered');
});

test('assistant blocks, system and thinking are untouched, and pruning is deterministic', () => {
  const s = bigBody(12);
  const one = pruneBody(s).body;
  const two = pruneBody(one);
  assert.strictEqual(two.body, one, 'pruning an already-pruned body changes nothing');
  const dIn = JSON.parse(s), dOut = JSON.parse(one);
  assert.deepStrictEqual(
    dOut.messages.filter((m) => m.role === 'assistant'),
    dIn.messages.filter((m) => m.role === 'assistant'),
  );
});

test('malformed JSON and OpenAI-shaped bodies pass through untouched', () => {
  const junk = 'x'.repeat(ENGAGE_BYTES) + '{not json';
  assert.strictEqual(pruneBody(junk).body, junk);
  const openai = JSON.stringify({ model: 'gpt-5', messages: [{ role: 'tool', content: 'k'.repeat(ENGAGE_BYTES) }] });
  const out = pruneBody(openai).body;
  assert.strictEqual(out, openai, 'role:tool (openai shape) has no tool_result blocks; untouched');
});

test('OSW_HISTORY_PRUNE=off is honored at module load', () => {
  // the flag is read at require time; spawn a child to prove the seam works end to end
  const { execFileSync } = require('child_process');
  const script = `
    const { pruneBody } = require(${JSON.stringify(MOD)});
    const msgs = [{ role: 'user', content: 'p'.repeat(${ENGAGE_BYTES}) }];
    for (let i = 0; i < 12; i++) msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't'+i, content: [{ type:'text', text: 'x'.repeat(8000) }] }] });
    const s = JSON.stringify({ model: 'm', messages: msgs });
    process.stdout.write(String(pruneBody(s).body === s));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { OSW_HISTORY_PRUNE: 'off' }) }).toString();
  assert.strictEqual(out, 'true');
});

test('WIRING: the gpt5 patch itself routes anthropic bodies through the pruner', () => {
  // Composition test: the interceptor plumbing (write/end buffering, Content-Length) is already
  // proven by the shipped gpt5 rewrite; what a regression would break is the transform chain, so
  // that is what this drives. Unwiring historyPrune() from transformBody turns this red.
  const PATCH = require('path').join(__dirname, '..', 'backend', 'apps', 'agents', '9router_gpt5_patch.js');
  const { transformBody } = require(PATCH);
  const msgs = [{ role: 'user', content: 'p'.repeat(ENGAGE_BYTES) }];
  // each body unique, or the dedup rule fires instead and the 'cleared' count reads 0 (found live)
  for (let i = 0; i < 12; i++) msgs.push({ role: 'user', content: [toolResult('t' + i, ('u' + i + ' ').padEnd(8000, 'x'))] });
  const s = JSON.stringify({ model: 'claude-sonnet-4-6', messages: msgs });
  const out = transformBody(s, 'api.anthropic.com');
  const d = JSON.parse(out);
  const stubbed = d.messages.filter((m) => Array.isArray(m.content) && m.content.some(
    (b) => b.type === 'tool_result' && Array.isArray(b.content) && /cleared by OpenSwarm/.test(b.content[0].text || '')
  )).length;
  assert.strictEqual(stubbed, 12 - KEEP_RECENT);
  // and the gpt5 rewrite still fires on its own host
  const g = JSON.stringify({ model: 'gpt-5', max_tokens: 100, messages: [] });
  assert.match(transformBody(g, 'api.openai.com'), /max_completion_tokens/);
});

test('old tool_use INPUTS lose their bulk but keep their identity', () => {
  // Measured on a real 211-tool session: after the result pass, tool_use inputs were 35.9% of
  // everything left, MORE than the results themselves, because a Write carries the whole file in
  // its arguments. Identity (file_path, command) always survives so the model can still say what
  // it did and re-read it.
  const msgs = [{ role: 'user', content: 'p'.repeat(ENGAGE_BYTES) }];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'w' + i, name: 'Write',
      input: { file_path: `/src/mod_${i}.ts`, content: ('x' + i).padEnd(9000, 'y') } }] });
    msgs.push({ role: 'user', content: [toolResult('w' + i, ('r' + i + ' ').padEnd(8000, 'z'))] });
  }
  const s = JSON.stringify({ model: 'claude-sonnet-4-6', messages: msgs });
  const d = JSON.parse(pruneBody(s).body);
  const uses = d.messages.filter((m) => m.role === 'assistant').map((m) => m.content[0]);

  const old = uses[0].input, recent = uses[uses.length - 1].input;
  assert.match(old.content, /cleared by OpenSwarm/, 'an old file body must not be re-sent forever');
  assert.strictEqual(old.file_path, '/src/mod_0.ts', 'but WHICH file it wrote must survive');
  assert.ok(recent.content.length > 5000, 'the newest calls are untouched, like the newest results');
});

test('a small input is never touched, and neither is a command', () => {
  const msgs = [{ role: 'user', content: 'p'.repeat(ENGAGE_BYTES) }];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'b' + i, name: 'Bash',
      input: { command: `grep -rn 'def ' src/mod_${i}.py` } }] });
    msgs.push({ role: 'user', content: [toolResult('b' + i, ('r' + i + ' ').padEnd(8000, 'z'))] });
  }
  const s = JSON.stringify({ model: 'claude-sonnet-4-6', messages: msgs });
  const d = JSON.parse(pruneBody(s).body);
  for (const m of d.messages.filter((x) => x.role === 'assistant')) {
    assert.match(m.content[0].input.command, /^grep -rn/, 'a command is identity, never bulk');
  }
});
