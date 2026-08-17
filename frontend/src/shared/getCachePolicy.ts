// The renderer dedupes identical GETs to our API through a 1s response cache (config.ts). Two
// things must never be served from it: a request that asked for fresh data, and any GET after a
// mutation that could have changed what it reads. Pure so it can be tested without a window.

/** A caller that says no-store / reload wants the network, not the 1s dedupe cache. */
export function bypassesGetCache(cache: RequestCache | undefined): boolean {
  return cache === 'no-store' || cache === 'reload';
}

/** After a successful mutation the whole GET cache is stale-by-assumption; it is a burst dedupe,
 *  not a store, so dropping it costs at most one extra round trip per URL. */
export function mutationClearsGetCache(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS';
}
