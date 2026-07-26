/** Best-effort, dependency-free repair for common LLM JSON formatting errors. */
export function repairJson(raw: string): Record<string, unknown> | null {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  // Locate the matching closing brace for the first "{", respecting string
  // literals, escapes and nested depth. lastIndexOf("}") would wrongly point at
  // a "}" inside trailing prose (e.g. "...done} thanks") and corrupt the slice.
  const end = matchingClosingBrace(text, start);
  text = text.slice(start, end >= 0 ? end + 1 : undefined);
  text = text.replace(/,\s*([}\]])/g, "$1");

  const parse = (value: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };
  const direct = parse(text);
  if (direct) return direct;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if ((char === "}" || char === "]") && stack.at(-1) === char) stack.pop();
  }
  if (inString || stack.length === 0) return null;
  return parse(text + stack.reverse().join(""));
}

/**
 * Find the index of the brace/bracket that closes the opener at `start`,
 * tracking string literals, escape sequences and nesting depth. Returns -1 if
 * no balanced closer is found.
 */
function matchingClosingBrace(text: string, start: number): number {
  if (text[start] !== "{") return -1;
  const stack: string[] = ["}"];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if ((char === "}" || char === "]") && stack.at(-1) === char) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}
