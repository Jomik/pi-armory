export interface RegularPlaceholder {
  kind: "regular";
  name: string;
  variadic: boolean;
  optional: boolean;
}

export interface BooleanFlagPlaceholder {
  kind: "boolean-flag";
  name: string;
  /** The flag string, e.g. `--verbose` or `-v`. */
  flag: string;
  optional: boolean;
}

export interface ValueFlagPlaceholder {
  kind: "value-flag";
  name: string;
  /** The flag string, e.g. `--message` or `-m`. */
  flag: string;
  optional: boolean;
}

export type PlaceholderInfo = RegularPlaceholder | BooleanFlagPlaceholder | ValueFlagPlaceholder;

/** Regex matching flag placeholders. Returns a new instance (with `g` flag) each call. */
export const FLAG_PLACEHOLDER_RE = () => /\{\{(-{1,2}[\w-]+)(?:\s+([\w]+)(\?)?)?\s*(\?)?\}\}/g;

export function extractPlaceholders(command: string): string[] {
  return parsePlaceholders(command).map((p) => p.name);
}

export function parsePlaceholders(command: string): PlaceholderInfo[] {
  const seen = new Map<string, PlaceholderInfo>();

  // Flag placeholders: {{--flag}}, {{--flag?}}, {{--flag value}}, {{--flag value?}},
  //                    {{-f}}, {{-f?}}, {{-f value}}, {{-f value?}}
  const FLAG_RE = FLAG_PLACEHOLDER_RE();
  for (const m of command.matchAll(FLAG_RE)) {
    const flagStr = m[1]; // e.g. "--verbose" or "-m"
    const valueParam = m[2]; // value word, e.g. "message", or undefined for boolean
    const valueOptMark = m[3]; // "?" when value word is optional
    const boolOptMark = m[4]; // "?" when boolean flag is optional

    if (valueParam) {
      // Flag+value: param name is the value word
      const name = valueParam;
      const optional = valueOptMark === "?";
      const existing = seen.get(name);
      if (existing) {
        if (existing.kind !== "value-flag" || existing.optional !== optional || existing.flag !== flagStr) {
          throw new Error(`Conflicting modifiers for placeholder: ${name}`);
        }
        continue;
      }
      seen.set(name, { kind: "value-flag", name, flag: flagStr, optional });
    } else {
      // Boolean flag: param name is the flag stripped of leading dashes
      const name = flagStr.replace(/^-+/, "");
      const optional = boolOptMark === "?";
      const existing = seen.get(name);
      if (existing) {
        if (existing.kind !== "boolean-flag" || existing.optional !== optional || existing.flag !== flagStr) {
          throw new Error(`Conflicting modifiers for placeholder: ${name}`);
        }
        continue;
      }
      seen.set(name, { kind: "boolean-flag", name, flag: flagStr, optional });
    }
  }

  // Regular placeholders: {{name}}, {{name?}}, {{...name}}, {{...name?}}
  const REGULAR_RE = /\{\{(\.\.\.)?([\w]+)(\?)?\}\}/g;
  for (const m of command.matchAll(REGULAR_RE)) {
    const name = m[2];
    const variadic = m[1] === "...";
    const optional = m[3] === "?";
    const existing = seen.get(name);
    if (existing) {
      if (existing.kind !== "regular" || existing.variadic !== variadic || existing.optional !== optional) {
        throw new Error(`Conflicting modifiers for placeholder: ${name}`);
      }
      continue;
    }
    seen.set(name, { kind: "regular", name, variadic, optional });
  }

  return [...seen.values()];
}
