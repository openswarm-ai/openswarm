import React, { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { createWorkflow, updateWorkflow } from '@/shared/state/workflowsSlice';
import { sendMessage } from '@/shared/state/agentsSlice';
import { defaultSchedule, stepsSignature, needsScheduleTestWarning } from '@/app/pages/Workflows/scheduleUtils';
import { runWorkflowTest } from '@/app/pages/Workflows/runWorkflowTest';
import AgentChat from '@/app/pages/AgentChat/AgentChat';
import InlineEditableTitle from '@/app/components/InlineEditableTitle';
import { Typewriter } from '@/app/components/feedback/Animated';
import { useWC, FONT_SERIF, colorForWorkflow } from './uiKit';
import ColorSwatch from './ColorSwatch';
import { useEditAgentSession } from './useEditAgentSession';
import { useWorkflowPatch } from './useWorkflowPatch';
import ScheduleCard from './ScheduleCard';
import StepsCard from './StepsCard';
import SaveGuard from './SaveGuard';
import type { AppNav } from './types';

// Short pill label for the clean cluster, plus the richer prompt actually sent
// so the agent gets real detail. Spread across personas (work, money, research,
// lifestyle, monitoring) so most people see one that fits. Keep labels similar
// length so they cluster two-per-row.
const NEW_CHIPS: Array<{ label: string; prompt: string }> = [
  { label: 'Summarize my inbox daily', prompt: 'Each morning, summarize my inbox and draft replies to the important emails.' },
  { label: 'Recap my weekly spending', prompt: 'Every Sunday, recap my spending, subscriptions, upcoming bills, and any weird charges.' },
  { label: 'Digest of news in my field', prompt: 'Each week, give me a digest of the latest news and research in my field.' },
  { label: 'Plan my weekend for me', prompt: 'Friday afternoon, plan my weekend from the weather and what\'s nearby.' },
  { label: 'Watch a webpage for changes', prompt: 'Watch a webpage and alert me when it changes.' },
];

const ComposeView: React.FC<{ nav: AppNav }> = ({ nav }) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const patch = useWorkflowPatch();
  const [draftId, setDraftId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [guardOpen, setGuardOpen] = useState(false);
  // null = follow the auto open-on-first-message behavior; true/false = user override.
  const [paneManual, setPaneManual] = useState<boolean | null>(null);
  const created = useRef(false);
  const handedOff = useRef(false);

  const workflow = useAppSelector((s) => (draftId ? s.workflows.items[draftId] : undefined));

  // One unsaved draft per visit to "New". The backend hides unsaved drafts from
  // lists, so an abandoned one stays out of the way until GC.
  useEffect(() => {
    if (created.current) return;
    created.current = true;
    (async () => {
      try {
        const wf = await dispatch(createWorkflow({ unsaved: true, title: 'Untitled workflow', steps: [], schedule: defaultSchedule() })).unwrap();
        setDraftId(wf.id);
      } catch { /* surfaced by the empty state */ }
    })();
  }, [dispatch]);

  const sessionId = useEditAgentSession(draftId ?? '');
  const session = useAppSelector((s) => (sessionId ? s.agents.sessions[sessionId] : undefined));
  const agentBusy = session?.status === 'running' || session?.status === 'waiting_approval';
  const visibleMsgs = (session?.messages || []).filter((m) => !m.hidden).length;
  // The agent has actually said something back, not just the user's own message
  // sitting alone in the gap before the turn even starts. Gate the pane + handoff
  // on THIS: "any message exists" is true the instant you send, so it used to
  // fling you to the detail page before the agent ever replied.
  const agentReplied = (session?.messages || []).some((m) => m.role === 'assistant' && !m.hidden);
  // Landing state: the blank page (incl. before the session has loaded, so the
  // right pane starts closed rather than open-then-snap-shut). Gone the moment a
  // message lands or the agent starts working, so its "thinking" never shows here.
  const composeEmpty = !agentBusy && visibleMsgs === 0;
  // Open the pane only once the agent has fully answered (not mid-response, where
  // the chat is reflowing and the slide looks janky). Header toggle overrides it.
  const autoOpen = !agentBusy && agentReplied;
  const paneOpen = paneManual ?? autoOpen;

  // Once it's revealed (in the sidebar) AND the agent has finished its first
  // answer, hand off to the detail page, after a beat so the right-pane open
  // animation plays here first. Same sticky edit session, so the chat carries over.
  useEffect(() => {
    if (handedOff.current || !draftId || !workflow) return;
    if (workflow.unsaved === false && autoOpen) {
      handedOff.current = true;
      setTimeout(() => nav.selectWorkflow(draftId), 480);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, workflow?.unsaved, autoOpen]);

  const sendChip = (text: string) => {
    if (!sessionId || !session) return;
    dispatch(sendMessage({ sessionId, prompt: text, mode: session.mode, model: session.model }));
  };

  // The conversation started, so the workflow is real: reveal it under Workflows
  // (and hand off to its detail) right away. The title stays "Untitled workflow"
  // until the first step lands and the backend auto-names it (auto_named stays
  // true), so the name types in from the steps, not the raw prompt.
  const revealed = useRef(false);
  const firstUserMsg = (session?.messages || []).find((m) => m.role === 'user' && !m.hidden);
  useEffect(() => {
    if (revealed.current || !workflow || !firstUserMsg || workflow.unsaved === false) return;
    revealed.current = true;
    // Reveal immediately so it lands in the sidebar the moment you send; the
    // handoff to detail waits for the agent to finish (see effect above).
    dispatch(updateWorkflow({ id: workflow.id, patch: { unsaved: false } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstUserMsg, workflow?.unsaved, dispatch]);

  if (!workflow) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: WC.page }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid rgba(${WC.inkRGB},0.15)`, borderTopColor: WC.accent, animation: 'os-spin 0.7s linear infinite' }} />
          <span style={{ fontFamily: "'Newsreader',serif", fontStyle: 'italic', fontSize: 14, color: WC.ink4 }}>Setting up your workflow…</span>
        </div>
      </div>
    );
  }

  const tested = workflow.steps.length > 0 && stepsSignature(workflow.steps) === (workflow.tested_signature ?? '');

  const doTest = async () => {
    if (testing || workflow.steps.length === 0) return;
    setTesting(true);
    try { await runWorkflowTest(workflow.id, workflow.steps, async () => {}); }
    finally { setTesting(false); }
  };

  // No steps / no title is fine, you can save a bare workflow and fill it in
  // later. No If-Match: this is the user's own brand-new draft, so there's no
  // concurrent edit to guard against and a stale stamp shouldn't block the save.
  const finalizeSave = () => {
    dispatch(updateWorkflow({ id: workflow.id, patch: { unsaved: false } }));
    nav.selectWorkflow(workflow.id);
  };
  const onSave = () => {
    if (needsScheduleTestWarning(workflow)) { setGuardOpen(true); return; }
    finalizeSave();
  };

  return (
    <>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: WC.page, position: 'relative' }}>
        <div style={{ flex: 'none', padding: '15px 28px', borderBottom: `1px solid rgba(${WC.inkRGB},0.06)`, display: 'flex', alignItems: 'center', gap: 12 }}>
          <ColorSwatch value={colorForWorkflow(workflow)} onChange={(hex) => patch(workflow, { color: hex })} size={15} />
          <InlineEditableTitle
            value={workflow.title || ''}
            onCommit={(t) => patch(workflow, { title: t, auto_named: false })}
            placeholder="Untitled workflow"
            sx={{ flex: 1, minWidth: 0, fontFamily: "'Newsreader',serif", fontSize: 21, fontWeight: 500, color: WC.ink, letterSpacing: '-0.01em' }}
          >
            <Typewriter value={workflow.title || 'Untitled workflow'} enabled={workflow.auto_named !== false}>
              {(t) => (
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: "'Newsreader',serif", fontSize: 21, fontWeight: 500, color: WC.ink, letterSpacing: '-0.01em' }}>{t}</span>
              )}
            </Typewriter>
          </InlineEditableTitle>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 500, color: WC.muted, background: `rgba(${WC.inkRGB},0.07)`, padding: '4px 10px', borderRadius: 999, flex: 'none' }}>Draft</span>
          <div
            onClick={() => setPaneManual(!paneOpen)}
            title={paneOpen ? 'Hide schedule & steps' : 'Show schedule & steps'}
            style={{ width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: paneOpen ? WC.ink3 : WC.muted, flex: 'none' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /><path d={paneOpen ? 'M19 9l-2 3 2 3' : 'M17 9l2 3-2 3'} /></svg>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {sessionId
            ? <AgentChat sessionId={sessionId} embedded autoFocus workflowEditId={workflow.id} />
            : <div style={{ flex: 1 }} />}
          {composeEmpty && (
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: 16, padding: '0 28px 96px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <div style={{ width: 11, height: 11, borderRadius: 3, background: WC.accent, flex: 'none' }} />
                <h2 style={{ margin: 0, fontFamily: FONT_SERIF, fontSize: 25, fontWeight: 500, fontStyle: 'italic', color: WC.ink }}>Describe the workflow to automate</h2>
              </div>
              <div style={{ fontSize: 13.5, color: WC.muted, maxWidth: 430, lineHeight: 1.55 }}>Tell me what you want this workflow to do. I'll turn it into steps you can run on a schedule, and you can tweak anything as we go.</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 9, justifyContent: 'center', width: '100%', maxWidth: 440, marginTop: 6, pointerEvents: 'auto' }}>
                {NEW_CHIPS.map((c) => (
                  <button
                    key={c.label}
                    onClick={() => sendChip(c.prompt)}
                    onMouseEnter={(e) => { e.currentTarget.style.background = `rgba(${WC.inkRGB},0.1)`; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = `rgba(${WC.inkRGB},0.06)`; }}
                    style={{ background: `rgba(${WC.inkRGB},0.06)`, border: `1px solid rgba(${WC.inkRGB},0.08)`, borderRadius: 999, padding: '8px 16px', fontSize: 12.5, color: WC.ink3, cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background .15s' }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {guardOpen && (
          <SaveGuard
            title={workflow.title || 'this workflow'}
            onClose={() => setGuardOpen(false)}
            onSaveAnyway={() => { setGuardOpen(false); finalizeSave(); }}
            onRunTest={() => { setGuardOpen(false); doTest(); }}
          />
        )}
      </div>

      {/* Hidden on the blank landing page; opens with a smooth width/fade once
          the conversation starts. */}
      <div style={{ width: paneOpen ? 344 : 0, flex: 'none', overflow: 'hidden', background: WC.rail, transition: 'width .4s cubic-bezier(.4,0,.2,1)' }}>
       <div style={{ width: 344, height: '100%', borderLeft: `1px solid ${WC.line}`, display: 'flex', flexDirection: 'column', minHeight: 0, opacity: paneOpen ? 1 : 0, transition: 'opacity .4s ease' }}>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '18px 18px 22px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ScheduleCard workflow={workflow} />
          <StepsCard workflow={workflow} />
        </div>
        <div style={{ flex: 'none', borderTop: `1px solid rgba(${WC.inkRGB},0.08)`, background: WC.rail, padding: '13px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!tested && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 11.5, lineHeight: 1.4, color: WC.muted }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={WC.warn} strokeWidth="2" style={{ flex: 'none', marginTop: 1 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16h.01" /></svg>
              <span>Not tested yet — a test run grants the tool access this workflow needs.</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 9 }}>
            <button onClick={doTest} disabled={testing || workflow.steps.length === 0} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, flex: 'none', padding: '10px 15px', borderRadius: 9, border: `1px solid rgba(${WC.inkRGB},0.14)`, background: WC.paper, color: testing || workflow.steps.length === 0 ? WC.muted2 : WC.ink, fontSize: 13, fontWeight: 600, cursor: testing || workflow.steps.length === 0 ? 'default' : 'pointer' }}>
              {testing
                ? <div style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgba(140,133,122,0.3)', borderTopColor: WC.muted, animation: 'os-spin 0.7s linear infinite', flex: 'none' }} />
                : <div style={{ width: 0, height: 0, borderTop: '5px solid transparent', borderBottom: '5px solid transparent', borderLeft: `8px solid ${WC.accent}`, flex: 'none' }} />}
              <span>{testing ? 'Testing…' : tested ? 'Run again' : 'Test run'}</span>
            </button>
            <button onClick={onSave} style={{ flex: 1, background: WC.accent, color: '#fff', border: 'none', borderRadius: 9, padding: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save workflow</button>
          </div>
        </div>
       </div>
      </div>
    </>
  );
};

export default ComposeView;
