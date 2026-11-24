// Puts what the npm package needs beside dist: the built web UI and the
// license files from the repository root. Run by `pnpm pack` and `pnpm publish`.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const web = here("../../web/dist");
if (!existsSync(`${web}/index.html`)) {
  console.error(
    "Build the web UI first: pnpm build, from the repository root.",
  );
  process.exit(1);
}
if (!existsSync(here("../dist/cli.js"))) {
  console.error(
    "Build the server first: pnpm build, from the repository root.",
  );
  process.exit(1);
}
rmSync(here("../web"), { recursive: true, force: true });
cpSync(web, here("../web"), { recursive: true });
for (const file of ["LICENSE", "NOTICE", "LICENSING.md"]) {
  cpSync(here(`../../../${file}`), here(`../${file}`));
}
