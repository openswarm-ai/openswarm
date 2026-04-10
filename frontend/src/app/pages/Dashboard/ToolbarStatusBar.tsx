import React, { useState, useEffect, useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Popover from '@mui/material/Popover';
import Checkbox from '@mui/material/Checkbox';
import InputBase from '@mui/material/InputBase';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import SearchIcon from '@mui/icons-material/Search';
import ComputerIcon from '@mui/icons-material/Computer';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { API_BASE } from '@/shared/config';

const LS_FOLDER_KEY = 'openswarm:lastFolder';
const LS_RECENT_KEY = 'openswarm:recentFolders';
const MAX_RECENT = 8;

interface GitInfo {
  is_git: boolean;
  branch?: string;
  branches?: string[];
  remote_url?: string;
  repo_name?: string;
}

interface Props {
  folder: string | null;
  onFolderChange: (folder: string) => void;
}

function folderDisplayName(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function truncatePath(p: string, maxLen = 50): string {
  if (p.length <= maxLen) return p;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 2) return p;
  return parts[0] + sep + '...' + sep + parts.slice(-2).join(sep);
}

export function loadLastFolder(): string | null {
  try {
    return localStorage.getItem(LS_FOLDER_KEY);
  } catch {
    return null;
  }
}

export function loadRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(LS_RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFolder(folder: string) {
  try {
    localStorage.setItem(LS_FOLDER_KEY, folder);
    const recent = loadRecentFolders().filter((f) => f !== folder);
    recent.unshift(folder);
    localStorage.setItem(LS_RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // ignore
  }
}

const BranchIcon: React.FC<{ size?: number; color?: string }> = ({ size = 14, color }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <circle cx="5" cy="4" r="1.5" stroke={color} strokeWidth="1.3" />
    <circle cx="5" cy="12" r="1.5" stroke={color} strokeWidth="1.3" />
    <circle cx="11" cy="7" r="1.5" stroke={color} strokeWidth="1.3" />
    <path d="M5 5.5V10.5" stroke={color} strokeWidth="1.3" />
    <path d="M5 5.5C5 5.5 5 7 7 7H9.5" stroke={color} strokeWidth="1.3" />
  </svg>
);

const ToolbarStatusBar: React.FC<Props> = ({ folder, onFolderChange }) => {
  const c = useClaudeTokens();
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [folderAnchor, setFolderAnchor] = useState<HTMLElement | null>(null);
  const [branchAnchor, setBranchAnchor] = useState<HTMLElement | null>(null);
  const [envAnchor, setEnvAnchor] = useState<HTMLElement | null>(null);
  const [branchSearch, setBranchSearch] = useState('');
  const [worktree, setWorktree] = useState(false);
  const branchSearchRef = useRef<HTMLInputElement>(null);

  // Fetch git info when folder changes
  useEffect(() => {
    if (!folder) {
      setGitInfo(null);
      return;
    }
    let cancelled = false;
    fetch(`${API_BASE}/settings/git-info?path=${encodeURIComponent(folder)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setGitInfo(data);
      })
      .catch(() => {
        if (!cancelled) setGitInfo(null);
      });
    return () => { cancelled = true; };
  }, [folder]);

  useEffect(() => {
    if (branchAnchor) {
      setTimeout(() => branchSearchRef.current?.focus(), 60);
    }
  }, [branchAnchor]);

  const recentFolders = loadRecentFolders();

  const handlePickFolder = useCallback(async () => {
    setFolderAnchor(null);
    const openswarm = (window as any).openswarm;
    if (openswarm?.showFolderDialog) {
      const picked = await openswarm.showFolderDialog(folder || undefined);
      if (picked) {
        saveFolder(picked);
        onFolderChange(picked);
      }
    } else {
      // Fallback: prompt
      const input = window.prompt('Enter folder path:', folder || '');
      if (input) {
        saveFolder(input);
        onFolderChange(input);
      }
    }
  }, [folder, onFolderChange]);

  const handleSelectRecent = useCallback(
    (f: string) => {
      setFolderAnchor(null);
      saveFolder(f);
      onFolderChange(f);
    },
    [onFolderChange],
  );

  const handleSelectBranch = useCallback(
    (branch: string) => {
      setBranchAnchor(null);
      setBranchSearch('');
      if (!folder) return;
      fetch(`${API_BASE}/settings/git-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folder, branch }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.success) {
            setGitInfo((prev) => (prev ? { ...prev, branch } : prev));
          }
        })
        .catch(() => {});
    },
    [folder],
  );

  const filteredBranches = (gitInfo?.branches || []).filter((b) =>
    !branchSearch || b.toLowerCase().includes(branchSearch.toLowerCase()),
  );

  const itemSx = {
    display: 'flex',
    alignItems: 'center',
    gap: 0.75,
    px: 1.25,
    py: 0.5,
    cursor: 'pointer',
    borderRadius: `${c.radius.sm}px`,
    transition: 'background-color 0.1s',
    '&:hover': { bgcolor: c.bg.elevated },
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 1.5,
        py: 0.5,
        borderTop: `1px solid ${c.border.subtle}`,
        minHeight: 30,
      }}
    >
      {/* Left side: folder + git branch */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0, flex: 1 }}>
        {/* Folder display */}
        <Box
          onClick={(e) => setFolderAnchor(e.currentTarget)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            cursor: 'pointer',
            borderRadius: `${c.radius.sm}px`,
            px: 0.75,
            py: 0.25,
            '&:hover': { bgcolor: c.bg.secondary },
            minWidth: 0,
          }}
        >
          <FolderOutlinedIcon sx={{ fontSize: 14, color: c.text.ghost, flexShrink: 0 }} />
          <Typography
            sx={{
              fontSize: '0.75rem',
              color: c.text.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 240,
            }}
          >
            {folder ? folderDisplayName(folder) : 'Select folder...'}
          </Typography>
        </Box>

        {/* Git branch display */}
        {gitInfo?.is_git && (
          <Box
            onClick={(e) => setBranchAnchor(e.currentTarget)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.4,
              cursor: 'pointer',
              borderRadius: `${c.radius.sm}px`,
              px: 0.75,
              py: 0.25,
              '&:hover': { bgcolor: c.bg.secondary },
            }}
          >
            <BranchIcon size={14} color={c.text.ghost} />
            <Typography sx={{ fontSize: '0.75rem', color: c.text.muted }}>
              {gitInfo.branch || 'HEAD'}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Right side: worktree + environment */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            cursor: 'pointer',
            borderRadius: `${c.radius.sm}px`,
            px: 0.5,
            py: 0.25,
            '&:hover': { bgcolor: c.bg.secondary },
          }}
          onClick={() => setWorktree(!worktree)}
        >
          <Checkbox
            checked={worktree}
            size="small"
            sx={{
              p: 0,
              color: c.text.ghost,
              '&.Mui-checked': { color: c.accent.primary },
              '& .MuiSvgIcon-root': { fontSize: 16 },
            }}
          />
          <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>worktree</Typography>
        </Box>

        <Box
          onClick={(e) => setEnvAnchor(e.currentTarget)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.4,
            cursor: 'pointer',
            borderRadius: `${c.radius.sm}px`,
            px: 0.75,
            py: 0.25,
            '&:hover': { bgcolor: c.bg.secondary },
          }}
        >
          <ComputerIcon sx={{ fontSize: 14, color: c.text.ghost }} />
          <Typography sx={{ fontSize: '0.72rem', color: c.text.muted }}>Local</Typography>
          <Typography sx={{ fontSize: '0.6rem', color: c.text.ghost, ml: -0.25 }}>▾</Typography>
        </Box>
      </Box>

      {/* Folder Picker Popover */}
      <Popover
        open={!!folderAnchor}
        anchorEl={folderAnchor}
        onClose={() => setFolderAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.subtle}`,
              borderRadius: `${c.radius.lg}px`,
              boxShadow: c.shadow.lg,
              minWidth: 280,
              maxWidth: 400,
              py: 0.5,
            },
          },
        }}
      >
        {recentFolders.length > 0 && (
          <>
            <Typography
              sx={{ fontSize: '0.7rem', color: c.text.ghost, fontWeight: 600, px: 1.5, py: 0.5, textTransform: 'uppercase', letterSpacing: '0.05em' }}
            >
              Recent
            </Typography>
            {recentFolders.map((f) => (
              <Box key={f} onClick={() => handleSelectRecent(f)} sx={itemSx}>
                <FolderOutlinedIcon sx={{ fontSize: 14, color: c.text.ghost, flexShrink: 0 }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: '0.8rem', color: c.text.primary, fontWeight: 500 }}>
                    {folderDisplayName(f)}
                  </Typography>
                  <Typography
                    sx={{
                      fontSize: '0.68rem',
                      color: c.text.ghost,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {truncatePath(f)}
                  </Typography>
                </Box>
                {f === folder && <CheckIcon sx={{ fontSize: 16, color: c.accent.primary, flexShrink: 0 }} />}
              </Box>
            ))}
            <Box sx={{ borderTop: `1px solid ${c.border.subtle}`, my: 0.5 }} />
          </>
        )}
        <Box onClick={handlePickFolder} sx={itemSx}>
          <AddIcon sx={{ fontSize: 16, color: c.text.muted }} />
          <Typography sx={{ fontSize: '0.8rem', color: c.text.primary }}>
            Choose a different folder
          </Typography>
        </Box>
      </Popover>

      {/* Branch Picker Popover */}
      <Popover
        open={!!branchAnchor}
        anchorEl={branchAnchor}
        onClose={() => { setBranchAnchor(null); setBranchSearch(''); }}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.subtle}`,
              borderRadius: `${c.radius.lg}px`,
              boxShadow: c.shadow.lg,
              minWidth: 240,
              maxWidth: 340,
              py: 0.5,
            },
          },
        }}
      >
        <Box sx={{ px: 1, py: 0.5 }}>
          <InputBase
            inputRef={branchSearchRef}
            value={branchSearch}
            onChange={(e) => setBranchSearch(e.target.value)}
            placeholder="Search branches"
            sx={{
              width: '100%',
              fontSize: '0.82rem',
              color: c.text.primary,
              fontFamily: c.font.sans,
              border: `1px solid ${c.border.medium}`,
              borderRadius: `${c.radius.sm}px`,
              px: 1,
              py: 0.25,
              '& input::placeholder': { color: c.text.ghost, opacity: 1 },
            }}
          />
        </Box>
        <Box sx={{ maxHeight: 240, overflow: 'auto', py: 0.25 }}>
          {filteredBranches.map((b) => (
            <Box key={b} onClick={() => handleSelectBranch(b)} sx={itemSx}>
              <Typography sx={{ fontSize: '0.8rem', color: c.text.primary, flex: 1 }}>{b}</Typography>
              {b === gitInfo?.branch && <CheckIcon sx={{ fontSize: 16, color: c.accent.primary }} />}
            </Box>
          ))}
          {filteredBranches.length === 0 && (
            <Typography sx={{ fontSize: '0.78rem', color: c.text.ghost, px: 1.5, py: 1, textAlign: 'center' }}>
              No branches found
            </Typography>
          )}
        </Box>
      </Popover>

      {/* Environment Popover */}
      <Popover
        open={!!envAnchor}
        anchorEl={envAnchor}
        onClose={() => setEnvAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              bgcolor: c.bg.surface,
              border: `1px solid ${c.border.subtle}`,
              borderRadius: `${c.radius.lg}px`,
              boxShadow: c.shadow.lg,
              minWidth: 220,
              py: 0.5,
            },
          },
        }}
      >
        <Box onClick={() => setEnvAnchor(null)} sx={itemSx}>
          <ComputerIcon sx={{ fontSize: 14, color: c.text.ghost }} />
          <Typography sx={{ fontSize: '0.8rem', color: c.text.primary, flex: 1 }}>Local</Typography>
          <CheckIcon sx={{ fontSize: 16, color: c.accent.primary }} />
        </Box>
        <Box sx={itemSx} onClick={() => setEnvAnchor(null)}>
          <AddIcon sx={{ fontSize: 16, color: c.text.muted }} />
          <Box>
            <Typography sx={{ fontSize: '0.8rem', color: c.text.primary }}>Add SSH connection</Typography>
          </Box>
        </Box>
        <Box sx={{ borderTop: `1px solid ${c.border.subtle}`, my: 0.5 }} />
        <Typography
          sx={{ fontSize: '0.7rem', color: c.text.ghost, fontWeight: 600, px: 1.5, py: 0.25, textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          Remote control
        </Typography>
        <Box sx={itemSx} onClick={() => setEnvAnchor(null)}>
          <AddIcon sx={{ fontSize: 16, color: c.text.muted }} />
          <Typography sx={{ fontSize: '0.8rem', color: c.text.primary }}>Add remote control</Typography>
        </Box>
        <Box sx={{ borderTop: `1px solid ${c.border.subtle}`, my: 0.5 }} />
        <Typography
          sx={{ fontSize: '0.7rem', color: c.text.ghost, fontWeight: 600, px: 1.5, py: 0.25, textTransform: 'uppercase', letterSpacing: '0.05em' }}
        >
          Cloud environments
        </Typography>
        <Box sx={itemSx} onClick={() => setEnvAnchor(null)}>
          <AddIcon sx={{ fontSize: 16, color: c.text.muted }} />
          <Typography sx={{ fontSize: '0.8rem', color: c.text.primary }}>Add environment</Typography>
        </Box>
      </Popover>
    </Box>
  );
};

export default ToolbarStatusBar;
