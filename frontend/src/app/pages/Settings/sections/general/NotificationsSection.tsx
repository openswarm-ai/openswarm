import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Switch from '@mui/material/Switch';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import type { AppSettings } from '@/shared/state/settingsSlice';

interface Props {
  form: AppSettings;
  setForm: (next: AppSettings) => void;
}

interface EmailPrefs {
  available: boolean;
  run_emails: boolean | null;
}

type NotifyKey = 'notify_agent_completion' | 'notify_agent_errors' | 'notify_workflow_runs'
  | 'notify_workflow_failures' | 'notify_sound' | 'notify_when_focused';

// Both toggles gate REAL notification paths (notifications.ts checks them before firing); nothing here is decorative.
const NotificationsSection: React.FC<Props> = ({ form, setForm }) => {
  const c = useClaudeTokens();
  const signedIn = useAppSelector((s) => Boolean(s.settings.data.openswarm_bearer_token));
  // The email pref lives in the CLOUD (the sender must read it with the laptop shut), so this row round-trips instead of writing local settings.
  const [emailPrefs, setEmailPrefs] = useState<EmailPrefs | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/auth/email-prefs`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: EmailPrefs) => { if (alive) setEmailPrefs(d); })
      .catch(() => { if (alive) setEmailPrefs({ available: false, run_emails: null }); });
    return () => { alive = false; };
  }, [signedIn]);

  const flipEmail = async (next: boolean): Promise<void> => {
    setSaving(true);
    setEmailPrefs({ available: true, run_emails: next });
    try {
      const r = await fetch(`${API_BASE}/auth/email-prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_emails: next }),
      });
      setEmailPrefs((await r.json()) as EmailPrefs);
    } catch {
      setEmailPrefs({ available: false, run_emails: null });
    } finally {
      setSaving(false);
    }
  };
  const row = (title: string, body: string, key: NotifyKey, defaultOn = true): React.ReactElement => (
    <Box sx={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2,
      px: 0.5, py: 2, borderBottom: `1px solid ${c.border.subtle}`, '&:last-of-type': { borderBottom: 'none' },
    }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: c.text.primary }}>{title}</Typography>
        <Typography sx={{ fontSize: '0.8125rem', color: c.text.tertiary, mt: 0.25 }}>{body}</Typography>
      </Box>
      <Switch
        size="small"
        checked={defaultOn ? form[key] !== false : form[key] === true}
        onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
      />
    </Box>
  );
  const heading = (text: string): React.ReactElement => (
    <Typography sx={{
      fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
      color: c.text.ghost, mt: 2.5, mb: 0.5, px: 0.5,
    }}>{text}</Typography>
  );
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      {heading('Agents')}
      {row('Finished', 'When an agent completes its work.', 'notify_agent_completion')}
      {row('Errored', 'When an agent stops because something went wrong. Worth keeping on even if you turn the rest off.', 'notify_agent_errors')}
      {heading('Workflows')}
      {row('Run succeeded', 'When a scheduled run finishes cleanly, with quick actions.', 'notify_workflow_runs')}
      {row('Run failed', 'When a scheduled run does not finish.', 'notify_workflow_failures')}
      {heading('How they arrive')}
      {row('Play a sound', 'Off makes every notification above silent.', 'notify_sound')}
      {row('Even when OpenSwarm is in front', 'Normally these are held back while you are already looking at the window.', 'notify_when_focused', false)}
      {heading('Email')}
      {emailPrefs?.available ? (
        <Box sx={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2,
          px: 0.5, py: 2, borderBottom: `1px solid ${c.border.subtle}`, '&:last-of-type': { borderBottom: 'none' },
        }}>
          <Box sx={{ minWidth: 0 }}>
            <Typography sx={{ fontSize: '0.875rem', fontWeight: 600, color: c.text.primary }}>Email on cloud runs</Typography>
            <Typography sx={{ fontSize: '0.8125rem', color: c.text.tertiary, mt: 0.25 }}>
              Emails you the result when a cloud-hosted workflow finishes, even with this computer off. Every email carries its own off switch.
            </Typography>
          </Box>
          <Switch
            size="small"
            disabled={saving}
            checked={emailPrefs.run_emails === true}
            onChange={(e) => { void flipEmail(e.target.checked); }}
          />
        </Box>
      ) : (
        <Typography sx={{ fontSize: '0.8125rem', color: c.text.ghost, px: 0.5, pt: 2 }}>
          {signedIn
            ? 'Email alerts are not available right now.'
            : 'Sign in to get an email when a cloud workflow run finishes.'}
        </Typography>
      )}
    </Box>
  );
};

export default NotificationsSection;
