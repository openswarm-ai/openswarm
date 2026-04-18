import React, { useCallback, useEffect, useRef, useState, type FC, type MutableRefObject } from 'react';
import { ComposerPrimitive, useAui } from '@assistant-ui/react';
import { LexicalComposerInput } from '@assistant-ui/react-lexical';
import type { Unstable_MentionItem } from '@assistant-ui/core';
import { useAppSelector } from '@/shared/hooks';
import type { ComposerExtras } from '../runtime/useOpenSwarmRuntime';
import type { ContextPath } from '@/shared/state/agentsTypes';
import { useOpenSwarmMentionAdapter, type MentionItemMetadata } from './components/OpenSwarmMentionAdapter';
import { useComposerAttachments } from './components/useComposerAttachments';
import { MentionSelectOverride, MentionPopover, ComposerAttachmentChips } from './components/ComposerParts';
import ModelModeSelector from './components/ModelModeSelector/ModelModeSelector';

interface OpenSwarmComposerProps {
  composerExtrasRef: MutableRefObject<ComposerExtras>;
  mode: string;
  onModeChange: (mode: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  isRunning?: boolean;
  onStop?: () => void;
  sessionId?: string;
  queueLength?: number;
  contextEstimate?: { used: number; limit: number };
  autoFocus?: boolean;
  initialContextPaths?: ContextPath[];
  embedded?: boolean;
}

const OpenSwarmComposer: FC<OpenSwarmComposerProps> = ({
  composerExtrasRef, mode, onModeChange, model, onModelChange,
  isRunning, onStop, sessionId, queueLength, contextEstimate, autoFocus,
  initialContextPaths, embedded,
}) => {
  const aui = useAui();
  const mentionAdapter = useOpenSwarmMentionAdapter();
  const att = useComposerAttachments();
  const formRef = useRef<HTMLFormElement>(null);
  const [hasContent, setHasContent] = useState(false);

  const initialContextApplied = useRef(false);
  const skills = useAppSelector((s) => s.skills.items);

  useEffect(() => {
    if (initialContextApplied.current || !initialContextPaths?.length) return;
    att.setContextPaths(initialContextPaths);
    initialContextApplied.current = true;
  }, [initialContextPaths, att]);

  const syncExtras = useCallback(() => {
    const allForcedTools = att.forcedTools.flatMap((ft) => ft.tools);
    const skillList = Object.values(att.attachedSkills);
    composerExtrasRef.current = {
      images: att.images.length > 0 ? att.images.map(({ data, media_type }) => ({ data, media_type })) : undefined,
      contextPaths: att.contextPaths.length > 0 ? att.contextPaths : undefined,
      forcedTools: allForcedTools.length > 0 ? allForcedTools : undefined,
      attachedSkills: skillList.length > 0 ? skillList : undefined,
    };
  }, [composerExtrasRef, att.images, att.contextPaths, att.forcedTools, att.attachedSkills]);

  const handleFormSubmit = useCallback(() => {
    syncExtras();
    setTimeout(() => att.clearAll(), 0);
  }, [syncExtras, att]);

  const handleSendClick = useCallback(() => {
    syncExtras();
    aui.composer().send();
    att.clearAll();
  }, [syncExtras, aui, att]);

  useEffect(() => {
    return aui.subscribe(() => {
      const text = aui.composer().getState().text;
      setHasContent(text.trim().length > 0 || att.images.length > 0 || att.contextPaths.length > 0);
    });
  }, [aui, att.images.length, att.contextPaths.length]);

  const handleMentionSelect = useCallback(
    (item: Unstable_MentionItem): boolean => {
      const meta = item.metadata as unknown as MentionItemMetadata | undefined;
      if (!meta) return false;
      switch (meta.itemType) {
        case 'skill': {
          const skill = skills[item.id];
          if (!skill) return true;
          att.setAttachedSkills((prev) => ({
            ...prev,
            [skill.id]: { id: skill.id, name: skill.name, content: skill.content },
          }));
          return true;
        }
        case 'mode':
          onModeChange(item.id);
          return true;
        case 'file':
          att.browseAndAttachFiles();
          return true;
        case 'tool-group':
        case 'output':
          if (meta.toolNames && meta.toolNames.length > 0) {
            att.setForcedTools((prev) => [
              ...prev,
              { label: item.label, tools: meta.toolNames!, iconKey: meta.iconKey },
            ]);
          }
          return true;
        default:
          return false;
      }
    },
    [skills, onModeChange, aui, att],
  );

  const hasAttachments =
    att.images.length > 0 || att.contextPaths.length > 0 ||
    att.forcedTools.length > 0 || Object.keys(att.attachedSkills).length > 0;

  return (
    <div className={embedded ? 'flex w-full flex-col' : 'mx-auto flex w-full max-w-(--thread-max-width) flex-col'}>
      <ComposerPrimitive.Unstable_MentionRoot trigger="@" adapter={mentionAdapter}>
        <ComposerPrimitive.Root ref={formRef} onSubmit={handleFormSubmit} className="aui-composer-root relative flex w-full flex-col">
          <MentionSelectOverride onSelect={handleMentionSelect} />
          <div
            className={embedded
              ? 'flex w-full flex-col gap-1 bg-transparent p-1'
              : 'flex w-full flex-col gap-1 rounded-2xl border bg-background p-2 transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20'
            }
            onDragOver={att.handleDragOver} onDragLeave={att.handleDragLeave} onDrop={att.handleDrop}
            data-dragging={att.isDragOver || undefined}
          >
            {hasAttachments && (
              <ComposerAttachmentChips
                images={att.images} contextPaths={att.contextPaths}
                forcedTools={att.forcedTools} attachedSkills={att.attachedSkills}
                onRemoveImage={att.removeImage} onRemoveContextPath={att.removeContextPath}
                onRemoveForcedTool={att.removeForcedTool} onRemoveSkill={att.removeSkill}
              />
            )}
            <LexicalComposerInput
              placeholder="Message — @ for context and commands"
              className="aui-composer-input max-h-40 min-h-10 w-full resize-none bg-transparent px-2 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground/80"
              autoFocus={autoFocus}
            />
            <MentionPopover />
            <div className="flex items-center justify-between px-1">
              <ModelModeSelector
                mode={mode} onModeChange={onModeChange} model={model} onModelChange={onModelChange}
                contextEstimate={contextEstimate} ownerId={sessionId || 'composer'} sessionId={sessionId}
                hasContent={hasContent} isRunning={isRunning} onSend={handleSendClick} onStop={onStop}
                browseAndAttachFiles={att.browseAndAttachFiles}
                queueLength={queueLength}
              />
            </div>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_MentionRoot>
    </div>
  );
};

export default OpenSwarmComposer;
