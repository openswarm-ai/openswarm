"use client";


import { ChevronDown, ChevronUp } from "lucide-react";

import { Button, cn, CollapsibleTrigger } from "../_adapter";
import { useCodeBlock } from "./CodeBlockRoot/CodeBlockRoot";


type CodeBlockSectionProps = {
  className?: string;
};

export function CodeBlockCollapseToggle({ className }: CodeBlockSectionProps) {
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