import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Switch from '@mui/material/Switch';
import TerminalIcon from '@mui/icons-material/Terminal';
import DescriptionIcon from '@mui/icons-material/Description';
import SearchIcon from '@mui/icons-material/Search';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import ScheduleIcon from '@mui/icons-material/Schedule';
import MapIcon from '@mui/icons-material/Map';
import SecurityIcon from '@mui/icons-material/Security';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { BuiltinTool } from '@/shared/state/toolsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import PermToggle from '@/app/components/PermToggle';
import { CATEGORY_ORDER } from '../toolsHelpers';

interface ToolSectionProps {
  label: string;
  icon: React.ReactElement;
  count: number;
  open: boolean;
  onToggle: () => void;
  grouped: Record<string, BuiltinTool[]>;
  collapsedCategories: Record<string, boolean>;
  toggleCategory: (cat: string) => void;
  expandedBuiltin: string | null;
  toggleBuiltinExpand: (name: string) => void;
  deferred?: boolean;
  builtinPermissions: Record<string, string>;
  onPermissionChange: (toolName: string, policy: string) => void;
  onCategoryPermissionChange: (toolNames: string[], policy: string) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

const ToolSection: React.FC<ToolSectionProps> = ({
  label, icon, count, open, onToggle,
  grouped, collapsedCategories, toggleCategory,
  expandedBuiltin, toggleBuiltinExpand, deferred,
  builtinPermissions, onPermissionChange, onCategoryPermissionChange,
  enabled, onEnabledChange,
}) => {
  const c = useClaudeTokens();

  const CATEGORY_META: Record<string, { label: string; color: string; icon: React.ReactElement }> = {
    filesystem: { label: 'Filesystem', color: c.status.success, icon: <DescriptionIcon sx={{ fontSize: 16 }} /> },
    system: { label: 'System', color: c.status.warning, icon: <TerminalIcon sx={{ fontSize: 16 }} /> },
    search: { label: 'Search', color: '#3b82f6', icon: <SearchIcon sx={{ fontSize: 16 }} /> },
    interaction: { label: 'Interaction', color: '#a855f7', icon: <QuestionAnswerIcon sx={{ fontSize: 16 }} /> },
    planning: { label: 'Planning', color: '#ec4899', icon: <MapIcon sx={{ fontSize: 16 }} /> },
    scheduling: { label: 'Scheduling', color: '#14b8a6', icon: <ScheduleIcon sx={{ fontSize: 16 }} /> },
    agents: { label: 'Agents', color: '#f97316', icon: <CallSplitIcon sx={{ fontSize: 16 }} /> },
    skills: { label: 'Skills', color: '#7B61BD', icon: <AutoAwesomeIcon sx={{ fontSize: 16 }} /> },
  };

  const getCatGroupPolicy = (tools: BuiltinTool[]) => {
    const policies = tools.map((t) => builtinPermissions[t.name] || 'always_allow');
    if (policies.every((p) => p === 'always_allow')) return 'always_allow';
    if (policies.every((p) => p === 'deny')) return 'deny';
    if (policies.every((p) => p === 'ask')) return 'ask';
    return 'mixed';
  };

  const allSectionTools = CATEGORY_ORDER.filter((cat) => grouped[cat]).flatMap((cat) => grouped[cat]);
  const overallPolicy = getCatGroupPolicy(allSectionTools);
  const categoryCount = CATEGORY_ORDER.filter((cat) => grouped[cat]).length;
  const sectionDescription = deferred
    ? 'On-demand tools loaded via ToolSearch for planning, scheduling, and extended operations'
    : 'Built-in Claude Agent SDK tools for file operations, shell commands, and search';

  const firstSentence = (desc: string) => {
    if (!desc) return '';
    const match = desc.match(/^(.+?(?:\.|$))/);
    return match ? match[1].trim() : desc.substring(0, 100);
  };

  return (
  <Card sx={{ bgcolor: open && enabled ? c.bg.elevated : 'transparent', border: 'none', borderRadius: 0, boxShadow: 'none', borderBottom: `1px solid ${c.border.subtle}`, '&:last-of-type': { borderBottom: 'none' }, '&:hover': { bgcolor: c.bg.elevated }, transition: 'background-color 0.12s' }}>
    <CardContent sx={{ py: 1.4, px: 2, '&:last-child': { pb: 1.4 } }}>
      <Box
        onClick={() => enabled && onToggle()}
        sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px 200px', alignItems: 'center', gap: 2, cursor: enabled ? 'pointer' : 'default' }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
          <Box sx={{
            width: 34, height: 34, borderRadius: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: `1px solid ${c.border.subtle}`, bgcolor: c.bg.surface, color: c.text.tertiary, flexShrink: 0,
            opacity: enabled ? 1 : 0.55, transition: 'opacity 0.2s',
          }}>
            {icon}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ color: enabled ? c.text.primary : c.text.tertiary, fontWeight: 600, fontSize: '0.9375rem', mb: 0.25 }}>{label}</Typography>
            <Typography noWrap sx={{ color: c.text.muted, fontSize: '0.8125rem' }}>{sectionDescription}</Typography>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.75rem', mt: 0.25 }}>{count} tools{deferred ? '  ·  on-demand' : ''}</Typography>
          </Box>
        </Box>
        <Typography sx={{ color: c.text.secondary, fontSize: '0.8125rem' }}>Built-in</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 0.5 }}>
          <Box onClick={(e) => e.stopPropagation()} sx={{ display: 'flex', alignItems: 'center' }}>
            <Switch
              size="small"
              checked={enabled}
              onChange={(_, checked) => onEnabledChange(checked)}
              sx={{
                '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
                '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
              }}
            />
          </Box>
          {enabled && (
            <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.ghost, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} />
          )}
        </Box>
      </Box>
    </CardContent>
    <Collapse in={open && enabled} timeout={0} unmountOnExit>
      <Box sx={{ px: 2, pb: 2, pt: 0, borderTop: `1px solid ${c.border.subtle}` }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5, mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <SecurityIcon sx={{ fontSize: 14, color: c.text.muted }} />
            <Typography sx={{ color: c.text.muted, fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Tool Permissions</Typography>
            <Chip label={`${count} tools`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.625rem', height: 18, ml: 0.5, '& .MuiChip-label': { px: 0.6 } }} />
          </Box>
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {CATEGORY_ORDER.filter((cat) => grouped[cat]).map((cat) => {
            const meta = CATEGORY_META[cat] || CATEGORY_META.filesystem;
            const catTools = grouped[cat];
            const colKey = `${deferred ? 'd_' : ''}${cat}`;
            const isOpen = !collapsedCategories[colKey];
            const catPolicy = getCatGroupPolicy(catTools);
            return (
              <Box key={cat} sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: 1.5, overflow: 'hidden', '&:hover': { borderColor: c.border.medium } }}>
                <Box
                  sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, cursor: 'pointer', bgcolor: isOpen ? c.bg.secondary : 'transparent', '&:hover': { bgcolor: c.bg.secondary } }}
                  onClick={() => toggleCategory(colKey)}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost, transition: 'transform 0.15s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                    <Typography sx={{ color: c.text.primary, fontSize: '0.875rem', fontWeight: 600 }}>{meta.label}</Typography>
                    <Chip label={catTools.length} size="small" sx={{ bgcolor: c.bg.page, color: c.text.muted, fontSize: '0.625rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                  </Box>
                  <PermToggle value={catPolicy === 'mixed' ? 'ask' : catPolicy} onChange={(v) => onCategoryPermissionChange(catTools.map((t) => t.name), v)} />
                </Box>
                <Collapse in={isOpen} timeout={0} unmountOnExit>
                  <Box sx={{ px: 1, pb: 1 }}>
                    {catTools.map((bt) => {
                      const toolPolicy = builtinPermissions[bt.name] || 'always_allow';
                      return (
                        <Box key={bt.name} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.4, px: 1.5, borderRadius: 1, '&:hover': { bgcolor: c.bg.secondary } }}>
                          <Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
                            <Typography sx={{ color: c.text.primary, fontSize: '0.8125rem', fontWeight: 500 }}>{bt.display_name || bt.name}</Typography>
                            {bt.description && <Typography sx={{ color: c.text.ghost, fontSize: '0.6875rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{firstSentence(bt.description)}</Typography>}
                          </Box>
                          <PermToggle value={toolPolicy} onChange={(v) => onPermissionChange(bt.name, v)} size={14} />
                        </Box>
                      );
                    })}
                  </Box>
                </Collapse>
              </Box>
            );
          })}
        </Box>
      </Box>
    </Collapse>
  </Card>
  );
};

export default ToolSection;
