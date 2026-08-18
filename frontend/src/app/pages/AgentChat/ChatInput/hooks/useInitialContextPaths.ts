import { useEffect, useRef, type RefObject } from 'react';
import type { ContextPath } from '@/app/components/editor/DirectoryBrowser';
import type { ChatInputHandle } from '../types';

// One-shot seed of the caller's initial context paths into the composer (a card opened "with these files"). Applied once per mount, after the editor has had a tick to mount its handle. Lifted verbatim from AgentChat.
export function useInitialContextPaths(chatInputRef: RefObject<ChatInputHandle>, initialContextPaths: ContextPath[] | undefined): void {
  const initialContextApplied = useRef(false);
  useEffect(() => {
    if (initialContextApplied.current || !initialContextPaths?.length) return;
    const timer = setTimeout(() => {
      chatInputRef.current?.setContent('', initialContextPaths);
      initialContextApplied.current = true;
    }, 50);
    return () => clearTimeout(timer);
  }, [chatInputRef, initialContextPaths]);
}
