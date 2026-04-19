import React, { useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { SPRING_LAYOUT, SPRING_BOUNCE } from './islandTypes';
import { IdlePill } from './components/IdlePill';
import { CompactPill } from './components/CompactPill/CompactPill';
import { CompactActionablePill } from './components/CompactActionablePill';
import { ExpandedCard } from './components/ExpandedCard/ExpandedCard';
import { useDynamicIslandData } from './hooks/useDynamicIslandData';
import { useDynamicIslandActions } from './hooks/useDynamicIslandActions';

const DynamicIsland: React.FC = () => {
  const c = useClaudeTokens();
  const islandRef = useRef<HTMLDivElement>(null);

  const {
    groups,
    totalApprovals,
    activeAgents,
    finishedAgents,
    hasApprovals,
    hasAgents,
    nonQuestionApprovalCount,
    oldestNonQuestionApproval,
    islandState,
    userExpanded,
    setUserExpanded,
  } = useDynamicIslandData();

  const {
    onApprove,
    onDeny,
    onStopAgent,
    onDismissAgent,
    onNavigateToDashboard,
    onClearAllFinished,
    handleIslandClick,
  } = useDynamicIslandActions(groups, islandState, hasAgents, hasApprovals, setUserExpanded, islandRef);

  const islandWidth = islandState === 'idle'
    ? 200
    : islandState === 'compact'
      ? 210
      : islandState === 'compact-actionable'
        ? 310
        : 400;

  const islandBorderRadius = islandState === 'expanded' ? 14 : 50;

  const shadow = islandState === 'idle'
    ? 'none'
    : islandState === 'compact'
      ? c.shadow.sm
      : c.shadow.md;

  const compactText = useMemo(() => {
    const parts: string[] = [];
    if (activeAgents.length > 0) parts.push(`${activeAgents.length} running`);
    if (finishedAgents.length > 0) parts.push(`${finishedAgents.length} done`);
    return parts.join(' · ') || 'Agents';
  }, [activeAgents.length, finishedAgents.length]);

  const glowKeyframes = useMemo(() => `
    @keyframes approvalGlow {
      0%, 100% { box-shadow: 0 0 6px 1px ${c.status.warning}30; }
      50% { box-shadow: 0 0 12px 3px ${c.status.warning}60; }
    }
  `, [c.status.warning]);

  return (
    <>
    {islandState === 'compact-actionable' && <style>{glowKeyframes}</style>}
    <motion.div
      ref={islandRef}
      layout
      transition={islandState === 'expanded' ? SPRING_LAYOUT : SPRING_BOUNCE}
      style={{
        position: 'absolute',
        left: '50%',
        top: 6,
        x: '-50%',
        zIndex: 9999,
        width: islandWidth,
        borderRadius: islandBorderRadius,
        cursor: islandState === 'expanded' ? 'default' : 'pointer',
        // @ts-expect-error -- vendor prefix
        WebkitAppRegion: 'no-drag',
      }}
      onClick={islandState !== 'expanded' && islandState !== 'compact-actionable' ? handleIslandClick : undefined}
    >
      <motion.div
        layout
        transition={SPRING_LAYOUT}
        style={{
          background: c.bg.secondary,
          border: islandState === 'compact-actionable'
            ? `1px solid ${c.status.warning}`
            : `0.5px solid ${c.border.medium}`,
          borderRadius: islandBorderRadius,
          boxShadow: islandState === 'compact-actionable'
            ? `0 0 8px 1px ${c.status.warning}40`
            : shadow,
          overflow: 'hidden',
          animation: islandState === 'compact-actionable'
            ? 'approvalGlow 2.5s ease-in-out infinite'
            : 'none',
        }}
      >
        <AnimatePresence mode="wait">
          {islandState === 'idle' && (
            <IdlePill key="idle" c={c} />
          )}
          {islandState === 'compact' && (
            <CompactPill
              key="compact"
              c={c}
              text={compactText}
              activeCount={activeAgents.length}
              hasApprovals={hasApprovals}
            />
          )}
          {islandState === 'compact-actionable' && oldestNonQuestionApproval && (
            <CompactActionablePill
              key="compact-actionable"
              c={c}
              request={oldestNonQuestionApproval}
              remainingCount={nonQuestionApprovalCount}
              onApprove={onApprove}
              onDeny={onDeny}
              onExpand={() => setUserExpanded(true)}
            />
          )}
          {islandState === 'expanded' && (
            <ExpandedCard
              key="expanded"
              c={c}
              groups={groups}
              totalApprovals={totalApprovals}
              activeAgents={activeAgents}
              finishedAgents={finishedAgents}
              hasApprovals={hasApprovals}
              hasAgents={hasAgents}
              onApprove={onApprove}
              onDeny={onDeny}
              onStopAgent={onStopAgent}
              onDismissAgent={onDismissAgent}
              onNavigateToDashboard={onNavigateToDashboard}
              onClearAllFinished={onClearAllFinished}
              onCollapse={() => setUserExpanded(false)}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
    </>
  );
};

export default DynamicIsland;
