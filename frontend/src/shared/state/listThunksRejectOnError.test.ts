// Run: node --test (via frontend/scripts/run-tests.mjs)
//
// The chokepoint half of ENG-277. Every list thunk did:
//
//     const res = await fetch(url);
//     const data = await res.json();
//     return data.things;
//
// On a 401 that parses the ERROR body, `data.things` is undefined, the thunk RESOLVES, and the
// reducer's `for (const t of action.payload)` throws inside immer. Guarding the reducer stops the
// crash; guarding the thunk stops the bad value existing at all, which is the higher rung.
//
// These run the real payload creators against a stubbed fetch, so they test behaviour rather than
// the presence of a line of source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTools } from './toolsSlice.ts';
import { fetchSkills } from './skillsSlice.ts';
import { fetchModes } from './modesSlice.ts';
import { fetchOutputs } from './outputsSlice.ts';
import { fetchWorkflows } from './workflowsSlice.ts';
import { searchRegistry } from './mcpRegistrySlice.ts';
import { searchSkillRegistry, fetchAllRegistrySkills } from './skillRegistrySlice.ts';

type Thunk = { (arg?: unknown): (d: unknown, g: unknown, e: unknown) => Promise<{ type: string; payload?: unknown }> };

// Some thunks destructure their argument, so passing undefined throws before the fetch and the
// rejection would be the harness's, not the guard's. Each entry carries the arg its thunk needs.
const LIST_THUNKS: Array<[string, Thunk, unknown]> = [
  ['fetchTools', fetchTools as unknown as Thunk, undefined],
  ['fetchSkills', fetchSkills as unknown as Thunk, undefined],
  ['fetchModes', fetchModes as unknown as Thunk, undefined],
  ['fetchOutputs', fetchOutputs as unknown as Thunk, undefined],
  ['fetchWorkflows', fetchWorkflows as unknown as Thunk, undefined],
  // The last two hard-throw sites: their reducers array-spread payload.servers / payload.skills,
  // so an undefined payload does not degrade, it throws inside immer.
  ['searchRegistry', searchRegistry as unknown as Thunk, { q: 'x' }],
  ['searchSkillRegistry', searchSkillRegistry as unknown as Thunk, { q: 'x' }],
  ['fetchAllRegistrySkills', fetchAllRegistrySkills as unknown as Thunk, undefined],
];

/** Run a thunk's payload creator with fetch stubbed, and report which lifecycle action it ended on. */
async function runWith(thunk: Thunk, response: unknown, arg?: unknown): Promise<string> {
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => response;
  try {
    // createAsyncThunk ignores getState here except for `condition`; loading:false lets it run.
    const getState = () => ({
      tools: { loading: false }, skills: { loading: false }, modes: { loading: false },
      outputs: { loading: false }, workflows: { loading: false, items: {} },
      mcpRegistry: { loading: false, servers: [] }, skillRegistry: { loading: false, skills: [] },
    });
    const action = await thunk(arg)(() => {}, getState, undefined);
    return action?.type ?? 'no-action';
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  }
}

const unauthorized = {
  ok: false,
  status: 401,
  json: async () => ({ detail: 'Unauthorized' }),
};

for (const [name, thunk, arg] of LIST_THUNKS) {
  test(`${name} REJECTS on 401 instead of resolving undefined into the reducer`, async () => {
    const type = await runWith(thunk, unauthorized, arg);
    assert.ok(
      type.endsWith('/rejected'),
      `${name} ended on "${type}"; a fulfilled action here hands the reducer an undefined payload`,
    );
  });
}

// The negative half: a healthy response must still reach the reducer, or "it rejects" would pass
// on a thunk that had been broken into rejecting always.
test('a healthy 200 still fulfils, for every list thunk', async () => {
  const okBody = {
    ok: true,
    status: 200,
    json: async () => ({
      tools: [], skills: [], modes: [], builtin_defaults: {}, outputs: [], workflows: [],
      servers: [], total: 0, offset: 0, limit: 20,
    }),
  };
  for (const [name, thunk, arg] of LIST_THUNKS) {
    const type = await runWith(thunk, okBody, arg);
    assert.ok(type.endsWith('/fulfilled'), `${name} ended on "${type}" for a good response`);
  }
});

test('a 500 rejects too, so this is about status and not about the 401 shape', async () => {
  const type = await runWith(fetchTools as unknown as Thunk, {
    ok: false, status: 500, json: async () => ({ detail: 'boom' }),
  });
  assert.ok(type.endsWith('/rejected'), `ended on "${type}"`);
});
