export type RuntimeAction = 'restart' | 'start' | 'status' | 'stop';

export function createRuntimeAttachmentId(): string {
  return crypto.randomUUID();
}

export function createRuntimeUrlBuilder(
  apiBase: string,
  workspaceId: string,
  instance: number,
  attachmentId: string,
): (action: RuntimeAction) => string {
  return (action) => {
    const query = new URLSearchParams({ instance: String(instance) });
    if (action === 'start' || action === 'stop') {
      query.set('attachment_id', attachmentId);
    }
    return `${apiBase}/outputs/workspace/${workspaceId}/runtime/${action}?${query}`;
  };
}
