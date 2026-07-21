/**
 * Sort an array of objects by a key
 */
export function sortData<T, K extends Extract<keyof T, string>>(
  data: T[],
  key: K,
  direction: "asc" | "desc",
  locale?: string,
): T[] {
  const get = (obj: T, k: K): unknown => (obj as Record<string, unknown>)[k];
  const collator = new Intl.Collator(locale, {
    numeric: true,
    sensitivity: "base",
  });
  return [...data].sort((a, b) => {
    const aVal = get(a, key);
    const bVal = get(b, key);

    // Handle nulls
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;

    // Type-specific comparison
    // Numbers
    if (typeof aVal === "number" && typeof bVal === "number") {
      return direction === "asc" ? aVal - bVal : bVal - aVal;
    }
    // Dates (Date instances)
    if (aVal instanceof Date && bVal instanceof Date) {
      const diff = aVal.getTime() - bVal.getTime();
      return direction === "asc" ? diff : -diff;
    }
    // Booleans: false < true
    if (typeof aVal === "boolean" && typeof bVal === "boolean") {
      const diff = aVal === bVal ? 0 : aVal ? 1 : -1;
      return direction === "asc" ? diff : -diff;
    }
    // Arrays: compare length
    if (Array.isArray(aVal) && Array.isArray(bVal)) {
      const diff = aVal.length - bVal.length;
      return direction === "asc" ? diff : -diff;
    }
    // Strings that look like numbers -> numeric compare
    if (typeof aVal === "string" && typeof bVal === "string") {
      const numA = parseNumericLike(aVal);
      const numB = parseNumericLike(bVal);
      if (numA != null && numB != null) {
        const diff = numA - numB;
        return direction === "asc" ? diff : -diff;
      }
      // ISO-like date strings
      if (/^\d{4}-\d{2}-\d{2}/.test(aVal) && /^\d{4}-\d{2}-\d{2}/.test(bVal)) {
        const da = new Date(aVal).getTime();
        const db = new Date(bVal).getTime();
        const diff = da - db;
        return direction === "asc" ? diff : -diff;
      }
    }

    // Fallback: locale-aware string compare with numeric collation
    const aStr = String(aVal);
    const bStr = String(bVal);
    const comparison = collator.compare(aStr, bStr);
    return direction === "asc" ? comparison : -comparison;
  });
}

/**
 * Return a human-friendly identifier for a row using common keys
 *
 * Accepts any JSON-serializable primitive or array of primitives.
 * Arrays are converted to comma-separated strings.
 */
export function getRowIdentifier(
  row: Record<
    string,
    string | number | boolean | null | (string | number | boolean | null)[]
  >,
  identifierKey?: string,
): string {
  const candidate =
    (identifierKey ? row[identifierKey] : undefined) ??
    (row as Record<string, unknown>).name ??
    (row as Record<string, unknown>).title ??
    (row as Record<string, unknown>).id;

  if (candidate == null) {
    return "";
  }

  // Handle arrays by joining them
  if (Array.isArray(candidate)) {
    return candidate.map((v) => (v === null ? "null" : String(v))).join(", ");
  }

  return String(candidate).trim();
}

