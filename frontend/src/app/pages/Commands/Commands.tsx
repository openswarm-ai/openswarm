import React, { useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import LanguageIcon from '@mui/icons-material/Language';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { fetchBuiltinTools, fetchTools } from '@/shared/state/toolsSlice';
import { getToolGroupIcon } from '@/app/components/editor/CommandPicker';
import { fetchSkills } from '@/shared/state/skillsSlice';
import { makeSettingsStyles } from '@/app/pages/Settings/sections/settingsStyles';

interface SlashCommand {
  id: string;
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

export const CommandsContent: React.FC = () => {
  const c = useClaudeTokens();
  const styles = makeSettingsStyles(c);
  const dispatch = useAppDispatch();
  const skills = useAppSelector((state) => state.skills.items);
  const builtinTools = useAppSelector((state) => state.tools.builtinTools);
  const customTools = useAppSelector((state) => state.tools.items);

  const skillsLoaded = useAppSelector((state) => state.skills.loaded);
  const builtinLoaded = useAppSelector((state) => state.tools.builtinLoaded);
  const toolsLoaded = useAppSelector((state) => state.tools.loaded);

  useEffect(() => {
    if (!skillsLoaded) dispatch(fetchSkills());
    if (!builtinLoaded) dispatch(fetchBuiltinTools());
    if (!toolsLoaded) dispatch(fetchTools());
  }, [dispatch, skillsLoaded, builtinLoaded, toolsLoaded]);

  const slashCommands: SlashCommand[] = useMemo(() => [
    ...Object.values(skills).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description || 'Skill',
      command: s.command || s.id,
    })),
  ], [skills]);

  const atCommands: AtCommand[] = useMemo(() => {
    const items: AtCommand[] = [
      { prefix: '@file', label: 'File', description: 'Attach a file or folder as context', icon: <InsertDriveFileOutlinedIcon sx={{ fontSize: 16 }} />, source: 'built-in' },
    ];

    const hasWebSearch = builtinTools.some((t) => t.name === 'WebSearch' && t.deferred);
    const hasWebFetch = builtinTools.some((t) => t.name === 'WebFetch' && t.deferred);
    if (hasWebSearch || hasWebFetch) {
      items.push({
        prefix: '@web',
        label: 'Web',
        description: 'Search the web and fetch URLs',
        icon: <LanguageIcon sx={{ fontSize: 16 }} />,
        source: 'built-in',
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

        const groupIcon = getToolGroupIcon(groupName, 16);
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
          icon: <BuildOutlinedIcon sx={{ fontSize: 16 }} />,
          source: tool.name,
        });
      }
    }

    return items;
  }, [builtinTools, customTools]);

  const monoSx = {
    color: c.text.primary,
    fontSize: '0.8125rem',
    fontFamily: c.font.mono,
    fontWeight: 500,
    minWidth: 150,
    flexShrink: 0,
  } as const;
  const descColSx = {
    color: c.text.muted,
    fontSize: '0.8125rem',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const;
  const sourceSx = { color: c.text.ghost, fontSize: '0.75rem', flexShrink: 0 } as const;
  const commandRowSx = {
    display: 'flex',
    alignItems: 'center',
    gap: 1.5,
    px: 0.5,
    py: 1.1,
    borderBottom: `1px solid ${c.border.subtle}`,
    '&:last-of-type': { borderBottom: 'none' },
  } as const;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Typography sx={{ ...styles.sectionSx, mt: 0 }}>Slash commands</Typography>
      <Typography sx={{ ...styles.descSx, px: 0.5, mb: 0.5 }}>Type / in chat to invoke a skill.</Typography>
      {slashCommands.length === 0 ? (
        <Typography sx={{ color: c.text.ghost, fontSize: '0.8125rem', px: 0.5, py: 1.5 }}>
          No slash commands yet. Install or create skills to see them here.
        </Typography>
      ) : (
        slashCommands.map((cmd) => (
          <Box key={cmd.id} sx={commandRowSx}>
            <Typography sx={monoSx}>/{cmd.command}</Typography>
            <Typography sx={descColSx}>{cmd.description}</Typography>
            <Typography sx={sourceSx}>skill</Typography>
          </Box>
        ))
      )}

      <Typography sx={styles.sectionSx}>@ commands</Typography>
      <Typography sx={{ ...styles.descSx, px: 0.5, mb: 0.5 }}>Type @ in chat to attach context and activate actions.</Typography>
      {atCommands.map((cmd, i) => (
        <Box key={`${cmd.prefix}::${cmd.source}::${i}`} sx={{ ...commandRowSx, pl: cmd.isChild ? 3.5 : 0.5 }}>
          <Box sx={{ color: c.text.muted, display: 'flex', flexShrink: 0, opacity: cmd.isChild ? 0.6 : 1 }}>
            {cmd.icon}
          </Box>
          <Typography sx={monoSx}>{cmd.prefix}</Typography>
          <Typography sx={descColSx}>{cmd.description}</Typography>
          <Typography sx={sourceSx}>{cmd.source}</Typography>
        </Box>
      ))}
    </Box>
  );
};

export default CommandsContent;
