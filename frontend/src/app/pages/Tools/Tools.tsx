import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import Menu from '@mui/material/Menu';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import InputAdornment from '@mui/material/InputAdornment';
import Avatar from '@mui/material/Avatar';
import Switch from '@mui/material/Switch';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import TerminalIcon from '@mui/icons-material/Terminal';
import BuildIcon from '@mui/icons-material/Build';
import ExtensionIcon from '@mui/icons-material/Extension';
import DescriptionIcon from '@mui/icons-material/Description';
import SearchIcon from '@mui/icons-material/Search';
import QuestionAnswerIcon from '@mui/icons-material/QuestionAnswer';
import LockIcon from '@mui/icons-material/Lock';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import ScheduleIcon from '@mui/icons-material/Schedule';
import MapIcon from '@mui/icons-material/Map';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import StorefrontIcon from '@mui/icons-material/Storefront';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DownloadIcon from '@mui/icons-material/Download';
import StarIcon from '@mui/icons-material/Star';
import SortIcon from '@mui/icons-material/Sort';
import CloudIcon from '@mui/icons-material/Cloud';
import PublicIcon from '@mui/icons-material/Public';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import { useAppDispatch, useAppSelector } from '@/shared/hooks';
import LinkIcon from '@mui/icons-material/Link';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import SettingsIcon from '@mui/icons-material/Settings';
import BlockIcon from '@mui/icons-material/Block';
import VisibilityIcon from '@mui/icons-material/Visibility';
import SecurityIcon from '@mui/icons-material/Security';
import PanToolIcon from '@mui/icons-material/PanTool';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import RefreshIcon from '@mui/icons-material/Refresh';
import {
  fetchTools,
  fetchBuiltinTools,
  fetchBuiltinPermissions,
  updateBuiltinPermissions,
  createTool,
  updateTool,
  deleteTool,
  startOAuth,
  fetchToolStatus,
  discoverTools,
  startDeviceCodeLogin,
  pollDeviceCodeStatus,
  disconnectM365,
  ToolDefinition,
  BuiltinTool,
} from '@/shared/state/toolsSlice';
import {
  searchRegistry,
  fetchRegistryStats,
  fetchServerDetail,
  clearDetail,
  McpServer,
} from '@/shared/state/mcpRegistrySlice';
import {
  fetchOutputs,
  updateOutput,
  Output,
} from '@/shared/state/outputsSlice';

import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';
import ViewQuiltIcon from '@mui/icons-material/ViewQuilt';

interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  helpText?: string;
}

interface Integration {
  id: string;
  name: string;
  description: string;
  mcp_config: Record<string, any>;
  color: string;
  website: string;
  icon: React.ReactNode;
  credentialFields?: CredentialField[];
  connectLabel?: string;
  connectInstructions?: string;
  authType?: 'none' | 'oauth2' | 'env_vars';
}

const INTEGRATIONS: Integration[] = [
  {
    id: 'xbird',
    name: 'xbird',
    description: 'Twitter/X research — search tweets, read profiles, threads, timelines.',
    mcp_config: { type: 'stdio', command: 'bunx', args: ['@checkra1n/xbird'] },
    color: '#1DA1F2',
    website: 'https://xbird.dev',
    icon: '𝕏',
    connectLabel: 'Connect 𝕏',
    connectInstructions: 'Open x.com in your browser, press F12 → Application → Cookies → x.com, and copy the values for auth_token and ct0.',
    credentialFields: [
      { key: 'TWITTER_AUTH_TOKEN', label: 'auth_token', placeholder: 'Paste auth_token cookie value' },
      { key: 'TWITTER_CT0', label: 'ct0', placeholder: 'Paste ct0 cookie value' },
    ],
  },
  {
    id: 'reddit',
    name: 'Reddit',
    description: 'Browse subreddits, search posts, get post details, analyze users. No API keys required.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', 'reddit-mcp-buddy'] },
    color: '#FF4500',
    website: 'https://www.npmjs.com/package/reddit-mcp-buddy',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <circle cx="12" cy="12" r="12" fill="#FF4500"/>
        <path d="M19.5 12c0-.6-.5-1.1-1.1-1.1-.3 0-.6.1-.8.3-1-.7-2.3-1.1-3.7-1.1l.6-3 2.1.5c0 .6.5 1.1 1.1 1.1.6 0 1.1-.5 1.1-1.1 0-.6-.5-1.1-1.1-1.1-.4 0-.8.3-1 .6l-2.3-.5c-.1 0-.2 0-.2.1l-.7 3.3c-1.4 0-2.7.4-3.7 1.1-.2-.2-.5-.3-.8-.3-.6 0-1.1.5-1.1 1.1 0 .4.2.8.6 1-.1.3-.1.6-.1.9 0 2.3 2.6 4.1 5.8 4.1s5.8-1.8 5.8-4.1c0-.3 0-.6-.1-.9.4-.2.6-.6.6-1zm-9.8 1.1c0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1-.6 0-1.1-.5-1.1-1.1zm6.2 2.9c-.8.8-2 .9-2.9.9s-2.1-.1-2.9-.9c-.1-.1-.1-.3 0-.4.1-.1.3-.1.4 0 .6.6 1.6.8 2.5.8s1.9-.2 2.5-.8c.1-.1.3-.1.4 0 .1.1.1.3 0 .4zm-.2-1.8c-.6 0-1.1-.5-1.1-1.1 0-.6.5-1.1 1.1-1.1.6 0 1.1.5 1.1 1.1 0 .6-.5 1.1-1.1 1.1z" fill="#fff"/>
      </svg>
    ),
  },
  {
    id: 'youtube',
    name: 'YouTube',
    description: 'Get video transcripts, details, comments, search videos, and channel stats. Transcripts work with no API key.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@kirbah/mcp-youtube'] },
    color: '#FF0000',
    website: 'https://www.npmjs.com/package/@kirbah/mcp-youtube',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814z" fill="#FF0000"/>
        <path d="M9.545 15.568V8.432L15.818 12l-6.273 3.568z" fill="#fff"/>
      </svg>
    ),
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Including Google Docs, Sheets, Slides, Calendar, and Gmail. (Gemini CLI extension)',
    mcp_config: { type: 'stdio', command: 'uvx', args: ['--from', 'google-workspace-mcp', 'google-workspace-worker'] },
    color: '#4285F4',
    website: 'https://developers.google.com/gemini-api/docs/mcp',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
    ),
    authType: 'oauth2',
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    description: 'Outlook email, Calendar, OneDrive, Excel, OneNote, Tasks, Contacts, Teams, and SharePoint.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@softeria/ms-365-mcp-server'] },
    color: '#0078D4',
    website: 'https://www.npmjs.com/package/@softeria/ms-365-mcp-server',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M11.4 24H0V12.6L11.4 24zM24 24H12.6V12.6L24 24zM11.4 11.4H0V0l11.4 11.4zM24 11.4H12.6V0L24 11.4z" fill="#0078D4"/>
      </svg>
    ),
    authType: 'device_code' as any,
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Create, read, and update pages, databases, and blocks in Notion workspaces.',
    mcp_config: { type: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] },
    color: '#000000',
    website: 'https://www.npmjs.com/package/@notionhq/notion-mcp-server',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M4.46 2.95c.53.43.73.4 1.73.33l9.4-.57c.2 0 .03-.2-.03-.23l-1.57-1.13c-.3-.23-.7-.5-1.47-.43L3.3 1.78c-.5.07-.6.33-.4.53l1.56 1.13v.51zM5.03 6.15v9.93c0 .53.27.73.87.7l10.33-.6c.6-.03.67-.4.67-.83V5.52c0-.43-.17-.63-.53-.6l-10.8.63c-.4.03-.54.2-.54.6zM14.93 6.63c.07.3 0 .6-.3.63l-.5.1v7.33c-.43.23-.83.37-1.17.37-.53 0-.67-.17-1.07-.67l-3.27-5.13v4.97l1.03.23s0 .6-.83.6l-2.3.13c-.07-.13 0-.47.23-.53l.6-.17V8.33l-.83-.07c-.07-.3.1-.73.57-.77l2.47-.17 3.4 5.2V8.6l-.87-.1c-.07-.37.2-.63.53-.67l2.3-.2zM2.57 1.28L11.93.28c1.17-.1 1.47-.03 2.2.5l3.03 2.13c.5.37.67.47.67.87v15.27c0 .63-.23 1-.87 1.07l-10.7.63c-.5.03-.73-.07-.97-.37L2.73 17.3c-.27-.33-.4-.6-.4-1.03V2.15c0-.53.23-.83.83-.87h-.59z" fill="#000"/>
      </svg>
    ),
    authType: 'oauth2',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Read and write records, manage bases, tables, and fields in Airtable.',
    mcp_config: { type: 'http', url: 'https://mcp.airtable.com/mcp' },
    color: '#18BFFF',
    website: 'https://airtable.com/developers/web/api/introduction',
    icon: (
      <svg viewBox="0 0 24 24" width="22" height="22">
        <path d="M11.52 1.28L2.1 5.13c-.28.12-.28.52 0 .64l9.5 3.9c.25.1.53.1.78 0l9.5-3.9c.28-.12.28-.52 0-.64l-9.5-3.85c-.25-.1-.53-.1-.78 0z" fill="#FCB400"/>
        <path d="M12.76 11.24v9.47c0 .3.32.5.58.38l9.3-4.32c.16-.07.26-.23.26-.4V6.9c0-.3-.32-.5-.58-.38l-9.3 4.32c-.16.07-.26.23-.26.4z" fill="#18BFFF"/>
        <path d="M11.24 11.24v9.47c0 .3-.32.5-.58.38L1.1 16.77c-.16-.07-.26-.23-.26-.4V6.9c0-.3.32-.5.58-.38l9.56 4.32c.16.07.26.23.26.4z" fill="#F82B60"/>
        <path d="M11.24 11.12L1.66 6.78l-.56.26 9.56 4.32c.16.07.34.07.5.02l.08-.26z" fill="#751AFF" opacity=".25"/>
      </svg>
    ),
    authType: 'oauth2',
  },
];

const CATEGORY_ORDER = ['filesystem', 'system', 'search', 'interaction', 'agents', 'planning', 'scheduling'];

interface ToolForm {
  name: string;
  description: string;
  command: string;
}

const emptyForm: ToolForm = {
  name: '',
  description: '',
  command: '',
};

function cleanServerName(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1];
}

function serverToToolForm(srv: McpServer): ToolForm {
  return {
    name: srv.title || cleanServerName(srv.name),
    description: srv.description,
    command: '',
  };
}

