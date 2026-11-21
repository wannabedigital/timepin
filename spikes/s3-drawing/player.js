// Стенд работает с CFR-прокси, начинающимся в нуле. Частота задаётся у версии.
export class DrawingPlayer extends HTMLElement {
  connectedCallback() {
    if (this.video) {
      this.observer.observe(this.querySelector(".viewport"));
      return;
    }
    this.innerHTML = `
      <div class="viewport"><div class="picture"><video playsinline preload="auto"></video><canvas></canvas></div></div>
      <div class="controls">
        <button data-action="play">Пуск / пауза</button>
        <button data-action="back" aria-label="Предыдущий кадр">−1</button>
        <label>Кадр <input class="frame" type="number" min="0" value="0"></label>
        <span class="time"></span>
        <button data-action="next" aria-label="Следующий кадр">+1</button>
        <button data-action="full">Полный экран</button>
        <label>Цвет <input class="color" type="color" value="#ff285c"></label>
        <label>Толщина <input class="width" type="number" min="1" max="32" value="8"></label>
        <button data-action="clear">Очистить</button>
        <button data-action="save">Сохранить</button>
        <label>Открыть <select><option value="vector">штрихи</option><option value="png">PNG</option></select></label>
        <button data-action="load">Загрузить</button>
      </div><output aria-live="polite"></output>`;
    this.video = this.querySelector("video");
    this.canvas = this.querySelector("canvas");
    // Стенд многократно читает пиксели. Один режим растеризации нужен и до,
    // и после чтения, чтобы сравнить исходный штрих с восстановленным.
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.field = this.querySelector(".frame");
    this.time = this.querySelector(".time");
    this.fps = Number(this.dataset.fpsNum) / Number(this.dataset.fpsDen);
    this.key = "s3:" + this.dataset.version;
    this.drawings = new Map();
    this.frame = 0;
    this.seekId = 0;
    this.lastMediaTime = null;
    this.video.onloadedmetadata = () => {
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
      this.field.max = Math.max(
        0,
        Math.round(this.video.duration * this.fps) - 1,
      );
      this.fit();
      this.seek(0);
    };
    this.video.onerror = () => this.report("Не удалось открыть прокси");
    this.video.onplay = () => {
      this.active = null;
      this.lastMediaTime = null;
      this.canvas.hidden = true;
      const track = (_, meta) => {
        if (this.video.paused) return;
        this.lastMediaTime = meta.mediaTime;
        this.displayFrame(Math.round(meta.mediaTime * this.fps));
        this.callback = this.video.requestVideoFrameCallback(track);
      };
      this.callback = this.video.requestVideoFrameCallback(track);
    };
    this.video.onpause = () => {
      this.video.cancelVideoFrameCallback(this.callback);
      if (!this.video.seeking && !this.explicitSeek) {
        this.seek(
          this.lastMediaTime === null
            ? this.frame
            : Math.round(this.lastMediaTime * this.fps),
        );
      }
      this.explicitSeek = false;
    };
    this.field.onchange = () => this.seek(Number(this.field.value));
    this.onclick = async (event) => {
      const action = event.target.dataset.action;
      try {
        if (action === "back") this.seek(this.frame - 1);
        if (action === "next") this.seek(this.frame + 1);
        if (action === "play") {
          if (this.video.paused) await this.video.play();
          else this.video.pause();
        }
        if (action === "full") {
          if (document.fullscreenElement) await document.exitFullscreen();
          else await this.requestFullscreen();
        }
        if (action === "clear") {
          this.drawings.delete(this.frame);
          this.redraw();
        }
        if (action === "save") this.save();
        if (action === "load") await this.load();
      } catch (error) {
        this.report(error.message);
      }
    };
    this.tabIndex = 0;
    this.onkeydown = (event) => {
      if (
        event.target !== this ||
        !["ArrowLeft", "ArrowRight"].includes(event.key)
      )
        return;
      event.preventDefault();
      this.seek(this.frame + (event.key === "ArrowRight" ? 1 : -1));
    };
    this.canvas.onpointerdown = (event) => this.startStroke(event);
    this.canvas.onpointermove = (event) => this.extendStroke(event);
    this.canvas.onpointerup = (event) => {
      this.extendStroke(event);
      this.active = null;
    };
    this.canvas.onlostpointercapture = () => {
      this.active = null;
    };
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(this.querySelector(".viewport"));
    this.video.src = this.dataset.src;
  }

  disconnectedCallback() {
    this.observer?.disconnect();
    this.video?.pause();
  }

  report(message) {
    this.querySelector("output").textContent = message;
  }

  fit() {
    const box = this.querySelector(".viewport").getBoundingClientRect();
    const scale = Math.min(
      box.width / this.canvas.width,
      box.height / this.canvas.height,
    );
    const picture = this.querySelector(".picture");
    picture.style.width = this.canvas.width * scale + "px";
    picture.style.height = this.canvas.height * scale + "px";
  }

