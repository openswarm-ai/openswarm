import React from 'react';
import { useThemeMode } from '@/shared/styles/ThemeContext';
import { parseMcpToolName } from '@/shared/mcpToolMeta';
import { isBashTool } from './toolResultParsing';

export interface TermColors {
  TERM_BG: string;
  TERM_BORDER: string;
  PROMPT_COLOR: string;
  CMD_COLOR: string;
  OUTPUT_COLOR: string;
  PATH_COLOR: string;
  ADD_COLOR: string;
  DEL_COLOR: string;
  STDERR_COLOR: string;
  WARN_COLOR: string;
  NUM_COLOR: string;
  DIM_COLOR: string;
  DIFF_HEADER_COLOR: string;
  SCROLLBAR_THUMB: string;
}

const darkTermColors: TermColors = {
  TERM_BG: '#131520',
  TERM_BORDER: '#1e2030',
  PROMPT_COLOR: '#7ec699',
  CMD_COLOR: '#e8ecf4',
  OUTPUT_COLOR: '#a0aab8',
  PATH_COLOR: '#82aaff',
  ADD_COLOR: '#7ec699',
  DEL_COLOR: '#ff8787',
  STDERR_COLOR: '#ff8787',
  WARN_COLOR: '#ffcb6b',
  NUM_COLOR: '#f78c6c',
  DIM_COLOR: '#555b6e',
  DIFF_HEADER_COLOR: '#c792ea',
  SCROLLBAR_THUMB: '#2a2d3e',
};

const lightTermColors: TermColors = {
  TERM_BG: '#f4f3ee',
  TERM_BORDER: '#e2e0d8',
  PROMPT_COLOR: '#2d7a3e',
  CMD_COLOR: '#2a2a28',
  OUTPUT_COLOR: '#555550',
  PATH_COLOR: '#3060a8',
  ADD_COLOR: '#2d7a3e',
  DEL_COLOR: '#c03030',
  STDERR_COLOR: '#c03030',
  WARN_COLOR: '#8a6518',
  NUM_COLOR: '#c05020',
  DIM_COLOR: '#9e9c95',
  DIFF_HEADER_COLOR: '#7c4daa',
  SCROLLBAR_THUMB: '#ccc9c0',
};

export function useTermColors(): TermColors {
  const { mode } = useThemeMode();
  return mode === 'dark' ? darkTermColors : lightTermColors;
}

export function colorizeInput(toolName: string, text: string, tc: TermColors): React.ReactNode {
  const n = toolName.toLowerCase();
  const mcp = parseMcpToolName(toolName);

  if (mcp.isMcp) {
    const lines = text.split('\n');
    return (
      <>
        {lines.map((line, i) => {
          const nl = i < lines.length - 1 ? '\n' : '';
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0 && colonIdx < 30) {
            return (
              <span key={i}>
                <span style={{ color: tc.DIM_COLOR }}>{line.slice(0, colonIdx + 1)}</span>
                <span style={{ color: tc.CMD_COLOR }}>{line.slice(colonIdx + 1)}</span>
                {nl}
              </span>
            );
          }
          return <span key={i} style={{ color: tc.CMD_COLOR }}>{line}{nl}</span>;
        })}
      </>
    );
  }

  if (isBashTool(toolName)) return <span style={{ color: tc.CMD_COLOR }}>{text}</span>;

  if (n === 'edit' || n === 'strreplace' || n === 'multiedit') {
    const lines = text.split('\n');
    return (
      <>
        {lines.map((line, i) => {
          const nl = i < lines.length - 1 ? '\n' : '';
          if (i === 0 && (line.startsWith('/') || line.includes('.')))
            return <span key={i} style={{ color: tc.PATH_COLOR }}>{line}{nl}</span>;
          if (line.startsWith('+ '))
            return <span key={i} style={{ color: tc.ADD_COLOR }}>{line}{nl}</span>;
          if (line.startsWith('- '))
            return <span key={i} style={{ color: tc.DEL_COLOR }}>{line}{nl}</span>;
          return <span key={i} style={{ color: tc.CMD_COLOR }}>{line}{nl}</span>;
        })}
      </>
    );
  }

  if (n === 'write') {
    const lines = text.split('\n');
    return (
      <>
        {lines.map((line, i) => {
          const nl = i < lines.length - 1 ? '\n' : '';
          if (i === 0 && (line.startsWith('/') || line.includes('.')))
            return <span key={i} style={{ color: tc.PATH_COLOR }}>{line}{nl}</span>;
          return <span key={i} style={{ color: tc.CMD_COLOR, opacity: 0.7 }}>{line}{nl}</span>;
        })}
      </>
    );
  }

  if (n === 'read' || n === 'glob' || n === 'webfetch') {
    if (/^\//.test(text) || text.includes('/'))
      return <span style={{ color: tc.PATH_COLOR }}>{text}</span>;
  }

  if (n === 'grep' || n === 'ripgrep') {
    const lines = text.split('\n');
    return (
      <>
        {lines.map((line, i) => {
          const nl = i < lines.length - 1 ? '\n' : '';
          if (line.startsWith('pattern:'))
            return (
              <span key={i}>
                <span style={{ color: tc.DIM_COLOR }}>pattern: </span>
                <span style={{ color: tc.WARN_COLOR }}>{line.slice(9)}</span>
                {nl}
              </span>
            );
          if (line.startsWith('path:'))
            return (
              <span key={i}>
                <span style={{ color: tc.DIM_COLOR }}>path: </span>
                <span style={{ color: tc.PATH_COLOR }}>{line.slice(6)}</span>
                {nl}
              </span>
            );
          return <span key={i} style={{ color: tc.CMD_COLOR }}>{line}{nl}</span>;
        })}
      </>
    );
  }

  return <span style={{ color: tc.CMD_COLOR }}>{text}</span>;
}

