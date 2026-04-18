import { useEffect, useMemo } from 'react';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import LanguageIcon from '@mui/icons-material/Language';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import { fetchBuiltinTools, fetchTools } from '@/shared/state/toolsSlice';
import { getToolGroupIcon } from '@/app/components/CommandPicker';
import { LIST_APPS } from '@/shared/backend-bridge/apps/app_builder';
import { LIST_SKILLS } from '@/shared/backend-bridge/apps/skills';
import { LIST_MODES } from '@/shared/state/modesSlice';
import { SlashCommand, AtCommand, SHORTCUTS } from '../commandsTypes';

export function useCommands() {
  const dispatch = useAppDispatch();
  const skills = useAppSelector((state) => state.skills.items);
  const modesMap = useAppSelector((state) => state.modes.items);
  const builtinTools = useAppSelector((state) => state.tools.builtinTools);
  const customTools = useAppSelector((state) => state.tools.items);
  const outputItems = useAppSelector((state) => state.apps.items);

  const skillsLoaded = useAppSelector((state) => state.skills.loaded);
  const modesLoaded = useAppSelector((state) => state.modes.loaded);
  const builtinLoaded = useAppSelector((state) => state.tools.builtinLoaded);
  const toolsLoaded = useAppSelector((state) => state.tools.loaded);
  const outputsLoaded = useAppSelector((state) => state.apps.loaded);

  useEffect(() => {
    if (!skillsLoaded) dispatch(LIST_SKILLS());
    if (!modesLoaded) dispatch(LIST_MODES());
    if (!builtinLoaded) dispatch(fetchBuiltinTools());
    if (!toolsLoaded) dispatch(fetchTools());
    if (!outputsLoaded) dispatch(LIST_APPS());
  }, [dispatch, skillsLoaded, modesLoaded, builtinLoaded, toolsLoaded, outputsLoaded]);

  const slashCommands: SlashCommand[] = useMemo(() => [
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
  ], [skills, modesMap]);

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

  return { slashCommands, atCommands, modesMap, navShortcuts, actionShortcuts };
}
