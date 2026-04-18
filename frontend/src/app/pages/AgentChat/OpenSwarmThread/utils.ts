import { createContext, useContext } from 'react';

export const SessionIdContext = createContext<string | undefined>(undefined);
export const useSessionId = () => useContext(SessionIdContext);

export const BranchChatContext = createContext<
  ((newSessionId: string) => void) | undefined
>(undefined);
export const useBranchChatCallback = () => useContext(BranchChatContext);