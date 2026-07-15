import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { streamStart, streamDelta } from '@/shared/state/streamingSlice';
import { addMessage, type AgentSession } from '@/shared/state/agentsSlice';

// The first thing a new user reads. Written as a normal assistant turn (prose, no headings) so it streams in exactly like a real reply. No em-dashes.
export const WELCOME_GREETING =
  "Hi, I'm OpenSwarm, your personal AI team. I can do just about anything right on your laptop, " +
  "so bring me anything: a tough problem, a half-formed idea, something you need to write. " +
  "We'll figure it out together.\n\nWhere do you want to start?";

const GREETING_MSG_ID = 'welcome-greeting';

// Streams the first-run greeting in as a genuine assistant bubble: it rides the same streaming slice + smooth-reveal every real reply uses, then settles into a real message so the chips can follow. Pure UI, no LLM, no run: launchAndSendFirstMessage POSTs only the prompt, so this seeded message is dropped on the server swap and never reaches the backend.
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
  // Onboarding v3's prep wrote a greeting about THIS machine; when present it replaces the stock opener.
  const personalized = useAppSelector((s) => s.settings.data.personalized_greeting);
  const greetingText = personalized?.trim()
    ? `${personalized.trim()}\n\nWhere do you want to start?`
    : WELCOME_GREETING;

  useEffect(() => {
    if (!eligible || !sessionId || startedRef.current) return;
    startedRef.current = true;

    dispatch(streamStart({ sessionId, messageId: GREETING_MSG_ID, role: 'assistant' }));

    // Snapshot the text at stream start: greetingText stays OUT of the deps because a mid-stream settings refetch changing it would tear down the interval and the one-shot ref blocks a restart (greeting freezes after two words).
    const streamText = greetingText;
    const tokens = streamText.split(/(\s+)/);
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
            content: streamText,
            timestamp: new Date().toISOString(),
            branch_id: branchId,
            parent_id: null,
          },
        }));
        setGreetingDone(true);
      }
    }, 50);

    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible, sessionId, branchId, dispatch]);

  return { greetingDone };
}
