import React, { useState, useEffect, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import DescriptionIcon from '@mui/icons-material/Description';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import QuestionAnswerOutlinedIcon from '@mui/icons-material/QuestionAnswerOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import CategoryOutlinedIcon from '@mui/icons-material/CategoryOutlined';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import LanguageIcon from '@mui/icons-material/Language';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import SvgIcon from '@mui/material/SvgIcon';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { fetchBuiltinTools, fetchTools } from '@/shared/state/toolsSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';

const XLogoIcon: React.FC<{ sx?: object }> = ({ sx }) => (
  <SvgIcon sx={sx} viewBox="0 0 24 24">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </SvgIcon>
);

const GoogleIcon: React.FC<{ sx?: object }> = ({ sx }) => (
  <SvgIcon sx={sx} viewBox="0 0 24 24">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
  </SvgIcon>
);

const RedditIcon: React.FC<{ sx?: object }> = ({ sx }) => (
  <SvgIcon sx={sx} viewBox="0 0 24 24">
    <path d="M14.238 15.348c.085.084.085.221 0 .306-.465.462-1.194.687-2.231.687l-.008-.002-.008.002c-1.036 0-1.766-.225-2.231-.688-.085-.084-.085-.221 0-.305.084-.084.222-.084.307 0 .379.377 1.008.561 1.924.561l.008.002.008-.002c.915 0 1.544-.184 1.924-.561.085-.084.223-.084.307 0zm-3.44-2.418c0-.507-.414-.919-.922-.919-.509 0-.922.412-.922.919 0 .506.414.918.922.918.508 0 .922-.412.922-.918zm4.04-.919c-.509 0-.922.412-.922.919 0 .506.414.918.922.918.508 0 .922-.412.922-.918 0-.507-.414-.919-.922-.919zM12 2C6.478 2 2 6.477 2 12c0 5.522 4.478 10 10 10s10-4.478 10-10c0-5.523-4.478-10-10-10zm5.8 11.333c.02.14.03.283.03.428 0 2.19-2.547 3.964-5.69 3.964-3.142 0-5.69-1.774-5.69-3.964 0-.145.01-.288.03-.428A1.588 1.588 0 0 1 5.6 12c0-.881.716-1.596 1.599-1.596.424 0 .808.17 1.09.443 1.07-.742 2.554-1.22 4.19-1.284l.782-3.674a.11.11 0 0 1 .13-.083l2.603.556a1.132 1.132 0 0 1 2.154.481 1.134 1.134 0 0 1-1.132 1.133 1.132 1.132 0 0 1-1.105-.896l-2.318-.495-.69 3.248c1.6.08 3.046.56 4.094 1.29.283-.278.67-.45 1.099-.45.882 0 1.599.715 1.599 1.596 0 .56-.29 1.05-.726 1.334z" />
  </SvgIcon>
);

const TOOL_GROUP_ICONS: Record<string, React.FC<{ sx?: object }>> = {
  Twitter: XLogoIcon,
  Google: GoogleIcon,
  Reddit: RedditIcon,
  Web: LanguageIcon,
  View: ViewQuiltOutlinedIcon,
};

export function getToolGroupIcon(groupName: string, size: number = 15): React.ReactNode {
  const Icon = TOOL_GROUP_ICONS[groupName];
  if (Icon) return <Icon sx={{ fontSize: size }} />;
  return <BuildOutlinedIcon sx={{ fontSize: size }} />;
}

export interface CommandPickerItem {
  id: string;
  type: 'template' | 'skill' | 'mode' | 'context';
  category: string;
  name: string;
  description: string;
  command: string;
  icon: React.ReactNode;
  toolNames?: string[];
  iconKey?: string;
}

interface Props {
  trigger: '/' | '@';
  filter: string;
  onSelect: (item: CommandPickerItem) => void;
  onClose: () => void;
  visible: boolean;
}

const MODE_ICON_MAP: Record<string, React.ComponentType<{ sx?: object }>> = {
  smart_toy: SmartToyOutlinedIcon,
  question_answer: QuestionAnswerOutlinedIcon,
  map: MapOutlinedIcon,
  category: CategoryOutlinedIcon,
  tune: TuneOutlinedIcon,
};

function highlightMatch(text: string, query: string, color: string): React.ReactNode {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ color, fontWeight: 600 }}>{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

const CommandPicker: React.FC<Props> = ({ trigger, filter, onSelect, onClose, visible }) => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const templates = useAppSelector((s) => s.templates.items);
  const skills = useAppSelector((s) => s.skills.items);
  const modesMap = useAppSelector((s) => s.modes.items);
  const builtinTools = useAppSelector((s) => s.tools.builtinTools);
  const customTools = useAppSelector((s) => s.tools.items);
  const outputItems = useAppSelector((s) => s.outputs.items);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const toolsLoaded = useAppSelector((s) => s.tools.loaded);
  const builtinLoaded = useAppSelector((s) => s.tools.builtinLoaded);
  const outputsLoaded = useAppSelector((s) => s.outputs.loaded);

  useEffect(() => {
    if (!builtinLoaded) dispatch(fetchBuiltinTools());
    if (!toolsLoaded) dispatch(fetchTools());
    if (!outputsLoaded) dispatch(fetchOutputs());
  }, [dispatch, builtinLoaded, toolsLoaded, outputsLoaded]);

  const items: CommandPickerItem[] = useMemo(() => {
    let all: CommandPickerItem[] = [];

    if (trigger === '/') {
      const templateItems: CommandPickerItem[] = Object.values(templates).map((t) => ({
        id: t.id,
        type: 'template' as const,
        category: 'Templates',
        name: t.name,
        description: t.description || `Template with ${t.fields.length} fields`,
        command: t.name.toLowerCase().replace(/\s+/g, '-'),
        icon: <DescriptionIcon sx={{ fontSize: 15 }} />,
      }));

      const skillItems: CommandPickerItem[] = Object.values(skills).map((s) => ({
        id: s.id,
        type: 'skill' as const,
        category: 'Skills',
        name: s.name,
        description: s.description || 'Skill',
        command: s.command || s.id,
        icon: <PsychologyIcon sx={{ fontSize: 15 }} />,
      }));

      const modeItems: CommandPickerItem[] = Object.values(modesMap).map((m) => {
        const IconComp = MODE_ICON_MAP[m.icon] || SmartToyOutlinedIcon;
        return {
          id: m.id,
          type: 'mode' as const,
          category: 'Modes',
          name: m.name,
          description: m.description || 'Switch to this mode',
          command: m.name.toLowerCase().replace(/\s+/g, '-'),
          icon: <IconComp sx={{ fontSize: 15 }} />,
        };
      });

      all = [...templateItems, ...skillItems, ...modeItems];
    } else {
      const atItems: CommandPickerItem[] = [
        {
          id: 'file',
          type: 'context' as const,
          category: 'Context',
          name: 'File',
          description: 'Attach a file or folder as context',
          command: 'file',
          icon: <InsertDriveFileOutlinedIcon sx={{ fontSize: 15 }} />,
        },
      ];

      const hasWebSearch = builtinTools.some((t) => t.name === 'WebSearch' && t.deferred);
      const hasWebFetch = builtinTools.some((t) => t.name === 'WebFetch' && t.deferred);
      if (hasWebSearch || hasWebFetch) {
        const webTools = [hasWebSearch && 'WebSearch', hasWebFetch && 'WebFetch'].filter(Boolean) as string[];
        atItems.push({
          id: 'web',
          type: 'context' as const,
          category: 'Actions',
          name: 'Web',
          description: 'Search the web and fetch URLs',
          command: 'web',
          icon: <LanguageIcon sx={{ fontSize: 15 }} />,
          toolNames: webTools,
          iconKey: 'Web',
        });
      }

      for (const tool of Object.values(customTools)) {
        if (!tool.mcp_config || Object.keys(tool.mcp_config).length === 0) continue;
        const services = tool.tool_permissions?._services as Record<string, { read: string[]; write: string[] }> | undefined;
        if (!services) continue;
        const perms = tool.tool_permissions as Record<string, any>;
        const serviceGroups = (tool.tool_permissions?._service_groups ?? {}) as Record<string, string[]>;

        const enabledServices: { name: string; tools: string[] }[] = [];
        for (const [serviceName, serviceTools] of Object.entries(services)) {
          const allToolNames = [...(serviceTools.read || []), ...(serviceTools.write || [])];
          const enabled = allToolNames.filter((name) => perms[name] !== 'deny');
          if (enabled.length > 0) enabledServices.push({ name: serviceName, tools: enabled });
        }

        if (enabledServices.length === 0) continue;

        const groupEntries = Object.entries(serviceGroups);
        const emittedServices = new Set<string>();

        for (const [groupName, groupServiceNames] of groupEntries) {
          const groupCmd = groupName.toLowerCase().replace(/\s+/g, '-');
          const groupServices = enabledServices.filter((s) => groupServiceNames.includes(s.name));
          if (groupServices.length === 0) continue;
          groupServices.forEach((s) => emittedServices.add(s.name));

          const groupIcon = getToolGroupIcon(groupName);
          if (groupServices.length >= 2) {
            const allTools = groupServices.flatMap((s) => s.tools);
            atItems.push({
              id: `mcp-${tool.id}-group-${groupName}`,
              type: 'context' as const,
              category: tool.name,
              name: groupName,
              description: `Use all ${groupName} actions`,
              command: groupCmd,
              icon: groupIcon,
              toolNames: allTools,
              iconKey: groupName,
            });
            for (const svc of groupServices) {
              atItems.push({
                id: `mcp-${tool.id}-${svc.name}`,
                type: 'context' as const,
                category: tool.name,
                name: svc.name,
                description: `Use ${svc.name} actions from ${tool.name}`,
                command: `${groupCmd}/${svc.name.toLowerCase().replace(/\s+/g, '-')}`,
                icon: groupIcon,
                toolNames: svc.tools,
                iconKey: groupName,
              });
            }
          } else {
            const svc = groupServices[0];
            atItems.push({
              id: `mcp-${tool.id}-${svc.name}`,
              type: 'context' as const,
              category: tool.name,
              name: svc.name,
              description: `Use ${svc.name} actions from ${tool.name}`,
              command: svc.name.toLowerCase().replace(/\s+/g, '-'),
              icon: groupIcon,
              toolNames: svc.tools,
              iconKey: groupName,
            });
          }
        }

        for (const svc of enabledServices) {
          if (emittedServices.has(svc.name)) continue;
          atItems.push({
            id: `mcp-${tool.id}-${svc.name}`,
            type: 'context' as const,
            category: tool.name,
            name: svc.name,
            description: `Use ${svc.name} actions from ${tool.name}`,
            command: svc.name.toLowerCase().replace(/\s+/g, '-'),
            icon: <BuildOutlinedIcon sx={{ fontSize: 15 }} />,
            toolNames: svc.tools,
          });
        }
      }

      for (const out of Object.values(outputItems)) {
        if (out.permission === 'deny') continue;
        const cmd = out.name.toLowerCase().replace(/\s+/g, '-');
        atItems.push({
          id: `view-${out.id}`,
          type: 'context' as const,
          category: 'Apps',
          name: out.name,
          description: out.description || `Render ${out.name} view`,
          command: cmd,
          icon: <ViewQuiltOutlinedIcon sx={{ fontSize: 15 }} />,
          toolNames: ['RenderOutput'],
          iconKey: 'View',
        });
      }

      all = atItems;
    }

    if (!filter) return all;
    const lower = filter.toLowerCase();
    return all.filter(
      (item) =>
        item.name.toLowerCase().includes(lower) ||
        item.command.toLowerCase().includes(lower) ||
        item.description.toLowerCase().includes(lower),
    );
  }, [trigger, templates, skills, modesMap, builtinTools, customTools, outputItems, filter]);

  const flatItems = useMemo(() => {
    const result: { item: CommandPickerItem; isGroupStart: boolean; category: string }[] = [];
    let lastCat = '';
    for (const item of items) {
      result.push({ item, isGroupStart: item.category !== lastCat, category: item.category });
      lastCat = item.category;
    }
    return result;
  }, [items]);

  const getIconColor = (item: CommandPickerItem): string => {
    switch (item.type) {
      case 'template': return c.accent.primary;
      case 'skill': return c.status.success;
      case 'mode': {
        const mode = modesMap[item.id];
        return mode?.color || c.accent.primary;
      }
      case 'context': return c.text.tertiary;
      default: return c.text.tertiary;
    }
  };

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter, trigger]);

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-picker-idx="${selectedIndex}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((p) => (p < items.length - 1 ? p + 1 : p));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((p) => (p > 0 ? p - 1 : p));
          break;
        case 'Enter':
        case 'Tab':
          if (items[selectedIndex]) {
            e.preventDefault();
            onSelect(items[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, items, selectedIndex, onSelect, onClose]);

  if (!visible || items.length === 0) return null;

  return (
    <Paper
      ref={containerRef}
      elevation={0}
      sx={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        mb: 0.5,
        bgcolor: c.bg.surface,
        border: `1px solid ${c.border.subtle}`,
        borderRadius: '12px',
        maxHeight: 320,
        overflow: 'auto',
        zIndex: 1000,
        boxShadow: c.shadow.lg,
        animation: 'cmdPickerIn 120ms ease-out',
        '@keyframes cmdPickerIn': {
          from: { opacity: 0, transform: 'translateY(4px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
        '&::-webkit-scrollbar': { width: 4 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': {
          background: c.border.medium,
          borderRadius: 2,
          '&:hover': { background: c.border.strong },
        },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}
    >
      <Box sx={{ py: 0.5 }}>
        {flatItems.map(({ item, isGroupStart, category }, idx) => (
          <React.Fragment key={`${item.type}-${item.id}`}>
            {isGroupStart && (
              <Box sx={{ px: 1.5, pt: idx === 0 ? 0.75 : 1.25, pb: 0.375 }}>
                <Typography
                  sx={{
                    color: c.text.ghost,
                    fontSize: '0.625rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                  }}
                >
                  {category}
                </Typography>
              </Box>
            )}
            <Box
              data-picker-idx={idx}
              onClick={() => onSelect(item)}
              onMouseEnter={() => setSelectedIndex(idx)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.25,
                py: 0.5,
                mx: 0.5,
                borderRadius: '8px',
                cursor: 'pointer',
                bgcolor: idx === selectedIndex ? `${c.accent.primary}0a` : 'transparent',
                '&:hover': { bgcolor: `${c.accent.primary}0a` },
                transition: 'background-color 60ms ease',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  flexShrink: 0,
                  borderRadius: '6px',
                  bgcolor: `${getIconColor(item)}12`,
                  color: getIconColor(item),
                }}
              >
                {item.icon}
              </Box>
              <Typography
                component="span"
                sx={{
                  color: c.text.primary,
                  fontSize: '0.8rem',
                  fontWeight: 500,
                  fontFamily: c.font.mono,
                  whiteSpace: 'nowrap',
                  lineHeight: 1.3,
                }}
              >
                {trigger}{highlightMatch(item.command, filter, c.accent.primary)}
              </Typography>
              <Typography
                component="span"
                sx={{
                  color: c.text.muted,
                  fontSize: '0.72rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  ml: 0.5,
                  lineHeight: 1.3,
                }}
              >
                {item.description}
              </Typography>
            </Box>
          </React.Fragment>
        ))}
      </Box>

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          px: 1.5,
          py: 0.625,
          borderTop: `1px solid ${c.border.subtle}`,
        }}
      >
        {[
          { keys: '↑↓', label: 'navigate' },
          { keys: '↵', label: 'select' },
          { keys: 'esc', label: 'dismiss' },
        ].map(({ keys, label }) => (
          <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.375 }}>
            <Typography
              sx={{
                fontSize: '0.58rem',
                fontFamily: c.font.mono,
                color: c.text.ghost,
                bgcolor: c.bg.secondary,
                px: 0.5,
                py: 0.125,
                borderRadius: '3px',
                border: `1px solid ${c.border.subtle}`,
                lineHeight: 1.3,
              }}
            >
              {keys}
            </Typography>
            <Typography sx={{ fontSize: '0.58rem', color: c.text.ghost }}>
              {label}
            </Typography>
          </Box>
        ))}
      </Box>
    </Paper>
  );
};

export default CommandPicker;
