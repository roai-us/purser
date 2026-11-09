import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/** Headers on every page and file of the web UI. No inline script, no framing, no referrer. */
export const UI_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ROAI Purser</title></head>
<body><h1>ROAI Purser is running</h1>
<p>The web UI is not built. From the repository root run <code>pnpm build</code>, then reload this page.</p>
<p>The gateway and the admin API work without it.</p></body></html>`;

/**
 * Serves the built web UI from a directory, with a fallback to index.html for
 * app routes. Paths are resolved and checked to stay inside the directory.
 */
export function serveUi(webDir: string, path: string): Response {
  const root = resolve(webDir);
  const index = join(root, "index.html");
  if (!existsSync(index)) {
    return new Response(NOT_BUILT, {
      status: path === "/" ? 200 : 404,
      headers: { ...UI_HEADERS, "content-type": TYPES[".html"] ?? "" },
    });
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return notFound();
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return notFound();
  const target = resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + sep)) return notFound();

  if (target !== root && isFile(target)) {
    return file(target, decoded.startsWith("/assets/"));
  }
  // An app route such as /agents/abc: let the app handle it. A missing file
  // with an extension is a real 404.
  if (extname(decoded) !== "") return notFound();
  return file(index, false);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function file(path: string, immutable: boolean): Response {
  return new Response(readFileSync(path), {
    headers: {
      ...UI_HEADERS,
      "content-type":
        TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "cache-control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  });
}

function notFound(): Response {
  return new Response("Not found.", {
    status: 404,
    headers: { ...UI_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}
