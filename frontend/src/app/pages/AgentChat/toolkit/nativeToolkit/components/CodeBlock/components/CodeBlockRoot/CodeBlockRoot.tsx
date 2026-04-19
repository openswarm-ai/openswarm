"use client";

import {
  useState,
  useCallback,
  useEffect,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { type Highlighter } from "shiki/bundle/web";
import type { CodeBlockProps } from "../../schema";
import { useCopyToClipboard } from "../../../_shared/useCopyToClipboard";
import { cn, Collapsible } from "../../_adapter";
import { useResolvedTheme, getHighlighter, getCacheKey, setCachedHtml, htmlCache } from "./helpers";

const COPY_ID = "codeblock-code";

export type CodeBlockRootProps = CodeBlockProps & {
  children: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

type CodeBlockSharedState = {
  id: string;
  code: string;
  language: string;
  filename?: string;
  highlightedHtml: string | null;
  isCopied: boolean;
  copyCode: () => void;
  lineCount: number;
  isCollapsed: boolean;
  shouldCollapse: boolean;
  toggleExpanded: () => void;
};

const CodeBlockContext = createContext<CodeBlockSharedState | null>(null);

export function useCodeBlock(): CodeBlockSharedState {
  const context = useContext(CodeBlockContext);
  if (!context) {
    throw new Error(
      "CodeBlock subcomponents must be used within <CodeBlock.Root>.",
    );
  }
  return context;
}

export function CodeBlockRoot({
  id,
  code,
  language = "text",
  lineNumbers = "visible",
  filename,
  highlightLines,
  maxCollapsedLines,
  className,
  children,
  expanded: expandedProp,
  defaultExpanded = false,
  onExpandedChange,
}: CodeBlockRootProps) {
  const resolvedTheme = useResolvedTheme();
  const [expandedState, setExpandedState] = useState(defaultExpanded);
  const { copiedId, copy } = useCopyToClipboard();
  const isCopied = copiedId === COPY_ID;

  const expanded = expandedProp ?? expandedState;
  const setExpanded = useCallback(
    (nextExpanded: boolean) => {
      if (expandedProp === undefined) {
        setExpandedState(nextExpanded);
      }
      onExpandedChange?.(nextExpanded);
    },
    [expandedProp, onExpandedChange],
  );

  const theme = resolvedTheme === "dark" ? "pierre-dark" : "pierre-light";
  const cacheKey = getCacheKey(
    code,
    language,
    theme,
    lineNumbers,
    highlightLines,
  );

  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(
    () => htmlCache.get(cacheKey) ?? null,
  );

  useEffect(() => {
    const cached = htmlCache.get(cacheKey);
    if (cached) {
      setHighlightedHtml(cached);
      return;
    }

    let cancelled = false;
    const showLineNumbers = lineNumbers === "visible";

    async function highlight() {
      if (!code) {
        if (!cancelled) setHighlightedHtml("");
        return;
      }

      try {
        const highlighter = await getHighlighter();
        const loadedLangs = highlighter.getLoadedLanguages();

        if (!loadedLangs.includes(language)) {
          await highlighter.loadLanguage(
            language as Parameters<Highlighter["loadLanguage"]>[0],
          );
        }

        const lineCount = code.split("\n").length;
        const lineNumberWidth = `${String(lineCount).length + 0.5}ch`;

        const html = highlighter.codeToHtml(code, {
          lang: language,
          theme,
          transformers: [
            {
              line(node, line) {
                node.properties["data-line"] = line;
                if (highlightLines?.includes(line)) {
                  const highlightBg =
                    resolvedTheme === "dark"
                      ? "rgba(255,255,255,0.1)"
                      : "rgba(0,0,0,0.05)";
                  node.properties.style = `background:${highlightBg};`;
                }
                if (showLineNumbers) {
                  node.children.unshift({
                    type: "element",
                    tagName: "span",
                    properties: {
                      style: `display:inline-block;width:${lineNumberWidth};text-align:right;margin-right:1.5em;user-select:none;opacity:0.5;`,
                      "aria-hidden": "true",
                    },
                    children: [{ type: "text", value: String(line) }],
                  });
                }
              },
            },
          ],
        });
        if (!cancelled) {
          setCachedHtml(cacheKey, html);
          setHighlightedHtml(html);
        }
      } catch {
        const escaped = code
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        if (!cancelled) {
          setHighlightedHtml(`<pre><code>${escaped}</code></pre>`);
        }
      }
    }
    void highlight();
    return () => {
      cancelled = true;
    };
  }, [
    cacheKey,
    code,
    language,
    lineNumbers,
    theme,
    highlightLines,
    resolvedTheme,
  ]);

  const lineCount = code.split("\n").length;
  const shouldCollapse = !!maxCollapsedLines && lineCount > maxCollapsedLines;
  const isCollapsed = shouldCollapse && !expanded;

  const copyCode = useCallback(() => {
    void copy(code, COPY_ID);
  }, [code, copy]);

  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded, setExpanded]);

  const state: CodeBlockSharedState = {
    id,
    code,
    language,
    filename,
    highlightedHtml,
    isCopied,
    copyCode,
    lineCount,
    shouldCollapse,
    isCollapsed,
    toggleExpanded,
  };

  return (
    <CodeBlockContext.Provider value={state}>
      <div
        className={cn(
          "@container flex w-full min-w-80 flex-col gap-3",
          className,
        )}
        data-tool-ui-id={id}
        data-slot="code-block"
      >
        <div className="border-border bg-card overflow-hidden rounded-lg border shadow-xs">
          <Collapsible open={!isCollapsed}>{children}</Collapsible>
        </div>
      </div>
    </CodeBlockContext.Provider>
  );
}
