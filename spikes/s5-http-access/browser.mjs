import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(
  new URL("../s4-shared-player/package.json", import.meta.url),
);
const { chromium, _electron } = require("playwright");
const {
  S5_BASE: base,
  S5_OWNER: owner,
  S5_RUN_DIR: dir,
  S5_OBSERVER: observer,
} = process.env;
async function records() {
  const text = await readFile(join(dir, "access.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function trial(page, mode) {
  const invite = await fetch(base + "/invites", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + owner,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(invite.status, 200);
  const { handle, token } = await invite.json();
  await page.goto(base + "/#" + new URLSearchParams({ token, mode }));
  assert.equal(new URL(page.url()).hash, "");
  let requests = 0;
  const countMedia = (req) => {
    if (new URL(req.url()).pathname.startsWith("/media/")) requests++;
  };
  page.on("request", countMedia);
  const logsBefore = (await records()).length;
  await page.locator("input").fill("Гость S5");
  await page.locator("button").click();
  await page.waitForFunction(
    () => document.querySelector("video").readyState >= 1,
  );
  const playback = await page.locator("video").evaluate(async (video) => {
    const target = video.duration / 2;
    const sought = new Promise((resolve) =>
      video.addEventListener("seeked", resolve, { once: true }),
    );
    video.currentTime = target;
    await sought;
    await video.play();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Истекло время воспроизведения")),
        10000,
      );
      function check() {
        if (video.currentTime > target + 0.2) {
          clearTimeout(timer);
          resolve();
        } else video.requestVideoFrameCallback(check);
      }
      video.requestVideoFrameCallback(check);
    });
    video.pause();
    const result = {
      duration: video.duration,
      target,
      shown: video.currentTime,
      frames: video.getVideoPlaybackQuality().totalVideoFrames,
      query: !!new URL(video.src).search,
    };
    video.removeAttribute("src");
    video.load();
    return result;
  });
  assert.ok(playback.frames > 0 && playback.shown >= playback.target);
  assert.equal(playback.query, mode !== "cookie");
  // Отдельный origin записывает только наличие Referer, без его содержимого.
  await page.evaluate(async (url) => {
    await fetch(url, { mode: "no-cors", cache: "no-store" });
  }, observer + "/probe");
  await page.evaluate(async (url) => {
    await fetch(url, {
      mode: "no-cors",
      cache: "no-store",
      referrerPolicy: "origin",
    });
  }, observer + "/control");
  await page.goto("about:blank");
  let media = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    await delay(100);
    media = (await records())
      .slice(logsBefore)
      .filter((e) => e.route === "/media/{mode}");
    if (media.length === requests && requests >= 2) break;
  }
  page.off("request", countMedia);
  assert.equal(media.length, requests, "Все запросы плеера должны завершиться");
  // При отмене до заголовков сервер фиксирует запрос без HTTP-ответа.
  const cancelled = media.filter(
    (e) => e.status === 0 && e.body_bytes === 0 && e.range_start === null,
  );
  media = media.filter((e) => !cancelled.includes(e));
  assert.ok(
    media.some((e) => e.range_start === 0) &&
      media.some((e) => e.range_start > 0),
    "Нет пары начального и дальнего Range",
  );
  const bytes = media.reduce((n, e) => n + e.body_bytes, 0);
  assert.ok(
    bytes > 0 && bytes < Number(process.env.S5_BYTES),
    "Файл передан целиком",
  );
  assert.ok(
    media.every((e) => e.status === 206),
    "Ожидался частичный ответ: " + JSON.stringify(media),
  );
  assert.ok(
    media.some((e) => e.range_start > bytes),
    "Перемотка должна пропустить байты файла",
  );
  const revoked = await fetch(base + "/invites/" + handle, {
    method: "DELETE",
    headers: { Authorization: "Bearer " + owner },
  });
  assert.equal(revoked.status, 200);
  return {
    mode,
    ...playback,
    bytes,
    cancelledBeforeHeaders: cancelled.length,
    rangeStarts: media.map((e) => e.range_start),
  };
}

const results = [];
for (const target of ["browser", "electron"]) {
  let app, browser;
  try {
    let page, version;
    if (target === "browser") {
      const channels =
        process.platform === "win32" ? ["chrome", "msedge"] : ["chrome"];
      let channel;
      for (const candidate of channels) {
        try {
          browser = await chromium.launch({ channel: candidate });
          channel = candidate;
          break;
        } catch (error) {
          if (candidate === channels.at(-1)) throw error;
        }
      }
      page = await browser.newPage();
      version = channel + " " + browser.version();
    } else {
      app = await _electron.launch({
        executablePath: require("electron"),
        args: [
          "--user-data-dir=" + join(dir, "electron-profile"),
          fileURLToPath(new URL("./desktop.cjs", import.meta.url)),
        ],
      });
      page = await app.firstWindow();
      version =
        "Electron " + (await app.evaluate(() => process.versions.electron));
    }
    for (const mode of ["url", "cookie", "signed"]) {
      const result = await trial(page, mode);
      results.push({ version, ...result });
      console.error(version, mode, "206;", result.bytes, "байт");
    }
  } finally {
    await browser?.close();
    await app?.close();
  }
}
console.log(JSON.stringify(results));
