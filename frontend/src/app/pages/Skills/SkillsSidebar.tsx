import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Collapse from '@mui/material/Collapse';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import CircularProgress from '@mui/material/CircularProgress';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import FolderIcon from '@mui/icons-material/Folder';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import type { Skill, RegistrySkill } from '@/shared/backend-bridge/apps/skills';
import { SIDEBAR_W } from './skillsTypes';
import SidebarRow from './SidebarRow';

interface SkillsSidebarProps {
  searchFilter: string;
  onSearchFilterChange: (v: string) => void;
  filteredLocal: Skill[];
  regGrouped: Record<string, RegistrySkill[]>;
  categoryOrder: string[];
  collapsedCats: Record<string, boolean>;
  onToggleCategory: (cat: string) => void;
  showLoadingSpinner: boolean;
  isSelected: (type: 'registry' | 'local', key: string) => boolean;
  onSelectLocal: (id: string) => void;
  onSelectRegistry: (name: string) => void;
  onOpenCreate: () => void;
  onOpenBuilder: () => void;
}

const SkillsSidebar: React.FC<SkillsSidebarProps> = ({
  searchFilter, onSearchFilterChange, filteredLocal, regGrouped, categoryOrder,
  collapsedCats, onToggleCategory, showLoadingSpinner,
  isSelected, onSelectLocal, onSelectRegistry, onOpenCreate, onOpenBuilder,
}) => {
  const c = useClaudeTokens();

  return (
    <Box
      sx={{
        width: SIDEBAR_W, minWidth: SIDEBAR_W, height: '100%', display: 'flex', flexDirection: 'column',
        borderRight: `${c.border.width} solid ${c.border.subtle}`, bgcolor: 'transparent',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2, pt: 2, pb: 1 }}>
        <Typography sx={{ fontSize: '0.92rem', fontWeight: 700, color: c.text.primary }}>Skills</Typography>
        <Box sx={{ display: 'flex', gap: 0.25 }}>
          <Tooltip title="Search">
            <IconButton
              size="small"
              onClick={() => onSearchFilterChange(searchFilter === '' ? ' ' : '')}
              sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}
            >
              <SearchIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Create skill">
            <IconButton size="small" onClick={onOpenCreate} sx={{ color: c.text.tertiary, '&:hover': { color: c.text.primary } }}>
              <AddIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      <Box sx={{ px: 1.5, pb: 0.5 }}>
        <Button
          size="small"
          startIcon={<AutoFixHighIcon sx={{ fontSize: 14 }} />}
          onClick={onOpenBuilder}
          fullWidth
          sx={{
            textTransform: 'none', fontSize: '0.76rem', fontWeight: 500,
            color: c.accent.primary, justifyContent: 'flex-start', py: 0.5, px: 1,
            borderRadius: `${c.radius.sm}px`,
            border: `1px dashed ${c.accent.primary}40`,
            '&:hover': { bgcolor: `${c.accent.primary}08`, borderColor: c.accent.primary },
          }}
        >
          Build with AI
        </Button>
      </Box>

      <Collapse in={searchFilter !== ''}>
        <Box sx={{ px: 1.5, pb: 1 }}>
          <TextField
            placeholder="Filter skills..."
            value={searchFilter.trim()}
            onChange={(e) => onSearchFilterChange(e.target.value)}
            fullWidth
            size="small"
            autoFocus
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 16, color: c.text.ghost }} />
                </InputAdornment>
              ),
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                bgcolor: c.bg.surface, borderRadius: `${c.radius.sm}px`, fontSize: '0.82rem',
                '& fieldset': { borderColor: c.border.medium },
              },
            }}
          />
        </Box>
      </Collapse>

      <Box
        sx={{
          flex: 1, overflow: 'auto', px: 0.75, pb: 2,
          '&::-webkit-scrollbar': { width: 4 },
          '&::-webkit-scrollbar-thumb': { background: c.border.medium, borderRadius: 2 },
        }}
      >
        {filteredLocal.length > 0 && (
          <Box sx={{ mb: 1 }}>
            <Box
              onClick={() => onToggleCategory('__local')}
              sx={{
                display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5,
                cursor: 'pointer', userSelect: 'none',
                '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' }, borderRadius: `${c.radius.sm}px`,
              }}
            >
              {collapsedCats['__local']
                ? <KeyboardArrowRightIcon sx={{ fontSize: 16, color: c.text.ghost }} />
                : <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost }} />}
              <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                My Skills
              </Typography>
              <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, ml: 0.5 }}>({filteredLocal.length})</Typography>
            </Box>
            <Collapse in={!collapsedCats['__local']}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, mt: 0.25 }}>
                {filteredLocal.map((sk) => (
                  <SidebarRow
                    key={sk.id}
                    label={sk.name}
                    selected={isSelected('local', sk.id)}
                    onClick={() => onSelectLocal(sk.id)}
                    icon={<FolderIcon sx={{ fontSize: 15, color: c.text.tertiary, flexShrink: 0 }} />}
                  />
                ))}
              </Box>
            </Collapse>
          </Box>
        )}

        {showLoadingSpinner ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', pt: 6 }}>
            <CircularProgress size={22} sx={{ color: c.accent.primary }} />
          </Box>
        ) : (
          categoryOrder.map((cat) => {
            const group = regGrouped[cat];
            if (!group || group.length === 0) return null;
            const isCollapsed = !!collapsedCats[cat];
            return (
              <Box key={cat} sx={{ mb: 0.5 }}>
                <Box
                  onClick={() => onToggleCategory(cat)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5,
                    cursor: 'pointer', userSelect: 'none',
                    '&:hover': { bgcolor: 'rgba(0,0,0,0.02)' }, borderRadius: `${c.radius.sm}px`,
                  }}
                >
                  {isCollapsed
                    ? <KeyboardArrowRightIcon sx={{ fontSize: 16, color: c.text.ghost }} />
                    : <KeyboardArrowDownIcon sx={{ fontSize: 16, color: c.text.ghost }} />}
                  <Typography sx={{ fontSize: '0.72rem', fontWeight: 600, color: c.text.tertiary, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    {cat}
                  </Typography>
                  <Typography sx={{ fontSize: '0.68rem', color: c.text.ghost, ml: 0.5 }}>({group.length})</Typography>
                </Box>
                <Collapse in={!isCollapsed}>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, mt: 0.25 }}>
                    {group.map((sk) => (
                      <SidebarRow
                        key={sk.name}
                        label={sk.name}
                        selected={isSelected('registry', sk.name)}
                        onClick={() => onSelectRegistry(sk.name)}
                      />
                    ))}
                  </Box>
                </Collapse>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
};

export default SkillsSidebar;
