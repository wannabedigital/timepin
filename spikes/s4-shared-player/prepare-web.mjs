// Копии нужны только для статической раздачи по HTTP, в Git они не попадают.
import { copyFile, mkdir } from "node:fs/promises";
import { media } from "./fixtures.mjs";
await mkdir("apps/web/public/media", { recursive: true });
for (const [url, path] of media) await copyFile(path, "apps/web/public" + url);
