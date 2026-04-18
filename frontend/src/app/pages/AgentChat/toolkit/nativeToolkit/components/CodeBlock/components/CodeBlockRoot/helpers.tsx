"use client";

import {
  useState,
  useEffect,
} from "react";
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

export function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function getDocumentTheme(): "light" | "dark" | null {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  const dataTheme = root.getAttribute("data-theme")?.toLowerCase();
  if (dataTheme === "dark") return "dark";
  if (dataTheme === "light") return "light";
  if (root.classList.contains("dark")) return "dark";
  if (root.classList.contains("light")) return "light";
  return null;
}

export function useResolvedTheme(): "light" | "dark" {
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