import { type FC } from 'react';
import { MessagePrimitive, ErrorPrimitive } from '@assistant-ui/react';
import { MarkdownText } from './MarkdownText/MarkdownText';
import { ToolFallback } from './ToolFallback/ToolFallback';
import { AssistantActionBar } from '../MessageActions';
import { BranchPicker } from '../BranchPicker';

export const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root relative mx-auto w-full max-w-(--thread-max-width) py-3"
      data-role="assistant"
    >
      <div className="aui-assistant-message-content wrap-break-word px-2 text-foreground leading-relaxed">
        <MessagePrimitive.Parts>
          {({ part }) => {
            if (part.type === 'text') return <MarkdownText />;
            if (part.type === 'tool-call')
              return part.toolUI ?? <ToolFallback {...part} />;
            return null;
          }}
        </MessagePrimitive.Parts>
        <MessageError />
      </div>

      <div className="aui-assistant-message-footer mt-1 ml-2 flex min-h-6 items-center">
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const MessageError: FC = () => (
  <MessagePrimitive.Error>
    <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5 dark:text-red-200">
      <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
    </ErrorPrimitive.Root>
  </MessagePrimitive.Error>
);
