"use client";

import {
  useState,
  useCallback,
  useEffect,
  createContext,
  use,
  type ReactNode,
} from "react";
import { createHighlighter, type Highlighter } from "shiki/bundle/web";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import pierreDarkTheme from "../shared/pierre-dark-theme.js";
import pierreLightTheme from "../shared/pierre-light-theme.js";
import type { CodeBlockLineNumbersMode, CodeBlockProps } from "./schema";
import { useCopyToClipboard } from "../shared/use-copy-to-clipboard";

import { Button, cn, Collapsible, CollapsibleTrigger } from "./_adapter";

const COPY_ID = "codeblock-code";
const MAX_HTML_CACHE_ENTRIES = 64;

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [pierreDarkTheme as never, pierreLightTheme as never],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

const htmlCache = new Map<string, string>();

function getCacheKey(
  code: string,
  language: string,
  theme: string,
  lineNumbers: CodeBlockLineNumbersMode,
  highlightLines?: number[],
): string {
  return JSON.stringify({
    code,
    language,
    theme,
    lineNumbers,
    highlightLines: highlightLines ?? null,
  });
}

function setCachedHtml(cacheKey: string, html: string): void {
  if (htmlCache.has(cacheKey)) {
    htmlCache.set(cacheKey, html);
    return;
  }

  if (htmlCache.size >= MAX_HTML_CACHE_ENTRIES) {
    const oldestKey = htmlCache.keys().next().value;
    if (typeof oldestKey === "string") {
      htmlCache.delete(oldestKey);
    }
  }

  htmlCache.set(cacheKey, html);
}

const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  tsx: "TSX",
  jsx: "JSX",
  json: "JSON",
  bash: "Bash",
  shell: "Shell",
  css: "CSS",
  html: "HTML",
  markdown: "Markdown",
  sql: "SQL",
  yaml: "YAML",
  go: "Go",
  rust: "Rust",
  text: "Plain Text",
};

function getLanguageDisplayName(lang: string): string {
  return LANGUAGE_DISPLAY_NAMES[lang.toLowerCase()] || lang.toUpperCase();
}

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function getDocumentTheme(): "light" | "dark" | null {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  const dataTheme = root.getAttribute("data-theme")?.toLowerCase();
  if (dataTheme === "dark") return "dark";
  if (dataTheme === "light") return "light";
  if (root.classList.contains("dark")) return "dark";
  if (root.classList.contains("light")) return "light";
  return null;
}

function useResolvedTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    return getDocumentTheme() ?? getSystemTheme();
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const update = () => setTheme(getDocumentTheme() ?? getSystemTheme());

    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    mql?.addEventListener("change", update);

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });

    return () => {
      mql?.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);

  return theme;
}

type CodeBlockRootProps = CodeBlockProps & {
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

function useCodeBlock(): CodeBlockSharedState {
  const context = use(CodeBlockContext);
  if (!context) {
    throw new Error(
      "CodeBlock subcomponents must be used within <CodeBlock.Root>.",
    );
  }
  return context;
}

function CodeBlockRoot({
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

type CodeBlockSectionProps = {
  className?: string;
};

function CodeBlockHeader({ className }: CodeBlockSectionProps) {
  const { language, filename, isCopied, copyCode } = useCodeBlock();
  return (
    <div
      className={cn(
        "bg-card flex items-center justify-between border-b px-4 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground text-sm">
          {getLanguageDisplayName(language)}
        </span>
        {filename && (
          <>
            <span className="text-muted-foreground/50">•</span>
            <span className="text-foreground text-sm font-medium">
              {filename}
            </span>
          </>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={copyCode}
        className="h-7 w-7 p-0"
        aria-label={isCopied ? "Copied" : "Copy code"}
      >
        {isCopied ? (
          <Check className="h-4 w-4 text-green-700 dark:text-green-400" />
        ) : (
          <Copy className="text-muted-foreground h-4 w-4" />
        )}
      </Button>
    </div>
  );
}

function CodeBlockContent({ className }: CodeBlockSectionProps) {
  const { highlightedHtml, isCollapsed } = useCodeBlock();
  return (
    <div
      className={cn(
        "overflow-x-auto overflow-y-clip text-[13px] leading-[1.4] [&_pre]:bg-transparent [&_pre]:py-4",
        isCollapsed && "max-h-[200px]",
        className,
      )}
    >
      {highlightedHtml && (
        <div dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
      )}
    </div>
  );
}

function CodeBlockCollapseToggle({ className }: CodeBlockSectionProps) {
  const { shouldCollapse, isCollapsed, toggleExpanded, lineCount } =
    useCodeBlock();

  if (!shouldCollapse) return null;

  return (
    <CollapsibleTrigger asChild>
      <Button
        variant="ghost"
        onClick={toggleExpanded}
        className={cn(
          "text-muted-foreground w-full rounded-none border-t font-normal",
          className,
        )}
      >
        {isCollapsed ? (
          <>
            <ChevronDown className="mr-1 size-4" />
            Show all {lineCount} lines
          </>
        ) : (
          <>
            <ChevronUp className="mr-2 h-4 w-4" />
            Collapse
          </>
        )}
      </Button>
    </CollapsibleTrigger>
  );
}

type CodeBlockComposedProps = Omit<CodeBlockRootProps, "children">;

function CodeBlockComposed(props: CodeBlockComposedProps) {
  return (
    <CodeBlockRoot {...props}>
      <CodeBlockHeader />
      <CodeBlockContent />
      <CodeBlockCollapseToggle />
    </CodeBlockRoot>
  );
}

type CodeBlockComponent = typeof CodeBlockComposed & {
  Root: typeof CodeBlockRoot;
  Header: typeof CodeBlockHeader;
  Content: typeof CodeBlockContent;
  CollapseToggle: typeof CodeBlockCollapseToggle;
};

export const CodeBlock = Object.assign(CodeBlockComposed, {
  Root: CodeBlockRoot,
  Header: CodeBlockHeader,
  Content: CodeBlockContent,
  CollapseToggle: CodeBlockCollapseToggle,
}) as CodeBlockComponent;
