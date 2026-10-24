import { autoType, csvParse, tsvParse } from "d3-dsv";
import { afterEach, expect, it, vi } from "vitest";
import { parsePlotData } from "./plot-spec.js";

afterEach(() => vi.unstubAllGlobals());

it("parses CSV and TSV rows exactly as d3-dsv's parse with autoType does", () => {
  const csv =
    'name,value,when,flag,empty\nA,1.5,2024-01-02,true,\n"B, quoted",-2,,false,x\nshort,3\n';
  expect(parsePlotData("data.csv", csv)).toEqual([...csvParse(csv, autoType)]);
  const tsv = "a\tb\n1\tz\n\t2\n";
  expect(parsePlotData("data.TSV", tsv)).toEqual([...tsvParse(tsv, autoType)]);
  const duplicateColumns = "x,x,y\n1,2,3\n";
  expect(parsePlotData("data.csv", duplicateColumns)).toEqual([
    ...csvParse(duplicateColumns, autoType),
  ]);
});

it("never builds code, so it runs under the web app's script-src 'self'", () => {
  vi.stubGlobal(
    "Function",
    new Proxy(Function, {
      apply: () => {
        throw new EvalError("blocked by CSP");
      },
      construct: () => {
        throw new EvalError("blocked by CSP");
      },
    }),
  );
  expect(() => csvParse("a,b\n1,2\n", autoType)).toThrow(EvalError);
  expect(parsePlotData("data.csv", "a,b\n1,2\n")).toEqual([{ a: 1, b: 2 }]);
});
