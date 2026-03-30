import { useMemo, useEffect } from 'react';
import type {
  Unstable_MentionAdapter,
  Unstable_MentionCategory,
  Unstable_MentionItem,
} from '@assistant-ui/core';
import { useAppSelector, useAppDispatch } from '@/shared/hooks';
import { fetchBuiltinTools, fetchTools } from '@/shared/state/toolsSlice';
import { fetchOutputs } from '@/shared/state/outputsSlice';

export interface MentionItemMetadata {
  itemType: 'template' | 'skill' | 'mode' | 'file' | 'tool-group' | 'output';
  toolNames?: string[];
  iconKey?: string;
  command?: string;
  hasFields?: boolean;
}

function buildItem(
  id: string,
  type: string,
  label: string,
  description: string,
  meta: MentionItemMetadata,
): Unstable_MentionItem {
  return { id, type, label, description, metadata: meta as any };
}

function matchesQuery(item: Unstable_MentionItem, lower: string): boolean {
  return (
    item.label.toLowerCase().includes(lower) ||
    (item.description?.toLowerCase().includes(lower) ?? false) ||
    ((item.metadata as any)?.command?.toLowerCase().includes(lower) ?? false)
  );
}

/**
 * Hook that builds an Unstable_MentionAdapter from Redux state.
 * Provides categories and items for templates, skills, modes, context tools,
 * MCP tool groups, and output apps.
 */
