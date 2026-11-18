"""Запуск из корня: python3 spikes/s5-http-access/run.py (Windows: py -3)."""

import hashlib
import http.client
import json
import os
import platform
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
S4 = HERE.parent / "s4-shared-player"
S1 = HERE.parent / "s1-ffmpeg-proxy"
LIMIT = 192 * 1024 * 1024
BLOCK = bytes(1024 * 1024)


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def prepare():
    OUT.mkdir(exist_ok=True)
    python = OUT / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(OUT / "venv")], check=True)
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "-q",
            "-r",
            str(HERE / "requirements.txt"),
        ],
        check=True,
    )
    if not all(
        (S4 / "node_modules" / name / "package.json").exists()
        for name in ["playwright", "electron"]
    ):
        subprocess.run(
            [shutil.which("npm.cmd" if os.name == "nt" else "npm") or "npm", "ci"],
            cwd=S4,
            check=True,
        )
    subprocess.run(["node", "-e", "require('electron')"], cwd=S4, check=True)
    return python


def fixture(work):
    base = "real-bbb-1080p30-10min"
    existing = S1 / "out" / (base + "--x264-720p-crf23-g1s.mp4")
    if existing.is_file():
        return existing
    original = S1 / "media" / (base + ".mp4")
    check(
        original.is_file(),
        "Нужен Big Buck Bunny из README или готовый прокси R1 из S1.",
    )
    path = work / existing.name
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(original),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-vf",
            "scale=-2:720",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-profile:v",
            "high",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "23",
            "-g",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            str(path),
        ],
        check=True,
    )
    return path


class Observer(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.observed.append(bool(self.headers.get("Referer")))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *args):
        pass


