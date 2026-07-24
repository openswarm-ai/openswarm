import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, FolderCheck, LayoutDashboard, Search, CalendarClock, Check, X } from 'lucide-react';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { useAppSelector } from '@/shared/hooks';
import type { PreppedJob } from '@/shared/state/onboardingV3Slice';

// The unmissable anchor of the reveal: a top-center panel that says, in plain language, exactly what
// OpenSwarm did while the user set up, with LIVE status (working -> done) on each item. The scattered
// cards are the real clickable work; this is the legend that makes the whole thing instantly readable.

type JobStatus = 'working' | 'done' | 'snag';

function iconFor(kind: PreppedJob['kind']): React.ReactNode {
  const size = 17;
  if (kind === 'app') return <LayoutDashboard size={size} />;
  if (kind === 'research') return <Search size={size} />;
  if (kind === 'schedule') return <CalendarClock size={size} />;
  return <FolderCheck size={size} />;
}

// Plain-language line, present-continuous while working, past once done. Super easy to grok at a glance.
function lineFor(job: PreppedJob, status: JobStatus): string {
  const t = job.title;
  if (job.kind === 'app') return status === 'done' ? `Built you a dashboard of your world` : `Building you a dashboard of your world`;
  if (job.kind === 'research') return status === 'done' ? `Looked into ${t} for you` : `Looking into ${t} for you`;
  if (job.kind === 'schedule') return `Set up ${t} to run on its own`;
  return status === 'done' ? `Tidied up your files (nothing moved or deleted)` : `Tidying up your files (nothing moved or deleted)`;
}

const RevealHero: React.FC = () => {
  const c = useClaudeTokens();
  const [dismissed, setDismissed] = useState(false);
  const prepped = useAppSelector((s) => s.onboardingV3.prepped);
  const flowActive = useAppSelector((s) => s.onboardingV3.flowActive);
  const revealPending = useAppSelector((s) => s.onboardingV3.revealPending);
  const sessions = useAppSelector((s) => s.agents.sessions);
  const userName = useAppSelector((s) => s.settings.data.user_name);

  // Dashboard-first order (the star), then research, cleanup, and the recurring task.
  const order: PreppedJob['kind'][] = ['app', 'research', 'audit', 'schedule'];
  const jobs = useMemo(
    () => [...prepped].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
    [prepped],
  );

  const statusOf = (job: PreppedJob): JobStatus => {
    if (job.kind === 'schedule') return 'done';  // a workflow: created instantly
    const s = job.sessionId ? sessions[job.sessionId] : undefined;
    if (!s) return 'working';
    if (s.status === 'completed' || s.status === 'stopped') return 'done';
    if (s.status === 'error') return 'snag';
    return 'working';
  };

  const open = !dismissed && !flowActive && !revealPending && jobs.length > 0;
  const doneCount = jobs.filter((j) => statusOf(j) === 'done').length;

  // Portal to body: the dashboard canvas is a transformed ancestor, so a position:fixed child would
  // anchor to IT (drifting off-center), not the window. The OUTER div owns the fixed top-center
  // placement (translateX(-50%)); the inner motion.div owns the entrance (framer drives its transform,
  // which would clobber the centering translate if they shared one element).
  return createPortal(
    <div style={{ position: 'fixed', top: 58, left: '50%', transform: 'translateX(-50%)', zIndex: 1300, width: 'min(460px, calc(100vw - 48px))', pointerEvents: 'none' }}>
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: -16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, transition: { duration: 0.25 } }}
          transition={{ type: 'spring', stiffness: 260, damping: 26 }}
          style={{
            width: '100%', pointerEvents: 'auto',
            borderRadius: 18, overflow: 'hidden',
            background: c.bg.surface, border: `1px solid ${c.border.medium}`,
            boxShadow: '0 20px 60px rgba(20,16,60,0.20)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 18px 12px' }}>
            <div style={{
              width: 34, height: 34, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: `linear-gradient(135deg, ${c.accent.primary}, ${c.accent.pressed})`, color: '#fff',
            }}>
              <Sparkles size={18} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '1rem', fontWeight: 700, color: c.text.primary, letterSpacing: '-0.01em' }}>
                {userName ? `${userName}, while you set up I got to work` : `While you set up, I got to work`}
              </div>
              <div style={{ fontSize: '0.8125rem', color: c.text.tertiary, marginTop: 2 }}>
                {doneCount === jobs.length ? `All done, here on your canvas` : `${doneCount} of ${jobs.length} done, the rest are running`}
              </div>
            </div>
            <button
              onClick={() => setDismissed(true)}
              aria-label="Dismiss"
              style={{ border: 'none', background: 'transparent', color: c.text.ghost, cursor: 'pointer', padding: 4, borderRadius: 6, flexShrink: 0 }}
            >
              <X size={16} />
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', padding: '0 10px 12px' }}>
            {jobs.map((job) => {
              const st = statusOf(job);
              return (
                <div key={job.workflowId || job.sessionId || job.kind}
                  style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', borderRadius: 11 }}>
                  <div style={{
                    width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: st === 'done' ? `${c.status.success}18` : `${c.accent.primary}14`,
                    color: st === 'done' ? c.status.success : c.accent.primary,
                  }}>
                    {iconFor(job.kind)}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, fontSize: '0.875rem', fontWeight: 500, color: c.text.secondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {lineFor(job, st)}
                  </div>
                  {st === 'done' ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', fontWeight: 600, color: c.status.success, flexShrink: 0 }}>
                      <Check size={13} /> done
                    </span>
                  ) : st === 'snag' ? (
                    <span style={{ fontSize: '0.75rem', fontWeight: 600, color: c.status.warning, flexShrink: 0 }}>needs a look</span>
                  ) : (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.75rem', fontWeight: 600, color: c.text.tertiary, flexShrink: 0 }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: 999, background: c.accent.primary,
                        animation: 'revealHeroPulse 1.3s ease-in-out infinite',
                      }} />
                      working
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ padding: '9px 18px 13px', borderTop: `1px solid ${c.border.subtle}`, fontSize: '0.75rem', color: c.text.ghost }}>
            It's all on your canvas below. Nothing's saved or deleted without you, keep it or clear it anytime.
          </div>
          <style>{`@keyframes revealHeroPulse { 0%,100% { opacity: 0.35; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1); } }`}</style>
        </motion.div>
      )}
    </AnimatePresence>
    </div>,
    document.body,
  );
};

export default RevealHero;