export function colorizeOutput(toolName: string, text: string, tc: TermColors): React.ReactNode {
  if (!text) return <span style={{ color: tc.DIM_COLOR, fontStyle: 'italic' }}>(empty)</span>;

  const lines = text.split('\n');
  const n = toolName.toLowerCase();

  return (
    <>
      {lines.map((line, i) => {
        const nl = i < lines.length - 1 ? '\n' : '';
        const trimmed = line.trimStart();

        if (/^\/\S+/.test(trimmed))
          return <span key={i} style={{ color: tc.PATH_COLOR }}>{line}{nl}</span>;

        if (n === 'grep' || n === 'ripgrep') {
          const grepMatch = line.match(/^(\S+?:\d+[:-])/);
          if (grepMatch) {
            return (
              <span key={i}>
                <span style={{ color: tc.PATH_COLOR }}>{grepMatch[1]}</span>
                <span style={{ color: tc.OUTPUT_COLOR }}>{line.slice(grepMatch[1].length)}</span>
                {nl}
              </span>
            );
          }
          const fileHeader = line.match(/^(\S+\.\w+)$/);
          if (fileHeader)
            return <span key={i} style={{ color: tc.PATH_COLOR, fontWeight: 600 }}>{line}{nl}</span>;
        }

        if (line.startsWith('@@') && line.includes('@@'))
          return <span key={i} style={{ color: tc.DIFF_HEADER_COLOR }}>{line}{nl}</span>;
        if (line.startsWith('+'))
          return <span key={i} style={{ color: tc.ADD_COLOR }}>{line}{nl}</span>;
        if (line.startsWith('-'))
          return <span key={i} style={{ color: tc.DEL_COLOR }}>{line}{nl}</span>;

        if (/\b[Ee]rror\b/.test(line))
          return <span key={i} style={{ color: tc.STDERR_COLOR }}>{line}{nl}</span>;
        if (/\b[Ww]arning\b/.test(line))
          return <span key={i} style={{ color: tc.WARN_COLOR }}>{line}{nl}</span>;

        if (n === 'read') {
          const lineNumMatch = line.match(/^(\s*\d+\s*[|:])/);
          if (lineNumMatch) {
            return (
              <span key={i}>
                <span style={{ color: tc.NUM_COLOR, opacity: 0.6 }}>{lineNumMatch[1]}</span>
                <span style={{ color: tc.OUTPUT_COLOR }}>{line.slice(lineNumMatch[1].length)}</span>
                {nl}
              </span>
            );
          }
        }

        return <span key={i} style={{ color: tc.OUTPUT_COLOR }}>{line}{nl}</span>;
      })}
    </>
  );
}
