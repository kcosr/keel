// Phase 5 fixture: a forbidden fs import; the determinism lint must reject this
// before the run even starts.
import { readFileSync } from "node:fs";
import type { Ctx } from "../../ctx.ts";

export default async function bad(_ctx: Ctx): Promise<number> {
  return readFileSync("/etc/hostname", "utf8").length;
}
