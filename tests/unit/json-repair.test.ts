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

  it("returns null when input cannot be repaired", () => {
    expect(repairJson("this is not JSON at all")).toBeNull();
  });
});
