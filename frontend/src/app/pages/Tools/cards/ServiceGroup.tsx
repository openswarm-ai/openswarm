import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import EditIcon from '@mui/icons-material/Edit';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PanToolIcon from '@mui/icons-material/PanTool';
import { ToolDefinition } from '@/shared/state/toolsSlice';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { Integration } from '../integrations';

const toDisplayName = (name: string, serviceName?: string) => {
  let display = name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (serviceName) {
    const svcLower = serviceName.toLowerCase();
    const variants = [svcLower, svcLower.replace(/s$/, '')];
    for (const v of variants) {
      display = display.replace(new RegExp(`\\b${v}\\b`, 'gi'), '').trim();
    }
    display = display.replace(/\s{2,}/g, ' ').trim();
  }
  return display;
};

const firstSentence = (desc: string) => {
  if (!desc) return '';
  const match = desc.match(/^(.+?(?:\.|$))/);
  return match ? match[1].trim() : desc.substring(0, 100);
};

interface ServiceGroupProps {
  tool: ToolDefinition;
  ig: Integration | undefined;
  serviceName: string;
  data: { read?: string[]; write?: string[] };
  isFirstGroup?: boolean;
  perms: Record<string, any>;
  descriptions: Record<string, string>;
  schemas: Record<string, any>;
  expandedServices: Record<string, boolean>;
  setExpandedServices: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  expandedSchema: string | null;
  setExpandedSchema: React.Dispatch<React.SetStateAction<string | null>>;
  devMode: boolean;
  onGroupPermissionChange: (toolId: string, names: string[], policy: string) => void;
  onPermissionChange: (toolId: string, toolName: string, policy: string) => void;
}

