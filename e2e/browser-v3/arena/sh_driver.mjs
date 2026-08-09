// Stagehand driver for one MiniWoB episode: attach to the already-seeded page over CDP, act, exit.
// Called by sh_real.py per episode; stdout's last line is a JSON result. Scoring stays in Python,
// read from MiniWoB's own globals -- this process never grades itself.
import { Stagehand } from '@browserbasehq/stagehand';

const [goal, cdpUrl, model, endpoint, maxSteps] = process.argv.slice(2);

const sh = new Stagehand({
  env: 'LOCAL',
  modelName: model,
  modelClientOptions: { apiKey: 'arena', baseURL: `${endpoint}/v1` },
  verbose: 0,
  disablePino: true,
  localBrowserLaunchOptions: { cdpUrl },
});

const out = { steps: 0, actions: [], errors: [], claimed: false };
try {
  await sh.init();
  // agent() is Stagehand's autonomous loop; per-act() would be MY orchestration, not theirs.
  const agent = sh.agent({
    provider: 'anthropic',
    model,
    instructions: 'Work only on the current page. Never navigate away.',
    options: { apiKey: 'arena', baseURL: `${endpoint}/v1` },
  });
  const result = await agent.execute({ instruction: goal, maxSteps: Number(maxSteps) || 12 });
  out.claimed = !!result?.success;
  out.steps = result?.actions?.length ?? 0;
  out.actions = (result?.actions ?? []).map((a) => JSON.stringify(a).slice(0, 120));
  out.usage = result?.usage ?? null;
} catch (e) {
  out.errors.push(String(e).slice(0, 200));
} finally {
  try { await sh.close(); } catch {}
}
console.log('RESULT:' + JSON.stringify(out));
