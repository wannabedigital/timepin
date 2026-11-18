import { app, BrowserWindow, net, protocol } from "electron";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { media } from "../../fixtures.mjs";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "timepin",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
app.whenReady().then(async () => {
  const dist = fileURLToPath(new URL("../web/dist/", import.meta.url));
  const files = new Map(media);
  files.set("/", join(dist, "index.html"));
  for (const name of await readdir(join(dist, "assets")))
    files.set("/assets/" + name, join(dist, "assets", name));
  protocol.handle("timepin", async (request) => {
    const url = new URL(request.url);
    const file = files.get(url.pathname);
    if (url.host !== "player" || !file || request.method !== "GET")
      return new Response(null, { status: 404 });
    if (media.has(url.pathname)) {
      const { size } = await stat(file);
      const range = request.headers.get("Range");
      const headers = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
      let start = 0,
        end = size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (match && (match[1] || match[2])) {
          start = match[1]
            ? Number(match[1])
            : Math.max(0, size - Number(match[2]));
          if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
        } else start = size;
        if (start > end)
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": "bytes */" + size },
          });
        headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      }
      headers["Content-Length"] = String(end - start + 1);
      const body = Readable.toWeb(createReadStream(file, { start, end }));
      return new Response(body, { status: range ? 206 : 200, headers });
    }
    return net.fetch(pathToFileURL(file).href, { headers: request.headers });
  });
  const win = new BrowserWindow({
    width: 960,
    height: 760,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== "timepin://player/") event.preventDefault();
  });
  await win.loadURL("timepin://player/");
  app.on("window-all-closed", () => app.quit());
});
