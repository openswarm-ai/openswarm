// Run: node --test frontend/src/app/pages/AgentChat/bubbles/markdownCache.test.ts
// Byte-parity guard: the cached pipeline must render EXACTLY what <ReactMarkdown> renders, or a react-markdown upgrade has drifted the mirror.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { renderMarkdownCached, renderMarkdownNow, transcriptComponents } from './markdownCache.ts';

const fixtures: Record<string, string> = {
  prose: 'Hello **world**, some *emphasis* and `inline code`.',
  link: 'A [link](https://example.com/a?b=c#d) and an autolink https://example.com/auto.',
  unsafeLink: 'Bad [click me](javascript:alert(1)) link and [data](data:text/html;base64,x).',
  image: '![alt text](https://example.com/img.png "title")',
  table: '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |',
  codeFence: '```ts\nconst x: number = 42;\nfunction f(a: string): string { return a + x; }\n```',
  taskList: '- [x] done thing\n- [ ] open thing',
  strikethrough: 'This is ~~gone~~ kept.',
  rawHtml: 'Before <div class="x">inside</div> after, and <script>alert(1)</script> too.',
  headingsQuotes: '# Title\n\n## Sub\n\n> a quote\n\n---\n\n1. one\n2. two',
  footnote: 'A claim.[^1]\n\n[^1]: The source.',
  mixed: '## Report\n\n| metric | value |\n| --- | --- |\n| speed | **fast** |\n\n```py\nprint("hi")\n```\n\n- item with [ref](https://x.dev)\n',
};

const reference = (text: string): string =>
  renderToString(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components: transcriptComponents }, text),
  );

for (const [name, text] of Object.entries(fixtures)) {
  test(`parity: ${name}`, () => {
    assert.equal(renderToString(createElement(() => renderMarkdownNow(text) as never)), reference(text));
  });
}

test('cache returns the identical element tree across calls', () => {
  const a = renderMarkdownCached('Same **text** twice.');
  const b = renderMarkdownCached('Same **text** twice.');
  assert.equal(a, b);
});

test('cache is bounded', async () => {
  for (let i = 0; i < 260; i++) renderMarkdownCached(`unique filler number ${i}`);
  const early = renderMarkdownCached('unique filler number 1');
  const earlyAgain = renderMarkdownCached('unique filler number 1');
  assert.equal(early, earlyAgain);
});