def run(work, python, report):
    source = fixture(work)
    size = source.stat().st_size
    owner = secrets.token_urlsafe(32)
    sensitive = [owner]
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    observer = ThreadingHTTPServer(("127.0.0.1", 0), Observer)
    observer.observed = []
    threading.Thread(target=observer.serve_forever, daemon=True).start()
    env = dict(
        os.environ,
        S5_OWNER=owner,
        S5_BASE=f"http://127.0.0.1:{port}",
        S5_RUN_DIR=str(work),
        S5_BYTES=str(size),
        S5_OBSERVER=f"http://127.0.0.1:{observer.server_port}",
    )
    auth = {"Authorization": "Bearer " + owner}

    def request(method, path, body=None, headers=None, chunked=False):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
        try:
            conn.request(
                method, path, body=body, headers=headers or {}, encode_chunked=chunked
            )
            response = conn.getresponse()
            return response.status, response.read(), response.headers
        finally:
            conn.close()

    def expect(status, method, path, **kwargs):
        actual, data, headers = request(method, path, **kwargs)
        check(
            actual == status,
            f"{method} {urlsplit(path).path}: ожидался {status}, получен {actual}",
        )
        return data, headers

    def post(path, payload, headers=None):
        return expect(
            200,
            "POST",
            path,
            body=json.dumps(payload),
            headers={"Content-Type": "application/json", **(headers or {})},
        )

    def invite(seconds):
        data = json.loads(post("/invites", {"seconds": seconds}, auth)[0])
        sensitive.append(data["token"])
        return data

    def links(grant):
        result = []
        for mode in ["url", "cookie", "signed"]:
            data, headers = post(
                "/join", {"token": grant["token"], "mode": mode, "name": "Гость S5"}
            )
            src = json.loads(data)["src"]
            media_headers = {"Range": "bytes=0-7"}
            if mode == "cookie":
                cookie = headers["Set-Cookie"]
                check(
                    all(
                        flag in cookie.lower()
                        for flag in ["httponly", "secure", "samesite=strict"]
                    ),
                    "Атрибуты cookie",
                )
                media_headers["Cookie"] = cookie.split(";")[0]
                sensitive.append(media_headers["Cookie"].split("=", 1)[1])
            if mode == "signed":
                sensitive.append(src.split("sig=")[1])
            result.append((src, media_headers))
        return result

    with (work / "uvicorn.log").open("wb") as log:
        server = subprocess.Popen(
            [
                str(python),
                "-m",
                "uvicorn",
                "server:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--no-access-log",
            ],
            env=env,
            cwd=HERE,
            stdout=log,
            stderr=log,
        )
        try:
            for _ in range(100):
                check(server.poll() is None, "FastAPI завершился до запуска")
                try:
                    expect(200, "GET", "/")
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("FastAPI не ответил")
            print("Проверяю потоковую загрузку и лимит 192 МиБ", flush=True)
            expect(403, "PUT", "/upload", body=b"x")
            expect(
                200,
                "PUT",
                "/upload",
                body=(BLOCK for _ in range(LIMIT // len(BLOCK))),
                headers=auth,
                chunked=True,
            )
            expect(
                413,
                "PUT",
                "/upload",
                body=iter([b"x" * len(BLOCK)] * (LIMIT // len(BLOCK)) + [b"x"]),
                headers=auth,
                chunked=True,
            )
            check(
                (work / "proxy.mp4").stat().st_size == LIMIT,
                "Отказ загрузки изменил предыдущий файл",
            )
            with (work / "proxy.mp4").open("rb") as previous:
                check(previous.read(len(BLOCK)) == BLOCK, "Повреждён предыдущий файл")
            # Клиент передаёт файл кусками и считает прогресс по фактически отправленным байтам.
            digest = hashlib.sha256()
            progress = []

            def chunks():
                sent = 0
                with source.open("rb") as stream:
                    while True:
                        chunk = stream.read(len(BLOCK))
                        if not chunk:
                            break
                        yield chunk
                        sent += len(chunk)
                        digest.update(chunk)
                        while len(progress) < 4 and sent * 4 >= size * (
                            len(progress) + 1
                        ):
                            progress.append((len(progress) + 1) * 25)

            start = time.monotonic()
            result = json.loads(
                expect(
                    200,
                    "PUT",
                    "/upload",
                    body=chunks(),
                    headers={**auth, "Content-Length": str(size)},
                )[0]
            )
            upload = {
                **result,
                "seconds": round(time.monotonic() - start, 3),
                "progress": progress,
                "limit_bytes": LIMIT,
                "over_limit_status": 413,
                "fixture": source.name,
            }
            check(
                progress == [25, 50, 75, 100]
                and result == {"bytes": size, "sha256": digest.hexdigest()},
                "Проверка загрузки",
            )
            expect(403, "GET", "/media/cookie", headers={"Range": "bytes=0-7"})
            grant = invite(120)
            credentials = links(grant)
            mid = size // 2
            with source.open("rb") as stream:
                stream.seek(mid)
                reference = stream.read(4096)
            for src, headers in credentials:
                data, response_headers = expect(
                    206,
                    "GET",
                    src,
                    headers={**headers, "Range": f"bytes={mid}-{mid + 4095}"},
                )
                check(
                    data == reference
                    and response_headers["Content-Range"]
                    == f"bytes {mid}-{mid + 4095}/{size}",
                    "Содержимое Range",
                )
            expect(200, "DELETE", "/invites/" + grant["handle"], headers=auth)
            for src, headers in credentials:
                expect(403, "GET", src, headers=headers)
            short = invite(2)
            expired = links(short)
            time.sleep(2.1)
            for src, headers in expired:
                expect(403, "GET", src, headers=headers)
            expect(
                403,
                "POST",
                "/join",
                body=json.dumps(
                    {"token": short["token"], "mode": "cookie", "name": "Гость"}
                ),
                headers={"Content-Type": "application/json"},
            )
            long = invite(120)
            active_links = links(long)
            signed_start = time.monotonic()
            proc = subprocess.run(
                ["node", str(HERE / "browser.mjs")],
                cwd=HERE,
                env=env,
                stdout=subprocess.PIPE,
                text=True,
                check=True,
                timeout=180,
            )
            browsers = json.loads(proc.stdout)
            check(
                len(browsers) == 6 and observer.observed == [False, True] * 6,
                "Referer: ожидались шесть пар без заголовка / контроль с заголовком",
            )
            time.sleep(max(0, 31 - (time.monotonic() - signed_start)))
            expect(403, "GET", active_links[2][0], headers=active_links[2][1])
            expect(206, "GET", active_links[1][0], headers=active_links[1][1])
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
            observer.shutdown()
            observer.server_close()
    audit = (work / "access.jsonl").read_text()
    logs = audit + (work / "uvicorn.log").read_text(errors="replace")
    check(all(value not in logs for value in sensitive), "В журнал попал секрет")
    entries = [json.loads(line) for line in audit.splitlines()]
    check(
        all(
            set(e) == {"method", "route", "status", "body_bytes", "range_start"}
            for e in entries
        ),
        "Формат журнала",
    )
    check(
        all(
            e["route"]
            in {
                "/",
                "/invites",
                "/invites/{handle}",
                "/join",
                "/upload",
                "/media/{mode}",
                "unknown",
            }
            for e in entries
        ),
        "В журнал попал полный адрес",
    )
    output = {
        "when": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "upload": upload,
        "browsers": browsers,
        "referer_absent": observer.observed.count(False),
        "referer_controls": observer.observed.count(True),
        "access_records": len(entries),
        "secrets_found": 0,
        "revoke": [403] * 3,
        "invite_expired": [403] * 3,
        "signed_expired": 403,
        "cookie_still_active": 206,
    }
    report.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("PASS", report, flush=True)


if __name__ == "__main__":
    python = prepare()
    with tempfile.TemporaryDirectory(prefix="s5-", dir=OUT) as tmp:
        report = OUT / (Path(tmp).name + ".json")
        run(Path(tmp), python, report)
