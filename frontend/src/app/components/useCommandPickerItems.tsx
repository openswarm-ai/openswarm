import { useMemo, useEffect } from 'react';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import LanguageIcon from '@mui/icons-material/Language';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import { LIST_BUILTIN_TOOLS, LIST_TOOLS } from '@/shared/backend-bridge/apps/tools';
import { LIST_APPS } from '@/shared/backend-bridge/apps/app_builder';
import { CommandPickerItem, MODE_ICON_MAP } from './commandPickerTypes';
import { getToolGroupIcon } from './CommandPickerIcons';

export function useCommandPickerItems(trigger: '/' | '@', filter: string) {
  const dispatch = useAppDispatch();
  const skills = useAppSelector((s) => s.skills.items);
  const modesMap = useAppSelector((s) => s.modes.items);
  const builtinTools = useAppSelector((s) => s.tools.builtinTools);
  const customTools = useAppSelector((s) => s.tools.items);
  const outputItems = useAppSelector((s) => s.apps.items);

  const toolsLoaded = useAppSelector((s) => s.tools.loaded);
  const builtinLoaded = useAppSelector((s) => s.tools.builtinLoaded);
  const outputsLoaded = useAppSelector((s) => s.apps.loaded);

  useEffect(() => {
    if (!builtinLoaded) dispatch(LIST_BUILTIN_TOOLS());
    if (!toolsLoaded) dispatch(LIST_TOOLS());
    if (!outputsLoaded) dispatch(LIST_APPS());
  }, [dispatch, builtinLoaded, toolsLoaded, outputsLoaded]);

  const items: CommandPickerItem[] = useMemo(() => {
    let all: CommandPickerItem[] = [];

    if (trigger === '/') {
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

      all = [...skillItems, ...modeItems];
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
  }, [trigger, skills, modesMap, builtinTools, customTools, outputItems, filter]);

  const flatItems = useMemo(() => {
    const result: { item: CommandPickerItem; isGroupStart: boolean; category: string }[] = [];
    let lastCat = '';
    for (const item of items) {
      result.push({ item, isGroupStart: item.category !== lastCat, category: item.category });
      lastCat = item.category;
    }
    return result;
  }, [items]);

  return { items, flatItems, modesMap };
}
