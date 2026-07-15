import React, { useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { estimateRenderedTextHeight, RECHECK_VISIBILITY_EVENT } from './markdownMeasure';

// Intra-message virtualization for very long assistant messages. The text is split into FIXED blocks (each block always covers the same character range), so unlike the old growing-tail chunking nothing shifts as you scroll, and no scroll correction is needed. Only blocks within a screen of the viewport actually render their markdown; the rest are height-reserved placeholders, so an extremely long message never parses or mounts more than the on-screen portion plus a buffer.

export const BLOCK_TARGET_CHARS = 4_000;
// Remembered measured height per block (`${messageId}#${index}`). Module-scoped so it survives the block unmounting/remounting as you scroll, keeping the reserved placeholder heights (and thus scroll position) stable.
const blockHeights = new Map<string, number>();

// Split markdown at blank lines that sit OUTSIDE fenced code blocks, so each block is a self-contained markdown fragment we can parse on its own. A fence (``` or ~~~) toggles "inside code" so we never cut a code block in half. Blocks grow to ~targetChars then break at the next safe boundary.
function splitMarkdownIntoBlocks(text: string, targetChars: number): string[] {
  if (text.length <= targetChars) return [text];
  const lines = text.split('\n');
  const blocks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) inFence = !inFence;
    cur.push(line);
    curLen += line.length + 1;
    if (curLen >= targetChars && !inFence && trimmed === '') {
      blocks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks.length ? blocks : [text];
}

const MD_COMPONENTS = {
  a: ({ children, ...props }: any) => (
    <a {...props} style={{ cursor: 'pointer' }}>{children}</a>
  ),
};

const renderBlock = (text: string) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{text}</ReactMarkdown>
);

const MarkdownBlock: React.FC<{
  blockId: string;
  text: string;
  scrollRoot: Element | null;
  viewportHeight: number;
  viewportWidth: number;
}> = React.memo(({ blockId, text, scrollRoot, viewportHeight, viewportWidth }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const bufferPx = Math.max(180, Math.round(viewportHeight || 240));
    // Resolve visibility synchronously (on mount and on demand) so an on-screen block paints its markdown without waiting on the observer's async callback.
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
    if (h > 0) blockHeights.set(blockId, h);
  }, [inView, blockId, text]);

  // chrome=8: block wrappers have minimal padding vs a full bubble.
  const reserved = blockHeights.get(blockId) ?? estimateRenderedTextHeight(text, viewportWidth, 8);

  return (
    <Box ref={ref}>
      {inView ? renderBlock(text) : <Box aria-hidden sx={{ height: reserved }} />}
    </Box>
  );
});

const WindowedMarkdown: React.FC<{
  messageId: string;
  text: string;
  scrollRoot: Element | null;
  viewportHeight: number;
  viewportWidth: number;
}> = ({ messageId, text, scrollRoot, viewportHeight, viewportWidth }) => {
  const blocks = useMemo(() => splitMarkdownIntoBlocks(text, BLOCK_TARGET_CHARS), [text]);
  if (blocks.length === 1) {
    // Short enough that virtualizing would only add overhead.
    return renderBlock(text);
  }
  return (
    <>
      {blocks.map((block, i) => (
        <MarkdownBlock
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

export default WindowedMarkdown;
