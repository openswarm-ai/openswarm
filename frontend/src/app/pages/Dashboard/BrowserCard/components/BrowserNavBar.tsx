import React from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import InputBase from '@mui/material/InputBase';
import LinearProgress from '@mui/material/LinearProgress';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import RefreshIcon from '@mui/icons-material/Refresh';
import LockIcon from '@mui/icons-material/Lock';
import SearchIcon from '@mui/icons-material/Search';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface BrowserNavBarProps {
  canGoBack: boolean;
  canGoForward: boolean;
  urlBarValue: string;
  isSecure: boolean;
  isSearch: boolean;
  loading: boolean;
  agentActive: boolean;
  agentAction: string | null;
  accentColor: string;
  onUrlChange: (value: string) => void;
  onUrlKeyDown: (e: React.KeyboardEvent) => void;
  onBack: (e: React.MouseEvent) => void;
  onForward: (e: React.MouseEvent) => void;
  onRefresh: (e: React.MouseEvent) => void;
}

const BrowserNavBar: React.FC<BrowserNavBarProps> = ({
  canGoBack, canGoForward, urlBarValue, isSecure, isSearch, loading,
  agentActive, agentAction, accentColor, onUrlChange, onUrlKeyDown,
  onBack, onForward, onRefresh,
}) => {
  const c = useClaudeTokens();

  return (
    <>
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 0.25, px: 0.5, py: 0.25,
        bgcolor: c.bg.page, borderBottom: `1px solid ${c.border.subtle}`, flexShrink: 0,
      }}>
        <Tooltip title="Back" placement="top">
          <span>
            <IconButton size="small" onClick={onBack} onPointerDown={(e) => e.stopPropagation()}
              disabled={!canGoBack} sx={{ color: c.text.muted, p: 0.4, '&:hover': { color: c.text.primary } }}>
              <ArrowBackIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Forward" placement="top">
          <span>
            <IconButton size="small" onClick={onForward} onPointerDown={(e) => e.stopPropagation()}
              disabled={!canGoForward} sx={{ color: c.text.muted, p: 0.4, '&:hover': { color: c.text.primary } }}>
              <ArrowForwardIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Reload" placement="top">
          <IconButton size="small" onClick={onRefresh} onPointerDown={(e) => e.stopPropagation()}
            sx={{ color: c.text.muted, p: 0.4, '&:hover': { color: c.text.primary } }}>
            <RefreshIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>

        <Box sx={{
          display: 'flex', alignItems: 'center', flex: 1, gap: 0.5, ml: 0.5, px: 1, py: 0.2,
          bgcolor: c.bg.secondary, borderRadius: `${c.radius.md}px`, border: `1px solid ${c.border.subtle}`,
        }}>
          {isSearch ? (
            <SearchIcon sx={{ fontSize: 13, color: c.text.muted, flexShrink: 0 }} />
          ) : isSecure ? (
            <LockIcon sx={{ fontSize: 12, color: c.status.success, flexShrink: 0 }} />
          ) : null}
          <InputBase
            value={urlBarValue}
            onChange={(e) => onUrlChange(e.target.value)}
            onKeyDown={onUrlKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            placeholder="Search Google or enter URL..."
            sx={{
              flex: 1, fontSize: '0.74rem', fontFamily: c.font.mono, color: c.text.secondary, py: 0,
              '& input': { py: '2px' }, '& input::placeholder': { color: c.text.ghost, opacity: 1 },
            }}
          />
        </Box>
      </Box>

      {(loading || (agentActive && agentAction === 'navigate')) && (
        <LinearProgress sx={{
          height: 2, flexShrink: 0, bgcolor: 'transparent',
          '& .MuiLinearProgress-bar': { bgcolor: agentActive ? accentColor : c.accent.primary },
        }} />
      )}
    </>
  );
};

export default BrowserNavBar;
