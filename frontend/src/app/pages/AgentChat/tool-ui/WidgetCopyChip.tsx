import React, { useCallback, useRef, useState, type RefObject } from 'react';
import Box from '@mui/material/Box';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import { toPng } from 'html-to-image';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';

interface WidgetCopyChipProps {
  /** The vendored component name ('data-table', 'chart', ...) or a ShowUI alias. */
  component: string;
  props: Record<string, unknown>;
  /** The rendered widget's container, for image capture. */
  containerRef: RefObject<HTMLElement | null>;
}

function tableToTsv(props: Record<string, unknown>): string | null {
  const columns = props.columns as Array<{ key: string; label: string }> | undefined;
  const data = props.data as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(columns) || !Array.isArray(data)) return null;
  const head = columns.map((col) => String(col.label ?? col.key)).join('\t');
  const rows = data.map((row) => columns.map((col) => {
    const v = (row as Record<string, unknown>)[col.key];
    return v === null || v === undefined ? '' : String(v);
  }).join('\t'));
  return [head, ...rows].join('\n');
}

// Non-text widget outputs need their own copy: a table copies as TSV (pastes straight into
// Sheets/Excel), a visual copies as a PNG, code copies its source. Hover chip, top-right.
const WidgetCopyChip: React.FC<WidgetCopyChipProps> = ({ component, props, containerRef }) => {
  const c = useClaudeTokens();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashCopied = useCallback(() => {
    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 1200);
  }, []);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (component === 'data-table') {
        const tsv = tableToTsv(props);
        if (tsv) { await navigator.clipboard.writeText(tsv); flashCopied(); return; }
      }
      if (component === 'code-block' && typeof props.code === 'string') {
        await navigator.clipboard.writeText(props.code); flashCopied(); return;
      }
      if (component === 'code-diff') {
        const body = typeof props.patch === 'string' ? props.patch : `${props.oldCode ?? ''}\n---\n${props.newCode ?? ''}`;
        await navigator.clipboard.writeText(body); flashCopied(); return;
      }
      const node = containerRef.current;
      if (node) {
        // Visuals (chart, stats, map, image...) copy as a real image; 2x for retina-crisp pastes.
        // skipFonts: the Google Fonts stylesheets are CSP-blocked for fetch, so embedding them only logs errors and changes nothing.
        const dataUrl = await toPng(node as HTMLElement, { pixelRatio: 2, skipFonts: true });
        const blob = await (await fetch(dataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        flashCopied();
        return;
      }
      await navigator.clipboard.writeText(JSON.stringify(props, null, 2));
      flashCopied();
    } catch {
      try { await navigator.clipboard.writeText(JSON.stringify(props, null, 2)); flashCopied(); } catch { /* clipboard denied: chip just doesn't flash */ }
    }
  }, [component, props, containerRef, flashCopied]);

  return (
    <Box
      role="button"
      aria-label={copied ? 'Copied' : 'Copy'}
      onClick={handleCopy}
      className="osw-widget-copy"
      sx={{
        position: 'absolute',
        top: 6,
        right: 6,
        zIndex: 5,
        width: 24,
        height: 24,
        borderRadius: '7px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: c.bg.elevated,
        border: `1px solid ${c.border.medium}`,
        color: copied ? c.status.success : c.text.tertiary,
        cursor: 'pointer',
        opacity: 0,
        transition: 'opacity 0.15s ease, color 0.15s ease',
        '&:hover': { color: copied ? c.status.success : c.text.primary },
      }}
    >
      {copied ? <CheckIcon sx={{ fontSize: 14 }} /> : <ContentCopyIcon sx={{ fontSize: 13 }} />}
    </Box>
  );
};

export default WidgetCopyChip;
