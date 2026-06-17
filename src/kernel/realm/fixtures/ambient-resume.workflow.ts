// Realm test fixture: ambient values must replay across a crash/resume boundary.
import { type Ctx, passthrough } from "@kcosr/keel";

const ambient = passthrough<{ t: number; r: number }>();

export default async function ambientResume(
  ctx: Ctx,
  _input: null,
): Promise<{ t: number; r: number }> {
  const t = ctx.now();
  const r = ctx.random();
  return ctx.step("after-ambient", ambient, { t, r }, ({ t, r }) => ({ t, r }));
}
