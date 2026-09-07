import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ENG-487 / ENG-467: on a send the selection object is rebuilt and the welcome flag flips, and four callbacks handed to every
// memoized AgentCard changed identity with them, so the whole board re-rendered (4,800 fibers, 380 ms at 4x). Each of the four
// is wrapped in useStableCallback now; the profiler (commit_profile.mjs) is the liveness proof, this pins the wiring.
const here = fileURLToPath(new URL('.', import.meta.url));
const src = here.replace(/([\\/])\.test-build([\\/])/, '$1src$2');
const files = {
  'hooks/interaction/useDashboardInteractions.ts': ['handleCardSelect'],
  'hooks/interaction/useCardDrag.ts': ['handleCardDragStart', 'handleCardDragEnd'],
  'hooks/lifecycle/useAgentSpawn.ts': ['handleBranchFromCard'],
};
for (const [rel, names] of Object.entries(files)) {
  test(`${rel}: ${names.join(', ')} keep one identity across renders`, () => {
    const path = src + rel;
    assert.ok(existsSync(path), `could not locate ${rel} from ${here}`);
    const text = readFileSync(path, 'utf8');
    for (const n of names) assert.match(text, new RegExp(`const ${n} = useStableCallback\\(${n}Impl\\);`), n);
  });
}
