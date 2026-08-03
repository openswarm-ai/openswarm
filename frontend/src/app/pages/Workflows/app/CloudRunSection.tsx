import React from 'react';
import type { CSSProperties } from 'react';
import { useAppDispatch } from '@/shared/hooks';
import { openSettingsCard } from '@/shared/state/dashboardLayoutSlice';
import type { Workflow } from '@/shared/state/workflowsSlice';
import { useWC } from './uiKit';
import type { WCPalette } from './uiKit';
import { clockOf, relativeDayLabel } from './model';
import { cloudAvailability, usageText } from './cloudAvailability';
import type { CloudProbe } from './cloudAvailability';
import type { HostedState } from './cloudApi';
import type { CloudStatusHandle } from './useCloudStatus';

const CLOUD_PATH = 'M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 10.5 4 4 0 0 0 6.5 19z';

function hostedOf(probe: CloudProbe) {
  if (probe.phase !== 'answered' || probe.status.state !== 'ready') return null;
  return probe.status.hosted;
}

// The cloud's own clock, printed from the answer we just fetched; our mirrored copy only moves on a probe.
function nextCloudRunText(hosted: HostedState): string {
  if (!hosted.enabled) return 'Paused in the cloud';
  if (!hosted.next_run_at) return 'No cloud run scheduled';
  const at = new Date(hosted.next_run_at);
  return `Next cloud run ${relativeDayLabel(at)} at ${clockOf(at)}`;
}

const Bullet: React.FC<{ wc: WCPalette; accent?: boolean; children: React.ReactNode }> = ({ wc, accent, children }) => (
  <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 8 }}>
    <div style={{ width: 14, display: 'flex', justifyContent: 'center', flex: 'none' }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: accent ? wc.accent : wc.muted }} />
    </div>
    <span style={{ fontSize: 12.5, color: wc.ink4 }}>{children}</span>
  </div>
);

const Note: React.FC<{ wc: WCPalette; tone: 'quiet' | 'warn'; children: React.ReactNode }> = ({ wc, tone, children }) => (
  <div
    style={{
      display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 9, padding: '8px 10px', borderRadius: 8,
      background: tone === 'warn' ? `${wc.warn}14` : `rgba(${wc.inkRGB},0.04)`,
      border: `1px solid ${tone === 'warn' ? `${wc.warn}40` : 'transparent'}`,
      fontSize: 11.5, lineHeight: 1.45, color: wc.ink4,
    }}
  >
    {children}
  </div>
);

