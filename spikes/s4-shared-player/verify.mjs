// Запуск после подготовки прокси и старта web-сервера, команды в README.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, _electron } from "playwright";

const target = process.argv[2] ?? "chrome";
const url = process.argv[3] ?? "http://127.0.0.1:5173";
const desktop = target === "electron";
assert.ok(["chrome", "electron"].includes(target));
const profile = desktop ? await mkdtemp(join(tmpdir(), "timepin-s4-")) : null;
const app = desktop
  ? await _electron.launch({
      args: ["--user-data-dir=" + profile, "apps/desktop"],
    })
  : null;
const browser = desktop ? null : await chromium.launch({ channel: "chrome" });
try {
  const page = desktop
    ? await app.firstWindow()
    : await browser.newPage({ viewport: { width: 980, height: 720 } });
  if (!desktop) await page.goto(url);
  const player = page.locator("drawing-player");
  const canvas = player.locator("canvas");
  const button = (name) => player.locator('[data-action="' + name + '"]');
  const ready = () =>
    page.waitForFunction(() => {
      const p = document.querySelector("drawing-player");
      return p?.video?.readyState >= 2 && !p.video.seeking && !p.canvas.hidden;
    });
  await ready();
  const seek = async (frame) => {
    await player.locator(".frame").fill(String(frame));
    await player.locator(".frame").press("Enter");
    await player.locator(".frame").press("Tab");
    await page
      .waitForFunction(
        (n) => {
          const p = document.querySelector("drawing-player");
          return p.frame === n && !p.video.seeking && !p.canvas.hidden;
        },
        frame,
        { timeout: 10000 },
      )
      .catch(async (error) => {
        console.error(
          await player.evaluate((p) => ({
            frame: p.frame,
            time: p.video.currentTime,
            src: p.video.currentSrc,
            max: p.field.max,
            seeking: p.video.seeking,
          })),
        );
        throw error;
      });
  };
  if (await page.locator("#clip").count()) {
    await page.locator("#clip").selectOption("audio");
    await ready();
    await seek(1800);
    await button("play").click();
    await page.waitForFunction(
      () => document.querySelector("video").currentTime > 61,
    );
    await button("play").click();
    await ready();
    console.log(
      "Прокси H.264/AAC:",
      await player.evaluate((p) => ({
        time: p.video.currentTime,
        audioBytes: p.video.webkitAudioDecodedByteCount,
        hasAudio: p.video.mozHasAudio,
        frames: p.video.getVideoPlaybackQuality().totalVideoFrames,
      })),
    );
    for (const name of ["hlg", "sdr"]) {
      await page.locator("#clip").selectOption(name);
      await ready();
      await seek(60);
      await button("play").click();
      await page.waitForFunction(
        () => document.querySelector("video").currentTime > 1.5,
      );
      await button("play").click();
      await ready();
      console.log(name, await player.evaluate((p) => p.video.currentTime));
    }
    await page.locator("#clip").selectOption("numbered");
    await ready();
  }
  await seek(45);
  const decoded = await player.evaluate((p) => {
    const c = document.createElement("canvas");
    c.width = 384;
    c.height = 24;
    const ctx = c.getContext("2d");
    ctx.drawImage(p.video, 0, 0);
    const row = ctx.getImageData(0, 12, 384, 1).data;
    let n = 0;
    for (let i = 0; i < 16; i++) if (row[(24 * i + 12) * 4] > 128) n |= 1 << i;
    return n;
  });
  assert.equal(decoded, 45);
  // Центр белого блока с младшим битом номера 45 в тестовом ролике S2.
  const x = 12 / 1280,
    y = 12 / 720;
  const geometry = () =>
    player.evaluate((p) => {
      const v = p.video,
        c = p.canvas,
        outer = p.querySelector(".viewport").getBoundingClientRect();
      const scale = Math.min(
        outer.width / v.videoWidth,
        outer.height / v.videoHeight,
      );
      const width = v.videoWidth * scale,
        height = v.videoHeight * scale;
      const rect = c.getBoundingClientRect();
      const errors = [
        rect.left - outer.left - (outer.width - width) / 2,
        rect.top - outer.top - (outer.height - height) / 2,
        rect.width - width,
        rect.height - height,
      ];
      return Math.max(...errors.map(Math.abs));
    });
  async function draw(points, span) {
    const rect = await canvas.boundingBox();
    const point = (a, b) => [rect.x + a * rect.width, rect.y + b * rect.height];
    await page.mouse.move(...point(x, y));
    await page.mouse.down();
    const start = performance.now();
    for (let i = 1; i <= points; i++) {
      await page.mouse.move(
        ...point(
          x + (span * i) / points,
          y + 0.12 * Math.abs(Math.sin((i * 2 * Math.PI) / points)),
        ),
      );
    }
    await page.mouse.up();
    return Math.round(performance.now() - start);
  }
  await draw(60, 0.6);
  await button("save").click();
  const saved = () =>
    player.evaluate((p) => {
      const { strokes, png } = JSON.parse(localStorage.getItem(p.key + ":45"));
      return {
        points: strokes.reduce((n, s) => n + s.points.length, 0),
        json: new Blob([JSON.stringify(strokes)]).size,
        png: atob(png.split(",")[1]).length,
      };
    });
  console.log("Короткая линия:", await saved());
  const pixels = () =>
    canvas.evaluate((c) => {
      const rgba = c
        .getContext("2d")
        .getImageData(0, 0, c.width, c.height).data;
      const filled = [];
      for (let i = 3; i < rgba.length; i += 4)
        if (rgba[i] >= 128) filled.push((i - 3) / 4);
      return filled;
    });
  const original = new Set(await pixels());
  const overlaps = [];
  async function checkShape() {
    const filled = await pixels();
    const shared = filled.filter((i) => original.has(i)).length;
    const overlap = shared / (filled.length + original.size - shared);
    assert.ok(overlap > 0.99, "Доля совпадения масок: " + overlap);
    overlaps.push(overlap);
  }
  const mark = () =>
    canvas.evaluate(
      (c) => c.getContext("2d").getImageData(12, 12, 1, 1).data[3],
    );
  assert.ok((await mark()) > 0);
  if (!desktop) await page.setViewportSize({ width: 540, height: 850 });
  await page.waitForTimeout(150);
  let error = await geometry();
  await button("full").click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.waitForTimeout(250);
  error = Math.max(error, await geometry());
  assert.ok(error < 1);
  assert.ok((await mark()) > 0);
  if (desktop) await page.waitForTimeout(1500);
  await button("full").evaluate((b) => b.click());
  await page.waitForFunction(() => !document.fullscreenElement);
  await player.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => document.querySelector("drawing-player").frame === 46,
  );
  assert.equal(await mark(), 0);
  await seek(45);
  await checkShape();
  await page.reload();
  await ready();
  await seek(45);
  for (const format of ["png", "vector"]) {
    await player.locator("select").selectOption(format);
    await button("load").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("drawing-player canvas")
          .getContext("2d")
          .getImageData(12, 12, 1, 1).data[3] > 0,
    );
    await checkShape();
    if (format === "png") await button("clear").click();
  }
  console.log(
    "Кадр, смена размера, полный экран, клавиши, PNG и штрихи: OK. Ошибка геометрии, CSS px:",
    error,
    "Минимальная доля совпадения:",
    Math.min(...overlaps),
  );
  if (url.includes("s3-drawing")) {
    await button("clear").click();
    await page.evaluate(() => {
      window.s3Intervals = [];
      let previous;
      function tick(t) {
        if (previous) window.s3Intervals.push(t - previous);
        previous = t;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    const elapsed = await draw(600, 0.95);
    await button("save").click();
    const intervals = await page.evaluate(() =>
      window.s3Intervals.sort((a, b) => a - b),
    );
    console.log("Длинная линия:", await saved(), {
      elapsed,
      rafP95: intervals[Math.floor(intervals.length * 0.95)],
    });
  }
} finally {
  await browser?.close();
  await app?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
