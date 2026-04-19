"use client";

import { createHighlighter, type Highlighter } from "shiki/bundle/web";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import pierreDarkTheme from "../../../_shared/pierre-dark-theme.js";
import pierreLightTheme from "../../../_shared/pierre-light-theme.js";
import type { CodeBlockLineNumbersMode } from "../../schema";

const MAX_HTML_CACHE_ENTRIES = 64;

let highlighterPromise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [pierreDarkTheme as never, pierreLightTheme as never],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

export const htmlCache = new Map<string, string>();

export function getCacheKey(
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

export function setCachedHtml(cacheKey: string, html: string): void {
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