// ENG-284: per-tool visibility in Settings, where users actually look for it. Same tri-state
// store the Tools page edits (builtin_permissions.json); enforcement lives at dispatch
// (register_builtin_mcp_servers, build_effective_tool_lists, the backing routes), never UI-only.
import React, { useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import {
  fetchBuiltinTools,
  fetchBuiltinPermissions,
  updateBuiltinPermissions,
  type BuiltinTool,
} from '@/shared/state/toolsSlice';
import PermToggle from '@/app/components/PermToggle';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

const CATEGORY_LABELS: Record<string, string> = {
  filesystem: 'Filesystem',
  system: 'System',
  search: 'Search',
  interaction: 'Interaction',
  planning: 'Planning',
  scheduling: 'Scheduling',
  agents: 'Agents',
  skills: 'Skills',
  browser_delegation: 'Browser delegation',
  browser_action: 'Browser actions',
};

function firstSentence(desc: string): string {
  const m = desc.match(/^(.+?(?:\.|$))/);
  return m ? m[1].trim() : desc.slice(0, 100);
}

const ToolsSettings: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const builtinTools = useAppSelector((s) => s.tools.builtinTools);
  const perms = useAppSelector((s) => s.tools.builtinPermissions);

  useEffect(() => {
    void dispatch(fetchBuiltinTools());
    void dispatch(fetchBuiltinPermissions());
  }, [dispatch]);

  const grouped = useMemo(() => {
    const g: Record<string, BuiltinTool[]> = {};
    for (const t of builtinTools) {
      if (!g[t.category]) g[t.category] = [];
      g[t.category].push(t);
    }
    return g;
  }, [builtinTools]);

  const categories = useMemo(
    () => Object.keys(CATEGORY_LABELS).filter((cat) => (grouped[cat] || []).length > 0),
    [grouped],
  );

  return (
    <Box>
      <Typography sx={{ fontSize: '0.8125rem', color: c.text.secondary, mb: 1.5, lineHeight: 1.5 }}>
        What agents may use, per tool. Allow runs without asking, Ask pauses for your approval, Deny
        hides the tool from every agent. Denied tools are refused by the backend as well, so a tool
        you turn off here is off everywhere.
      </Typography>
      {categories.map((cat) => (
        <Box key={cat} sx={{ mb: 1.5 }}>
          <Typography sx={{ fontSize: '0.6875rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: c.text.muted, mb: 0.5, px: 0.5 }}>
            {CATEGORY_LABELS[cat]}
          </Typography>
          {grouped[cat].map((t) => (
            <Box
              key={t.name}
              sx={{
                display: 'flex', alignItems: 'center', gap: 2, px: 0.5, py: 1,
                borderBottom: `1px solid ${c.border.subtle}`,
                '&:last-of-type': { borderBottom: 'none' },
              }}
            >
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography sx={{ fontSize: '0.8125rem', fontWeight: 600, color: c.text.primary }}>
                  {t.display_name || t.name}
                </Typography>
                <Typography sx={{ fontSize: '0.75rem', color: c.text.tertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {firstSentence(t.description)}
                </Typography>
              </Box>
              <PermToggle
                value={perms[t.name] || 'always_allow'}
                onChange={(v) => void dispatch(updateBuiltinPermissions({ [t.name]: v }))}
              />
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
};

export default ToolsSettings;
