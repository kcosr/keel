import { describe, expect, test } from "bun:test";
import { formatTable, sanitizeTableText, tableCell, truncateText } from "./table.ts";

describe("CLI table formatting", () => {
  test("aligns headers and rows with two-space column padding", () => {
    expect(
      formatTable(
        ["RUN ID", "STATUS", "WORKFLOW"],
        [
          ["run_1", "finished", "chain"],
          ["run_long", "waiting-signal", "gate"],
        ],
      ),
    ).toBe(
      [
        "RUN ID    STATUS          WORKFLOW",
        "run_1     finished        chain",
        "run_long  waiting-signal  gate",
        "",
      ].join("\n"),
    );
  });

  test("sanitizes embedded whitespace in cells", () => {
    expect(sanitizeTableText(" one\n two\tthree   four ")).toBe("one two three four");
    expect(formatTable(["A", "B"], [["one\n two", "three\t\tfour"]])).toBe(
      "A        B\none two  three four\n",
    );
  });

  test("truncates only explicitly capped cells with an ellipsis", () => {
    expect(truncateText("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…");
    expect(
      formatTable(
        ["NAME", "DETAIL"],
        [[tableCell("abcdefghijklmnopqrstuvwxyz", { maxWidth: 10 }), "not capped at all"]],
      ),
    ).toBe("NAME        DETAIL\nabcdefghi…  not capped at all\n");
  });

  test("leaves the final column unpadded", () => {
    const lines = formatTable(
      ["A", "B"],
      [
        ["longer", "x"],
        ["y", "longer final"],
      ],
    )
      .trimEnd()
      .split("\n");
    expect(lines).toEqual(["A       B", "longer  x", "y       longer final"]);
    expect(lines.every((line) => !line.endsWith(" "))).toBe(true);
  });
});