const ServiceGroup: React.FC<ServiceGroupProps> = ({
  tool, ig, serviceName, data, isFirstGroup,
  perms, descriptions, schemas,
  expandedServices, setExpandedServices, expandedSchema, setExpandedSchema, devMode,
  onGroupPermissionChange: handleGroupPermissionChange,
  onPermissionChange: handlePermissionChange,
}) => {
  const c = useClaudeTokens();

  const getGroupPolicy = (names: string[]) => {
    if (names.length === 0) return 'ask';
    const policies = names.map((n) => perms[n] || 'ask');
    if (policies.every((p) => p === 'always_allow')) return 'always_allow';
    if (policies.every((p) => p === 'deny')) return 'deny';
    if (policies.every((p) => p === 'ask')) return 'ask';
    return 'mixed';
  };

  const PermToggle = ({ value, onChange, size = 16 }: { value: string; onChange: (v: string) => void; size?: number }) => (
    <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
      <Tooltip title="Always allow"><IconButton size="small" onClick={() => onChange('always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: value === 'always_allow' ? `${c.status.success}20` : 'transparent', color: value === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: size }} /></IconButton></Tooltip>
      <Tooltip title="Ask permission"><IconButton size="small" onClick={() => onChange('ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: value === 'ask' ? `${c.status.warning}20` : 'transparent', color: value === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: size }} /></IconButton></Tooltip>
      <Tooltip title="Always deny"><IconButton size="small" onClick={() => onChange('deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: value === 'deny' ? `${c.status.error}20` : 'transparent', color: value === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: size }} /></IconButton></Tooltip>
    </Box>
  );

  const renderActionList = (names: string[]) => names.map((name) => {
    const schemaKey = `${tool.id}:${name}`;
    const schema = schemas[name];
    const schemaProps = schema?.properties as Record<string, any> | undefined;
    const schemaRequired = (schema?.required || []) as string[];
    return (
      <Box key={name}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.4, px: 1.5, borderRadius: 1, cursor: devMode && schema ? 'pointer' : undefined, '&:hover': { bgcolor: c.bg.secondary } }} onClick={() => devMode && schema && setExpandedSchema((p) => p === schemaKey ? null : schemaKey)}>
          <Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
            <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500 }}>{toDisplayName(name, serviceName)}</Typography>
            {descriptions[name] && <Typography sx={{ color: c.text.ghost, fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{firstSentence(descriptions[name])}</Typography>}
          </Box>
          <PermToggle value={perms[name] || 'ask'} onChange={(v) => handlePermissionChange(tool.id, name, v)} size={14} />
        </Box>
        {devMode && expandedSchema === schemaKey && schemaProps && (
          <Box sx={{ mx: 1.5, mb: 0.75, px: 1.5, py: 1, bgcolor: c.bg.page, borderRadius: 1, border: `1px solid ${c.border.subtle}` }}>
            <Typography sx={{ color: c.text.ghost, fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', mb: 0.5 }}>Input Parameters</Typography>
            {Object.entries(schemaProps).map(([pName, pDef]: [string, any]) => (
              <Box key={pName} sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, py: 0.2 }}>
                <Typography sx={{ color: c.accent.primary, fontSize: '0.72rem', fontFamily: c.font.mono, fontWeight: 600, flexShrink: 0 }}>{pName}</Typography>
                <Typography sx={{ color: c.text.muted, fontSize: '0.68rem', fontFamily: c.font.mono }}>{pDef?.type || 'any'}</Typography>
                {schemaRequired.includes(pName) && <Chip label="required" size="small" sx={{ bgcolor: `${c.status.error}12`, color: c.status.error, fontSize: '0.55rem', height: 14, '& .MuiChip-label': { px: 0.4 } }} />}
                {pDef?.description && <Typography sx={{ color: c.text.ghost, fontSize: '0.68rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pDef.description}</Typography>}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  });

  const svcKey = `${tool.id}:${serviceName}`;
  const isOpen = expandedServices[svcKey] ?? false;
  const allNames = [...(data.read || []), ...(data.write || [])];
  const svcPolicy = getGroupPolicy(allNames);
  const count = allNames.length;
  const isReddit =
    ig?.id === 'reddit' ||
    tool.name?.toLowerCase() === 'reddit' ||
    (tool.command || '').toLowerCase().includes('reddit');
  const isYoutube =
    ig?.id === 'youtube' ||
    tool.name?.toLowerCase() === 'youtube' ||
    (tool.command || '').toLowerCase().includes('youtube');
  const isSubredditsForReddit =
    isReddit && /subreddit/i.test(serviceName);
  // YouTube marker lands on the first service group since YouTube has no drill-down.
  const showPermissionMarker =
    isSubredditsForReddit || (isYoutube && isFirstGroup);

  return (
      <Box sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: 1.5, overflow: 'hidden', '&:hover': { borderColor: `${c.border.medium}` } }}>
        <Box
          data-onboarding={isSubredditsForReddit ? 'actions-subreddits-chevron' : undefined}
          sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, cursor: 'pointer', bgcolor: isOpen ? c.bg.secondary : 'transparent', '&:hover': { bgcolor: c.bg.secondary } }}
          onClick={() => setExpandedServices((p) => ({ ...p, [svcKey]: !isOpen }))}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost, transition: 'transform 0.15s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
            <Typography sx={{ color: c.text.primary, fontSize: '0.85rem', fontWeight: 600 }}>{serviceName}</Typography>
            <Chip label={count} size="small" sx={{ bgcolor: c.bg.page, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
          </Box>
          <Box data-onboarding={showPermissionMarker ? 'actions-permission-toggle' : undefined}>
            <PermToggle value={svcPolicy === 'mixed' ? 'ask' : svcPolicy} onChange={(v) => handleGroupPermissionChange(tool.id, allNames, v)} />
          </Box>
        </Box>
        <Collapse in={isOpen} timeout={0} unmountOnExit>
          <Box sx={{ px: 1, pb: 1 }}>
            {(data.read?.length || 0) > 0 && (
              <Box sx={{ mt: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 0.5, py: 0.25 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <VisibilityIcon sx={{ fontSize: 12, color: c.status.info }} />
                    <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', fontWeight: 600 }}>Read-only</Typography>
                    <Chip label={data.read!.length} size="small" sx={{ bgcolor: c.bg.page, color: c.text.ghost, fontSize: '0.6rem', height: 14, '& .MuiChip-label': { px: 0.4 } }} />
                  </Box>
                  <PermToggle value={getGroupPolicy(data.read!) === 'mixed' ? 'ask' : getGroupPolicy(data.read!)} onChange={(v) => handleGroupPermissionChange(tool.id, data.read!, v)} size={14} />
                </Box>
                {renderActionList(data.read!)}
              </Box>
            )}
            {(data.write?.length || 0) > 0 && (
              <Box sx={{ mt: 0.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 0.5, py: 0.25 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <EditIcon sx={{ fontSize: 12, color: c.status.warning }} />
                    <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', fontWeight: 600 }}>Write / delete</Typography>
                    <Chip label={data.write!.length} size="small" sx={{ bgcolor: c.bg.page, color: c.text.ghost, fontSize: '0.6rem', height: 14, '& .MuiChip-label': { px: 0.4 } }} />
                  </Box>
                  <PermToggle value={getGroupPolicy(data.write!) === 'mixed' ? 'ask' : getGroupPolicy(data.write!)} onChange={(v) => handleGroupPermissionChange(tool.id, data.write!, v)} size={14} />
                </Box>
                {renderActionList(data.write!)}
              </Box>
            )}
          </Box>
        </Collapse>
      </Box>
  );
};

export default ServiceGroup;
