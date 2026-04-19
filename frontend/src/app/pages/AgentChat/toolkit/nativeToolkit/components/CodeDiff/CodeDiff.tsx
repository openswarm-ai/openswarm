"use client";

import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import {
  FileDiff as PierreFileDiff,
  PatchDiff as PierrePatchDiff,
} from "@pierre/diffs/react";
import { parseDiffFromFile, RegisteredCustomThemes } from "@pierre/diffs";
import type { FileDiffMetadata, ThemesType } from "@pierre/diffs";
import { Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import type { CodeDiffProps } from "./schema";
import { useCopyToClipboard } from "../_shared/useCopyToClipboard";
import { Button, cn, Collapsible, CollapsibleTrigger } from "./_adapter";

/*
 * Pierre's shared_highlighter registers custom themes with dynamic imports
 * (`import("../themes/pierre-dark.js")`) that fail under Turbopack because the
 * package `exports` field doesn't include those subpaths. We override the
 * RegisteredCustomThemes map entries with loaders that point to local vendored
 * theme files in `components/tool-ui/shared`, which Turbopack can resolve.
 */
RegisteredCustomThemes.set("pierre-dark", () =>
  import("../_shared/pierre-dark-theme.js").then((m) => m.default as never),
);
RegisteredCustomThemes.set("pierre-light", () =>
  import("../_shared/pierre-light-theme.js").then((m) => m.default as never),
);

const COPY_ID = "codediff-code";

/* ── Theme detection (mirrors CodeBlock) ────────────────────────── */

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

/* ── Language display names (mirrors CodeBlock) ─────────────────── */

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

/* ── Shared context ─────────────────────────────────────────────── */

type CodeDiffSharedState = {
  id: string;
  isPatchMode: boolean;
  language: string;
  lineNumbers: "visible" | "hidden";
  filename?: string;
  diffStyle: "unified" | "split";
  copyableCode: string;
  isCopied: boolean;
  copyCode: () => void;
  isCollapsed: boolean;
  shouldCollapse: boolean;
  toggleExpanded: () => void;
  resolvedTheme: "light" | "dark";
  pierreThemes: ThemesType;
  fileDiffMetadata: FileDiffMetadata | null;
  patch: string | null;
  additions: number;
  deletions: number;
};

const CodeDiffContext = createContext<CodeDiffSharedState | null>(null);

function useCodeDiff(): CodeDiffSharedState {
  const context = useContext(CodeDiffContext);
  if (!context) {
    throw new Error(
      "CodeDiff subcomponents must be used within <CodeDiff.Root>.",
    );
  }
  return context;
}

/* ── Subcomponents ──────────────────────────────────────────────── */

type CodeDiffRootProps = CodeDiffProps & {
  children: ReactNode;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

function CodeDiffRoot({
  id,
  oldCode,
  newCode,
  patch,
  language = "text",
  filename,
  lineNumbers = "visible",
  diffStyle = "unified",
  maxCollapsedLines,
  className,
  children,
  expanded: expandedProp,
  defaultExpanded = false,
  onExpandedChange,
}: CodeDiffRootProps) {
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

  const pierreThemes: ThemesType = {
    dark: "pierre-dark",
    light: "pierre-light",
  };

  // Auto-detect mode: if `patch` is provided, use patch mode; otherwise files mode
  const isPatchMode = !!patch;

  const fileDiffMetadata = useMemo(() => {
    if (isPatchMode) return null;
    return parseDiffFromFile(
      {
        name: filename ?? "file",
        contents: oldCode ?? "",
        lang: language as never,
      },
      {
        name: filename ?? "file",
        contents: newCode ?? "",
        lang: language as never,
      },
    );
  }, [isPatchMode, oldCode, newCode, filename, language]);

  const copyableCode = isPatchMode ? (patch ?? "") : (newCode ?? oldCode ?? "");

  const lineCount = useMemo(() => {
    if (isPatchMode) {
      return (patch ?? "").split("\n").length;
    }
    if (fileDiffMetadata) {
      return fileDiffMetadata.unifiedLineCount;
    }
    return 0;
  }, [isPatchMode, patch, fileDiffMetadata]);

  const { additions, deletions } = useMemo(() => {
    if (!isPatchMode && fileDiffMetadata) {
      let add = 0;
      let del = 0;
      for (const hunk of fileDiffMetadata.hunks) {
        add += hunk.additionLines;
        del += hunk.deletionLines;
      }
      return { additions: add, deletions: del };
    }
    if (isPatchMode && patch) {
      let add = 0;
      let del = 0;
      for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++ ")) add++;
        else if (line.startsWith("-") && !line.startsWith("--- ")) del++;
      }
      return { additions: add, deletions: del };
    }
    return { additions: 0, deletions: 0 };
  }, [isPatchMode, fileDiffMetadata, patch]);

  const shouldCollapse = !!maxCollapsedLines && lineCount > maxCollapsedLines;
  const isCollapsed = shouldCollapse && !expanded;

  const copyCode = useCallback(() => {
    void copy(copyableCode, COPY_ID);
  }, [copyableCode, copy]);

  const toggleExpanded = useCallback(() => {
    setExpanded(!expanded);
  }, [expanded, setExpanded]);

  const state: CodeDiffSharedState = {
    id,
    isPatchMode,
    language,
    lineNumbers,
    filename,
    diffStyle,
    copyableCode,
    isCopied,
    copyCode,
    isCollapsed,
    shouldCollapse,
    toggleExpanded,
    resolvedTheme,
    pierreThemes,
    fileDiffMetadata,
    patch: isPatchMode ? (patch ?? null) : null,
    additions,
    deletions,
  };

  return (
    <CodeDiffContext.Provider value={state}>
      <div
        className={cn(
          "@container flex w-full min-w-80 flex-col gap-3",
          className,
        )}
        data-tool-ui-id={id}
        data-slot="code-diff"
      >
        <div className="border-border bg-card overflow-hidden rounded-lg border shadow-xs">
          <Collapsible open={!isCollapsed}>{children}</Collapsible>
        </div>
      </div>
    </CodeDiffContext.Provider>
  );
}

type CodeDiffSectionProps = {
  className?: string;
};

function CodeDiffHeader({ className }: CodeDiffSectionProps) {
  const { language, filename, isCopied, copyCode, additions, deletions } =
    useCodeDiff();
  const hasChanges = additions > 0 || deletions > 0;
  return (
    <div
      className={cn(
        "bg-card flex items-center justify-between gap-2 border-b px-4 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground text-sm">
          {getLanguageDisplayName(language)}
        </span>
        {filename && (
          <>
            <span className="text-muted-foreground/50">&bull;</span>
            <span className="text-foreground text-sm font-medium">
              {filename}
            </span>
          </>
        )}
      </div>
      {hasChanges && (
        <span className="ml-auto text-xs font-mono tabular-nums">
          {additions > 0 && (
            <span style={{ color: "#00cab1" }}>+{additions}</span>
          )}
          {additions > 0 && deletions > 0 && " "}
          {deletions > 0 && (
            <span style={{ color: "#ff2e3f" }}>-{deletions}</span>
          )}
        </span>
      )}
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

function CodeDiffContent({ className }: CodeDiffSectionProps) {
  const {
    isPatchMode,
    diffStyle,
    lineNumbers,
    isCollapsed,
    resolvedTheme,
    pierreThemes,
    fileDiffMetadata,
    patch,
  } = useCodeDiff();

  const disableLineNumbers = lineNumbers === "hidden";

  return (
    <div
      className={cn(
        "overflow-x-auto overflow-y-clip text-sm",
        isCollapsed && "max-h-[200px]",
        className,
      )}
    >
      {!isPatchMode && fileDiffMetadata && (
        <PierreFileDiff
          fileDiff={fileDiffMetadata}
          options={{
            theme: pierreThemes,
            themeType: resolvedTheme,
            diffStyle,
            disableFileHeader: true,
            disableLineNumbers,
          }}
        />
      )}
      {isPatchMode && patch && (
        <PierrePatchDiff
          patch={patch}
          options={{
            theme: pierreThemes,
            themeType: resolvedTheme,
            diffStyle,
            disableFileHeader: true,
            disableLineNumbers,
          }}
        />
      )}
    </div>
  );
}

function CodeDiffCollapseToggle({ className }: CodeDiffSectionProps) {
  const { shouldCollapse, isCollapsed, toggleExpanded } = useCodeDiff();

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
            Show full diff
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

/* ── Composed preset (callable as a flat component) ─────────────── */

type CodeDiffComposedProps = Omit<CodeDiffRootProps, "children">;

function CodeDiffComposed(props: CodeDiffComposedProps) {
  return (
    <CodeDiffRoot {...props}>
      <CodeDiffHeader />
      <CodeDiffContent />
      <CodeDiffCollapseToggle />
    </CodeDiffRoot>
  );
}

/* ── Compound export: CodeDiff is callable AND has subcomponents ── */

type CodeDiffComponent = typeof CodeDiffComposed & {
  Root: typeof CodeDiffRoot;
  Header: typeof CodeDiffHeader;
  Content: typeof CodeDiffContent;
  CollapseToggle: typeof CodeDiffCollapseToggle;
};

export const CodeDiff = Object.assign(CodeDiffComposed, {
  Root: CodeDiffRoot,
  Header: CodeDiffHeader,
  Content: CodeDiffContent,
  CollapseToggle: CodeDiffCollapseToggle,
}) as CodeDiffComponent;
