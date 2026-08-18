interface PendingRequest {
  abort: () => void;
}

interface RuntimeRequestPool {
  abortAll: () => void;
  fetch: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
}

export function createRuntimeRequestPool(fetchImpl: typeof fetch = fetch): RuntimeRequestPool {
  const pendingRequests = new Set<PendingRequest>();

  const abortAll = () => {
    pendingRequests.forEach((request) => request.abort());
    pendingRequests.clear();
  };

  const timedFetch = (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rejectRequest: (reason: Error) => void = () => {};
    const timeout = new Promise<Response>((_, reject) => {
      rejectRequest = reject;
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Request timed out'));
      }, timeoutMs);
    });
    const pending: PendingRequest = {
      abort: () => {
        controller.abort();
        if (timer) clearTimeout(timer);
        rejectRequest(new Error('Request cancelled'));
      },
    };
    pendingRequests.add(pending);
    return Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      pendingRequests.delete(pending);
    });
  };

  return { abortAll, fetch: timedFetch };
}
