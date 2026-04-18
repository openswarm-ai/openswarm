"use client";

import { Copy, Check } from "lucide-react";
import { Button, cn,  } from "../_adapter";
import { useCodeBlock } from "./CodeBlockRoot/CodeBlockRoot";

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


type CodeBlockSectionProps = {
  className?: string;
};

export function CodeBlockHeader({ className }: CodeBlockSectionProps) {
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