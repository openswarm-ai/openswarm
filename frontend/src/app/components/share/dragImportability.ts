// What counts as droppable into OpenSwarm, decided from what the browser lets us see at each stage: only MIME types while a file is still being dragged (Chromium keeps names private until the drop), the real name once it lands.
export const IMPORTABLE_EXTENSIONS = ['.swarm', '.md', '.zip'] as const;
export const UNSUPPORTED_DROP_MESSAGE = 'Only .swarm, .md and .zip files can be added to OpenSwarm.';

// A .swarm has no registered MIME type, so an empty type is the one every importable drag carries; the rest are what macOS and Windows stamp on .md and .zip files.
const IMPORTABLE_MIME_TYPES = new Set([
  '',
  'text/markdown',
  'text/x-markdown',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
]);

export type DragVerdict = 'importable' | 'unsupported' | 'no-files';

export function looksImportable(name: string): boolean {
  const n = name.toLowerCase();
  return IMPORTABLE_EXTENSIONS.some((ext) => n.endsWith(ext));
}

export function judgeDrag(types: readonly string[], fileItemTypes: readonly string[]): DragVerdict {
  if (!types.includes('Files')) return 'no-files';
  if (fileItemTypes.length === 0) return 'importable';
  return fileItemTypes.some((t) => IMPORTABLE_MIME_TYPES.has(t.toLowerCase())) ? 'importable' : 'unsupported';
}

export function firstImportable(files: readonly File[]): File | null {
  return files.find((f) => looksImportable(f.name)) ?? null;
}
