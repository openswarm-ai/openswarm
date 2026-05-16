import { ContainerError, ContainerTimeout } from "./errors.js";
import type { GraphClient } from "./graph-client.js";
import { log } from "./logger.js";

export type ContainerStatus =
  | "IN_PROGRESS"
  | "FINISHED"
  | "ERROR"
  | "EXPIRED"
  | "PUBLISHED";

export interface ContainerStatusResponse {
  status: ContainerStatus;
  status_code?: string;
  id?: string;
}

/**
 * Fetch container status once. Used by the get_container_status tool.
 */
export async function fetchContainerStatus(
  client: GraphClient,
  containerId: string,
): Promise<ContainerStatusResponse> {
  return client.request<ContainerStatusResponse>(`/${containerId}`, {
    query: { fields: "status,status_code,id" },
  });
}

/**
 * Poll a container with exponential backoff until it reaches FINISHED.
 * Throws ContainerError on ERROR/EXPIRED status, or ContainerTimeout if the budget expires.
 */
export async function pollUntilFinished(
  client: GraphClient,
  containerId: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  let delay = 2000;
  const maxDelay = 10_000;

  while (true) {
    const elapsed = Date.now() - started;
    if (elapsed > timeoutMs) {
      throw new ContainerTimeout(containerId, elapsed);
    }
    const res = await fetchContainerStatus(client, containerId);
    log.debug("container_poll", { containerId, status: res.status, elapsedMs: elapsed });
    switch (res.status) {
      case "FINISHED":
      case "PUBLISHED":
        return;
      case "ERROR":
      case "EXPIRED":
        throw new ContainerError(containerId, res.status, res.status_code);
      case "IN_PROGRESS":
        break;
      default:
        throw new ContainerError(containerId, String(res.status));
    }
    await sleep(Math.min(delay, timeoutMs - elapsed));
    delay = Math.min(delay * 1.5, maxDelay);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
