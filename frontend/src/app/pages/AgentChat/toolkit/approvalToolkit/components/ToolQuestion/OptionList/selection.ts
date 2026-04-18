import type { OptionListSelection } from "./schema";

export function parseSelectionToIdSet(
  value: OptionListSelection | undefined,
  mode: "multi" | "single",
  maxSelections?: number,
): Set<string> {
  if (mode === "single") {
    const single =
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value[0]
          : null;
    return single ? new Set([single]) : new Set();
  }

  const arr =
    typeof value === "string" ? [value] : Array.isArray(value) ? value : [];

  return new Set(maxSelections ? arr.slice(0, maxSelections) : arr);
}

export function normalizeSelectionForOptions(
  selection: Set<string>,
  optionIds: Set<string>,
): Set<string> {
  const normalized = new Set<string>();
  for (const id of selection) {
    if (optionIds.has(id)) {
      normalized.add(id);
    }
  }
  return normalized;
}
