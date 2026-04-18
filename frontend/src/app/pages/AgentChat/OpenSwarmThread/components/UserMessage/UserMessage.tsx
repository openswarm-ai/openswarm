import { type FC } from 'react';
import {
  MessagePrimitive,
  useAui,
  useMessagePartText,
} from '@assistant-ui/react';
import { UserMessageAttachments } from './UserMessageAttachments';
import { useAppSelector } from '@/shared/hooks';
import type { AgentMessage } from '@/shared/state/agentsSlice';
import { useSessionId } from '../../utils';
import { UserActionBar } from '../MessageActions';
import { BranchPicker } from '../BranchPicker';

const ELEMENT_SEPARATOR = '\n\n---\nSelected UI Elements:\n';
const SKILL_PILL_RE = /\{\{skill:([^}]+)\}\}/g;

interface ParsedElement {
  label: string;
  selector: string;
}

function parseElementContext(text: string): {
  userMessage: string;
  elements: ParsedElement[];
} {
  const sepIdx = text.indexOf(ELEMENT_SEPARATOR);
  if (sepIdx === -1) return { userMessage: text, elements: [] };

  const userMessage = text.slice(0, sepIdx);
  const elementSection = text.slice(sepIdx + ELEMENT_SEPARATOR.length);

  const elements: ParsedElement[] = [];
  const blocks = elementSection.split(/\n(?=\d+\.\s)/).filter(Boolean);
  for (const block of blocks) {
    const semanticMatch = block.match(/\d+\.\s+\[([^\]]+)\]\s*(.*)/);
    if (semanticMatch) {
      elements.push({
        label: `${semanticMatch[1]}: ${semanticMatch[2].trim().split('\n')[0]}`,
        selector: semanticMatch[1],
      });
      continue;
    }
    const labelMatch = block.match(/`([^`]+)`\s+\((\w+)\)/);
    const selectorMatch = block.match(/Selector:\s*(.+)/);
    if (labelMatch) {
      elements.push({
        label: labelMatch[1],
        selector: selectorMatch?.[1]?.trim() ?? labelMatch[1],
      });
    }
  }
  return { userMessage, elements };
}

function renderTextWithSkillPills(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(SKILL_PILL_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    parts.push(
      <span
        key={`skill-${match.index}`}
        className="inline-flex items-center gap-0.5 rounded-full bg-violet-500/10 text-violet-600 text-xs font-mono px-1.5 py-0.5 mx-0.5 align-baseline"
      >
        {match[1]}
      </span>,
    );
    lastIndex = re.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function useOriginalMessage(): AgentMessage | undefined {
  const sessionId = useSessionId();
  const aui = useAui();

  let messageId: string | undefined;
  try {
    messageId = aui.message().getState().id;
  } catch {
    return undefined;
  }

  return useAppSelector((state) => {
    if (!sessionId || !messageId) return undefined;
    return state.agents.sessions[sessionId]?.messages.find(
      (m) => m.id === messageId,
    );
  });
}

const UserTextContent: FC = () => {
  const { text } = useMessagePartText();
  const { userMessage, elements } = parseElementContext(text);

  return (
    <>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
        {renderTextWithSkillPills(userMessage)}
      </p>
      {elements.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {elements.map((el, i) => (
            <span
              key={i}
              className="inline-flex items-center rounded-full bg-blue-500/10 text-blue-600 text-xs px-2 py-0.5"
              title={el.selector}
            >
              {el.label}
            </span>
          ))}
        </div>
      )}
    </>
  );
};

const ContextPills: FC = () => {
  const msg = useOriginalMessage();
  if (!msg) return null;

  const contextPaths = msg.context_paths;
  const attachedSkills = msg.attached_skills;
  const forcedTools = msg.forced_tools;
  const hasContext =
    (contextPaths && contextPaths.length > 0) ||
    (attachedSkills && attachedSkills.length > 0) ||
    (forcedTools && forcedTools.length > 0);

  if (!hasContext) return null;

  return (
    <div className="mt-1.5 pt-1.5 border-t border-border/50 flex flex-wrap gap-1">
      {contextPaths?.map((cp, i) => (
        <span
          key={`path-${i}`}
          className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-600 text-xs font-mono px-2 py-0.5"
          title={cp.path}
        >
          {cp.type === 'directory' ? '📁' : '📄'}
          {cp.path.split('/').filter(Boolean).pop()}
        </span>
      ))}
      {attachedSkills?.map((skill, i) => (
        <span
          key={`skill-${i}`}
          className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 text-violet-600 text-xs font-mono px-2 py-0.5"
        >
          🧠 {skill.name}
        </span>
      ))}
      {forcedTools?.map((tool, i) => (
        <span
          key={`tool-${i}`}
          className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-600 text-xs font-mono px-2 py-0.5"
        >
          🔧 {tool}
        </span>
      ))}
    </div>
  );
};

const ImageThumbnails: FC = () => {
  const msg = useOriginalMessage();
  if (!msg?.images?.length) return null;

  return (
    <div className="flex gap-1.5 mb-1.5 flex-wrap">
      {msg.images.map((img, i) => (
        <img
          key={i}
          src={`data:${img.media_type};base64,${img.data}`}
          alt=""
          className="size-16 rounded-lg object-cover border border-border/50 cursor-pointer hover:opacity-80 transition-opacity"
        />
      ))}
    </div>
  );
};

export const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-user-message-root mx-auto grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 py-3 [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer rounded-2xl bg-muted px-4 py-2.5 text-foreground empty:hidden">
          <ImageThumbnails />
          <MessagePrimitive.Parts components={{ Text: UserTextContent }} />
          <ContextPills />
        </div>
        <div className="aui-user-action-bar-wrapper absolute top-1/2 left-0 -translate-x-full -translate-y-1/2 pr-2 peer-empty:hidden">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker className="aui-user-branch-picker col-span-full col-start-1 row-start-3 -mr-1 justify-end" />
    </MessagePrimitive.Root>
  );
};
