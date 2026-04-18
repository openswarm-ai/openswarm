import { type FC, type ReactNode } from 'react';
import {
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  AuiIf,
} from '@assistant-ui/react';
import { ArrowDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TooltipIconButton } from './components/TooltipIconButton';
import { UserMessage } from './components/UserMessage/UserMessage';
import { AssistantMessage } from './components/AssistantMessage/AssistantMessage';
import { SessionIdContext, BranchChatContext } from './utils';

interface OpenSwarmThreadProps {
  sessionId?: string;
  onBranchChat?: (newSessionId: string) => void;
  children?: ReactNode;
}

const OpenSwarmThread: FC<OpenSwarmThreadProps> = ({
  sessionId,
  onBranchChat,
  children,
}) => {
  return (
    <TooltipProvider>
    <SessionIdContext.Provider value={sessionId}>
      <BranchChatContext.Provider value={onBranchChat}>
        <ThreadPrimitive.Root
          className="aui-root aui-thread-root flex h-full flex-col bg-background"
          style={{
            ['--thread-max-width' as string]: '44rem',
          }}
        >
          <ThreadPrimitive.Viewport className="aui-thread-viewport relative flex flex-1 flex-col overflow-y-auto scroll-smooth px-4 pt-4">
            <AuiIf condition={(s) => s.thread.isEmpty}>
              <ThreadWelcome />
            </AuiIf>

            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
                EditComposer,
              }}
            />

            <ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer sticky bottom-0 mx-auto mt-auto flex w-full max-w-(--thread-max-width) flex-col items-center overflow-visible pb-4">
              <ThreadScrollToBottom />
              {children}
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </BranchChatContext.Provider>
    </SessionIdContext.Provider>
    </TooltipProvider>
  );
};

const ThreadWelcome: FC = () => (
  <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center">
    <p className="text-muted-foreground text-lg">How can I help you today?</p>
  </div>
);

const ThreadScrollToBottom: FC = () => (
  <ThreadPrimitive.ScrollToBottom asChild>
    <TooltipIconButton
      tooltip="Scroll to bottom"
      variant="outline"
      className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
    >
      <ArrowDownIcon />
    </TooltipIconButton>
  </ThreadPrimitive.ScrollToBottom>
);

const EditComposer: FC = () => (
  <MessagePrimitive.Root className="aui-edit-composer-wrapper mx-auto flex w-full max-w-(--thread-max-width) flex-col px-2 py-3">
    <ComposerPrimitive.Root className="aui-edit-composer-root ml-auto flex w-full max-w-[85%] flex-col rounded-2xl bg-muted">
      <ComposerPrimitive.Input
        className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent p-4 text-foreground text-sm outline-none"
        autoFocus
      />
      <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <Button variant="ghost" size="sm">
            Cancel
          </Button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <Button size="sm">Update</Button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </MessagePrimitive.Root>
);

export default OpenSwarmThread;
