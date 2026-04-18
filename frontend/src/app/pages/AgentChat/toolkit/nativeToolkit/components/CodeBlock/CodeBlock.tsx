"use client";

import { CodeBlockHeader } from "./components/CodeBlockHeader";
import { CodeBlockContent } from "./components/CodeBlockContent";
import { CodeBlockCollapseToggle } from "./components/CodeBlockCollapseToggle";
import { CodeBlockRoot, CodeBlockRootProps } from "./components/CodeBlockRoot/CodeBlockRoot";

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
