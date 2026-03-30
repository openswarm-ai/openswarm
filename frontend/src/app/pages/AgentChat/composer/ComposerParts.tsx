import { useEffect, type FC } from 'react';
import {
  ComposerPrimitive,
  unstable_useMentionContextOptional,
} from '@assistant-ui/react';
import type { Unstable_MentionItem } from '@assistant-ui/core';
import { XIcon } from 'lucide-react';

/**
 * Registers a selectItemOverride callback on the nearest MentionRoot context.
 * Must be rendered inside a ComposerPrimitive.Unstable_MentionRoot.
 * Returns true from the callback to prevent the default mention directive insertion.
 */
export const MentionSelectOverride: FC<{
  onSelect: (item: Unstable_MentionItem) => boolean;
}> = ({ onSelect }) => {
  const ctx = unstable_useMentionContextOptional();

  useEffect(() => {
    if (!ctx) return;
    return ctx.registerSelectItemOverride(onSelect);
  }, [ctx, onSelect]);

  return null;
};

export const MentionPopover: FC = () => (
  <ComposerPrimitive.Unstable_MentionPopover className="z-50 max-h-64 min-w-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg">
    <ComposerPrimitive.Unstable_MentionBack className="mb-1 flex w-full items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent">
      ← Back
    </ComposerPrimitive.Unstable_MentionBack>
    <ComposerPrimitive.Unstable_MentionCategories>
      {(categories) =>
        categories.map((cat) => (
          <ComposerPrimitive.Unstable_MentionCategoryItem
            key={cat.id}
            categoryId={cat.id}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent data-[highlighted]:bg-accent"
          >
            {cat.label}
          </ComposerPrimitive.Unstable_MentionCategoryItem>
        ))
      }
    </ComposerPrimitive.Unstable_MentionCategories>
    <ComposerPrimitive.Unstable_MentionItems>
      {(items) =>
        items.map((item) => (
          <ComposerPrimitive.Unstable_MentionItem
            key={item.id}
            item={item}
            className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 hover:bg-accent data-[highlighted]:bg-accent"
          >
            <span className="text-sm font-medium">{item.label}</span>
            {item.description && (
              <span className="text-xs text-muted-foreground">{item.description}</span>
            )}
          </ComposerPrimitive.Unstable_MentionItem>
        ))
      }
    </ComposerPrimitive.Unstable_MentionItems>
  </ComposerPrimitive.Unstable_MentionPopover>
);

const Chip: FC<{ label: string; onRemove: () => void }> = ({ label, onRemove }) => (
  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
    {label}
    <button onClick={onRemove} className="ml-0.5 text-muted-foreground hover:text-foreground">
      <XIcon className="h-3 w-3" />
    </button>
  </span>
);

export const ComposerAttachmentChips: FC<{
  images: { preview: string }[];
  contextPaths: { path: string; type: string }[];
  forcedTools: { label: string }[];
  attachedSkills: Record<string, { name: string }>;
  onRemoveImage: (idx: number) => void;
  onRemoveContextPath: (idx: number) => void;
  onRemoveForcedTool: (idx: number) => void;
  onRemoveSkill: (id: string) => void;
}> = ({
  images, contextPaths, forcedTools, attachedSkills,
  onRemoveImage, onRemoveContextPath, onRemoveForcedTool, onRemoveSkill,
}) => (
  <div className="flex flex-wrap gap-1 px-1">
    {images.map((img, i) => (
      <div key={`img-${i}`} className="group relative h-10 w-10 overflow-hidden rounded border">
        <img src={img.preview} alt="" className="h-full w-full object-cover" />
        <button
          onClick={() => onRemoveImage(i)}
          className="absolute -top-1 -right-1 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground group-hover:block"
        >
          <XIcon className="h-2.5 w-2.5" />
        </button>
      </div>
    ))}
    {contextPaths.map((cp, i) => (
      <Chip key={`cp-${i}`} label={cp.path.split('/').pop() || cp.path} onRemove={() => onRemoveContextPath(i)} />
    ))}
    {forcedTools.map((ft, i) => (
      <Chip key={`ft-${i}`} label={`@${ft.label}`} onRemove={() => onRemoveForcedTool(i)} />
    ))}
    {Object.entries(attachedSkills).map(([id, s]) => (
      <Chip key={`sk-${id}`} label={s.name} onRemove={() => onRemoveSkill(id)} />
    ))}
  </div>
);
