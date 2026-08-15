// A refused takedown is not a takedown (ENG-283).
//
// /outputs/unpublish answers HTTP 200 with {ok:false,error} whenever the app could not actually be
// pulled off the internet: signed out, offline, or the hosting service refused. This helper used to
// read only res.ok, so every one of those cases toasted "App unpublished", cleared the card's
// publish state, and left the app serving to anyone with the link, with no way to retry. Same class
// as ENG-309 one surface over: never let "the request completed" stand in for "the thing happened".
import test from 'node:test';
import assert from 'node:assert/strict';

import { unpublishApp } from './publishApi';

function stubFetch(res: { ok?: boolean; status?: number; body?: unknown; nonJson?: boolean }): () => void {
  const real = (globalThis as any).fetch;
  (globalThis as any).fetch = async () => ({
    ok: res.ok ?? true,
    status: res.status ?? 200,
    json: async () => {
      if (res.nonJson) throw new SyntaxError('Unexpected token');
      return res.body;
    },
  });
  return () => { (globalThis as any).fetch = real; };
}

async function rejection(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

test('an explicit ok:true resolves', async () => {
  const restore = stubFetch({ body: { ok: true } });
  try {
    await unpublishApp('out-1');
  } finally {
    restore();
  }
});

test('a 200 that says ok:false throws with the server reason', async () => {
  const restore = stubFetch({ body: { ok: false, error: 'Sign in to your OpenSwarm account to manage published apps.' } });
  try {
    const err = await rejection(() => unpublishApp('out-1'));
    assert.ok(err, 'a refused takedown must not resolve; the app is still on the internet');
    assert.match(err!.message, /Sign in/, 'the user needs the actual reason, not a generic failure');
  } finally {
    restore();
  }
});

test('a body with no ok field is treated as a failure, not a success', async () => {
  // Only an explicit success counts. Anything else means we do not know that the app came down.
  for (const body of [{}, { ok: 'yes' }, null, { error: 'boom' }]) {
    const restore = stubFetch({ body });
    try {
      assert.ok(await rejection(() => unpublishApp('out-1')), `ambiguous body ${JSON.stringify(body)} must not read as success`);
    } finally {
      restore();
    }
  }
});

test('an unparseable body fails closed', async () => {
  const restore = stubFetch({ nonJson: true });
  try {
    assert.ok(await rejection(() => unpublishApp('out-1')));
  } finally {
    restore();
  }
});

test('an HTTP error still throws, and says the app may still be live', async () => {
  const restore = stubFetch({ ok: false, status: 500, body: {} });
  try {
    const err = await rejection(() => unpublishApp('out-1'));
    assert.match(err!.message, /still be live/i);
  } finally {
    restore();
  }
});
