import React, { useState, useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import DescriptionIcon from '@mui/icons-material/Description';
import PsychologyIcon from '@mui/icons-material/Psychology';
import { useAppSelector } from '@/shared/hooks';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

export interface SlashItem {
  id: string;
  type: 'template' | 'skill';
  name: string;
  description: string;
  command: string;
}

interface Props {
  filter: string;
  onSelect: (item: SlashItem) => void;
  onClose: () => void;
  visible: boolean;
}

const SlashCommandPicker: React.FC<Props> = ({ filter, onSelect, onClose, visible }) => {
  const c = useClaudeTokens();
  const templates = useAppSelector((state) => state.templates.items);
  const skills = useAppSelector((state) => state.skills.items);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const items: SlashItem[] = useMemo(() => {
    const all: SlashItem[] = [
      ...Object.values(templates).map((t) => ({
        id: t.id,
        type: 'template' as const,
        name: t.name,
        description: t.description || `Template with ${t.fields.length} fields`,
        command: t.name.toLowerCase().replace(/\s+/g, '-'),
      })),
      ...Object.values(skills).map((s) => ({
        id: s.id,
        type: 'skill' as const,
        name: s.name,
        description: s.description || 'Skill',
        command: s.command || s.id,
      })),
    ];

    if (!filter) return all;
    const lower = filter.toLowerCase();
    return all.filter(
      (item) =>
        item.name.toLowerCase().includes(lower) ||
        item.command.toLowerCase().includes(lower) ||
        item.description.toLowerCase().includes(lower)
    );
  }, [templates, skills, filter]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && items[selectedIndex]) {
        e.preventDefault();
        onSelect(items[selectedIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [visible, items, selectedIndex, onSelect, onClose]);

  if (!visible || items.length === 0) return null;

  return (
    <Paper
      sx={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        mb: 0.5,
        bgcolor: c.bg.surface,
        border: `1px solid ${c.border.subtle}`,
        borderRadius: 3,
        maxHeight: 280,
        overflow: 'auto',
        zIndex: 1000,
        boxShadow: c.shadow.lg,
        '&::-webkit-scrollbar': { width: 5 },
        '&::-webkit-scrollbar-track': { background: 'transparent' },
        '&::-webkit-scrollbar-thumb': {
          background: c.border.medium,
          borderRadius: 3,
          '&:hover': { background: c.border.strong },
        },
        scrollbarWidth: 'thin',
        scrollbarColor: `${c.border.medium} transparent`,
      }}
    >
      <Box sx={{ px: 1.5, py: 1, borderBottom: `0.5px solid ${c.border.medium}` }}>
        <Typography sx={{ color: c.text.tertiary, fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>
          Commands
        </Typography>
      </Box>
      <List sx={{ py: 0.5 }}>
        {items.map((item, i) => (
          <ListItemButton
            key={`${item.type}-${item.id}`}
            selected={i === selectedIndex}
            onClick={() => onSelect(item)}
            sx={{
              py: 0.75,
              px: 1.5,
              '&.Mui-selected': { bgcolor: 'rgba(174,86,48,0.06)' },
              '&:hover': { bgcolor: 'rgba(0,0,0,0.04)' },
            }}
          >
            <ListItemIcon sx={{ minWidth: 32 }}>
              {item.type === 'template' ? (
                <DescriptionIcon sx={{ fontSize: 18, color: c.accent.primary }} />
              ) : (
                <PsychologyIcon sx={{ fontSize: 18, color: c.status.success }} />
              )}
            </ListItemIcon>
            <ListItemText
              primary={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography sx={{ color: c.text.primary, fontSize: '0.8rem', fontWeight: 500 }}>
                    /{item.command}
                  </Typography>
                  <Typography sx={{ color: c.text.ghost, fontSize: '0.7rem' }}>
                    {item.type}
                  </Typography>
                </Box>
              }
              secondary={
                <Typography sx={{ color: c.text.tertiary, fontSize: '0.7rem', mt: 0.25 }}>
                  {item.description}
                </Typography>
              }
            />
          </ListItemButton>
        ))}
      </List>
    </Paper>
  );
};

export default SlashCommandPicker;
