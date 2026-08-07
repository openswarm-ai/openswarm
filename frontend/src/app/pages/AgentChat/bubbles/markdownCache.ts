import { createElement, type ReactNode } from 'react';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime';
import { urlAttributes } from 'html-url-attributes';
import { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit, type BuildVisitor } from 'unist-util-visit';
import type { Root } from 'hast';

// Mirrors react-markdown@10.1.0's parse -> run -> post pipeline so a finished message's parsed tree can live in a module-level LRU and survive remounts (session switch, scroll re-entry of windowed blocks). markdownCache.test.ts asserts byte-identical HTML against the real <ReactMarkdown>, so any upgrade that drifts the pipeline fails loudly instead of silently.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true });

export const transcriptComponents: Partial<Components> = {
  a: ({ children, node, ...props }) => {
    void node;
    return createElement('a', { ...props, style: { cursor: 'pointer' } }, children);
  },
};

const transform: BuildVisitor<Root> = (node, index, parent) => {
  if (node.type === 'raw' && parent && typeof index === 'number') {
    parent.children[index] = { type: 'text', value: node.value };
    return index;
  }
  if (node.type === 'element') {
    let key: string;
    for (key in urlAttributes) {
      if (Object.hasOwn(urlAttributes, key) && Object.hasOwn(node.properties, key)) {
        const value = node.properties[key];
        const test = urlAttributes[key];
        if (test === null || test.includes(node.tagName)) {
          node.properties[key] = defaultUrlTransform(String(value || ''));
        }
      }
    }
  }
  return undefined;
};

/** Parse + render markdown to a React tree right now, no caching. The streaming path uses this so per-chunk prefixes never churn the LRU. */
export function renderMarkdownNow(text: string): ReactNode {
  const mdast = processor.parse(text);
  const hast = processor.runSync(mdast) as Root;
  visit(hast, transform);
  return toJsxRuntime(hast, {
    Fragment,
    components: transcriptComponents,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  });
}

const CACHE_MAX = 200;
const cache = new Map<string, ReactNode>();

/** Cached render for FINISHED text only: same text in, same immutable element tree out, across remounts. */
export function renderMarkdownCached(text: string): ReactNode {
  const hit = cache.get(text);
  if (hit !== undefined) {
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const el = renderMarkdownNow(text);
  cache.set(text, el);
  if (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value as string);
  }
  return el;
}
