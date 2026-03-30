import React, { useCallback, useEffect, useRef, useState, type FC, type MutableRefObject } from 'react';
import { ComposerPrimitive, useAui } from '@assistant-ui/react';
import { LexicalComposerInput } from '@assistant-ui/react-lexical';
import type { Unstable_MentionItem } from '@assistant-ui/core';
import { useAppSelector } from '@/shared/hooks';
import type { PromptTemplate } from '@/shared/state/templatesSlice';
import type { ComposerExtras } from '../runtime/useOpenSwarmRuntime';
import { useOpenSwarmMentionAdapter, type MentionItemMetadata } from './OpenSwarmMentionAdapter';
import { useComposerAttachments } from './useComposerAttachments';
import { MentionSelectOverride, MentionPopover, ComposerAttachmentChips } from './ComposerParts';
import TemplateInvokeModal from '../TemplateInvokeModal';
import ModelModeSelector from '../ModelModeSelector';

export interface OpenSwarmComposerProps {
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
}

const OpenSwarmComposer: FC<OpenSwarmComposerProps> = ({
  composerExtrasRef, mode, onModeChange, model, onModelChange,
  isRunning, onStop, sessionId, queueLength, contextEstimate, autoFocus,
}) => {
  const aui = useAui();
  const mentionAdapter = useOpenSwarmMentionAdapter();
  const att = useComposerAttachments();
  const formRef = useRef<HTMLFormElement>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplate | null>(null);
  const [hasContent, setHasContent] = useState(false);

  const templates = useAppSelector((s) => s.templates.items);
  const skills = useAppSelector((s) => s.skills.items);

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
        case 'template': {
          const tmpl = templates[item.id];
          if (!tmpl) return true;
          if (tmpl.fields.length === 0) {
            aui.composer().setText(aui.composer().getState().text + tmpl.template);
          } else {
            setSelectedTemplate(tmpl);
          }
          return true;
        }
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
          att.generalFileInputRef.current?.click();
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
    [templates, skills, onModeChange, aui, att],
  );

  const handleTemplateApply = useCallback(
    (rendered: string) => {
      aui.composer().setText(aui.composer().getState().text + rendered);
      setSelectedTemplate(null);
    },
    [aui],
  );

  const hasAttachments =
    att.images.length > 0 || att.contextPaths.length > 0 ||
    att.forcedTools.length > 0 || Object.keys(att.attachedSkills).length > 0;

  return (
    <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col">
      <ComposerPrimitive.Unstable_MentionRoot trigger="@" adapter={mentionAdapter}>
        <ComposerPrimitive.Root ref={formRef} onSubmit={handleFormSubmit} className="aui-composer-root relative flex w-full flex-col">
          <MentionSelectOverride onSelect={handleMentionSelect} />
          <div
            className="flex w-full flex-col gap-1 rounded-2xl border bg-background p-2 transition-shadow focus-within:border-ring/75 focus-within:ring-2 focus-within:ring-ring/20"
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
                addImageFiles={att.addImageFiles} uploadAndAttachFiles={att.uploadAndAttachFiles}
                generalFileInputRef={att.generalFileInputRef} queueLength={queueLength}
              />
            </div>
          </div>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.Unstable_MentionRoot>

      <input ref={att.generalFileInputRef} type="file" multiple className="hidden" onChange={att.handleFileInputChange} />

      {selectedTemplate && (
        <TemplateInvokeModal
          template={selectedTemplate} open={!!selectedTemplate}
          onClose={() => setSelectedTemplate(null)} onApply={handleTemplateApply}
        />
      )}
    </div>
  );
};

export default OpenSwarmComposer;