function stableStringify(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Create deterministic, reorder-stable React keys for DataTable rows.
 *
 * - Uses `identifierKey` or common identifier fields as the primary base.
 * - Falls back to stable content fingerprints when no identifier exists.
 * - Disambiguates duplicates without relying on array index.
 */
export function createDataTableRowKeys(
  rows: Array<Record<string, unknown>>,
  identifierKey?: string,
): string[] {
  const canonicalRows = rows.map((row) => stableStringify(row));

  const baseKeys = rows.map((row, index) => {
    const identifier = getRowIdentifier(
      row as Record<
        string,
        string | number | boolean | null | (string | number | boolean | null)[]
      >,
      identifierKey,
    );

    if (identifier) {
      return `id:${identifier}`;
    }

    return `row:${hashString(canonicalRows[index])}`;
  });

  const baseCounts = new Map<string, number>();
  baseKeys.forEach((key) => {
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
  });

  const usedKeys = new Map<string, number>();

  return rows.map((row, index) => {
    const baseKey = baseKeys[index];
    if ((baseCounts.get(baseKey) ?? 0) === 1) {
      return baseKey;
    }

    const rowFingerprint = hashString(canonicalRows[index]);
    let disambiguatedKey = `${baseKey}::${rowFingerprint}`;

    const seenCount = usedKeys.get(disambiguatedKey) ?? 0;
    usedKeys.set(disambiguatedKey, seenCount + 1);
    if (seenCount > 0) {
      disambiguatedKey = `${disambiguatedKey}::d${seenCount + 1}`;
    }

    return disambiguatedKey;
  });
}

function sanitizeDomIdToken(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

export function getDataTableMobileDescriptionId(surfaceId: string): string {
  return `${sanitizeDomIdToken(surfaceId)}-mobile-table-description`;
}

/**
 * Parse a string that represents a numeric value, handling various formats:
 * - Currency symbols: $, €, £, ¥, etc.
 * - Percent symbols: %
 * - Accounting negatives: (1234) → -1234
 * - Thousands/decimal separators: 1,234.56 or 1.234,56
 * - Compact notation: 2.8T (trillion), 1.5M (million), 500K (thousand)
 * - Byte suffixes: 768B (bytes), 1.5KB, 2GB, 1TB
 *
 * Note: Single "B" is disambiguated - integers < 1024 are bytes, otherwise billions.
 *
 * @param input - String to parse
 * @returns Parsed number or null if unparseable
 *
 * @example
 * parseNumericLike("$1,234.56") // 1234.56
 * parseNumericLike("2.8T") // 2800000000000
 * parseNumericLike("768B") // 768
 * parseNumericLike("50%") // 50
 * parseNumericLike("(1234)") // -1234
 */
export function parseNumericLike(input: string): number | null {
  // Normalize whitespace (spaces, NBSPs, thin spaces)
  let s = input.replace(/[\u00A0\u202F\s]/g, "").trim();
  if (!s) return null;

  // Accounting negatives: (1234) -> -1234
  s = s.replace(/^\((.*)\)$/g, "-$1");

  // Strip common currency and percent symbols
  s = s.replace(/[%$€£¥₩₹₽₺₪₫฿₦₴₡₲₵₸]/g, "");

  function hasGroupedThousands(value: string, sep: "," | "."): boolean {
    const unsigned = value.replace(/^[+-]/, "");
    const parts = unsigned.split(sep);
    if (parts.length < 2) return false;
    if (parts.some((part) => part.length === 0)) return false;
    if (!/^\d{1,3}$/.test(parts[0])) return false;
    if (parts[0] === "0") return false;
    return parts.slice(1).every((part) => /^\d{3}$/.test(part));
  }

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Decide decimal by whichever occurs last
    const decimalSep = lastComma > lastDot ? "," : ".";
    const thousandSep = decimalSep === "," ? "." : ",";
    s = s.split(thousandSep).join("");
    s = s.replace(decimalSep, ".");
  } else if (lastComma !== -1) {
    // Only comma present
    if (hasGroupedThousands(s, ",")) {
      s = s.replace(/,/g, "");
    } else {
      const frac = s.length - lastComma - 1;
      if (frac >= 1 && frac <= 3) s = s.replace(/,/g, ".");
      else s = s.replace(/,/g, "");
    }
  } else if (lastDot !== -1) {
    // Only dot present; normalize grouped thousands separators.
    if (hasGroupedThousands(s, ".")) {
      s = s.replace(/\./g, "");
    } else if ((s.match(/\./g) || []).length > 1) {
      s = s.replace(/\./g, "");
    }
  }

  // Handle compact notation (K, M, B, T, P, G) and byte suffixes (KB, MB, GB, TB, PB)
  const compactMatch = s.match(/^([+-]?\d+\.?\d*|\d*\.\d+)([KMBTPG]B?|B)$/i);
  if (compactMatch) {
    const baseNum = Number(compactMatch[1]);
    if (Number.isNaN(baseNum)) return null;

    const suffix = compactMatch[2].toUpperCase();

    // Disambiguate single "B" (bytes vs billions)
    // If whole number < 1024, treat as bytes. Otherwise, billions.
    if (suffix === "B") {
      const isLikelyBytes = Number.isInteger(baseNum) && baseNum < 1024;
      return isLikelyBytes ? baseNum : baseNum * 1e9;
    }

    const multipliers: Record<string, number> = {
      K: 1e3,
      KB: 1024, // Kilo: metric vs binary
      M: 1e6,
      MB: 1024 ** 2, // Mega
      G: 1e9,
      GB: 1024 ** 3, // Giga
      T: 1e12,
      TB: 1024 ** 4, // Tera
      P: 1e15,
      PB: 1024 ** 5, // Peta
    };

    return baseNum * (multipliers[suffix] ?? 1);
  }

  if (/^[+-]?(?:\d+\.?\d*|\d*\.\d+)$/.test(s)) {
    const n = Number(s);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}
