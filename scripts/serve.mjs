// Zero-dep static server for the demo. Maps:
//   /           -> demo/          (static html/css)
//   /demo/*     -> dist/demo/*    (compiled TS)
//   /src/*      -> dist/src/*     (compiled TS)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT ?? 5179);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function resolve(urlPath) {
  if (urlPath.startsWith("/demo/")) return join(root, "dist", normalize(urlPath));
  if (urlPath.startsWith("/src/")) return join(root, "dist", normalize(urlPath));
  if (urlPath === "/") return join(root, "demo", "index.html");
  return join(root, "demo", normalize(urlPath));
}

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = resolve(path);
    if (!file.startsWith(root)) throw new Error("traversal");
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(port, () => {
  console.log(`contrapunctus demo → http://127.0.0.1:${port}`);
});