export function useOpenSwarmMentionAdapter(): Unstable_MentionAdapter {
  const dispatch = useAppDispatch();
  const templates = useAppSelector((s) => s.templates.items);
  const skills = useAppSelector((s) => s.skills.items);
  const modesMap = useAppSelector((s) => s.modes.items);
  const builtinTools = useAppSelector((s) => s.tools.builtinTools);
  const customTools = useAppSelector((s) => s.tools.items);
  const outputItems = useAppSelector((s) => s.outputs.items);

  const toolsLoaded = useAppSelector((s) => s.tools.loaded);
  const builtinLoaded = useAppSelector((s) => s.tools.builtinLoaded);
  const outputsLoaded = useAppSelector((s) => s.outputs.loaded);

  useEffect(() => {
    if (!builtinLoaded) dispatch(fetchBuiltinTools());
    if (!toolsLoaded) dispatch(fetchTools());
    if (!outputsLoaded) dispatch(fetchOutputs());
  }, [dispatch, builtinLoaded, toolsLoaded, outputsLoaded]);

  const { categories, itemsByCategory, allItems } = useMemo(() => {
    const cats: Unstable_MentionCategory[] = [];
    const byCategory: Record<string, Unstable_MentionItem[]> = {};
    const all: Unstable_MentionItem[] = [];

    const addCategory = (id: string, label: string) => {
      if (!byCategory[id]) {
        cats.push({ id, label });
        byCategory[id] = [];
      }
    };

    const addItem = (catId: string, item: Unstable_MentionItem) => {
      byCategory[catId]?.push(item);
      all.push(item);
    };

    // --- Templates ---
    const templateValues = Object.values(templates);
    if (templateValues.length > 0) {
      addCategory('templates', 'Templates');
      for (const t of templateValues) {
        addItem(
          'templates',
          buildItem(t.id, 'template', t.name, t.description || `Template with ${t.fields.length} fields`, {
            itemType: 'template',
            command: t.name.toLowerCase().replace(/\s+/g, '-'),
            hasFields: t.fields.length > 0,
          }),
        );
      }
    }

    // --- Skills ---
    const skillValues = Object.values(skills);
    if (skillValues.length > 0) {
      addCategory('skills', 'Skills');
      for (const s of skillValues) {
        addItem(
          'skills',
          buildItem(s.id, 'skill', s.name, s.description || 'Skill', {
            itemType: 'skill',
            command: s.command || s.id,
          }),
        );
      }
    }

    // --- Modes ---
    const modeValues = Object.values(modesMap);
    if (modeValues.length > 0) {
      addCategory('modes', 'Modes');
      for (const m of modeValues) {
        addItem(
          'modes',
          buildItem(m.id, 'mode', m.name, m.description || 'Switch to this mode', {
            itemType: 'mode',
            command: m.name.toLowerCase().replace(/\s+/g, '-'),
          }),
        );
      }
    }

    // --- Context: File ---
    addCategory('context', 'Context');
    addItem(
      'context',
      buildItem('file', 'context', 'File', 'Attach a file or folder as context', {
        itemType: 'file',
        command: 'file',
      }),
    );

    // --- Actions: Web ---
    const hasWebSearch = builtinTools.some((t) => t.name === 'WebSearch' && t.deferred);
    const hasWebFetch = builtinTools.some((t) => t.name === 'WebFetch' && t.deferred);
    if (hasWebSearch || hasWebFetch) {
      const webTools = [hasWebSearch && 'WebSearch', hasWebFetch && 'WebFetch'].filter(
        Boolean,
      ) as string[];
      addItem(
        'context',
        buildItem('web', 'context', 'Web', 'Search the web and fetch URLs', {
          itemType: 'tool-group',
          command: 'web',
          toolNames: webTools,
          iconKey: 'Web',
        }),
      );
    }

    // --- MCP Tool Groups ---
    for (const tool of Object.values(customTools)) {
      if (!tool.mcp_config || Object.keys(tool.mcp_config).length === 0) continue;
      const services = tool.tool_permissions?._services as Record<string, { read: string[]; write: string[] }> | undefined;
      if (!services) continue;
      const perms = tool.tool_permissions as Record<string, any>;
      const serviceGroups = (tool.tool_permissions?._service_groups ?? {}) as Record<string, string[]>;
      const enabled: { name: string; tools: string[] }[] = [];
      for (const [sn, st] of Object.entries(services)) {
        const names = [...(st.read || []), ...(st.write || [])].filter((n) => perms[n] !== 'deny');
        if (names.length > 0) enabled.push({ name: sn, tools: names });
      }
      if (enabled.length === 0) continue;
      const catId = `mcp-${tool.id}`;
      addCategory(catId, tool.name);
      const emitted = new Set<string>();
      for (const [gn, gsn] of Object.entries(serviceGroups)) {
        const gc = gn.toLowerCase().replace(/\s+/g, '-');
        const gs = enabled.filter((s) => gsn.includes(s.name));
        if (gs.length === 0) continue;
        gs.forEach((s) => emitted.add(s.name));
        if (gs.length >= 2) {
          addItem(catId, buildItem(`mcp-${tool.id}-group-${gn}`, 'context', gn, `Use all ${gn} actions`, { itemType: 'tool-group', command: gc, toolNames: gs.flatMap((s) => s.tools), iconKey: gn }));
        }
        for (const svc of gs) {
          const cmd = gs.length >= 2 ? `${gc}/${svc.name.toLowerCase().replace(/\s+/g, '-')}` : svc.name.toLowerCase().replace(/\s+/g, '-');
          addItem(catId, buildItem(`mcp-${tool.id}-${svc.name}`, 'context', svc.name, `Use ${svc.name} actions from ${tool.name}`, { itemType: 'tool-group', command: cmd, toolNames: svc.tools, iconKey: gn }));
        }
      }
      for (const svc of enabled) {
        if (emitted.has(svc.name)) continue;
        addItem(catId, buildItem(`mcp-${tool.id}-${svc.name}`, 'context', svc.name, `Use ${svc.name} actions from ${tool.name}`, { itemType: 'tool-group', command: svc.name.toLowerCase().replace(/\s+/g, '-'), toolNames: svc.tools }));
      }
    }

    // --- Apps / Outputs ---
    const outputValues = Object.values(outputItems).filter((o) => o.permission !== 'deny');
    if (outputValues.length > 0) {
      addCategory('apps', 'Apps');
      for (const out of outputValues) {
        addItem(
          'apps',
          buildItem(`view-${out.id}`, 'context', out.name, out.description || `Render ${out.name} view`, {
            itemType: 'output',
            command: out.name.toLowerCase().replace(/\s+/g, '-'),
            toolNames: ['RenderOutput'],
            iconKey: 'View',
          }),
        );
      }
    }

    return { categories: cats, itemsByCategory: byCategory, allItems: all };
  }, [templates, skills, modesMap, builtinTools, customTools, outputItems]);

  return useMemo<Unstable_MentionAdapter>(
    () => ({
      categories: () => categories,
      categoryItems: (categoryId: string) => itemsByCategory[categoryId] ?? [],
      search: (query: string) => {
        if (!query) return allItems;
        const lower = query.toLowerCase();
        return allItems.filter((item) => matchesQuery(item, lower));
      },
    }),
    [categories, itemsByCategory, allItems],
  );
}
