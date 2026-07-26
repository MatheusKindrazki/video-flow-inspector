/** Best-effort, dependency-free repair for common LLM JSON formatting errors. */
export function repairJson(raw: string): Record<string, unknown> | null {
  let text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0) return null;
  text = text.slice(start, end >= start ? end + 1 : undefined);
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
