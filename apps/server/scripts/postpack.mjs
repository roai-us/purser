// Removes what prepack copied in, so a checkout never serves a stale web UI.
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
rmSync(here("../web"), { recursive: true, force: true });
for (const file of ["LICENSE", "NOTICE", "LICENSING.md"]) {
  rmSync(here(`../${file}`), { force: true });
}
