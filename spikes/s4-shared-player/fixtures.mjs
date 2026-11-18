import { fileURLToPath } from "node:url";
export const media = new Map(
  [
    ["/media/numbered.mp4", "../s2-player-seek/out/cfr30-g30.mp4"],
    ["/media/hlg.mp4", "../s1-ffmpeg-proxy/out/hdr/naive.mp4"],
    ["/media/sdr.mp4", "../s1-ffmpeg-proxy/out/hdr/hable-npl200.mp4"],
    [
      "/media/audio.mp4",
      "../s1-ffmpeg-proxy/out/real-bbb-1080p30-10min--x264-720p-crf23-g1s.mp4",
    ],
  ].map(([url, path]) => [url, fileURLToPath(new URL(path, import.meta.url))]),
);