function serverToMcpConfig(srv: McpServer): Record<string, any> {
  if (srv.remoteUrl) {
    return { type: srv.remoteType === 'sse' ? 'sse' : 'http', url: srv.remoteUrl };
  }
  if (srv.repositoryUrl && srv.repositoryUrl.includes('github.com')) {
    const match = srv.repositoryUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/|$)/);
    if (match) {
      return { type: 'stdio', command: 'npx', args: ['-y', `github:${match[1]}`] };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// ToolSection (reusable for Core / Extended built-in tool groups)
// ---------------------------------------------------------------------------

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
  };

  const PermToggle = ({ value, onChange, size = 16 }: { value: string; onChange: (v: string) => void; size?: number }) => (
    <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
      <Tooltip title="Always allow"><IconButton size="small" onClick={() => onChange('always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: value === 'always_allow' ? `${c.status.success}20` : 'transparent', color: value === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: size }} /></IconButton></Tooltip>
      <Tooltip title="Ask permission"><IconButton size="small" onClick={() => onChange('ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: value === 'ask' ? `${c.status.warning}20` : 'transparent', color: value === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: size }} /></IconButton></Tooltip>
      <Tooltip title="Always deny"><IconButton size="small" onClick={() => onChange('deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: value === 'deny' ? `${c.status.error}20` : 'transparent', color: value === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: size }} /></IconButton></Tooltip>
    </Box>
  );

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
    ? 'On-demand actions loaded via ToolSearch for planning, scheduling, and extended operations'
    : 'Built-in Claude Agent SDK actions for file operations, shell commands, and search';

  const firstSentence = (desc: string) => {
    if (!desc) return '';
    const match = desc.match(/^(.+?(?:\.|$))/);
    return match ? match[1].trim() : desc.substring(0, 100);
  };

  return (
  <Card sx={{ bgcolor: c.bg.surface, border: `1px solid ${open && enabled ? c.accent.primary : c.border.subtle}`, borderRadius: 2, boxShadow: c.shadow.sm, '&:hover': { borderColor: c.accent.primary, boxShadow: '0 0 0 1px rgba(174,86,48,0.12)' }, transition: 'border-color 0.2s, box-shadow 0.2s' }}>
    <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
      <Box
        onClick={() => enabled && onToggle()}
        sx={{ display: 'flex', alignItems: 'center', gap: 2, cursor: enabled ? 'pointer' : 'default' }}
      >
        <Box sx={{
          width: 36, height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
          bgcolor: c.bg.secondary, color: c.text.tertiary, flexShrink: 0,
          opacity: enabled ? 1 : 0.4, transition: 'opacity 0.2s',
        }}>
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, opacity: enabled ? 1 : 0.4, transition: 'opacity 0.2s' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem' }}>{label}</Typography>
            <Chip label={`${count} actions`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 20, '& .MuiChip-label': { px: 0.6 } }} />
            {deferred && (
              <Chip label="on-demand" size="small" sx={{ bgcolor: c.status.warningBg, color: c.status.warning, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
            )}
          </Box>
          <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>{sectionDescription}</Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={enabled}
            onChange={(_, checked) => onEnabledChange(checked)}
            sx={{
              '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
            }}
          />
        </Box>
        {enabled && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
            <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.ghost, transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} />
          </Box>
        )}
      </Box>
    </CardContent>
    <Collapse in={open && enabled}>
      <Box sx={{ px: 2, pb: 2, pt: 0, borderTop: `1px solid ${c.border.subtle}` }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5, mb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <SecurityIcon sx={{ fontSize: 14, color: c.text.muted }} />
            <Typography sx={{ color: c.text.muted, fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Action Permissions</Typography>
            <Chip label={`${count} actions`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, ml: 0.5, '& .MuiChip-label': { px: 0.6 } }} />
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
                    <Typography sx={{ color: c.text.primary, fontSize: '0.85rem', fontWeight: 600 }}>{meta.label}</Typography>
                    <Chip label={catTools.length} size="small" sx={{ bgcolor: c.bg.page, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                  </Box>
                  <PermToggle value={catPolicy === 'mixed' ? 'ask' : catPolicy} onChange={(v) => onCategoryPermissionChange(catTools.map((t) => t.name), v)} />
                </Box>
                <Collapse in={isOpen}>
                  <Box sx={{ px: 1, pb: 1 }}>
                    {catTools.map((bt) => {
                      const toolPolicy = builtinPermissions[bt.name] || 'always_allow';
                      return (
                        <Box key={bt.name} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.4, px: 1.5, borderRadius: 1, '&:hover': { bgcolor: c.bg.secondary } }}>
                          <Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
                            <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500 }}>{bt.display_name || bt.name}</Typography>
                            {bt.description && <Typography sx={{ color: c.text.ghost, fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{firstSentence(bt.description)}</Typography>}
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

// ---------------------------------------------------------------------------
// Main Tools Page
// ---------------------------------------------------------------------------

const Tools: React.FC = () => {
  const c = useClaudeTokens();
  const dispatch = useAppDispatch();
  const { items, builtinTools, builtinPermissions, loading } = useAppSelector((s) => s.tools);
  const { servers: regServers, total: regTotal, loading: regLoading, stats: regStats, detail: regDetail, detailLoading: regDetailLoading } = useAppSelector((s) => s.mcpRegistry);
  const devMode = useAppSelector((s) => s.settings.data.dev_mode);
  const outputItems = useAppSelector((s) => s.outputs.items);
  const outputs = useMemo(() => Object.values(outputItems), [outputItems]);
  const allTools = Object.values(items);
  const tools = allTools;
  const uninstalledIntegrations = useMemo(() => INTEGRATIONS.filter((ig) => !allTools.find((t) => t.name === ig.name)), [allTools]);
  const getIntegrationForTool = useCallback((tool: ToolDefinition) => INTEGRATIONS.find((ig) => ig.name === tool.name), []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ToolForm>(emptyForm);

  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>(
    Object.fromEntries([
      ...CATEGORY_ORDER.map((cat) => [cat, true]),
      ...CATEGORY_ORDER.map((cat) => [`d_${cat}`, true]),
    ]),
  );
  const [expandedBuiltin, setExpandedBuiltin] = useState<string | null>(null);
  const [coreSectionOpen, setCoreSectionOpen] = useState(false);
  const [deferredSectionOpen, setDeferredSectionOpen] = useState(false);
  const [customSectionOpen, setCustomSectionOpen] = useState(true);

  // Dropdown menu
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);

  // Registry browser
  const [registryOpen, setRegistryOpen] = useState(false);
  const [regQuery, setRegQuery] = useState('');
  const [regSort, setRegSort] = useState<'name' | 'stars'>('stars');
  const [regSource, setRegSource] = useState<'' | 'community' | 'google'>('');
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity?: 'success' | 'error' }>({ open: false, message: '' });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // MCP config dialog state
  const [mcpConfigOpen, setMcpConfigOpen] = useState(false);
  const [mcpConfigServer, setMcpConfigServer] = useState<McpServer | null>(null);
  const [mcpAuthType, setMcpAuthType] = useState<'none' | 'env_vars'>('none');
  const [mcpCredentials, setMcpCredentials] = useState<Record<string, string>>({});
  const [mcpConfigJson, setMcpConfigJson] = useState('');
  const [mcpConfigError, setMcpConfigError] = useState('');

  // Expanded MCP tool permissions state
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);

  // Integration toggle state
  const [integrationLoading, setIntegrationLoading] = useState<Record<string, boolean>>({});

  // Device code login dialog state (M365)
  const [deviceCodeDialogOpen, setDeviceCodeDialogOpen] = useState(false);
  const [deviceCodeDialogToolId, setDeviceCodeDialogToolId] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState('');
  const [deviceCodeUrl, setDeviceCodeUrl] = useState('');
  const [deviceCodeStatus, setDeviceCodeStatus] = useState<'loading' | 'awaiting' | 'connected' | 'error'>('loading');

  // Integration credentials dialog state
  const [credDialogOpen, setCredDialogOpen] = useState(false);
  const [credDialogToolId, setCredDialogToolId] = useState<string | null>(null);
  const [credDialogIntegration, setCredDialogIntegration] = useState<Integration | null>(null);
  const [credDialogValues, setCredDialogValues] = useState<Record<string, string>>({});
  const [credDialogSaving, setCredDialogSaving] = useState(false);

  const getInstalledIntegration = useCallback((integration: Integration): ToolDefinition | undefined => {
    return allTools.find((t) => t.name === integration.name);
  }, [allTools]);

  const handleIntegrationToggle = async (integration: Integration) => {
    const existing = getInstalledIntegration(integration);
    setIntegrationLoading((p) => ({ ...p, [integration.id]: true }));
    try {
      if (existing && existing.enabled !== false) {
        await dispatch(updateTool({ id: existing.id, enabled: false }));
        setSnackbar({ open: true, message: `Disabled ${integration.name}` });
      } else if (existing && existing.enabled === false) {
        await dispatch(updateTool({ id: existing.id, enabled: true }));
        if (integration.authType === 'oauth2' && existing.auth_status !== 'connected') {
          setSnackbar({ open: true, message: `Enabled ${integration.name} — connect your account to discover actions` });
        } else {
          setSnackbar({ open: true, message: `Enabled ${integration.name} — re-discovering actions…` });
          const discoverResult = await dispatch(discoverTools(existing.id));
          if (discoverTools.fulfilled.match(discoverResult)) {
            setSnackbar({ open: true, message: `${integration.name} ready — actions discovered` });
          } else {
            setSnackbar({ open: true, message: `${integration.name} enabled but discovery failed`, severity: 'error' });
          }
        }
      } else {
        const result = await dispatch(createTool({
          name: integration.name,
          description: integration.description,
          command: '',
          mcp_config: integration.mcp_config,
          credentials: {},
          auth_type: integration.authType || 'none',
          auth_status: 'configured',
        }));
        if (createTool.fulfilled.match(result)) {
          const newTool = result.payload;
          if (integration.authType === 'oauth2' || integration.authType === 'device_code') {
            setSnackbar({ open: true, message: `Enabled ${integration.name} — connect your account to discover actions` });
          } else {
            setSnackbar({ open: true, message: `Enabled ${integration.name} — discovering actions…` });
            const discoverResult = await dispatch(discoverTools(newTool.id));
            if (discoverTools.fulfilled.match(discoverResult)) {
              setSnackbar({ open: true, message: `${integration.name} ready — actions discovered` });
            } else {
              setSnackbar({ open: true, message: `${integration.name} enabled but discovery failed — is ${integration.mcp_config.command || 'the server'} installed?`, severity: 'error' });
            }
          }
        }
      }
    } finally {
      setIntegrationLoading((p) => ({ ...p, [integration.id]: false }));
    }
  };

  const handleDiscover = async (toolId: string) => {
    setDiscovering(true);
    try {
      const result = await dispatch(discoverTools(toolId));
      if (discoverTools.fulfilled.match(result)) {
        setSnackbar({ open: true, message: 'Actions discovered successfully' });
      } else {
        const detail = (result as any).error?.message || 'Discovery failed — is the MCP server running?';
        setSnackbar({ open: true, message: detail, severity: 'error' });
      }
    } finally {
      setDiscovering(false);
    }
  };

  const handlePermissionChange = async (toolId: string, toolName: string, policy: string) => {
    const tool = items[toolId];
    if (!tool) return;
    const updated = { ...tool.tool_permissions, [toolName]: policy };
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleGroupPermissionChange = async (toolId: string, names: string[], policy: string) => {
    const tool = items[toolId];
    if (!tool) return;
    const updated = { ...tool.tool_permissions };
    for (const name of names) updated[name] = policy;
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleBulkReadOnly = async (toolId: string) => {
    const tool = items[toolId];
    if (!tool?.tool_permissions?._categories) return;
    const readNames: string[] = tool.tool_permissions._categories.read || [];
    const updated = { ...tool.tool_permissions };
    for (const name of readNames) updated[name] = 'always_allow';
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const handleResetPermissions = async (toolId: string) => {
    const tool = items[toolId];
    if (!tool?.tool_permissions) return;
    const updated = { ...tool.tool_permissions };
    for (const key of Object.keys(updated)) {
      if (!key.startsWith('_')) updated[key] = 'ask';
    }
    await dispatch(updateTool({ id: toolId, tool_permissions: updated }));
  };

  const [expandedServices, setExpandedServices] = useState<Record<string, boolean>>({});
  const [expandedSchema, setExpandedSchema] = useState<string | null>(null);

  const [viewsSectionOpen, setViewsSectionOpen] = useState(false);
  const [browserSectionOpen, setBrowserSectionOpen] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState<Record<string, boolean>>({ browser_delegation: true, browser_action: true });
  const [builtinSectionOpen, setBuiltinSectionOpen] = useState(true);

  useEffect(() => {
    dispatch(fetchTools());
    dispatch(fetchBuiltinTools());
    dispatch(fetchBuiltinPermissions());
    dispatch(fetchOutputs());
  }, [dispatch]);

  const handleViewPermissionChange = async (viewId: string, permission: string) => {
    await dispatch(updateOutput({ id: viewId, permission }));
  };

  const handleBuiltinPermissionChange = async (toolName: string, policy: string) => {
    await dispatch(updateBuiltinPermissions({ [toolName]: policy }));
  };

  const handleBuiltinCategoryPermissionChange = async (toolNames: string[], policy: string) => {
    const perms: Record<string, string> = {};
    for (const name of toolNames) perms[name] = policy;
    await dispatch(updateBuiltinPermissions(perms));
  };

  // Built-in tool grouping
  const BROWSER_CATEGORIES = new Set(['browser_delegation', 'browser_action']);
  const coreTools = useMemo(() => builtinTools.filter((bt) => !bt.deferred && !BROWSER_CATEGORIES.has(bt.category)), [builtinTools]);
  const deferredTools = useMemo(() => builtinTools.filter((bt) => bt.deferred && !BROWSER_CATEGORIES.has(bt.category)), [builtinTools]);
  const browserTools = useMemo(() => builtinTools.filter((bt) => BROWSER_CATEGORIES.has(bt.category)), [builtinTools]);
  const browserDelegationTools = useMemo(() => browserTools.filter((bt) => bt.category === 'browser_delegation'), [browserTools]);
  const browserActionTools = useMemo(() => browserTools.filter((bt) => bt.category === 'browser_action'), [browserTools]);
  const groupTools = (list: BuiltinTool[]) => {
    const g: Record<string, BuiltinTool[]> = {};
    for (const bt of list) { if (!g[bt.category]) g[bt.category] = []; g[bt.category].push(bt); }
    return g;
  };
  const groupedCore = useMemo(() => groupTools(coreTools), [coreTools]);
  const groupedDeferred = useMemo(() => groupTools(deferredTools), [deferredTools]);

  const coreSectionEnabled = useMemo(
    () => !coreTools.every((t) => builtinPermissions[t.name] === 'deny'),
    [coreTools, builtinPermissions],
  );
  const deferredSectionEnabled = useMemo(
    () => !deferredTools.every((t) => builtinPermissions[t.name] === 'deny'),
    [deferredTools, builtinPermissions],
  );
  const viewsSectionEnabled = useMemo(
    () => !outputs.every((o) => o.permission === 'deny'),
    [outputs],
  );
  const browserSectionEnabled = useMemo(
    () => browserTools.length > 0 && !browserTools.every((t) => builtinPermissions[t.name] === 'deny'),
    [browserTools, builtinPermissions],
  );

  const handleSectionEnabledChange = async (tools: BuiltinTool[], enabled: boolean) => {
    const perms: Record<string, string> = {};
    for (const t of tools) perms[t.name] = enabled ? 'always_allow' : 'deny';
    await dispatch(updateBuiltinPermissions(perms));
  };

  const handleViewsSectionEnabledChange = async (enabled: boolean) => {
    for (const out of outputs) {
      await dispatch(updateOutput({ id: out.id, permission: enabled ? 'ask' : 'deny' }));
    }
  };

  const toggleCategory = (cat: string) => setCollapsedCategories((p) => ({ ...p, [cat]: !p[cat] }));
  const toggleBuiltinExpand = (name: string) => setExpandedBuiltin((p) => (p === name ? null : name));

  // --------------- Dropdown handlers ---------------

  const handleMenuOpen = (e: React.MouseEvent<HTMLElement>) => setMenuAnchor(e.currentTarget);
  const handleMenuClose = () => setMenuAnchor(null);

  const openCreate = () => {
    handleMenuClose();
    setEditingId(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openRegistryBrowser = () => {
    handleMenuClose();
    setRegistryOpen(true);
    setRegQuery('');
    setRegSort('stars');
    setRegSource('');
    setExpandedServer(null);
    dispatch(fetchRegistryStats());
    dispatch(searchRegistry({ q: '', limit: 20, offset: 0, sort: 'stars', source: '' }));
  };

  // --------------- Tool CRUD ---------------

  const openEdit = (tool: ToolDefinition) => {
    setEditingId(tool.id);
    setForm({ name: tool.name, description: tool.description, command: tool.command });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const payload = { name: form.name, description: form.description, command: form.command };
    if (editingId) { await dispatch(updateTool({ id: editingId, ...payload })); } else { await dispatch(createTool(payload)); }
    setDialogOpen(false);
  };

  const handleDelete = async (id: string) => { await dispatch(deleteTool(id)); };

  // --------------- Registry browser ---------------

  const handleRegSearch = useCallback((q: string, sort?: 'name' | 'stars', source?: '' | 'community' | 'google') => {
    setRegQuery(q);
    setExpandedServer(null);
    const sortVal = sort ?? regSort;
    const sourceVal = source ?? regSource;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      dispatch(searchRegistry({ q, limit: 20, offset: 0, sort: sortVal, source: sourceVal }));
    }, 300);
  }, [dispatch, regSort, regSource]);

  const handleLoadMore = () => {
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: regServers.length, sort: regSort, source: regSource }));
  };

  const handleRegSort = (sort: 'name' | 'stars') => {
    setRegSort(sort);
    setExpandedServer(null);
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: 0, sort, source: regSource }));
  };

  const handleRegSourceFilter = (_: React.MouseEvent<HTMLElement>, val: '' | 'community' | 'google') => {
    if (val === null) return;
    setRegSource(val);
    setExpandedServer(null);
    dispatch(searchRegistry({ q: regQuery, limit: 20, offset: 0, sort: regSort, source: val }));
  };

  const openMcpConfigDialog = (srv: McpServer) => {
    setMcpConfigServer(srv);
    setMcpAuthType('none');
    setMcpCredentials({});
    const derivedConfig = serverToMcpConfig(srv);
    setMcpConfigJson(JSON.stringify(
      Object.keys(derivedConfig).length > 0 ? derivedConfig : {},
      null, 2,
    ));
    setMcpConfigError('');
    setMcpConfigOpen(true);
  };

  const handleMcpConfigSave = async () => {
    if (!mcpConfigServer) return;
    let parsedConfig: Record<string, any> = {};
    try { parsedConfig = JSON.parse(mcpConfigJson); } catch { setMcpConfigError('Invalid JSON'); return; }

    const f = serverToToolForm(mcpConfigServer);
    const authStatus = 'configured';

    await dispatch(createTool({
      name: f.name,
      description: f.description,
      command: '',
      mcp_config: parsedConfig,
      credentials: mcpCredentials,
      auth_type: mcpAuthType,
      auth_status: authStatus,
    }));

    setMcpConfigOpen(false);
    setSnackbar({ open: true, message: `Installed "${f.name}" as MCP tool` });
  };

  const handleInstall = async (srv: McpServer) => {
    const f = serverToToolForm(srv);
    const mcpConfig = serverToMcpConfig(srv);
    const hasConfig = Object.keys(mcpConfig).length > 0;

    if (srv.source === 'google' && srv.remoteUrl && hasConfig) {
      await dispatch(createTool({
        name: f.name,
        description: f.description,
        command: '',
        mcp_config: mcpConfig,
        credentials: {},
        auth_type: 'oauth2',
        auth_status: 'configured',
      }));
      setSnackbar({ open: true, message: `Installed "${f.name}" — click "Connect Google" to authorize` });
    } else if (hasConfig && mcpConfig.type === 'stdio') {
      const result = await dispatch(createTool({
        name: f.name,
        description: f.description,
        command: '',
        mcp_config: mcpConfig,
        credentials: {},
        auth_type: 'none',
        auth_status: 'configured',
      }));
      if (createTool.fulfilled.match(result)) {
        const newTool = result.payload;
        setSnackbar({ open: true, message: `Installed "${f.name}" — discovering actions…` });
        const discoverResult = await dispatch(discoverTools(newTool.id));
        if (discoverTools.fulfilled.match(discoverResult)) {
          setSnackbar({ open: true, message: `${f.name} ready — actions discovered` });
        } else {
          setSnackbar({ open: true, message: `${f.name} installed but discovery failed — the MCP server may need setup first`, severity: 'error' });
        }
      }
    } else {
      openMcpConfigDialog(srv);
    }
  };

  const handleEditInstall = (srv: McpServer) => {
    setRegistryOpen(false);
    const f = serverToToolForm(srv);
    setEditingId(null);
    setForm(f);
    setDialogOpen(true);
  };

  const handleOAuthConnect = async (toolId: string) => {
    const result = await dispatch(startOAuth(toolId));
    if (startOAuth.fulfilled.match(result)) {
      const { auth_url } = result.payload;
      const popup = window.open(auth_url, 'oauth', 'width=500,height=700,left=200,top=100');

      const afterConnect = async () => {
        const statusResult = await dispatch(fetchToolStatus(toolId));
        if (fetchToolStatus.fulfilled.match(statusResult) && statusResult.payload.auth_status === 'connected') {
          setSnackbar({ open: true, message: 'Account connected! Discovering actions…' });
          setExpandedToolId(toolId);
          dispatch(discoverTools(toolId));
        } else {
          setSnackbar({ open: true, message: 'Account connected!' });
        }
      };

      const onMessage = (event: MessageEvent) => {
        if (event.data?.type === 'oauth_complete' && event.data?.tool_id === toolId) {
          afterConnect();
          window.removeEventListener('message', onMessage);
        }
      };
      window.addEventListener('message', onMessage);

      const pollInterval = setInterval(() => {
        if (popup?.closed) {
          clearInterval(pollInterval);
          afterConnect();
          window.removeEventListener('message', onMessage);
        }
      }, 1000);
    } else {
      setSnackbar({ open: true, message: 'OAuth failed — check that OAuth credentials are set in backend .env', severity: 'error' });
    }
  };

  const handleDeviceCodeConnect = async (toolId: string) => {
    setDeviceCodeDialogToolId(toolId);
    setDeviceCodeStatus('loading');
    setDeviceCode('');
    setDeviceCodeUrl('');
    setDeviceCodeDialogOpen(true);

    const result = await dispatch(startDeviceCodeLogin(toolId));
    if (startDeviceCodeLogin.fulfilled.match(result)) {
      const { device_code, device_code_url } = result.payload;
      setDeviceCode(device_code);
      const url = device_code_url || 'https://login.microsoft.com/device';
      setDeviceCodeUrl(url);
      setDeviceCodeStatus('awaiting');

      // Auto-open Microsoft login in a popup
      window.open(url, 'm365-login', 'width=500,height=700,left=200,top=100');

      // Poll for completion
      const poll = setInterval(async () => {
        const statusResult = await dispatch(pollDeviceCodeStatus(toolId));
        if (pollDeviceCodeStatus.fulfilled.match(statusResult)) {
          const { status, email } = statusResult.payload;
          if (status === 'connected') {
            clearInterval(poll);
            setDeviceCodeStatus('connected');
            setSnackbar({ open: true, message: `Connected to Microsoft 365${email ? ` as ${email}` : ''}! Discovering actions…` });
            setDeviceCodeDialogOpen(false);
            setExpandedToolId(toolId);
            await dispatch(fetchToolStatus(toolId));
            dispatch(discoverTools(toolId));
          } else if (status === 'error') {
            clearInterval(poll);
            setDeviceCodeStatus('error');
          }
        }
      }, 2000);

      // Stop polling after 5 minutes
      setTimeout(() => clearInterval(poll), 300000);
    } else {
      setDeviceCodeStatus('error');
    }
  };

  const handleM365Disconnect = async (toolId: string) => {
    await dispatch(disconnectM365(toolId));
    setSnackbar({ open: true, message: 'Disconnected from Microsoft 365' });
  };

  const openCredentialsDialog = (toolId: string, integration: Integration) => {
    const tool = items[toolId];
    const existing = tool?.credentials || {};
    const initial: Record<string, string> = {};
    for (const field of integration.credentialFields || []) {
      initial[field.key] = existing[field.key] || '';
    }
    setCredDialogToolId(toolId);
    setCredDialogIntegration(integration);
    setCredDialogValues(initial);
    setCredDialogOpen(true);
  };

  const handleCredentialsSave = async () => {
    if (!credDialogToolId || !credDialogIntegration) return;
    const hasEmpty = (credDialogIntegration.credentialFields || []).some((f) => !credDialogValues[f.key]?.trim());
    if (hasEmpty) return;

    setCredDialogSaving(true);
    try {
      const result = await dispatch(updateTool({
        id: credDialogToolId,
        credentials: credDialogValues,
        auth_type: 'env_vars',
        auth_status: 'connected',
      }));
      if (updateTool.fulfilled.match(result)) {
        setCredDialogOpen(false);
        setSnackbar({ open: true, message: `${credDialogIntegration.name} connected! Re-discovering actions…` });
        dispatch(discoverTools(credDialogToolId));
      } else {
        setSnackbar({ open: true, message: 'Failed to save credentials', severity: 'error' });
      }
    } finally {
      setCredDialogSaving(false);
    }
  };

  const handleDisconnectIntegration = async (toolId: string, integration: Integration) => {
    if (integration.authType === 'oauth2') {
      // Revoke the token on Google's side (fire-and-forget)
      fetch(`${API_BASE}/tools/${toolId}/oauth/disconnect`, { method: 'POST' }).catch(() => {});
      // Clear OAuth state via the existing update endpoint
      const result = await dispatch(updateTool({
        id: toolId,
        oauth_tokens: {},
        auth_status: 'configured',
        connected_account_email: '',
      }));
      if (updateTool.fulfilled.match(result)) {
        setSnackbar({ open: true, message: `${integration.name} disconnected. You can now connect a different account.` });
      } else {
        setSnackbar({ open: true, message: `Failed to disconnect ${integration.name}`, severity: 'error' });
      }
    } else {
      await dispatch(updateTool({
        id: toolId,
        credentials: {},
        auth_type: 'none',
        auth_status: 'configured',
      }));
      setSnackbar({ open: true, message: `${integration.name} disconnected` });
    }
  };

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h5" sx={{ color: c.text.primary, fontWeight: 700, mb: 0.5 }}>Action Library</Typography>
          <Typography sx={{ color: c.text.tertiary, fontSize: '0.9rem' }}>Define and manage custom actions for your Claude Code agents.</Typography>
        </Box>
        <Box>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            endIcon={<KeyboardArrowDownIcon sx={{ fontSize: 18 }} />}
            onClick={handleMenuOpen}
            sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed }, textTransform: 'none', borderRadius: 2 }}
          >
            New Action
          </Button>
          <Menu
            anchorEl={menuAnchor}
            open={!!menuAnchor}
            onClose={handleMenuClose}
            PaperProps={{ sx: { bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 2, mt: 0.5, minWidth: 200 } }}
          >
            <MenuItem onClick={openCreate} sx={{ color: c.text.primary, fontSize: '0.88rem', gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
              <BuildIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
              Create Custom
            </MenuItem>
            <MenuItem onClick={openRegistryBrowser} sx={{ color: c.text.primary, fontSize: '0.88rem', gap: 1.5, '&:hover': { bgcolor: c.bg.secondary } }}>
              <StorefrontIcon sx={{ fontSize: 16, color: c.text.tertiary }} />
              Browse MCP Registry
            </MenuItem>
          </Menu>
        </Box>
      </Box>

      {/* Built-in Tool Sets */}
      <Box sx={{ mb: 3 }}>
        <Box
          onClick={() => setBuiltinSectionOpen((v) => !v)}
          sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1, cursor: 'pointer', userSelect: 'none', '&:hover .section-arrow': { color: c.text.secondary } }}
        >
          {builtinSectionOpen ? <KeyboardArrowDownIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} /> : <KeyboardArrowRightIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} />}
          <LockIcon sx={{ fontSize: 14, color: c.text.tertiary }} />
          <Typography sx={{ color: c.text.muted, fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Built-in Action Sets</Typography>
          <Chip label={coreTools.length + deferredTools.length + outputs.length + browserTools.length} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 18, minWidth: 24, '& .MuiChip-label': { px: 0.8 } }} />
        </Box>
        <Collapse in={builtinSectionOpen}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pl: 1 }}>

      {/* Core Tools */}
      {coreTools.length > 0 && (
        <ToolSection label="Core Actions" icon={<LockIcon sx={{ fontSize: 14, color: c.text.tertiary }} />} count={coreTools.length} open={coreSectionOpen} onToggle={() => setCoreSectionOpen((v) => !v)} grouped={groupedCore} collapsedCategories={collapsedCategories} toggleCategory={toggleCategory} expandedBuiltin={expandedBuiltin} toggleBuiltinExpand={toggleBuiltinExpand} builtinPermissions={builtinPermissions} onPermissionChange={handleBuiltinPermissionChange} onCategoryPermissionChange={handleBuiltinCategoryPermissionChange} enabled={coreSectionEnabled} onEnabledChange={(v) => handleSectionEnabledChange(coreTools, v)} />
      )}

      {/* Extended Tools */}
      {deferredTools.length > 0 && (
        <ToolSection label="Extended Actions" icon={<HourglassEmptyIcon sx={{ fontSize: 14, color: c.text.tertiary }} />} count={deferredTools.length} open={deferredSectionOpen} onToggle={() => setDeferredSectionOpen((v) => !v)} grouped={groupedDeferred} collapsedCategories={collapsedCategories} toggleCategory={toggleCategory} expandedBuiltin={expandedBuiltin} toggleBuiltinExpand={toggleBuiltinExpand} deferred builtinPermissions={builtinPermissions} onPermissionChange={handleBuiltinPermissionChange} onCategoryPermissionChange={handleBuiltinCategoryPermissionChange} enabled={deferredSectionEnabled} onEnabledChange={(v) => handleSectionEnabledChange(deferredTools, v)} />
      )}

      {/* Apps */}
      {outputs.length > 0 && (
        <Card sx={{ bgcolor: c.bg.surface, border: `1px solid ${viewsSectionOpen && viewsSectionEnabled ? c.accent.primary : c.border.subtle}`, borderRadius: 2, boxShadow: c.shadow.sm, '&:hover': { borderColor: c.accent.primary, boxShadow: '0 0 0 1px rgba(174,86,48,0.12)' }, transition: 'border-color 0.2s, box-shadow 0.2s' }}>
          <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
            <Box
              onClick={() => viewsSectionEnabled && setViewsSectionOpen((v) => !v)}
              sx={{ display: 'flex', alignItems: 'center', gap: 2, cursor: viewsSectionEnabled ? 'pointer' : 'default' }}
            >
              <Box sx={{
                width: 36, height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                bgcolor: c.bg.secondary, color: c.text.tertiary, flexShrink: 0,
                opacity: viewsSectionEnabled ? 1 : 0.4, transition: 'opacity 0.2s',
              }}>
                <ViewQuiltIcon sx={{ fontSize: 18 }} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0, opacity: viewsSectionEnabled ? 1 : 0.4, transition: 'opacity 0.2s' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                  <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem' }}>Apps</Typography>
                  <Chip label={`${outputs.length} app${outputs.length !== 1 ? 's' : ''}`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 20, '& .MuiChip-label': { px: 0.6 } }} />
                </Box>
                <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>Dashboard apps and data displays for your agent</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={viewsSectionEnabled}
                  onChange={(_, checked) => handleViewsSectionEnabledChange(checked)}
                  sx={{
                    '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
                    '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
                  }}
                />
              </Box>
              {viewsSectionEnabled && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
                  <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.ghost, transition: 'transform 0.2s', transform: viewsSectionOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                </Box>
              )}
            </Box>
          </CardContent>
          <Collapse in={viewsSectionOpen && viewsSectionEnabled}>
            <Box sx={{ px: 2, pb: 2, pt: 0, borderTop: `1px solid ${c.border.subtle}` }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1.5 }}>
                {outputs.map((out) => {
                  const perm = out.permission || 'ask';
                  return (
                    <Box
                      key={out.id}
                      sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.5, px: 1.5, borderRadius: 1, '&:hover': { bgcolor: c.bg.secondary } }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0, flex: 1, mr: 1 }}>
                        <Box sx={{
                          width: 28, height: 28, borderRadius: 1.5, flexShrink: 0,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          bgcolor: `${out.color}20`,
                        }}>
                          <ViewQuiltIcon sx={{ fontSize: 14, color: out.color }} />
                        </Box>
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500 }}>{out.name}</Typography>
                            <Chip label={out.category} size="small" sx={{ bgcolor: `${out.color}15`, color: out.color, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                          </Box>
                          {out.description && (
                            <Typography sx={{ color: c.text.ghost, fontSize: '0.7rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {out.description}
                            </Typography>
                          )}
                        </Box>
                      </Box>
                      <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                        <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleViewPermissionChange(out.id, 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: perm === 'always_allow' ? `${c.status.success}20` : 'transparent', color: perm === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                        <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleViewPermissionChange(out.id, 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: perm === 'ask' ? `${c.status.warning}20` : 'transparent', color: perm === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                        <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleViewPermissionChange(out.id, 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: perm === 'deny' ? `${c.status.error}20` : 'transparent', color: perm === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Collapse>
        </Card>
      )}

      {/* Browser */}
      {browserTools.length > 0 && (
        <Card sx={{ bgcolor: c.bg.surface, border: `1px solid ${browserSectionOpen && browserSectionEnabled ? c.accent.primary : c.border.subtle}`, borderRadius: 2, boxShadow: c.shadow.sm, '&:hover': { borderColor: c.accent.primary, boxShadow: '0 0 0 1px rgba(174,86,48,0.12)' }, transition: 'border-color 0.2s, box-shadow 0.2s' }}>
          <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
            <Box
              onClick={() => browserSectionEnabled && setBrowserSectionOpen((v) => !v)}
              sx={{ display: 'flex', alignItems: 'center', gap: 2, cursor: browserSectionEnabled ? 'pointer' : 'default' }}
            >
              <Box sx={{
                width: 36, height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                bgcolor: c.bg.secondary, color: c.text.tertiary, flexShrink: 0,
                opacity: browserSectionEnabled ? 1 : 0.4, transition: 'opacity 0.2s',
              }}>
                <PublicIcon sx={{ fontSize: 18 }} />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0, opacity: browserSectionEnabled ? 1 : 0.4, transition: 'opacity 0.2s' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                  <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem' }}>Browser</Typography>
                  <Chip label={`${browserTools.length} actions`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 20, '& .MuiChip-label': { px: 0.6 } }} />
                </Box>
                <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>Browser automation delegation and individual browser actions</Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={browserSectionEnabled}
                  onChange={(_, checked) => handleSectionEnabledChange(browserTools, checked)}
                  sx={{
                    '& .MuiSwitch-switchBase.Mui-checked': { color: c.accent.primary },
                    '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: c.accent.primary },
                  }}
                />
              </Box>
              {browserSectionEnabled && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
                  <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.ghost, transition: 'transform 0.2s', transform: browserSectionOpen ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                </Box>
              )}
            </Box>
          </CardContent>
          <Collapse in={browserSectionOpen && browserSectionEnabled}>
            <Box sx={{ px: 2, pb: 2, pt: 0, borderTop: `1px solid ${c.border.subtle}` }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5, mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  <SecurityIcon sx={{ fontSize: 14, color: c.text.muted }} />
                  <Typography sx={{ color: c.text.muted, fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Action Permissions</Typography>
                  <Chip label={`${browserTools.length} actions`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, ml: 0.5, '& .MuiChip-label': { px: 0.6 } }} />
                </Box>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                {/* Delegation group */}
                {browserDelegationTools.length > 0 && (() => {
                  const delegationPolicies = browserDelegationTools.map((t) => builtinPermissions[t.name] || 'always_allow');
                  const groupPolicy = delegationPolicies.every((p) => p === 'always_allow') ? 'always_allow'
                    : delegationPolicies.every((p) => p === 'deny') ? 'deny'
                    : delegationPolicies.every((p) => p === 'ask') ? 'ask' : 'ask';
                  const isOpen = !browserCollapsed.browser_delegation;
                  return (
                    <Box sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: 1.5, overflow: 'hidden', '&:hover': { borderColor: c.border.medium } }}>
                      <Box
                        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, cursor: 'pointer', bgcolor: isOpen ? c.bg.secondary : 'transparent', '&:hover': { bgcolor: c.bg.secondary } }}
                        onClick={() => setBrowserCollapsed((p) => ({ ...p, browser_delegation: !p.browser_delegation }))}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost, transition: 'transform 0.15s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                          <Typography sx={{ color: c.text.primary, fontSize: '0.85rem', fontWeight: 600 }}>Delegation</Typography>
                          <Chip label={browserDelegationTools.length} size="small" sx={{ bgcolor: c.bg.page, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                        </Box>
                        <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                          <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserDelegationTools.map((t) => t.name), 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'always_allow' ? `${c.status.success}20` : 'transparent', color: groupPolicy === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                          <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserDelegationTools.map((t) => t.name), 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'ask' ? `${c.status.warning}20` : 'transparent', color: groupPolicy === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                          <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserDelegationTools.map((t) => t.name), 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'deny' ? `${c.status.error}20` : 'transparent', color: groupPolicy === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                        </Box>
                      </Box>
                      <Collapse in={isOpen}>
                        <Box sx={{ px: 1, pb: 1 }}>
                          {browserDelegationTools.map((bt) => {
                            const toolPolicy = builtinPermissions[bt.name] || 'always_allow';
                            return (
                              <Box key={bt.name} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.4, px: 1.5, borderRadius: 1, '&:hover': { bgcolor: c.bg.secondary } }}>
                                <Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
                                  <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500 }}>{bt.display_name || bt.name}</Typography>
                                  {bt.description && <Typography sx={{ color: c.text.ghost, fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bt.description}</Typography>}
                                </Box>
                                <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                                  <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'always_allow' ? `${c.status.success}20` : 'transparent', color: toolPolicy === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                  <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'ask' ? `${c.status.warning}20` : 'transparent', color: toolPolicy === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                  <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'deny' ? `${c.status.error}20` : 'transparent', color: toolPolicy === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                </Box>
                              </Box>
                            );
                          })}
                        </Box>
                      </Collapse>
                    </Box>
                  );
                })()}

                {/* Browser Actions group */}
                {browserActionTools.length > 0 && (() => {
                  const actionPolicies = browserActionTools.map((t) => builtinPermissions[t.name] || 'always_allow');
                  const groupPolicy = actionPolicies.every((p) => p === 'always_allow') ? 'always_allow'
                    : actionPolicies.every((p) => p === 'deny') ? 'deny'
                    : actionPolicies.every((p) => p === 'ask') ? 'ask' : 'ask';
                  const isOpen = !browserCollapsed.browser_action;
                  return (
                    <Box sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: 1.5, overflow: 'hidden', '&:hover': { borderColor: c.border.medium } }}>
                      <Box
                        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, cursor: 'pointer', bgcolor: isOpen ? c.bg.secondary : 'transparent', '&:hover': { bgcolor: c.bg.secondary } }}
                        onClick={() => setBrowserCollapsed((p) => ({ ...p, browser_action: !p.browser_action }))}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost, transition: 'transform 0.15s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                          <Typography sx={{ color: c.text.primary, fontSize: '0.85rem', fontWeight: 600 }}>Browser Actions</Typography>
                          <Chip label={browserActionTools.length} size="small" sx={{ bgcolor: c.bg.page, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                        </Box>
                        <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                          <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserActionTools.map((t) => t.name), 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'always_allow' ? `${c.status.success}20` : 'transparent', color: groupPolicy === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                          <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserActionTools.map((t) => t.name), 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'ask' ? `${c.status.warning}20` : 'transparent', color: groupPolicy === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                          <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleBuiltinCategoryPermissionChange(browserActionTools.map((t) => t.name), 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: groupPolicy === 'deny' ? `${c.status.error}20` : 'transparent', color: groupPolicy === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                        </Box>
                      </Box>
                      <Collapse in={isOpen}>
                        <Box sx={{ px: 1, pb: 1 }}>
                          {browserActionTools.map((bt) => {
                            const toolPolicy = builtinPermissions[bt.name] || 'always_allow';
                            return (
                              <Box key={bt.name} sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', py: 0.4, px: 1.5, borderRadius: 1, '&:hover': { bgcolor: c.bg.secondary } }}>
                                <Box sx={{ minWidth: 0, flex: 1, mr: 1 }}>
                                  <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500 }}>{bt.display_name || bt.name}</Typography>
                                  {bt.description && <Typography sx={{ color: c.text.ghost, fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bt.description}</Typography>}
                                </Box>
                                <Box sx={{ display: 'flex', gap: 0.25 }} onClick={(e) => e.stopPropagation()}>
                                  <Tooltip title="Always allow"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'always_allow')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'always_allow' ? `${c.status.success}20` : 'transparent', color: toolPolicy === 'always_allow' ? c.status.success : c.text.ghost, '&:hover': { bgcolor: `${c.status.success}15`, color: c.status.success } }}><CheckCircleIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                  <Tooltip title="Ask permission"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'ask')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'ask' ? `${c.status.warning}20` : 'transparent', color: toolPolicy === 'ask' ? c.status.warning : c.text.ghost, '&:hover': { bgcolor: `${c.status.warning}15`, color: c.status.warning } }}><PanToolIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                  <Tooltip title="Always deny"><IconButton size="small" onClick={() => handleBuiltinPermissionChange(bt.name, 'deny')} sx={{ p: 0.4, borderRadius: 1, bgcolor: toolPolicy === 'deny' ? `${c.status.error}20` : 'transparent', color: toolPolicy === 'deny' ? c.status.error : c.text.ghost, '&:hover': { bgcolor: `${c.status.error}15`, color: c.status.error } }}><BlockIcon sx={{ fontSize: 14 }} /></IconButton></Tooltip>
                                </Box>
                              </Box>
                            );
                          })}
                        </Box>
                      </Collapse>
                    </Box>
                  );
                })()}
              </Box>
            </Box>
          </Collapse>
        </Card>
      )}

          </Box>
        </Collapse>
      </Box>

      {/* Custom Tool Sets */}
      <Box sx={{ mb: 2 }}>
        <Box onClick={() => setCustomSectionOpen((v) => !v)} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1, cursor: 'pointer', userSelect: 'none', '&:hover .section-arrow': { color: c.text.secondary } }}>
          {customSectionOpen ? <KeyboardArrowDownIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} /> : <KeyboardArrowRightIcon className="section-arrow" sx={{ fontSize: 18, color: c.text.tertiary, transition: 'color 0.15s' }} />}
          <BuildIcon sx={{ fontSize: 14, color: c.text.tertiary }} />
          <Typography sx={{ color: c.text.muted, fontWeight: 600, fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Custom Action Sets</Typography>
          <Chip label={tools.length + uninstalledIntegrations.length} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 18, minWidth: 24, '& .MuiChip-label': { px: 0.8 } }} />
        </Box>
        <Collapse in={customSectionOpen}>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 6 }}><CircularProgress sx={{ color: c.accent.primary }} size={28} /></Box>
          ) : (tools.length === 0 && uninstalledIntegrations.length === 0) ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', py: 6, color: c.text.ghost, gap: 1.5 }}>
              <BuildIcon sx={{ fontSize: 40, opacity: 0.3 }} />
              <Typography sx={{ fontSize: '0.9rem' }}>No custom actions defined yet. Create one to get started.</Typography>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pl: 1 }}>
              {uninstalledIntegrations.map((ig) => {
                const isLoading = !!integrationLoading[ig.id];
                return (
                  <Card key={ig.id} sx={{ bgcolor: c.bg.surface, border: `1px solid ${c.border.subtle}`, borderRadius: 2, boxShadow: c.shadow.sm, transition: 'border-color 0.2s, box-shadow 0.2s' }}>
                    <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <Box sx={{
                          width: 36, height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          bgcolor: c.bg.secondary, fontSize: '1.1rem', fontWeight: 700, color: c.text.ghost,
                        }}>
                          {ig.icon}
                        </Box>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.25 }}>
                            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem' }}>{ig.name}</Typography>
                            <Chip component="a" href={ig.website} clickable icon={<OpenInNewIcon sx={{ fontSize: 10 }} />} label="docs" size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.4 }, '& .MuiChip-icon': { ml: 0.4, fontSize: 10 } }} />
                          </Box>
                          <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>{ig.description}</Typography>
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
                          {isLoading && <CircularProgress size={16} sx={{ color: ig.color }} />}
                          <Switch
                            checked={false}
                            onChange={() => handleIntegrationToggle(ig)}
                            disabled={isLoading}
                            sx={{
                              '& .MuiSwitch-switchBase.Mui-checked': { color: ig.color },
                              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: ig.color },
                            }}
                          />
                        </Box>
                      </Box>
                    </CardContent>
                  </Card>
                );
              })}
              {tools.map((tool) => {
                const ig = getIntegrationForTool(tool);
                const isExpanded = expandedToolId === tool.id;
                const isMcp = tool.mcp_config && Object.keys(tool.mcp_config).length > 0;
                const isStdio = isMcp && (tool.mcp_config.type === 'stdio' || !!tool.mcp_config.command);
                const canDiscover = isMcp;
                const perms = tool.tool_permissions || {};
                const services = perms._services as Record<string, { read?: string[]; write?: string[] }> | undefined;
                const descriptions = (perms._tool_descriptions || {}) as Record<string, string>;
                const schemas = (perms._tool_schemas || {}) as Record<string, any>;
                const serviceNames = services ? Object.keys(services) : [];
                const hasPerms = serviceNames.length > 0;
                const totalToolCount = serviceNames.reduce((acc, s) => acc + (services![s].read?.length || 0) + (services![s].write?.length || 0), 0);

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

                const ServiceGroup = ({ serviceName, data }: { serviceName: string; data: { read?: string[]; write?: string[] } }) => {
                  const svcKey = `${tool.id}:${serviceName}`;
                  const isOpen = expandedServices[svcKey] ?? false;
                  const allNames = [...(data.read || []), ...(data.write || [])];
                  const svcPolicy = getGroupPolicy(allNames);
                  const count = allNames.length;

                  return (
                    <Box sx={{ border: `1px solid ${c.border.subtle}`, borderRadius: 1.5, overflow: 'hidden', '&:hover': { borderColor: `${c.border.medium}` } }}>
                      <Box
                        sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 0.75, cursor: 'pointer', bgcolor: isOpen ? c.bg.secondary : 'transparent', '&:hover': { bgcolor: c.bg.secondary } }}
                        onClick={() => setExpandedServices((p) => ({ ...p, [svcKey]: !isOpen }))}
                      >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost, transition: 'transform 0.15s', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
                          <Typography sx={{ color: c.text.primary, fontSize: '0.85rem', fontWeight: 600 }}>{serviceName}</Typography>
                          <Chip label={count} size="small" sx={{ bgcolor: c.bg.page, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                        </Box>
                        <PermToggle value={svcPolicy === 'mixed' ? 'ask' : svcPolicy} onChange={(v) => handleGroupPermissionChange(tool.id, allNames, v)} />
                      </Box>
                      <Collapse in={isOpen}>
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
                              {data.read!.map((name) => {
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
                              })}
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
                              {data.write!.map((name) => {
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
                              })}
                            </Box>
                          )}
                        </Box>
                      </Collapse>
                    </Box>
                  );
                };

                const isDisabled = tool.enabled === false;

                return (
                  <Card key={tool.id} sx={{ bgcolor: c.bg.surface, border: `1px solid ${isExpanded ? c.accent.primary : c.border.subtle}`, borderRadius: 2, boxShadow: c.shadow.sm, '&:hover': { borderColor: isDisabled ? c.border.subtle : c.accent.primary, boxShadow: isDisabled ? undefined : '0 0 0 1px rgba(174,86,48,0.12)' }, transition: 'border-color 0.2s, box-shadow 0.2s' }}>
                    <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
                      <Box
                        sx={{ display: 'flex', alignItems: 'center', gap: 2, cursor: isDisabled ? 'default' : 'pointer' }}
                        onClick={() => !isDisabled && setExpandedToolId(isExpanded ? null : tool.id)}
                      >
                        {ig && (
                          <Box sx={{
                            width: 36, height: 36, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            bgcolor: `${ig.color}18`, fontSize: '1.1rem', fontWeight: 700, color: ig.color, flexShrink: 0,
                            opacity: isDisabled ? 0.4 : 1, transition: 'opacity 0.2s',
                          }}>
                            {ig.icon}
                          </Box>
                        )}
                        <Box sx={{ flex: 1, minWidth: 0, opacity: isDisabled ? 0.4 : 1, transition: 'opacity 0.2s' }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
                            <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.95rem' }}>{tool.name}</Typography>
                            {isMcp && <Chip icon={<ExtensionIcon sx={{ fontSize: 12 }} />} label={isStdio ? 'MCP · stdio' : 'MCP'} size="small" sx={{ bgcolor: `${c.status.warning}20`, color: c.status.warning, fontSize: '0.75rem', height: 24 }} />}
                            {tool.command && <Chip icon={<TerminalIcon sx={{ fontSize: 12 }} />} label={`/${tool.command}`} size="small" sx={{ bgcolor: 'rgba(174,86,48,0.12)', color: c.accent.hover, fontSize: '0.72rem', height: 22 }} />}
                            {tool.auth_status === 'connected' && !ig && (
                              <Chip icon={<CheckCircleIcon sx={{ fontSize: 12 }} />} label={tool.connected_account_email ? `Connected · ${tool.connected_account_email}` : 'Connected'} size="small" sx={{ bgcolor: c.status.successBg, color: c.status.success, fontSize: '0.7rem', height: 20, '& .MuiChip-icon': { color: c.status.success } }} />
                            )}
                            {tool.auth_status === 'configured' && !ig?.credentialFields && (
                              <Chip icon={<SettingsIcon sx={{ fontSize: 12 }} />} label="Configured" size="small" sx={{ bgcolor: c.status.warningBg, color: c.status.warning, fontSize: '0.7rem', height: 20, '& .MuiChip-icon': { color: c.status.warning } }} />
                            )}
                            {ig && totalToolCount > 0 && (
                              <Chip label={`${totalToolCount} actions`} size="small" sx={{ bgcolor: `${ig.color}15`, color: ig.color, fontSize: '0.7rem', height: 20, '& .MuiChip-label': { px: 0.6 } }} />
                            )}
                            {ig && (
                              <Chip component="a" href={ig.website} clickable icon={<OpenInNewIcon sx={{ fontSize: 10 }} />} label="docs" size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.4 }, '& .MuiChip-icon': { ml: 0.4, fontSize: 10 } }} />
                            )}
                          </Box>
                          {tool.description && <Typography sx={{ color: c.text.muted, fontSize: '0.84rem' }}>{tool.description}</Typography>}
                        </Box>
                        {!isDisabled && (tool.auth_type === 'oauth2' || ig?.authType === 'oauth2') && tool.auth_status !== 'connected' && (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<LinkIcon sx={{ fontSize: 14 }} />}
                            onClick={(e) => { e.stopPropagation(); handleOAuthConnect(tool.id); }}
                            sx={{ borderColor: `${c.status.info}40`, color: c.status.info, '&:hover': { borderColor: c.status.info, bgcolor: `${c.status.info}10` }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5, py: 0.5, flexShrink: 0 }}
                          >
                            Connect {tool.name}
                          </Button>
                        )}
                        {!isDisabled && ig?.authType === 'device_code' && tool.auth_status !== 'connected' && (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<LinkIcon sx={{ fontSize: 14 }} />}
                            onClick={(e) => { e.stopPropagation(); handleDeviceCodeConnect(tool.id); }}
                            sx={{ borderColor: `${ig.color}40`, color: ig.color, '&:hover': { borderColor: ig.color, bgcolor: `${ig.color}10` }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5, py: 0.5, flexShrink: 0 }}
                          >
                            Connect Microsoft 365
                          </Button>
                        )}
                        {!isDisabled && ig?.credentialFields && tool.auth_status !== 'connected' && (
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<LinkIcon sx={{ fontSize: 14 }} />}
                            onClick={(e) => { e.stopPropagation(); openCredentialsDialog(tool.id, ig); }}
                            sx={{ borderColor: `${ig.color}40`, color: ig.color, '&:hover': { borderColor: ig.color, bgcolor: `${ig.color}10` }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5, py: 0.5, flexShrink: 0 }}
                          >
                            {ig.connectLabel || 'Connect'}
                          </Button>
                        )}
                        {!isDisabled && ig && tool.auth_status === 'connected' && (
                          <Tooltip title={ig.credentialFields || ig.authType === 'oauth2' || ig.authType === 'device_code' ? 'Disconnect' : ''}>
                            <Chip
                              icon={<CheckCircleIcon sx={{ fontSize: 12 }} />}
                              label={tool.connected_account_email ? `Connected · ${tool.connected_account_email}` : 'Connected'}
                              size="small"
                              onDelete={(ig.credentialFields || ig.authType === 'oauth2' || ig.authType === 'device_code') ? (e: React.SyntheticEvent) => { e.stopPropagation(); ig.authType === 'device_code' ? handleM365Disconnect(tool.id) : handleDisconnectIntegration(tool.id, ig); } : undefined}
                              onClick={(e) => e.stopPropagation()}
                              sx={{ bgcolor: c.status.successBg, color: c.status.success, fontSize: '0.7rem', height: 22, '& .MuiChip-icon': { color: c.status.success }, '& .MuiChip-deleteIcon': { color: c.status.success, '&:hover': { color: c.status.error } }, flexShrink: 0 }}
                            />
                          </Tooltip>
                        )}
                        {ig && (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                            {!!integrationLoading[ig.id] && <CircularProgress size={16} sx={{ color: ig.color }} />}
                            <Switch
                              checked={tool.enabled !== false}
                              onChange={() => handleIntegrationToggle(ig)}
                              disabled={!!integrationLoading[ig.id]}
                              sx={{
                                '& .MuiSwitch-switchBase.Mui-checked': { color: ig.color },
                                '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: ig.color },
                              }}
                            />
                          </Box>
                        )}
                        {!isDisabled && (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flexShrink: 0 }}>
                            <KeyboardArrowDownIcon sx={{ fontSize: 18, color: c.text.ghost, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                            {!ig && (
                              <>
                                <Tooltip title="Edit" placement="left"><IconButton size="small" onClick={(e) => { e.stopPropagation(); openEdit(tool); }} sx={{ color: c.text.ghost, '&:hover': { color: c.accent.primary } }}><EditIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                                <Tooltip title="Delete" placement="left"><IconButton size="small" onClick={(e) => { e.stopPropagation(); handleDelete(tool.id); }} sx={{ color: c.text.ghost, '&:hover': { color: c.status.error } }}><DeleteIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                              </>
                            )}
                          </Box>
                        )}
                      </Box>
                    </CardContent>

                    <Collapse in={isExpanded && !isDisabled}>
                        <Box sx={{ px: 2, pb: 2, pt: 0, borderTop: `1px solid ${c.border.subtle}` }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mt: 1.5, mb: 1 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <SecurityIcon sx={{ fontSize: 14, color: c.text.muted }} />
                              <Typography sx={{ color: c.text.muted, fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Action Permissions</Typography>
                              {hasPerms && <Chip label={`${totalToolCount} actions`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.ghost, fontSize: '0.65rem', height: 18, ml: 0.5, '& .MuiChip-label': { px: 0.6 } }} />}
                            </Box>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              {hasPerms && (
                                <>
                                  <Tooltip title="Allow all read-only actions">
                                    <Button size="small" onClick={() => handleBulkReadOnly(tool.id)} sx={{ color: c.status.info, textTransform: 'none', fontSize: '0.7rem', minWidth: 'auto', px: 1, py: 0.25 }}>
                                      Allow reads
                                    </Button>
                                  </Tooltip>
                                  <Tooltip title="Reset all to Ask">
                                    <Button size="small" onClick={() => handleResetPermissions(tool.id)} sx={{ color: c.text.ghost, textTransform: 'none', fontSize: '0.7rem', minWidth: 'auto', px: 1, py: 0.25 }}>
                                      Reset
                                    </Button>
                                  </Tooltip>
                                </>
                              )}
                              <Tooltip title="Discover / refresh actions from MCP server">
                                <IconButton
                                  size="small"
                                  onClick={() => handleDiscover(tool.id)}
                                  disabled={discovering || !canDiscover}
                                  sx={{ color: c.text.ghost, '&:hover': { color: c.accent.primary } }}
                                >
                                  {discovering ? <CircularProgress size={14} sx={{ color: c.text.ghost }} /> : <RefreshIcon sx={{ fontSize: 16 }} />}
                                </IconButton>
                              </Tooltip>
                            </Box>
                          </Box>

                          {!hasPerms ? (
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 3, gap: 1.5 }}>
                              <ExtensionIcon sx={{ fontSize: 28, color: c.text.ghost, opacity: 0.4 }} />
                              <Typography sx={{ color: c.text.ghost, fontSize: '0.82rem' }}>No actions discovered yet</Typography>
                              <Button
                                size="small"
                                variant="outlined"
                                startIcon={discovering ? <CircularProgress size={12} /> : <SearchIcon sx={{ fontSize: 14 }} />}
                                onClick={() => handleDiscover(tool.id)}
                                disabled={discovering || !canDiscover}
                                sx={{ borderColor: c.border.medium, color: c.text.secondary, '&:hover': { borderColor: c.accent.primary, color: c.accent.primary }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5 }}
                              >
                                Discover Actions
                              </Button>
                              {!canDiscover && (
                                <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Add an MCP configuration to enable action discovery</Typography>
                              )}
                            </Box>
                          ) : (
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                              {serviceNames.map((svc) => (
                                <ServiceGroup key={svc} serviceName={svc} data={services![svc]} />
                              ))}
                            </Box>
                          )}

                          {devMode && isMcp && (
                            <Box sx={{ mt: 2, pt: 1.5, borderTop: `1px solid ${c.border.subtle}`, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                              <Typography sx={{ color: c.text.muted, fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                Developer Info
                              </Typography>
                              <Box sx={{ bgcolor: c.bg.page, borderRadius: 1.5, border: `1px solid ${c.border.subtle}`, px: 1.5, py: 1 }}>
                                <Typography sx={{ color: c.text.ghost, fontSize: '0.68rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', mb: 0.5 }}>
                                  MCP Config
                                </Typography>
                                <Typography component="pre" sx={{ color: c.text.muted, fontSize: '0.75rem', fontFamily: c.font.mono, whiteSpace: 'pre-wrap', wordBreak: 'break-all', m: 0, lineHeight: 1.5 }}>
                                  {JSON.stringify(tool.mcp_config, null, 2)}
                                </Typography>
                              </Box>
                              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Auth type:</Typography>
                                  <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', fontFamily: c.font.mono }}>{tool.auth_type || 'none'}</Typography>
                                </Box>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                  <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Status:</Typography>
                                  <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', fontFamily: c.font.mono }}>{tool.auth_status || 'none'}</Typography>
                                </Box>
                                {tool.connected_account_email && (
                                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                    <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Account:</Typography>
                                    <Typography sx={{ color: c.text.muted, fontSize: '0.72rem', fontFamily: c.font.mono }}>{tool.connected_account_email}</Typography>
                                  </Box>
                                )}
                              </Box>
                              {tool.credentials && Object.keys(tool.credentials).length > 0 && (
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                                  <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>Credentials:</Typography>
                                  {Object.keys(tool.credentials).map((key) => (
                                    <Chip key={key} label={`${key}: configured`} size="small" sx={{ bgcolor: `${c.status.success}12`, color: c.status.success, fontSize: '0.65rem', height: 18, fontFamily: c.font.mono, '& .MuiChip-label': { px: 0.6 } }} />
                                  ))}
                                </Box>
                              )}
                            </Box>
                          )}
                        </Box>
                      </Collapse>
                  </Card>
                );
              })}
            </Box>
          )}
        </Collapse>
      </Box>

      {/* Create/Edit Tool Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="md" fullWidth PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}>
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600 }}>{editingId ? 'Edit Tool' : 'New Tool'}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} fullWidth size="small" sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page } }} />
          <TextField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} fullWidth size="small" sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page } }} />
          <TextField label="Command (slash command name)" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} fullWidth size="small" placeholder="e.g. my-tool" sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page } }} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDialogOpen(false)} sx={{ color: c.text.tertiary, textTransform: 'none' }}>Cancel</Button>
          <Button variant="contained" onClick={handleSave} disabled={!form.name} sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed }, textTransform: 'none', borderRadius: 2 }}>{editingId ? 'Save Changes' : 'Create Tool'}</Button>
        </DialogActions>
      </Dialog>

      {/* Registry Browser Dialog */}
      <Dialog
        open={registryOpen}
        onClose={() => setRegistryOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={{ sx: { bgcolor: c.bg.page, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}`, height: '80vh' } }}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1.5, pb: 1 }}>
          <StorefrontIcon sx={{ color: c.accent.primary }} />
          MCP Registry
          {regStats && (
            <>
              <Chip
                label={
                  regSource === 'google'
                    ? `${regStats.google.toLocaleString()} Google servers`
                    : regSource === 'community'
                      ? `${regStats.community.toLocaleString()} Community servers`
                      : `${regStats.total.toLocaleString()} servers`
                }
                size="small"
                sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 20, ml: 'auto' }}
              />
              {devMode && regStats.lastUpdated > 0 && (
                <Typography sx={{ color: c.text.ghost, fontSize: '0.68rem', flexShrink: 0 }}>
                  Synced {Math.round((Date.now() / 1000 - regStats.lastUpdated) / 60)}m ago
                </Typography>
              )}
            </>
          )}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 0, px: 3, pb: 0, overflow: 'hidden',
          '&::-webkit-scrollbar': { width: 6 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
          scrollbarWidth: 'thin', scrollbarColor: `${c.border.medium} transparent`,
        }}>
          <Box sx={{ display: 'flex', gap: 1, mb: 1.5, alignItems: 'center' }}>
            <TextField
              placeholder="Search MCP servers..."
              value={regQuery}
              onChange={(e) => handleRegSearch(e.target.value)}
              fullWidth
              size="small"
              autoFocus
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon sx={{ color: c.text.ghost, fontSize: 20 }} />
                  </InputAdornment>
                ),
              }}
              sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.surface, borderRadius: 2 } }}
            />
            <ToggleButtonGroup
              value={regSource}
              exclusive
              onChange={handleRegSourceFilter}
              size="small"
              sx={{
                flexShrink: 0,
                '& .MuiToggleButton-root': {
                  color: c.text.ghost, border: `1px solid ${c.border.medium}`, textTransform: 'none',
                  fontSize: '0.72rem', py: 0.5, px: 1.2, lineHeight: 1.4,
                  '&.Mui-selected': { bgcolor: c.bg.secondary, color: c.text.primary, borderColor: c.border.strong },
                  '&:hover': { bgcolor: c.bg.secondary },
                },
              }}
            >
              <ToggleButton value="">All</ToggleButton>
              <ToggleButton value="community"><PublicIcon sx={{ fontSize: 14, mr: 0.5 }} />Community</ToggleButton>
              <ToggleButton value="google"><CloudIcon sx={{ fontSize: 14, mr: 0.5 }} />Google</ToggleButton>
            </ToggleButtonGroup>
            <Tooltip title={regSort === 'name' ? 'Sort by stars' : 'Sort by name'}>
              <IconButton
                size="small"
                onClick={() => handleRegSort(regSort === 'name' ? 'stars' : 'name')}
                sx={{
                  color: regSort === 'stars' ? '#c89c00' : c.text.ghost,
                  border: '1px solid',
                  borderColor: regSort === 'stars' ? '#c89c0040' : c.border.medium,
                  borderRadius: 1.5,
                  px: 1,
                  flexShrink: 0,
                  transition: 'all 0.15s',
                  '&:hover': { borderColor: '#c89c00', color: '#c89c00' },
                }}
              >
                <StarIcon sx={{ fontSize: 16 }} />
                <SortIcon sx={{ fontSize: 14, ml: 0.25 }} />
              </IconButton>
            </Tooltip>
          </Box>

          {regLoading && regServers.length === 0 ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
              <CircularProgress sx={{ color: c.accent.primary }} size={28} />
            </Box>
          ) : regServers.length === 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, color: c.text.ghost, gap: 1.5 }}>
              <SearchIcon sx={{ fontSize: 40, opacity: 0.3 }} />
              <Typography sx={{ fontSize: '0.9rem' }}>No servers found matching "{regQuery}"</Typography>
            </Box>
          ) : (
            <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 0.5,
              '&::-webkit-scrollbar': { width: 6 },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
              '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 3, '&:hover': { background: c.border.strong } },
              scrollbarWidth: 'thin', scrollbarColor: `${c.border.medium} transparent`,
            }}>
              <Typography sx={{ color: c.text.ghost, fontSize: '0.75rem', mb: 0.5 }}>
                Showing {regServers.length} of {regTotal.toLocaleString()} results
              </Typography>
              {regServers.map((srv) => {
                const isExpanded = expandedServer === srv.name;
                const isInstalled = allTools.some((t) => t.name === (srv.title || cleanServerName(srv.name)));
                return (
                  <Box key={srv.name}>
                    <Box
                      onClick={() => {
                        const next = isExpanded ? null : srv.name;
                        setExpandedServer(next);
                        if (next && devMode) {
                          dispatch(clearDetail());
                          dispatch(fetchServerDetail(srv.name));
                        }
                      }}
                      sx={{
                        display: 'flex', alignItems: 'center', gap: 1.5,
                        px: 1.5, py: 1, borderRadius: 1.5, cursor: 'pointer',
                        transition: 'background 0.15s',
                        '&:hover': { bgcolor: c.bg.secondary },
                        ...(isExpanded && { bgcolor: c.bg.secondary }),
                      }}
                    >
                      <Avatar
                        src={srv.iconUrl || undefined}
                        sx={{
                          width: 24, height: 24, flexShrink: 0, bgcolor: c.bg.secondary,
                          fontSize: '0.7rem', fontWeight: 700, color: c.text.muted,
                        }}
                      >
                        {srv.iconUrl ? null : (srv.title || cleanServerName(srv.name)).charAt(0).toUpperCase()}
                      </Avatar>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.88rem', fontFamily: c.font.mono }}>
                            {srv.title || cleanServerName(srv.name)}
                          </Typography>
                          {srv.version && <Chip label={`v${srv.version}`} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />}
                          {srv.remoteType && <Chip label={srv.remoteType} size="small" sx={{ bgcolor: '#3b82f615', color: '#3b82f6', fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />}
                          {srv.source === 'google' ? (
                            <Chip icon={<CloudIcon sx={{ fontSize: 12 }} />} label="Google" size="small" sx={{ bgcolor: `${c.status.info}15`, color: c.status.info, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.4 }, '& .MuiChip-icon': { ml: 0.4, color: c.status.info } }} />
                          ) : (
                            <Chip icon={<PublicIcon sx={{ fontSize: 12 }} />} label="Community" size="small" sx={{ bgcolor: 'rgba(174,86,48,0.08)', color: c.accent.primary, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.4 }, '& .MuiChip-icon': { ml: 0.4, color: c.accent.primary } }} />
                          )}
                          {srv.stars != null && (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, ml: 0.5 }}>
                              <StarIcon sx={{ fontSize: 13, color: '#c89c00' }} />
                              <Typography sx={{ color: c.text.muted, fontSize: '0.7rem', fontWeight: 600, lineHeight: 1 }}>
                                {srv.stars >= 1000 ? `${(srv.stars / 1000).toFixed(1)}k` : srv.stars.toLocaleString()}
                              </Typography>
                            </Box>
                          )}
                          {devMode && !srv.remoteType && (
                            <Chip label="stdio" size="small" sx={{ bgcolor: '#8b5cf615', color: '#8b5cf6', fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                          )}
                          {isInstalled && (
                            <Chip icon={<CheckCircleIcon sx={{ fontSize: 12 }} />} label="Installed" size="small" sx={{ bgcolor: `${c.status.success}15`, color: c.status.success, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.4 }, '& .MuiChip-icon': { ml: 0.4, color: c.status.success } }} />
                          )}
                        </Box>
                        <Typography sx={{ color: c.text.tertiary, fontSize: '0.78rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {srv.description}
                        </Typography>
                      </Box>
                      <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }} />
                    </Box>

                    <Collapse in={isExpanded}>
                      <Box sx={{ ml: 4.5, mr: 1.5, mb: 1, px: 2, py: 1.5, bgcolor: c.bg.elevated, borderRadius: 1.5, borderLeft: '2px solid rgba(174,86,48,0.12)' }}>
                        <Typography sx={{ color: c.text.secondary, fontSize: '0.85rem', mb: 1.5, lineHeight: 1.5 }}>
                          {srv.description}
                        </Typography>

                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 2 }}>
                          <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem', fontFamily: c.font.mono }}>
                            {srv.name}
                          </Typography>
                          {srv.remoteUrl && (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                              <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem', textTransform: 'uppercase' }}>Endpoint</Typography>
                              <Typography sx={{ color: c.text.muted, fontSize: '0.78rem', fontFamily: c.font.mono }}>{srv.remoteUrl}</Typography>
                            </Box>
                          )}
                          <Box sx={{ display: 'flex', gap: 1 }}>
                            {srv.websiteUrl && (
                              <Chip
                                component="a"
                                href={srv.websiteUrl}
                                clickable
                                icon={<OpenInNewIcon sx={{ fontSize: 12 }} />}
                                label="Website"
                                size="small"
                                sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 22 }}
                              />
                            )}
                            {srv.repositoryUrl && (
                              <Chip
                                component="a"
                                href={srv.repositoryUrl}
                                clickable
                                icon={<OpenInNewIcon sx={{ fontSize: 12 }} />}
                                label="Repository"
                                size="small"
                                sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.7rem', height: 22 }}
                              />
                            )}
                          </Box>
                        </Box>

                        {devMode && (
                          <Box sx={{ mb: 2 }}>
                            {regDetailLoading && expandedServer === srv.name ? (
                              <CircularProgress size={14} sx={{ color: c.text.ghost }} />
                            ) : regDetail && regDetail.name === srv.name ? (
                              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                {(regDetail.keywords?.length > 0 || regDetail.license) && (
                                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'center' }}>
                                    {regDetail.license && (
                                      <Chip label={regDetail.license} size="small" sx={{ bgcolor: `${c.status.info}15`, color: c.status.info, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                                    )}
                                    {regDetail.keywords?.map((kw) => (
                                      <Chip key={kw} label={kw} size="small" sx={{ bgcolor: c.bg.secondary, color: c.text.muted, fontSize: '0.65rem', height: 18, '& .MuiChip-label': { px: 0.6 } }} />
                                    ))}
                                  </Box>
                                )}
                                {regDetail.environmentVariables?.length > 0 && (
                                  <Box sx={{ bgcolor: c.bg.page, borderRadius: 1.5, border: `1px solid ${c.border.subtle}`, px: 1.5, py: 1 }}>
                                    <Typography sx={{ color: c.text.muted, fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', mb: 0.75 }}>
                                      Required Environment Variables
                                    </Typography>
                                    {regDetail.environmentVariables.map((ev) => (
                                      <Box key={ev.name} sx={{ display: 'flex', alignItems: 'baseline', gap: 1, py: 0.25 }}>
                                        <Typography sx={{ color: c.accent.primary, fontSize: '0.75rem', fontFamily: c.font.mono, fontWeight: 600, flexShrink: 0 }}>
                                          {ev.name}
                                        </Typography>
                                        {ev.description && (
                                          <Typography sx={{ color: c.text.ghost, fontSize: '0.72rem' }}>
                                            {ev.description}
                                          </Typography>
                                        )}
                                      </Box>
                                    ))}
                                  </Box>
                                )}
                              </Box>
                            ) : null}
                          </Box>
                        )}

                        <Box sx={{ display: 'flex', gap: 1 }}>
                          <Button
                            size="small"
                            variant="contained"
                            startIcon={<DownloadIcon sx={{ fontSize: 14 }} />}
                            onClick={(e) => { e.stopPropagation(); handleInstall(srv); }}
                            sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5, py: 0.5 }}
                          >
                            Install
                          </Button>
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<EditIcon sx={{ fontSize: 14 }} />}
                            onClick={(e) => { e.stopPropagation(); handleEditInstall(srv); }}
                            sx={{ borderColor: c.border.strong, color: c.text.secondary, '&:hover': { borderColor: c.accent.primary, color: c.text.primary }, textTransform: 'none', fontSize: '0.78rem', borderRadius: 1.5, py: 0.5 }}
                          >
                            Edit & Install
                          </Button>
                        </Box>
                      </Box>
                    </Collapse>
                  </Box>
                );
              })}

              {regServers.length < regTotal && (
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                  <Button
                    onClick={handleLoadMore}
                    disabled={regLoading}
                    sx={{ color: c.accent.primary, textTransform: 'none', fontSize: '0.85rem' }}
                  >
                    {regLoading ? <CircularProgress size={16} sx={{ color: c.accent.primary, mr: 1 }} /> : null}
                    Load More
                  </Button>
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRegistryOpen(false)} sx={{ color: c.text.tertiary, textTransform: 'none' }}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* MCP Config Dialog */}
      <Dialog
        open={mcpConfigOpen}
        onClose={() => setMcpConfigOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1 }}>
          <ExtensionIcon sx={{ color: c.status.warning }} />
          Configure MCP Tool
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pt: '8px !important' }}>
          {mcpConfigServer && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, bgcolor: c.bg.page, borderRadius: 2, border: `1px solid ${c.border.subtle}` }}>
              <Avatar
                src={mcpConfigServer.iconUrl || undefined}
                sx={{ width: 32, height: 32, bgcolor: c.bg.secondary, fontSize: '0.8rem', fontWeight: 700, color: c.text.muted }}
              >
                {mcpConfigServer.iconUrl ? null : (mcpConfigServer.title || cleanServerName(mcpConfigServer.name)).charAt(0).toUpperCase()}
              </Avatar>
              <Box>
                <Typography sx={{ color: c.text.primary, fontWeight: 600, fontSize: '0.9rem' }}>
                  {mcpConfigServer.title || cleanServerName(mcpConfigServer.name)}
                </Typography>
                <Typography sx={{ color: c.text.tertiary, fontSize: '0.78rem' }}>{mcpConfigServer.description}</Typography>
              </Box>
            </Box>
          )}

          <TextField
            label="MCP Config (JSON)"
            value={mcpConfigJson}
            onChange={(e) => { setMcpConfigJson(e.target.value); try { JSON.parse(e.target.value); setMcpConfigError(''); } catch { setMcpConfigError('Invalid JSON'); } }}
            fullWidth
            multiline
            minRows={3}
            maxRows={8}
            error={!!mcpConfigError}
            helperText={mcpConfigError || 'Transport config passed to claude_agent_sdk (type, url, command, args, etc.)'}
            sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page, fontFamily: c.font.mono, fontSize: '0.85rem' } }}
          />

          <FormControl fullWidth size="small">
            <InputLabel sx={{ color: c.text.tertiary }}>Authentication Type</InputLabel>
            <Select
              value={mcpAuthType}
              label="Authentication Type"
              onChange={(e) => {
                const val = e.target.value as 'none' | 'env_vars';
                setMcpAuthType(val);
                if (val === 'env_vars') setMcpCredentials({ API_KEY: '' });
                else setMcpCredentials({});
              }}
              sx={{ bgcolor: c.bg.page }}
            >
              <MenuItem value="none">None</MenuItem>
              <MenuItem value="env_vars">API Keys / Env Vars</MenuItem>
            </Select>
          </FormControl>

          {mcpAuthType !== 'none' && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 1.5, bgcolor: c.bg.page, borderRadius: 2, border: `1px solid ${c.border.subtle}` }}>
              <Typography sx={{ color: c.text.muted, fontSize: '0.78rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Environment Variables
              </Typography>
              {Object.entries(mcpCredentials).map(([key, val]) => (
                <TextField
                  key={key}
                  label={key}
                  value={val}
                  onChange={(e) => setMcpCredentials({ ...mcpCredentials, [key]: e.target.value })}
                  fullWidth
                  size="small"
                  type={key.toLowerCase().includes('secret') ? 'password' : 'text'}
                  sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.elevated, fontFamily: c.font.mono, fontSize: '0.85rem' } }}
                />
              ))}
              {mcpAuthType === 'env_vars' && (
                <Button
                  size="small"
                  onClick={() => setMcpCredentials({ ...mcpCredentials, [`VAR_${Object.keys(mcpCredentials).length + 1}`]: '' })}
                  sx={{ color: c.accent.primary, textTransform: 'none', fontSize: '0.78rem', alignSelf: 'flex-start' }}
                >
                  + Add Variable
                </Button>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setMcpConfigOpen(false)} sx={{ color: c.text.tertiary, textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleMcpConfigSave}
            disabled={!!mcpConfigError}
            sx={{ bgcolor: c.accent.primary, '&:hover': { bgcolor: c.accent.pressed }, textTransform: 'none', borderRadius: 2 }}
          >
            Install Tool
          </Button>
        </DialogActions>
      </Dialog>

      {/* Microsoft 365 Device Code Login Dialog */}
      <Dialog
        open={deviceCodeDialogOpen}
        onClose={() => { if (deviceCodeStatus !== 'loading') setDeviceCodeDialogOpen(false); }}
        maxWidth="xs"
        fullWidth
        PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{ width: 32, height: 32, borderRadius: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: '#0078D418' }}>
            <svg viewBox="0 0 24 24" width="20" height="20"><path d="M11.4 24H0V12.6L11.4 24zM24 24H12.6V12.6L24 24zM11.4 11.4H0V0l11.4 11.4zM24 11.4H12.6V0L24 11.4z" fill="#0078D4"/></svg>
          </Box>
          Connect Microsoft 365
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {deviceCodeStatus === 'loading' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 3, justifyContent: 'center' }}>
              <CircularProgress size={20} />
              <Typography sx={{ color: c.text.muted, fontSize: '0.9rem' }}>Generating login code...</Typography>
            </Box>
          )}
          {deviceCodeStatus === 'awaiting' && (
            <>
              <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', lineHeight: 1.6 }}>
                Open the link below and enter the code to sign in:
              </Typography>
              <Box sx={{ bgcolor: c.bg.page, border: `1px solid ${c.border.subtle}`, borderRadius: 2, p: 2, display: 'flex', flexDirection: 'column', gap: 1.5, alignItems: 'center' }}>
                <Typography component="a" href={deviceCodeUrl} target="_blank" rel="noopener" sx={{ color: c.status.info, fontSize: '0.9rem', fontWeight: 500 }}>
                  {deviceCodeUrl}
                </Typography>
                <Typography sx={{ fontFamily: c.font.mono, fontSize: '1.5rem', fontWeight: 700, color: c.text.primary, letterSpacing: 2 }}>
                  {deviceCode}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, justifyContent: 'center', py: 1 }}>
                <CircularProgress size={14} />
                <Typography sx={{ color: c.text.ghost, fontSize: '0.8rem' }}>Waiting for you to sign in...</Typography>
              </Box>
            </>
          )}
          {deviceCodeStatus === 'connected' && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2, justifyContent: 'center' }}>
              <CheckCircleIcon sx={{ color: c.status.success, fontSize: 20 }} />
              <Typography sx={{ color: c.status.success, fontSize: '0.9rem', fontWeight: 500 }}>Connected successfully!</Typography>
            </Box>
          )}
          {deviceCodeStatus === 'error' && (
            <Typography sx={{ color: c.status.error, fontSize: '0.85rem', py: 2, textAlign: 'center' }}>
              Login failed. Please try again.
            </Typography>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeviceCodeDialogOpen(false)} sx={{ color: c.text.muted, textTransform: 'none' }}>
            {deviceCodeStatus === 'connected' ? 'Done' : 'Cancel'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Integration Credentials Dialog */}
      <Dialog
        open={credDialogOpen}
        onClose={() => setCredDialogOpen(false)}
        maxWidth="sm"
        fullWidth
        PaperProps={{ sx: { bgcolor: c.bg.surface, backgroundImage: 'none', borderRadius: 4, border: `1px solid ${c.border.subtle}` } }}
      >
        <DialogTitle sx={{ color: c.text.primary, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 1.5 }}>
          {credDialogIntegration && (
            <Box sx={{
              width: 32, height: 32, borderRadius: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'center',
              bgcolor: `${credDialogIntegration.color}18`, fontSize: '1rem', fontWeight: 700, color: credDialogIntegration.color,
            }}>
              {credDialogIntegration.icon}
            </Box>
          )}
          {credDialogIntegration?.connectLabel || 'Connect'}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {credDialogIntegration?.connectInstructions && (
            <Typography sx={{ color: c.text.muted, fontSize: '0.85rem', lineHeight: 1.5, bgcolor: c.bg.secondary, px: 2, py: 1.5, borderRadius: 2, border: `1px solid ${c.border.subtle}` }}>
              {credDialogIntegration.connectInstructions}
            </Typography>
          )}
          {(credDialogIntegration?.credentialFields || []).map((field) => (
            <TextField
              key={field.key}
              label={field.label}
              placeholder={field.placeholder}
              value={credDialogValues[field.key] || ''}
              onChange={(e) => setCredDialogValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              fullWidth
              size="small"
              helperText={field.helpText}
              sx={{ '& .MuiOutlinedInput-root': { bgcolor: c.bg.page, fontFamily: c.font.mono, fontSize: '0.85rem' } }}
            />
          ))}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setCredDialogOpen(false)} sx={{ color: c.text.tertiary, textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleCredentialsSave}
            disabled={credDialogSaving || (credDialogIntegration?.credentialFields || []).some((f) => !credDialogValues[f.key]?.trim())}
            startIcon={credDialogSaving ? <CircularProgress size={14} /> : <LinkIcon sx={{ fontSize: 14 }} />}
            sx={{ bgcolor: credDialogIntegration?.color || c.accent.primary, '&:hover': { bgcolor: credDialogIntegration?.color || c.accent.pressed, filter: 'brightness(0.9)' }, textTransform: 'none', borderRadius: 2 }}
          >
            Connect
          </Button>
        </DialogActions>
      </Dialog>

      {/* Install success snackbar */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={() => setSnackbar({ open: false, message: '' })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={() => setSnackbar({ open: false, message: '' })} severity={snackbar.severity || 'success'} sx={{ bgcolor: snackbar.severity === 'error' ? '#2e1a1a' : c.status.successBg, color: snackbar.severity === 'error' ? '#f87171' : c.status.success, border: `1px solid ${snackbar.severity === 'error' ? '#ef444440' : `${c.status.success}40`}` }}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default Tools;
