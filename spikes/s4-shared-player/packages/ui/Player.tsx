import { createElement, useState } from "react";
import "../../../s3-drawing/player.js";
import "../../../s3-drawing/player.css";

export type Source = (name: string) => string;

export function Player({ source }: { source: Source }) {
  const [clip, setClip] = useState("numbered");
  return (
    <>
      <h1>Проверка общего плеера</h1>
      <label>
        Прокси{" "}
        <select
          id="clip"
          value={clip}
          onChange={(e) => setClip(e.target.value)}
        >
          <option value="numbered">Тест с номерами кадров</option>
          <option value="hlg">iPhone HDR · HLG</option>
          <option value="sdr">iPhone HDR · перевод в SDR</option>
          <option value="audio">Big Buck Bunny со звуком</option>
        </select>
      </label>
      {createElement("drawing-player", {
        key: clip,
        "data-src": source(clip),
        "data-version": clip,
        "data-fps-num": ["hlg", "sdr"].includes(clip) ? 60 : 30,
        "data-fps-den": 1,
      })}
    </>
  );
}
