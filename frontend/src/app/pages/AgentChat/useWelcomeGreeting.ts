import { useEffect, useRef, useState } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { streamStart, streamDelta } from '@/shared/state/streamingSlice';
import { addMessage, type AgentSession } from '@/shared/state/agentsSlice';

// The first thing a new user reads. Written as a normal assistant turn (prose, no headings) so it
// streams in exactly like a real reply. No em-dashes.
export const WELCOME_GREETING =
  "Hi, I'm OpenSwarm, your personal AI team. I can do just about anything right on your laptop, " +
  "so bring me anything: a tough problem, a half-formed idea, something you need to write. " +
  "We'll figure it out together.\n\nWhere do you want to start?";

const GREETING_MSG_ID = 'welcome-greeting';

// Streams the first-run greeting in as a genuine assistant bubble: it rides the same streaming
// slice + smooth-reveal every real reply uses, then settles into a real message so the chips can
// follow. Pure UI, no LLM, no run: launchAndSendFirstMessage POSTs only the prompt, so this
// seeded message is dropped on the server swap and never reaches the backend.
export function useWelcomeGreeting(
  session: AgentSession | undefined,
  isDraft: boolean,
): { greetingDone: boolean } {
  const dispatch = useAppDispatch();
  const [greetingDone, setGreetingDone] = useState(false);
  const startedRef = useRef(false);

  const eligible = isDraft && !!session?.is_welcome_draft && (session?.messages?.length ?? 0) === 0;
  const sessionId = session?.id;
  const branchId = session?.active_branch_id || 'main';

  useEffect(() => {
    if (!eligible || !sessionId || startedRef.current) return;
    startedRef.current = true;

    dispatch(streamStart({ sessionId, messageId: GREETING_MSG_ID, role: 'assistant' }));

    // Feed word-by-word at a real-reply cadence; useSmoothText trails it for the typed look.
    const tokens = WELCOME_GREETING.split(/(\s+)/);
    let i = 0;
    const timer = window.setInterval(() => {
      const chunk = (tokens[i] ?? '') + (tokens[i + 1] ?? '');
      i += 2;
      if (chunk) dispatch(streamDelta({ sessionId, messageId: GREETING_MSG_ID, delta: chunk }));
      if (i >= tokens.length) {
        window.clearInterval(timer);
        // Settle into a real message; addMessage's listener clears the matching stream entry.
        dispatch(addMessage({
          sessionId,
          message: {
            id: GREETING_MSG_ID,
            role: 'assistant',
            content: WELCOME_GREETING,
            timestamp: new Date().toISOString(),
            branch_id: branchId,
            parent_id: null,
          },
        }));
        setGreetingDone(true);
      }
    }, 50);

    return () => window.clearInterval(timer);
  }, [eligible, sessionId, branchId, dispatch]);

  return { greetingDone };
}
