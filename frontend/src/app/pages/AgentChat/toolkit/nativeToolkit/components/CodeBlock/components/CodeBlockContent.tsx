"use client";

import { cn } from "../_adapter";
import { useCodeBlock } from "./CodeBlockRoot/CodeBlockRoot";

type CodeBlockSectionProps = {
  className?: string;
};

export function CodeBlockContent({ className }: CodeBlockSectionProps) {
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