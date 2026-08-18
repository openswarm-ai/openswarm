import { useCallback, useRef, useState } from 'react';

// A message queued while the agent is busy; drained in order once the turn goes terminal.
export interface QueuedMessage {
  prompt: string;
  images?: Array<{ data: string; media_type: string }>;
  contextPaths?: Array<{ path: string; type: 'file' | 'directory' }>;
  forcedTools?: string[];
  attachedSkills?: Array<{ id: string; name: string; content: string }>;
  selectedBrowserIds?: string[];
  selectedAppIds?: string[];
  attachedRunId?: string;
  selectedSettingIds?: string[];
}

// Owns the pending-send queue. The ref is the source of truth (synchronous push/drain from effects and
// callbacks that must not wait for a render); `length` is the render mirror, re-synced after every ref
// mutation. UI state (expanded, editing) lives here too since it only makes sense against the queue.
export interface MessageQueue {
  ref: React.MutableRefObject<QueuedMessage[]>;
  length: number;
  expanded: boolean;
  editingIdx: number | null;
  editingText: string;
  dragIdx: number | null;
  dropTargetIdx: number | null;
  setExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingIdx: (idx: number | null) => void;
  setEditingText: React.Dispatch<React.SetStateAction<string>>;
  setDragIdx: (idx: number | null) => void;
  setDropTargetIdx: (idx: number | null) => void;
  enqueue: (msg: QueuedMessage) => void;
  drainNext: () => QueuedMessage | undefined;
  remove: (idx: number) => void;
  reorder: (from: number, to: number) => void;
  commitEdit: (idx: number, prompt: string) => void;
  clear: () => void;
}

export function useMessageQueue(): MessageQueue {
  const ref = useRef<QueuedMessage[]>([]);
  const [length, setLength] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);

  const enqueue = useCallback((msg: QueuedMessage) => {
    ref.current.push(msg);
    setLength(ref.current.length);
  }, []);

  const drainNext = useCallback(() => {
    const next = ref.current.shift();
    if (next) setLength(ref.current.length);
    return next;
  }, []);

  const remove = useCallback((idx: number) => {
    ref.current.splice(idx, 1);
    setLength(ref.current.length);
    if (ref.current.length === 0) setExpanded(false);
  }, []);

  const reorder = useCallback((from: number, to: number) => {
    const q = ref.current;
    const [item] = q.splice(from, 1);
    q.splice(to, 0, item);
    setLength(q.length);
  }, []);

  const commitEdit = useCallback((idx: number, prompt: string) => {
    ref.current[idx] = { ...ref.current[idx], prompt };
    setLength(ref.current.length);
  }, []);

  const clear = useCallback(() => {
    ref.current = [];
    setLength(0);
    setExpanded(false);
    setEditingIdx(null);
    setEditingText('');
  }, []);

  return {
    ref, length, expanded, editingIdx, editingText, dragIdx, dropTargetIdx,
    setExpanded, setEditingIdx, setEditingText, setDragIdx, setDropTargetIdx,
    enqueue, drainNext, remove, reorder, commitEdit, clear,
  };
}
