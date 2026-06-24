import React from 'react';
import { Typewriter } from '@/app/components/feedback/Animated';

interface WorkflowTitleProps {
  // Raw title; the 'Untitled workflow' fallback is applied here so every surface
  // agrees on the empty-name text.
  value: string | null | undefined;
  // Animate AI-driven renames only. Pass `workflow.auto_named !== false`: a user
  // rename flips auto_named false and the new title should just snap (they typed
  // it), while the build agent's first-step rename types in like the chat card.
  animate: boolean;
  children: (shown: string) => React.ReactNode;
}

// One home for the workflow-title typewriter so every place a workflow name
// renders animates the same way AgentCard does when its name regenerates.
export const WorkflowTitle: React.FC<WorkflowTitleProps> = ({ value, animate, children }) => (
  <Typewriter value={value || 'Untitled workflow'} enabled={animate}>
    {children}
  </Typewriter>
);

export default WorkflowTitle;
