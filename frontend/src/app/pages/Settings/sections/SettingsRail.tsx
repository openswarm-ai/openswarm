import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { User, Settings2, Palette, ShieldCheck, Wrench, Boxes, SquareSlash, BarChart3, Bell, Mic, LayoutGrid, Bot, Brain, Hammer } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import UpdateReadyDot from '@/app/components/UpdateReadyDot';

// ChatGPT/Apple-style settings nav: a left rail of short, focused sections instead of one giant
// General scroll. Grouped so the eye lands (account, then app-wide, then capabilities).
export interface RailSection {
  value: string;
  label: string;
  Icon: LucideIcon;
}

interface RailGroup {
  header: string | null;
  sections: RailSection[];
}

export const RAIL_GROUPS: RailGroup[] = [
  { header: null, sections: [
    { value: 'account', label: 'Account', Icon: User },
  ] },
  { header: 'App', sections: [
    { value: 'general', label: 'General', Icon: Settings2 },
    { value: 'appearance', label: 'Appearance', Icon: Palette },
    { value: 'dictation', label: 'Dictation', Icon: Mic },
    { value: 'memory', label: 'Memory', Icon: Brain },
    { value: 'canvas', label: 'Canvas', Icon: LayoutGrid },
    { value: 'agents', label: 'Agents', Icon: Bot },
    { value: 'notifications', label: 'Notifications', Icon: Bell },
    { value: 'privacy', label: 'Privacy', Icon: ShieldCheck },
    { value: 'advanced', label: 'Advanced', Icon: Wrench },
  ] },
  { header: 'Capabilities', sections: [
    { value: 'models', label: 'Models', Icon: Boxes },
    { value: 'tools', label: 'Tools', Icon: Hammer },
    { value: 'commands', label: 'Commands', Icon: SquareSlash },
    { value: 'usage', label: 'Usage', Icon: BarChart3 },
  ] },
];

export function railLabelFor(value: string): string {
  for (const g of RAIL_GROUPS) {
    const hit = g.sections.find((s) => s.value === value);
    if (hit) return hit.label;
  }
  return 'Settings';
}

const SettingsRail: React.FC<{
  activeTab: string;
  onTabChange: (v: string) => void;
}> = ({ activeTab, onTabChange }) => {
  const c = useClaudeTokens();
  return (
    <Box sx={{
      width: 210, minWidth: 210, flexShrink: 0, display: 'flex', flexDirection: 'column',
      px: 2, pt: 0.5, overflowY: 'auto',
    }}>
      {RAIL_GROUPS.map((group) => (
        <Box key={group.header ?? 'top'} sx={{ mb: 0.5 }}>
          {group.header && (
            <Typography sx={{
              color: c.text.ghost, fontSize: '0.6875rem', fontWeight: 700,
              letterSpacing: '0.07em', textTransform: 'uppercase', px: 1.5, pt: 1.5, pb: 0.5,
            }}>
              {group.header}
            </Typography>
          )}
          {group.sections.map((s) => {
            const selected = activeTab === s.value;
            return (
              <Box
                key={s.value}
                component="button"
                onClick={() => onTabChange(s.value)}
                data-onboarding={s.value === 'models' ? 'settings-models-tab' : undefined}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 1.25, width: '100%',
                  px: 1.5, py: 1, mb: '2px', border: 'none', borderRadius: `${c.radius.md}px`,
                  bgcolor: selected ? c.bg.secondary : 'transparent',
                  color: c.text.primary,
                  fontFamily: 'inherit', fontSize: '0.9375rem', fontWeight: 600,
                  cursor: 'pointer', textAlign: 'left',
                  transition: 'background-color 0.12s',
                  '&:hover': { bgcolor: selected ? c.bg.secondary : c.bg.elevated },
                }}
              >
                <s.Icon size={16} style={{ flexShrink: 0, color: c.text.secondary }} />
                {s.label}
                {s.value === 'advanced' && <UpdateReadyDot size={7} sx={{ ml: 'auto' }} />}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
};

export default SettingsRail;
