"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import remarkGfm from "remark-gfm";
import { DEFAULT_COMPONENTS } from "./DEFAULT_COMPONENTS/DEFAULT_COMPONENTS";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

export const MarkdownText = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    className="aui-md"
    components={DEFAULT_COMPONENTS}
  />
);