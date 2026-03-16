import React, { useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import DescriptionIcon from '@mui/icons-material/Description';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import AlternateEmailIcon from '@mui/icons-material/AlternateEmail';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import TerminalIcon from '@mui/icons-material/Terminal';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import LanguageIcon from '@mui/icons-material/Language';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { fetchBuiltinTools, fetchTools } from '@/shared/state/toolsSlice';
import { getToolGroupIcon } from '@/app/components/CommandPicker';
import { fetchOutputs } from '@/shared/state/outputsSlice';
import { fetchTemplates } from '@/shared/state/templatesSlice';
import { fetchSkills } from '@/shared/state/skillsSlice';
import { fetchModes } from '@/shared/state/modesSlice';

interface SlashCommand {
  id: string;
  type: 'template' | 'skill' | 'mode';
  name: string;
  description: string;
  command: string;
}

interface AtCommand {
  prefix: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  source: string;
  isChild?: boolean;
}

interface Shortcut {
  key: string;
  description: string;
  category: 'navigation' | 'action';
}

const SHORTCUTS: Shortcut[] = [
  { key: 'd', description: 'Go to Dashboard', category: 'navigation' },
  { key: 't', description: 'Go to Templates', category: 'navigation' },
  { key: '1-9', description: 'Open agent by position', category: 'navigation' },
  { key: 'Shift+A', description: 'Approve all pending', category: 'action' },
  { key: 'Shift+D', description: 'Deny all pending', category: 'action' },
  { key: '?', description: 'Show shortcuts dialog', category: 'navigation' },
];

const KeyBadge: React.FC<{ keys: string; c: any }> = ({ keys, c }) => (
  <Box
    sx={{
      bgcolor: c.bg.secondary,
      border: `1px solid ${c.border.medium}`,
      borderRadius: 1.5,
      px: 1.25,
      py: 0.4,
      display: 'inline-flex',
      alignItems: 'center',
    }}
  >
    <Typography
      sx={{
        color: c.accent.primary,
        fontSize: '0.75rem',
        fontFamily: c.font.mono,
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {keys}
    </Typography>
  </Box>
);

const SectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  count?: number;
  c: any;
}> = ({ icon, title, subtitle, count, c }) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
    <Box sx={{ color: c.accent.primary, display: 'flex', alignItems: 'center' }}>{icon}</Box>
    <Box sx={{ flex: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '1rem' }}>
          {title}
        </Typography>
        {count !== undefined && (
          <Chip
            label={count}
            size="small"
            sx={{
              height: 20,
              fontSize: '0.7rem',
              fontWeight: 600,
              bgcolor: `${c.accent.primary}15`,
              color: c.accent.primary,
            }}
          />
        )}
      </Box>
      <Typography sx={{ color: c.text.tertiary, fontSize: '0.8rem' }}>{subtitle}</Typography>
    </Box>
  </Box>
);

export const CommandsContent: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const templates = useAppSelector((state) => state.templates.items);
  const skills = useAppSelector((state) => state.skills.items);
  const modesMap = useAppSelector((state) => state.modes.items);
  const builtinTools = useAppSelector((state) => state.tools.builtinTools);
  const customTools = useAppSelector((state) => state.tools.items);
  const outputItems = useAppSelector((state) => state.outputs.items);

  const templatesLoaded = useAppSelector((state) => state.templates.loaded);
  const skillsLoaded = useAppSelector((state) => state.skills.loaded);
  const modesLoaded = useAppSelector((state) => state.modes.loaded);
  const builtinLoaded = useAppSelector((state) => state.tools.builtinLoaded);
  const toolsLoaded = useAppSelector((state) => state.tools.loaded);
  const outputsLoaded = useAppSelector((state) => state.outputs.loaded);

  useEffect(() => {
    if (!templatesLoaded) dispatch(fetchTemplates());
    if (!skillsLoaded) dispatch(fetchSkills());
    if (!modesLoaded) dispatch(fetchModes());
    if (!builtinLoaded) dispatch(fetchBuiltinTools());
    if (!toolsLoaded) dispatch(fetchTools());
    if (!outputsLoaded) dispatch(fetchOutputs());
  }, [dispatch, templatesLoaded, skillsLoaded, modesLoaded, builtinLoaded, toolsLoaded, outputsLoaded]);

  const slashCommands: SlashCommand[] = useMemo(() => [
    ...Object.values(templates).map((t) => ({
      id: t.id,
      type: 'template' as const,
      name: t.name,
      description: t.description || `Template with ${t.fields.length} fields`,
      command: t.name.toLowerCase().replace(/\s+/g, '-'),
    })),
    ...Object.values(skills).map((s) => ({
      id: s.id,
      type: 'skill' as const,
      name: s.name,
      description: s.description || 'Skill',
      command: s.command || s.id,
    })),
    ...Object.values(modesMap).map((m) => ({
      id: m.id,
      type: 'mode' as const,
      name: m.name,
      description: m.description || 'Switch to this mode',
      command: m.name.toLowerCase().replace(/\s+/g, '-'),
    })),
  ], [templates, skills, modesMap]);

  const atCommands: AtCommand[] = useMemo(() => {
    const items: AtCommand[] = [
      { prefix: '@file', label: 'File', description: 'Attach a file or folder as context', icon: <InsertDriveFileOutlinedIcon sx={{ fontSize: 18 }} />, source: 'builtin' },
    ];

    const hasWebSearch = builtinTools.some((t) => t.name === 'WebSearch' && t.deferred);
    const hasWebFetch = builtinTools.some((t) => t.name === 'WebFetch' && t.deferred);
    if (hasWebSearch || hasWebFetch) {
      items.push({
        prefix: '@web',
        label: 'Web',
        description: 'Search the web and fetch URLs',
        icon: <LanguageIcon sx={{ fontSize: 18 }} />,
        source: 'builtin',
      });
    }

    for (const tool of Object.values(customTools)) {
      if (!tool.mcp_config || Object.keys(tool.mcp_config).length === 0) continue;
      const services = tool.tool_permissions?._services as Record<string, { read: string[]; write: string[] }> | undefined;
      if (!services) continue;
      const perms = tool.tool_permissions as Record<string, any>;
      const serviceGroups = (tool.tool_permissions?._service_groups ?? {}) as Record<string, string[]>;

      const enabledServices: { name: string }[] = [];
      for (const [serviceName, serviceTools] of Object.entries(services)) {
        const allToolNames = [...(serviceTools.read || []), ...(serviceTools.write || [])];
        const enabled = allToolNames.filter((name) => perms[name] !== 'deny');
        if (enabled.length > 0) enabledServices.push({ name: serviceName });
      }

      if (enabledServices.length === 0) continue;

      const groupEntries = Object.entries(serviceGroups);
      const emittedServices = new Set<string>();

      for (const [groupName, groupServiceNames] of groupEntries) {
        const groupCmd = groupName.toLowerCase().replace(/\s+/g, '-');
        const groupServices = enabledServices.filter((s) => groupServiceNames.includes(s.name));
        if (groupServices.length === 0) continue;
        groupServices.forEach((s) => emittedServices.add(s.name));

        const groupIcon = getToolGroupIcon(groupName, 18);
        if (groupServices.length >= 2) {
          items.push({
            prefix: `@${groupCmd}`,
            label: groupName,
            description: `Use all ${groupName} actions`,
            icon: groupIcon,
            source: tool.name,
          });
          for (const svc of groupServices) {
            items.push({
              prefix: `@${groupCmd}/${svc.name.toLowerCase().replace(/\s+/g, '-')}`,
              label: svc.name,
              description: `Use ${svc.name} actions from ${tool.name}`,
              icon: groupIcon,
              source: tool.name,
              isChild: true,
            });
          }
        } else {
          const svc = groupServices[0];
          items.push({
            prefix: `@${svc.name.toLowerCase().replace(/\s+/g, '-')}`,
            label: svc.name,
            description: `Use ${svc.name} actions from ${tool.name}`,
            icon: groupIcon,
            source: tool.name,
          });
        }
      }

      for (const svc of enabledServices) {
        if (emittedServices.has(svc.name)) continue;
        items.push({
          prefix: `@${svc.name.toLowerCase().replace(/\s+/g, '-')}`,
          label: svc.name,
          description: `Use ${svc.name} actions from ${tool.name}`,
          icon: <BuildOutlinedIcon sx={{ fontSize: 18 }} />,
          source: tool.name,
        });
      }
    }

    for (const out of Object.values(outputItems)) {
      if (out.permission === 'deny') continue;
      const cmd = out.name.toLowerCase().replace(/\s+/g, '-');
      items.push({
        prefix: `@${cmd}`,
        label: out.name,
        description: out.description || `Render ${out.name} view`,
        icon: <ViewQuiltOutlinedIcon sx={{ fontSize: 18 }} />,
        source: 'view',
      });
    }

    return items;
  }, [builtinTools, customTools, outputItems]);

  const navShortcuts = SHORTCUTS.filter((s) => s.category === 'navigation');
  const actionShortcuts = SHORTCUTS.filter((s) => s.category === 'action');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
        {/* Slash Commands */}
        <Box>
          <SectionHeader
            icon={<TerminalIcon sx={{ fontSize: 22 }} />}
            title="Slash Commands"
            subtitle="Type / in chat to invoke templates, skills, and modes"
            count={slashCommands.length}
            c={c}
          />

          {slashCommands.length === 0 ? (
            <Box
              sx={{
                py: 4,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                color: c.text.ghost,
              }}
            >
              <TerminalIcon sx={{ fontSize: 36, opacity: 0.3 }} />
              <Typography sx={{ fontSize: '0.85rem' }}>
                No slash commands yet. Create templates, skills, or modes to see them here.
              </Typography>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {slashCommands.map((cmd) => (
                <Box
                  key={`${cmd.type}-${cmd.id}`}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    px: 2,
                    py: 1.25,
                    borderRadius: 2,
                    '&:hover': { bgcolor: `${c.accent.primary}06` },
                    transition: 'background-color 0.15s',
                  }}
                >
                  <Box sx={{
                    color: cmd.type === 'template' ? c.accent.primary
                      : cmd.type === 'mode' ? (modesMap[cmd.id]?.color || c.accent.primary)
                      : c.status.success,
                    display: 'flex',
                  }}>
                    {cmd.type === 'template' ? (
                      <DescriptionIcon sx={{ fontSize: 18 }} />
                    ) : cmd.type === 'mode' ? (
                      <SmartToyOutlinedIcon sx={{ fontSize: 18 }} />
                    ) : (
                      <PsychologyIcon sx={{ fontSize: 18 }} />
                    )}
                  </Box>
                  <Typography
                    sx={{
                      color: c.text.primary,
                      fontSize: '0.85rem',
                      fontFamily: c.font.mono,
                      fontWeight: 500,
                      minWidth: 140,
                    }}
                  >
                    /{cmd.command}
                  </Typography>
                  <Chip
                    label={cmd.type}
                    size="small"
                    sx={{
                      height: 20,
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      bgcolor: cmd.type === 'template' ? `${c.accent.primary}12`
                        : cmd.type === 'mode' ? `${modesMap[cmd.id]?.color || c.accent.primary}15`
                        : `${c.status.success}15`,
                      color: cmd.type === 'template' ? c.accent.primary
                        : cmd.type === 'mode' ? (modesMap[cmd.id]?.color || c.accent.primary)
                        : c.status.success,
                    }}
                  />
                  <Typography
                    sx={{
                      color: c.text.muted,
                      fontSize: '0.8rem',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {cmd.description}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>

        <Box sx={{ my: 2, borderTop: `1px solid ${c.border.subtle}` }} />

        {/* @ Commands */}
        <Box>
          <SectionHeader
            icon={<AlternateEmailIcon sx={{ fontSize: 22 }} />}
            title="@ Context Commands"
            subtitle="Type @ in chat to attach context and activate actions"
            count={atCommands.length}
            c={c}
          />

          {atCommands.length === 0 ? (
            <Box
              sx={{
                py: 4,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 1,
                color: c.text.ghost,
              }}
            >
              <AlternateEmailIcon sx={{ fontSize: 36, opacity: 0.3 }} />
              <Typography sx={{ fontSize: '0.85rem' }}>
                No @ commands yet. Install MCP actions to see them here.
              </Typography>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {atCommands.map((cmd) => (
                <Box
                  key={cmd.prefix}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    pl: cmd.isChild ? 5 : 2,
                    pr: 2,
                    py: cmd.isChild ? 0.875 : 1.25,
                    borderRadius: 2,
                    '&:hover': { bgcolor: `${c.accent.primary}06` },
                    transition: 'background-color 0.15s',
                  }}
                >
                  <Box sx={{ color: c.accent.primary, display: 'flex', opacity: cmd.isChild ? 0.6 : 1 }}>
                    {cmd.icon}
                  </Box>
                  <Typography
                    sx={{
                      color: c.text.primary,
                      fontSize: cmd.isChild ? '0.8rem' : '0.85rem',
                      fontFamily: c.font.mono,
                      fontWeight: 500,
                      minWidth: 140,
                    }}
                  >
                    {cmd.prefix}
                  </Typography>
                  <Chip
                    label={cmd.source}
                    size="small"
                    sx={{
                      height: 20,
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      bgcolor: cmd.source === 'builtin' ? `${c.accent.primary}12` : cmd.source === 'view' ? '#f472b615' : `${c.status.info}15`,
                      color: cmd.source === 'builtin' ? c.accent.primary : cmd.source === 'view' ? '#f472b6' : c.status.info,
                    }}
                  />
                  <Typography
                    sx={{
                      color: c.text.muted,
                      fontSize: '0.8rem',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {cmd.description}
                  </Typography>
                </Box>
              ))}
            </Box>
          )}
        </Box>

        <Box sx={{ my: 2, borderTop: `1px solid ${c.border.subtle}` }} />

        {/* Keyboard Shortcuts */}
        <Box>
          <SectionHeader
            icon={<KeyboardIcon sx={{ fontSize: 22 }} />}
            title="Keyboard Shortcuts"
            subtitle="Press ? anywhere to see the quick-reference dialog"
            count={SHORTCUTS.length}
            c={c}
          />

          <Box sx={{ display: 'flex', gap: 4 }}>
            {/* Navigation */}
            <Box sx={{ flex: 1 }}>
              <Typography
                sx={{
                  color: c.text.tertiary,
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  mb: 1.5,
                  px: 1,
                }}
              >
                Navigation
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {navShortcuts.map((s) => (
                  <Box
                    key={s.key}
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      px: 1.5,
                      py: 1,
                      borderRadius: 2,
                      '&:hover': { bgcolor: `${c.accent.primary}06` },
                      transition: 'background-color 0.15s',
                    }}
                  >
                    <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>
                      {s.description}
                    </Typography>
                    <KeyBadge keys={s.key} c={c} />
                  </Box>
                ))}
              </Box>
            </Box>

            {/* Actions */}
            <Box sx={{ flex: 1 }}>
              <Typography
                sx={{
                  color: c.text.tertiary,
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  mb: 1.5,
                  px: 1,
                }}
              >
                Actions
              </Typography>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {actionShortcuts.map((s) => (
                  <Box
                    key={s.key}
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      px: 1.5,
                      py: 1,
                      borderRadius: 2,
                      '&:hover': { bgcolor: `${c.accent.primary}06` },
                      transition: 'background-color 0.15s',
                    }}
                  >
                    <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>
                      {s.description}
                    </Typography>
                    <KeyBadge keys={s.key} c={c} />
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        </Box>
    </Box>
  );
};

export default CommandsContent;
