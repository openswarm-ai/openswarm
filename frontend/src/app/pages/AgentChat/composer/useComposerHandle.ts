import { useMemo, type MutableRefObject } from 'react';
import { useAui } from '@assistant-ui/react';
import type { ContextPath } from '@/app/components/DirectoryBrowser';
import type { ComposerExtras } from '../runtime/useOpenSwarmRuntime';

export interface ForcedToolGroup {
  label: string;
  tools: string[];
  iconKey?: string;
}

export interface ComposerHandle {
  getConfig: () => {
    prompt: string;
    contextPaths: ContextPath[];
    forcedTools: ForcedToolGroup[];
  };
  setContent: (
    prompt: string,
    contextPaths?: ContextPath[],
    forcedTools?: ForcedToolGroup[],
  ) => void;
}

/**
 * Provides a ChatInputHandle-compatible interface backed by the assistant-ui
 * ComposerRuntime and a shared ComposerExtras ref.
 *
 * Agent 7 can wire this into useAgentChat to replace the old chatInputRef.
 */
export function useComposerHandle(
  composerExtrasRef: MutableRefObject<ComposerExtras>,
): ComposerHandle {
  const aui = useAui();

  return useMemo<ComposerHandle>(
    () => ({
      getConfig: () => {
        const text = aui.composer().getState().text;
        const extras = composerExtrasRef.current;
        const contextPaths: ContextPath[] = (extras.contextPaths ?? []) as ContextPath[];
        const forcedTools: ForcedToolGroup[] = extras.forcedTools
          ? extras.forcedTools.map((t) => ({ label: t, tools: [t] }))
          : [];
        return { prompt: text, contextPaths, forcedTools };
      },
      setContent: (prompt, contextPaths, forcedTools) => {
        aui.composer().setText(prompt);
        composerExtrasRef.current = {
          ...composerExtrasRef.current,
          contextPaths: contextPaths as ComposerExtras['contextPaths'],
          forcedTools: forcedTools?.flatMap((g) => g.tools),
        };
      },
    }),
    [aui, composerExtrasRef],
  );
}
