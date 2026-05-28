import { useMemo } from 'react';
import { BuiltinTool } from '@/shared/state/toolsSlice';

const BROWSER_CATEGORIES = new Set(['browser_delegation', 'browser_action']);

function groupTools(list: BuiltinTool[]) {
  const g: Record<string, BuiltinTool[]> = {};
  for (const bt of list) { if (!g[bt.category]) g[bt.category] = []; g[bt.category].push(bt); }
  return g;
}

const notDenied = (tools: BuiltinTool[], perms: Record<string, string>) =>
  !tools.every((t) => perms[t.name] === 'deny');

export function useBuiltinSections(builtinTools: BuiltinTool[], builtinPermissions: Record<string, string>) {
  const coreTools = useMemo(() => builtinTools.filter((bt) => !bt.deferred && !BROWSER_CATEGORIES.has(bt.category)), [builtinTools]);
  const deferredTools = useMemo(() => builtinTools.filter((bt) => bt.deferred && !BROWSER_CATEGORIES.has(bt.category)), [builtinTools]);
  const browserTools = useMemo(() => builtinTools.filter((bt) => BROWSER_CATEGORIES.has(bt.category)), [builtinTools]);
  const browserDelegationTools = useMemo(() => browserTools.filter((bt) => bt.category === 'browser_delegation'), [browserTools]);
  const browserActionTools = useMemo(() => browserTools.filter((bt) => bt.category === 'browser_action'), [browserTools]);
  const groupedCore = useMemo(() => groupTools(coreTools), [coreTools]);
  const groupedDeferred = useMemo(() => groupTools(deferredTools), [deferredTools]);

  const coreSectionEnabled = useMemo(() => notDenied(coreTools, builtinPermissions), [coreTools, builtinPermissions]);
  const deferredSectionEnabled = useMemo(() => notDenied(deferredTools, builtinPermissions), [deferredTools, builtinPermissions]);
  const browserSectionEnabled = useMemo(() => browserTools.length > 0 && notDenied(browserTools, builtinPermissions), [browserTools, builtinPermissions]);

  return {
    coreTools, deferredTools, browserTools, browserDelegationTools, browserActionTools,
    groupedCore, groupedDeferred, coreSectionEnabled, deferredSectionEnabled, browserSectionEnabled,
  };
}
