import React from 'react';
import { report } from '@/shared/serviceClient';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Switch from '@mui/material/Switch';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import { AppSettings } from '@/shared/state/settingsSlice';
import { closeSettingsCard } from '@/shared/state/dashboardLayoutSlice';
import { onboardingBus } from '@/app/components/Onboarding/eventBus';
import { resetTour } from '@/shared/state/onboardingProgressSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import TrustedFilePatterns from '@/app/components/overlays/TrustedFilePatterns';
import SoftwareUpdateRow, { UpdateReadyBanner } from './SoftwareUpdateRow';
import type { SettingsStyles } from '../settingsStyles';
import { settingSelectAttrs } from '../settingSelect';

const GeneralAdvanced: React.FC<{
  form: AppSettings;
  setForm: React.Dispatch<React.SetStateAction<AppSettings>>;
  styles: SettingsStyles;
}> = ({ form, setForm, styles }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const appVersion = useAppSelector((s) => s.update.appVersion);
  const { sectionSx, rowSx, inlineRowSx, inlineRowLastSx, labelSx, descSx, switchSx } = styles;

  // Provenance: the exact commit this build was cut from. Surfaced so a support screenshot of Settings is enough to identify the shipped code. Empty in dev / web (no Electron bridge or unknown sha), in which case we hide the row.
  const [buildLabel, setBuildLabel] = React.useState<string | null>(null);
  // ENG-422: Windows only. The row does not exist elsewhere, so a Mac user is never shown a switch
  // that cannot do anything, and main enforces the same rule rather than trusting this.
  const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);
  const [defenderBusy, setDefenderBusy] = React.useState(false);
  const [defenderNote, setDefenderNote] = React.useState<string | null>(null);

  const toggleDefenderExclusion = async (next: boolean) => {
    const api = (window as { openswarm?: { setDefenderExclusion?: (v: boolean) => Promise<{ ok: boolean; detail?: string }> } }).openswarm;
    if (!api?.setDefenderExclusion) return;
    setDefenderBusy(true);
    setDefenderNote(null);
    // Optimistic, then reverted on refusal: the switch must never claim an exclusion that Windows
    // did not actually make (a toggle that lies about a security boundary is worse than no toggle).
    setForm({ ...form, windows_defender_exclusion: next });
    try {
      const res = await api.setDefenderExclusion(next);
      if (!res?.ok) {
        setForm({ ...form, windows_defender_exclusion: !next });
        setDefenderNote(res?.detail || 'nothing was changed');
      }
    } catch {
      setForm({ ...form, windows_defender_exclusion: !next });
      setDefenderNote('nothing was changed');
    } finally {
      setDefenderBusy(false);
    }
  };
  React.useEffect(() => {
    const api = (window as { openswarm?: { getBuildInfo?: () => Promise<{ shortSha: string; channel: string }> } }).openswarm;
    api?.getBuildInfo?.()
      .then((b) => { if (b?.shortSha && b.shortSha !== 'unknown') setBuildLabel(`${b.shortSha} (${b.channel})`); })
      .catch(() => {});
  }, []);

  return (
    <>
      <UpdateReadyBanner />

      <Box sx={inlineRowSx} {...settingSelectAttrs('dev_mode', 'Developer mode', 'Advanced', 'Show transport details, env vars, and technical metadata throughout the app.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Developer mode</Typography>
          <Typography sx={descSx}>Show transport details, environment variables, raw configs, and other technical metadata throughout the app.</Typography>
        </Box>
        <Switch
          checked={form.dev_mode}
          onChange={(e) => setForm({ ...form, dev_mode: e.target.checked })}
          sx={switchSx}
        />
      </Box>

      {isWindows && (
        <Box sx={inlineRowSx} {...settingSelectAttrs('windows_defender_exclusion', 'Antivirus exclusion', 'Advanced', 'Stop Windows Defender from scanning OpenSwarm\'s own folders.')}>
          <Box sx={{ mr: 3 }}>
            <Typography sx={labelSx}>Antivirus exclusion</Typography>
            <Typography sx={descSx}>
              Stops Windows Defender scanning OpenSwarm&apos;s own folders. Turn this on if antivirus keeps
              removing part of the app: without it a repaired file can be taken again. Windows will ask you to
              approve the change, and turning this off undoes it.
            </Typography>
            {defenderNote && (
              <Typography sx={{ ...descSx, mt: 0.5 }}>{defenderNote}</Typography>
            )}
          </Box>
          <Switch
            checked={form.windows_defender_exclusion}
            disabled={defenderBusy}
            onChange={(e) => { void toggleDefenderExclusion(e.target.checked); }}
            sx={switchSx}
          />
        </Box>
      )}

      <Box sx={inlineRowLastSx} {...settingSelectAttrs('allow_experimental_updates', 'Experimental updates', 'Advanced', 'Receive pre-release builds with new features earlier.')}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={labelSx}>Experimental updates</Typography>
          <Typography sx={descSx}>Receive pre-release builds with new features earlier. These versions may be less stable than normal releases.</Typography>
        </Box>
        <Switch
          checked={form.allow_experimental_updates}
          onChange={(e) => setForm({ ...form, allow_experimental_updates: e.target.checked })}
          sx={switchSx}
        />
      </Box>

      <Typography sx={{ ...sectionSx, mt: 3 }}>About</Typography>

      <Box sx={rowSx}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography sx={labelSx}>Version</Typography>
          <Typography sx={{ ...descSx, fontFamily: c.font.mono }}>{appVersion ?? '-'}</Typography>
        </Box>
        {buildLabel && (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1 }}>
            <Typography sx={labelSx}>Build</Typography>
            <Typography sx={{ ...descSx, fontFamily: c.font.mono }}>{buildLabel}</Typography>
          </Box>
        )}
      </Box>

      <SoftwareUpdateRow styles={styles} />

      <TrustedFilePatterns />

      <Box sx={inlineRowLastSx}>
        <Box sx={{ mr: 3 }}>
          <Typography sx={{ ...labelSx, mb: 0.25 }}>Onboarding tour</Typography>
          <Typography sx={{ ...descSx, mb: 0 }}>
            Re-run the Show me walkthrough at any time.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          data-onboarding="settings-restart-tour"
          onClick={() => {
            report('onboarding_v2', 'tour_restarted');
            try {
              window.localStorage.removeItem('openswarm.onboarding.v2');
            } catch { /* ignore */ }
            dispatch(resetTour());
            dispatch(closeSettingsCard());
            onboardingBus.emit('settings:closed');
            // In-place reset can't re-arm the welcome cursor's once-per-mount guard, so the tour never re-fired without a reload; reload from the now-cleared storage is the reliable restart (matches the workaround).
            window.location.reload();
          }}
          sx={{
            color: c.text.secondary,
            borderColor: c.border.medium,
            textTransform: 'none',
            fontSize: '0.8125rem',
            whiteSpace: 'nowrap',
            '&:hover': { color: c.accent.primary, borderColor: c.accent.primary },
          }}
        >
          Restart tour
        </Button>
      </Box>

    </>
  );
};

export default GeneralAdvanced;