  seek(number) {
    if (!this.video.videoWidth || !Number.isFinite(number)) return;
    if (!this.video.paused) {
      this.explicitSeek = true;
      this.video.pause();
    }
    this.active = null;
    const frame = Math.max(
      0,
      Math.min(Number(this.field.max), Math.round(number)),
    );
    this.field.value = frame;
    this.canvas.hidden = true;
    const id = ++this.seekId;
    if (this.seekCallback != null)
      this.video.cancelVideoFrameCallback(this.seekCallback);
    const presented = new Promise((resolve) => {
      this.seekCallback = this.video.requestVideoFrameCallback(resolve);
    });
    this.video.onseeked = async () => {
      await Promise.race([
        presented,
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (this.seekId === id && this.video.paused && !this.video.seeking)
        this.showFrame(frame);
    };
    this.video.currentTime = (frame + 0.5) / this.fps;
  }

  displayFrame(frame) {
    this.field.value = frame;
    this.time.textContent = (frame / this.fps).toFixed(3) + " с";
  }

  showFrame(frame) {
    this.frame = frame;
    this.displayFrame(frame);
    this.canvas.hidden = false;
    this.redraw();
  }

  point(event, rect) {
    const norm = (value) =>
      Math.round(Math.min(1, Math.max(0, value)) * 100000) / 100000;
    return [
      norm((event.clientX - rect.left) / rect.width),
      norm((event.clientY - rect.top) / rect.height),
    ];
  }

  startStroke(event) {
    if (event.button !== 0 || !event.isPrimary || this.canvas.hidden) return;
    this.focus({ preventScroll: true });
    const drawing = this.drawings.get(this.frame) ?? { strokes: [] };
    if (drawing.image) {
      this.report("Для редактирования загрузите штрихи");
      return;
    }
    this.drawings.set(this.frame, drawing);
    const width = Math.min(
      32,
      Math.max(1, Number(this.querySelector(".width").value)),
    );
    const stroke = {
      color: this.querySelector(".color").value,
      width: width / this.canvas.width,
      points: [],
    };
    drawing.strokes.push(stroke);
    this.active = stroke;
    this.canvas.setPointerCapture(event.pointerId);
    this.extendStroke(event);
  }

  extendStroke(event) {
    if (!event.isPrimary || !this.active) return;
    const stroke = this.active;
    const rect = this.canvas.getBoundingClientRect();
    const events = event.getCoalescedEvents?.() ?? [];
    for (const sample of events.length ? events : [event]) {
      const point = this.point(sample, rect);
      const last = stroke.points.at(-1);
      if (last && point[0] === last[0] && point[1] === last[1]) continue;
      this.paint(stroke, last ?? point, point);
      stroke.points.push(point);
    }
  }

  paint(stroke, from, to) {
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    ctx.strokeStyle = ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.width * width;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (from === to) {
      ctx.arc(to[0] * width, to[1] * height, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(from[0] * width, from[1] * height);
      ctx.lineTo(to[0] * width, to[1] * height);
      ctx.stroke();
    }
  }

  redraw() {
    const { width, height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    const drawing = this.drawings.get(this.frame);
    if (drawing?.image) this.ctx.drawImage(drawing.image, 0, 0, width, height);
    for (const stroke of drawing?.strokes ?? []) {
      stroke.points.forEach((point, i) =>
        this.paint(stroke, stroke.points[Math.max(0, i - 1)], point),
      );
    }
  }

  save() {
    if (this.canvas.hidden) throw Error("Сначала остановите видео");
    const drawing = this.drawings.get(this.frame) ?? { strokes: [] };
    if (drawing.image) throw Error("Для сохранения загрузите штрихи");
    const png = this.canvas.toDataURL("image/png");
    const json = JSON.stringify(drawing.strokes);
    localStorage.setItem(
      this.key + ":" + this.frame,
      JSON.stringify({ strokes: drawing.strokes, png }),
    );
    this.report(
      "Кадр " +
        this.frame +
        " сохранён. Штрихи " +
        new Blob([json]).size +
        " Б, PNG " +
        atob(png.split(",")[1]).length +
        " Б",
    );
  }

  async load() {
    const frame = this.frame;
    if (this.canvas.hidden) throw Error("Сначала остановите видео");
    const saved = JSON.parse(localStorage.getItem(this.key + ":" + frame));
    if (!saved) throw Error("Для этого кадра нет сохранённого рисунка");
    let drawing = { strokes: saved.strokes };
    if (this.querySelector("select").value === "png") {
      const image = new Image();
      image.src = saved.png;
      await image.decode();
      drawing = { image };
    }
    this.drawings.set(frame, drawing);
    if (this.frame === frame) this.redraw();
    this.report("Загружен рисунок кадра " + frame);
  }
}
customElements.define("drawing-player", DrawingPlayer);
