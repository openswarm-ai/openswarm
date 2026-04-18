import { useCallback } from 'react';
import {
  useExternalStoreRuntime,
  type ThreadMessageLike,
  type AppendMessage,
} from '@assistant-ui/react';
import type { MutableRefObject } from 'react';
import type { ComposerExtras, DispatchableMessage } from './useOpenSwarmRuntime';

const EMPTY_MESSAGES: ThreadMessageLike[] = [];

function extractText(message: AppendMessage): string {
  for (const part of message.content) {
    if (part.type === 'text') return part.text;
  }
  return '';
}

export function useStandaloneComposerRuntime(
  composerExtrasRef: MutableRefObject<ComposerExtras>,
  dispatchMessage: (msg: DispatchableMessage) => void,
) {
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = extractText(message);
      if (!text) return;
      const extras = composerExtrasRef.current;
      composerExtrasRef.current = {};
      dispatchMessage({ prompt: text, ...extras });
    },
    [composerExtrasRef, dispatchMessage],
  );

  return useExternalStoreRuntime({
    messages: EMPTY_MESSAGES,
    isRunning: false,
    onNew,
  });
}
