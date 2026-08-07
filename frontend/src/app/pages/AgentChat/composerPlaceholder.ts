const FRESH = ['What should we do?', 'Give me a task...', "What's on your mind?", 'Ask me anything...'];
const FOLLOWUP = ['Reply or take it further...', 'What next?', 'Ask a follow-up...', 'Keep going or change course...'];

/** A composer that always says "Send a message..." reads canned; pick a stable per-chat line, follow-up flavored once the agent has spoken. */
export function composerPlaceholder(sessionId: string, hasReply: boolean): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  const pool = hasReply ? FOLLOWUP : FRESH;
  return pool[h % pool.length];
}
