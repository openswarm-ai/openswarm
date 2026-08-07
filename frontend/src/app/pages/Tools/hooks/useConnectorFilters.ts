import { useMemo, useState } from 'react';
import { ToolDefinition } from '@/shared/state/toolsSlice';
import { Integration } from '../integrations';

export type ConnFilter = 'all' | 'connected' | 'not-connected';

// The claude Connectors-page filter state: All/Connected/Not connected pills + the header search.
export function useConnectorFilters(tools: ToolDefinition[], uninstalledIntegrations: Integration[]) {
  const [connFilter, setConnFilter] = useState<ConnFilter>('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const q = searchQ.trim().toLowerCase();

  const visibleTools = useMemo(() => {
    let out = tools;
    if (connFilter === 'connected') out = out.filter((t) => t.enabled !== false);
    if (connFilter === 'not-connected') out = out.filter((t) => t.enabled === false);
    if (q) out = out.filter((t) => (t.name || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
    return out;
  }, [tools, connFilter, q]);

  const visibleGallery = useMemo(() => {
    if (connFilter === 'connected') return [];
    if (!q) return uninstalledIntegrations;
    return uninstalledIntegrations.filter((ig) => ig.name.toLowerCase().includes(q) || ig.description.toLowerCase().includes(q));
  }, [uninstalledIntegrations, connFilter, q]);

  const popularUninstalled = useMemo(
    () => ['google-workspace', 'slack', 'notion'].map((id) => uninstalledIntegrations.find((ig) => ig.id === id)).filter((ig): ig is Integration => !!ig),
    [uninstalledIntegrations],
  );

  return { connFilter, setConnFilter, searchOpen, setSearchOpen, searchQ, setSearchQ, q, visibleTools, visibleGallery, popularUninstalled };
}
