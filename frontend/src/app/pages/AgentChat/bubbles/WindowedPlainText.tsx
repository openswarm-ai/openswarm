import React, { useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { estimateRenderedTextHeight, RECHECK_VISIBILITY_EVENT } from './markdownMeasure';
import { renderUserTextWithPills } from './renderUserTextWithPills';
import { useClaudeTokens } from '@/shared/styles/ThemeContext';
import { BLOCK_TARGET_CHARS } from './WindowedMarkdown';

// Intra-message virtualization for very long user (plain-text) messages, mirroring WindowedMarkdown's approach minus fence-awareness (plain text has no code fences to protect).

const plainBlockHeights = new Map<string, number>();

// Split at blank lines so each block is a self-contained chunk of lines. Blocks grow to ~targetChars then break at the next blank-line boundary.
// Plain-text pastes (logs, book/PDF-extracted text) often have no blank lines at all, so a hard ceiling force-cuts at 2x target to guarantee progress.
function splitPlainTextIntoBlocks(text: string, targetChars: number): string[] {
  if (text.length <= targetChars) return [text];
  const lines = text.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const line of lines) {
    cur.push(line);
    curLen += line.length + 1;
    if (curLen >= targetChars && (line.trim() === '' || curLen >= targetChars * 2)) {
      blocks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.length ? blocks : [text];
}

const PlainTextBlock: React.FC<{
  blockId: string;
  text: string;
  scrollRoot: Element | null;
  viewportHeight: number;
  viewportWidth: number;
}> = React.memo(({ blockId, text, scrollRoot, viewportHeight, viewportWidth }) => {
  const c = useClaudeTokens();
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const bufferPx = Math.max(180, Math.round(viewportHeight || 240));
    // Resolve visibility synchronously (on mount and on demand) so an on-screen block paints its text without waiting on the observer's async callback.
    const rootEl: Element = (scrollRoot as Element) ?? document.scrollingElement ?? document.documentElement;
    const evaluate = () => {
      const rootRect = rootEl.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      setInView(nodeRect.bottom >= rootRect.top - bufferPx && nodeRect.top <= rootRect.bottom + bufferPx);
    };
    evaluate();

    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (entry) setInView(entry.isIntersecting);
    }, {
      root: scrollRoot ?? null,
      rootMargin: `${bufferPx}px 0px ${bufferPx}px 0px`,
      threshold: 0,
    });
    observer.observe(node);
    // Re-evaluate when a programmatic jump settles (see RECHECK_VISIBILITY_EVENT).
    scrollRoot?.addEventListener(RECHECK_VISIBILITY_EVENT, evaluate);
    return () => {
      observer.disconnect();
      scrollRoot?.removeEventListener(RECHECK_VISIBILITY_EVENT, evaluate);
    };
  }, [scrollRoot, viewportHeight]);

  // Remember the rendered height so the placeholder reserves exactly that space.
  React.useLayoutEffect(() => {
    if (!inView) return;
    const node = ref.current;
    if (!node) return;
    const h = node.offsetHeight;
    if (h > 0) plainBlockHeights.set(blockId, h);
  }, [inView, blockId, text]);

  // chrome=8: block wrappers have minimal padding vs a full bubble.
  const reserved = plainBlockHeights.get(blockId) ?? estimateRenderedTextHeight(text, viewportWidth, 8);

  return (
    <Box ref={ref}>
      {inView ? (
        <Typography sx={{ color: c.text.primary, fontSize: '0.875rem', lineHeight: 1.6, overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
          {renderUserTextWithPills(text, c)}
        </Typography>
      ) : (
        <Box aria-hidden sx={{ height: reserved }} />
      )}
    </Box>
  );
});

const WindowedPlainText: React.FC<{
  messageId: string;
  text: string;
  scrollRoot: Element | null;
  viewportHeight: number;
  viewportWidth: number;
}> = ({ messageId, text, scrollRoot, viewportHeight, viewportWidth }) => {
  const c = useClaudeTokens();
  const blocks = useMemo(() => splitPlainTextIntoBlocks(text, BLOCK_TARGET_CHARS), [text]);
  if (blocks.length === 1) {
    // Short enough that virtualizing would only add overhead.
    return (
      <Typography sx={{ color: c.text.primary, fontSize: '0.875rem', lineHeight: 1.6, overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
        {renderUserTextWithPills(text, c)}
      </Typography>
    );
  }
  return (
    <>
      {blocks.map((block, i) => (
        <PlainTextBlock
          key={i}
          blockId={`${messageId}#${i}`}
          text={block}
          scrollRoot={scrollRoot}
          viewportHeight={viewportHeight}
          viewportWidth={viewportWidth}
        />
      ))}
    </>
  );
};

export default WindowedPlainText;
