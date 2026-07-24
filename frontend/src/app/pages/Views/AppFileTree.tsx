// Workspace file-tree primitives shared by ViewEditor's Code tab and the dashboard card's AppCodePanel.
import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Collapse from '@mui/material/Collapse';
import HtmlIcon from '@mui/icons-material/Code';
import PythonIcon from '@mui/icons-material/Terminal';
import SchemaIcon from '@mui/icons-material/DataObject';
import JsIcon from '@mui/icons-material/Javascript';
import CssIcon from '@mui/icons-material/Style';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import FolderIcon from '@mui/icons-material/Folder';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

// File-tree noise: filtered by basename anywhere in the path; callers may offer a "show hidden" bypass.
export const HIDDEN_PATH_SEGMENTS = new Set<string>([
  'node_modules',
  '.vite-cache',
  '.vite',
  '.git',
  'dist',
  '.next',
  '__pycache__',
  '.venv',
  '.openswarm',
]);

export function isHiddenWorkspacePath(p: string): boolean {
  for (const seg of p.split('/')) {
    if (HIDDEN_PATH_SEGMENTS.has(seg)) return true;
  }
  return false;
}

export function getFileIcon(filename: string): React.ReactNode {
  const ext = filename.split('.').pop()?.toLowerCase();
  const size = 15;
  switch (ext) {
    case 'html': case 'htm': return <HtmlIcon sx={{ fontSize: size }} />;
    case 'py': return <PythonIcon sx={{ fontSize: size }} />;
    case 'json': return <SchemaIcon sx={{ fontSize: size }} />;
    case 'js': case 'jsx': case 'ts': case 'tsx': return <JsIcon sx={{ fontSize: size }} />;
    case 'css': case 'scss': case 'less': return <CssIcon sx={{ fontSize: size }} />;
    default: return <InsertDriveFileIcon sx={{ fontSize: size }} />;
  }
}

export function getEditorLanguage(filename: string): 'html' | 'python' | 'json' {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py': return 'python';
    case 'json': return 'json';
    default: return 'html';
  }
}

export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
}

export function buildFileTree(filePaths: string[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const sorted = [...filePaths].sort();

  for (const fp of sorted) {
    const parts = fp.split('/');
    let current = root;
    let pathSoFar = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      const isLast = i === parts.length - 1;

      let existing = current.find(n => n.name === part && n.isDir === !isLast);
      if (!existing) {
        if (isLast) {
          existing = { name: part, path: fp, isDir: false };
        } else {
          existing = { name: part, path: pathSoFar, isDir: true, children: [] };
        }
        current.push(existing);
      }
      if (!isLast) {
        current = existing.children!;
      }
    }
  }

  return root;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  activeFile: string;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
  c: ReturnType<typeof useClaudeTokens>;
}

const PROTECTED_FILES = new Set(['index.html', 'schema.json', 'meta.json', 'SKILL.md']);

export const FileTreeItem: React.FC<FileTreeItemProps> = ({ node, depth, activeFile, onSelect, onDelete, c }) => {
  const [open, setOpen] = useState(true);

  if (node.isDir) {
    return (
      <>
        <Box
          onClick={() => setOpen(!open)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            pl: 1.5 + depth * 1,
            pr: 1,
            py: 0.5,
            cursor: 'pointer',
            '&:hover': { bgcolor: c.bg.surface },
          }}
        >
          <ExpandMoreIcon sx={{ fontSize: 12, color: c.text.ghost, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: '0.15s' }} />
          <FolderIcon sx={{ fontSize: 14, color: c.text.muted }} />
          <Typography sx={{ fontSize: '0.75rem', color: c.text.secondary, fontFamily: c.font.mono }}>
            {node.name}
          </Typography>
        </Box>
        <Collapse in={open}>
          {node.children?.map((child) => (
            <FileTreeItem key={child.path} node={child} depth={depth + 1} activeFile={activeFile} onSelect={onSelect} onDelete={onDelete} c={c} />
          ))}
        </Collapse>
      </>
    );
  }

  const isActive = activeFile === node.path;
  const canDelete = onDelete && !PROTECTED_FILES.has(node.path);

  return (
    <Box
      onClick={() => onSelect(node.path)}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        pl: 1.5 + depth * 1 + 1.25,
        pr: 0.5,
        py: 0.5,
        cursor: 'pointer',
        bgcolor: isActive ? c.bg.elevated : 'transparent',
        borderLeft: isActive ? `2px solid ${c.accent.primary}` : '2px solid transparent',
        '&:hover': { bgcolor: isActive ? c.bg.elevated : c.bg.surface },
        '&:hover .delete-btn': { opacity: 1 },
        transition: 'background-color 0.1s',
      }}
    >
      <Box sx={{ color: isActive ? c.accent.primary : c.text.muted, display: 'flex', flexShrink: 0 }}>
        {getFileIcon(node.name)}
      </Box>
      <Typography
        sx={{
          fontSize: '0.75rem',
          fontFamily: c.font.mono,
          color: isActive ? c.text.primary : c.text.secondary,
          fontWeight: isActive ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
      >
        {node.name}
      </Typography>
      {canDelete && (
        <IconButton
          className="delete-btn"
          size="small"
          onClick={(e) => { e.stopPropagation(); onDelete(node.path); }}
          sx={{ opacity: 0, p: 0.25, color: c.text.ghost, '&:hover': { color: '#ef4444' }, transition: 'opacity 0.15s, color 0.15s' }}
        >
          <DeleteOutlineIcon sx={{ fontSize: 14 }} />
        </IconButton>
      )}
    </Box>
  );
};
