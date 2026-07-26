import { describe, expect, it } from "vitest";
import { repairJson } from "../../src/analysis/json-repair.js";

describe("repairJson", () => {
  it("strips JSON fences", () => {
    expect(repairJson("```json\n{\"summary\": \"ok\"}\n```")) .toEqual({ summary: "ok" });
  });

  it("removes trailing commas", () => {
    expect(repairJson('{"items":[1,2,],}')).toEqual({ items: [1, 2] });
  });

  it("closes truncated objects and arrays", () => {
    expect(repairJson('{"summary":"ok","items":[1,2]')).toEqual({ summary: "ok", items: [1, 2] });
  });

  it("extracts the JSON object from surrounding prose", () => {
    expect(repairJson('Here is the result: {"summary":"ok"} thanks')).toEqual({ summary: "ok" });
  });

  it("ignores a stray brace in trailing prose after a complete object", () => {
    // The valid JSON closes at the real matching brace; a "}" later in trailing
    // prose must NOT extend the slice. lastIndexOf("}") would wrongly include
    // "... done}" and break parsing.
    expect(repairJson('{"summary":"ok"} analysis complete}')).toEqual({ summary: "ok" });
  });

  it("ignores braces inside string values when locating the closer", () => {
    expect(repairJson('{"note":"a } b","ok":true}')).toEqual({ note: "a } b", ok: true });
  });

  it("returns null when input cannot be repaired", () => {
    expect(repairJson("this is not JSON at all")).toBeNull();
  });
});