const CloudRunSection: React.FC<{ workflow: Workflow; cloud: CloudStatusHandle }> = ({ workflow, cloud }) => {
  const WC = useWC();
  const dispatch = useAppDispatch();
  const availability = cloudAvailability(cloud.probe);
  const hosted = hostedOf(cloud.probe);
  const target = cloud.probe.phase === 'answered' ? cloud.probe.status.target : workflow.execution_target ?? 'device';
  const onCloud = target === 'cloud';
  const usage = usageText(cloud.probe, availability);
  const canPickCloud = availability.kind === 'available' && !cloud.pending;

  const seg = (active: boolean, enabled: boolean): CSSProperties => ({
    flex: 1, padding: '6px 2px', borderRadius: 7, border: 'none', fontSize: 11.5, fontWeight: 600,
    cursor: enabled ? 'pointer' : 'default',
    background: active ? WC.paper : 'transparent',
    color: active ? WC.ink : enabled ? WC.muted : WC.faint,
    boxShadow: active ? WC.shadow.sm : 'none',
  });

  const link: CSSProperties = {
    background: 'none', border: 'none', padding: 0, marginLeft: 4, cursor: 'pointer',
    color: WC.accent, fontSize: 11.5, fontWeight: 600, textDecoration: 'underline',
  };

  return (
    <div style={{ marginTop: 13, paddingTop: 13, borderTop: `1px solid ${WC.line}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: WC.ink3 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={WC.muted} strokeWidth="1.8" style={{ flex: 'none' }}><path d={CLOUD_PATH} /></svg>
          Runs on
        </span>
        <div style={{ display: 'flex', width: 186, background: WC.inset, border: `1px solid ${WC.line}`, borderRadius: 9, padding: 3, gap: 2 }}>
          <button
            onClick={() => { if (onCloud && !cloud.pending) cloud.choose('device', workflow.schedule.enabled); }}
            style={seg(!onCloud, !cloud.pending)}
          >
            This device
          </button>
          <button
            onClick={() => { if (!onCloud && canPickCloud) cloud.choose('cloud', workflow.schedule.enabled); }}
            style={seg(onCloud, canPickCloud)}
            title={availability.kind === 'blocked' ? availability.reason : undefined}
          >
            Cloud
          </button>
        </div>
      </div>

      {cloud.pending && <Note wc={WC} tone="quiet">Talking to the cloud…</Note>}

      {/* A refusal used to swallow every other branch, including the one holding the upgrade link, so being told you need Pro removed the way to get Pro. Carry the action through. */}
      {!cloud.pending && cloud.refusal && (
        <Note wc={WC} tone="warn">
          <span>
            {cloud.refusal}
            {availability.kind === 'blocked' && availability.action === 'sign_in' && (
              <button onClick={() => dispatch(openSettingsCard())} style={link}>Sign in</button>
            )}
            {availability.kind === 'blocked' && availability.action === 'plans' && (
              <button onClick={() => dispatch(openSettingsCard())} style={link}>See plans</button>
            )}
            {availability.kind === 'blocked' && availability.action === 'connect' && (
              <button onClick={() => dispatch(openSettingsCard())} style={link}>Connect an account</button>
            )}
            <button onClick={cloud.retry} style={link}>Try again</button>
          </span>
        </Note>
      )}

      {!cloud.pending && !cloud.refusal && availability.kind === 'checking' && (
        <Note wc={WC} tone="quiet">Checking what your account allows…</Note>
      )}

      {!cloud.pending && !cloud.refusal && availability.kind === 'unknown' && (
        <Note wc={WC} tone="warn">
          <span>
            Can&apos;t reach the cloud, so we can&apos;t tell whether this can run there.
            {onCloud
              ? ' It stays scheduled in the cloud; nothing changed.'
              : ' This workflow still runs on this device.'}
            <button onClick={cloud.refresh} style={link}>Try again</button>
          </span>
        </Note>
      )}

      {!cloud.pending && !cloud.refusal && availability.kind === 'blocked' && (
        <Note wc={WC} tone="quiet">
          <span>
            {availability.reason}
            {availability.action === 'sign_in' && (
              <button onClick={() => dispatch(openSettingsCard())} style={link}>Sign in</button>
            )}
            {availability.action === 'plans' && (
              <button onClick={() => dispatch(openSettingsCard())} style={link}>See plans</button>
            )}
            {availability.action === 'connect' && (
              <button onClick={() => dispatch(openSettingsCard())} style={link}>Connect an account</button>
            )}
          </span>
        </Note>
      )}

      {!cloud.pending && !cloud.refusal && availability.kind === 'available' && !onCloud && (
        <Note wc={WC} tone="quiet">Cloud runs fire on our servers, so they still happen with this app closed.</Note>
      )}

      {!cloud.pending && onCloud && hosted === null && cloud.probe.phase === 'answered' && cloud.probe.status.state === 'ready' && (
        <Note wc={WC} tone="warn">
          <span>
            This is set to run in the cloud, but the cloud has no copy of it, so nothing is running it.
            <button onClick={() => cloud.choose('device', workflow.schedule.enabled)} style={link}>Move it back here</button>
          </span>
        </Note>
      )}

      {!cloud.pending && onCloud && hosted && !hosted.in_sync && (
        <Note wc={WC} tone="warn">
          <span>
            The cloud is still running the version you sent it. Your later edits are not up there yet.
            <button onClick={() => cloud.choose('cloud', workflow.schedule.enabled)} style={link}>Send the current version</button>
          </span>
        </Note>
      )}

      {onCloud && hosted && <Bullet wc={WC} accent>{nextCloudRunText(hosted)}</Bullet>}
      {usage && <Bullet wc={WC}>{usage}</Bullet>}
    </div>
  );
};

export default CloudRunSection;
