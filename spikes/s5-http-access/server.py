"""Одноразовый стенд: один монтажёр, один файл, изолированный каталог на прогон."""

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
ROOT = Path(os.environ["S5_RUN_DIR"])
OWNER = os.environ["S5_OWNER"]
LIMIT = 192 * 1024 * 1024
MEDIA = ROOT / "proxy.mp4"
SECRET = secrets.token_bytes(32)
grants = {}
sessions = {}


def audit(event):
    with (ROOT / "access.jsonl").open("a", encoding="utf-8") as log:
        log.write(json.dumps(event) + "\n")


async def app(scope, receive, send):
    if scope["type"] != "http":
        return await api(scope, receive, send)
    status = 0
    transferred = 0
    offset = None

    async def counted(message):
        nonlocal status, transferred, offset
        if message["type"] == "http.response.start":
            status = message["status"]
            content_range = dict(message["headers"]).get(b"content-range", b"")
            if status == 206 and content_range.startswith(b"bytes "):
                offset = int(content_range.split()[1].split(b"-")[0])
            message["headers"] += [
                (b"referrer-policy", b"no-referrer"),
                (b"cache-control", b"no-store"),
            ]
        await send(message)
        length = len(message.get("body", b""))
        transferred += length
        if scope["path"].startswith("/media/") and length:
            # Канал стенда 4 МиБ/с: измеряем перемотку до завершения буферизации.
            await asyncio.sleep(length / (4 * 1024 * 1024))

    async def disconnected():
        while (await receive())["type"] != "http.disconnect":
            pass

    try:
        if scope["method"] == "GET" and scope["path"].startswith("/media/"):
            # Прервать чтение с диска сразу после отмены старого Range плеером.
            transfer = asyncio.create_task(api(scope, receive, counted))
            watcher = asyncio.create_task(disconnected())
            try:
                await asyncio.wait(
                    [transfer, watcher], return_when=asyncio.FIRST_COMPLETED
                )
                if transfer.done():
                    await transfer
            finally:
                for task in (transfer, watcher):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(transfer, watcher, return_exceptions=True)
        else:
            await api(scope, receive, counted)
    finally:
        route = scope.get("route")
        audit(
            {
                "method": scope["method"],
                "route": getattr(route, "path", "unknown"),
                "status": status,
                "body_bytes": transferred,
                "range_start": offset,
            }
        )


def owner(request):
    if not secrets.compare_digest(
        request.headers.get("authorization", ""), "Bearer " + OWNER
    ):
        raise HTTPException(403)


def active(handle):
    grant = grants.get(handle)
    if not grant or grant["revoked"] or time.time() >= grant["expires"]:
        raise HTTPException(403)
    return grant


class Lifetime(BaseModel):
    seconds: int = Field(ge=1, le=604800, default=120)


@api.post("/invites")
def invite(data: Lifetime, request: Request):
    owner(request)
    handle, token = secrets.token_hex(12), secrets.token_urlsafe(32)
    grants[handle] = {
        "token": token,
        "expires": time.time() + data.seconds,
        "revoked": False,
    }
    return {"handle": handle, "token": token}


@api.delete("/invites/{handle}")
def revoke(handle: str, request: Request):
    owner(request)
    if handle not in grants:
        raise HTTPException(404)
    grants[handle]["revoked"] = True
    return {"revoked": True}


def from_token(token):
    for handle, grant in grants.items():
        if secrets.compare_digest(grant["token"], token):
            active(handle)
            return handle
    raise HTTPException(403)


class Guest(BaseModel):
    token: str
    name: str = Field(min_length=1, max_length=100)
    mode: str


def signature(handle, expiry):
    return hmac.new(
        SECRET, f"/media/signed:{handle}:{expiry}".encode(), hashlib.sha256
    ).hexdigest()


@api.post("/join")
def join(data: Guest):
    handle = from_token(data.token)
    if not data.name.strip():
        raise HTTPException(422)
    if data.mode == "url":
        return {"src": "/media/url?" + urlencode({"token": data.token})}
    if data.mode == "signed":
        expiry = min(int(time.time()) + 30, int(active(handle)["expires"]))
        return {
            "src": "/media/signed?"
            + urlencode(
                {"id": handle, "until": expiry, "sig": signature(handle, expiry)}
            )
        }
    if data.mode != "cookie":
        raise HTTPException(400)
    sid = secrets.token_urlsafe(32)
    sessions[sid] = (handle, data.name.strip())
    result = JSONResponse({"src": "/media/cookie"})
    result.set_cookie(
        "s5_session", sid, httponly=True, secure=True, samesite="strict", path="/media"
    )
    return result


@api.get("/media/{mode}")
async def media(mode: str, request: Request):
    query = request.query_params
    if mode == "url":
        from_token(query.get("token", ""))
    elif mode == "cookie":
        session = sessions.get(request.cookies.get("s5_session"))
        if not session:
            raise HTTPException(403)
        active(session[0])
    elif mode == "signed":
        handle = query.get("id", "")
        expiry = query.get("until", "")
        if not expiry.isdecimal() or len(expiry) > 12 or time.time() >= int(expiry):
            raise HTTPException(403)
        if not secrets.compare_digest(signature(handle, expiry), query.get("sig", "")):
            raise HTTPException(403)
        active(handle)
    else:
        raise HTTPException(404)
    return FileResponse(MEDIA, media_type="video/mp4")


@api.put("/upload")
async def upload(request: Request):
    owner(request)
    length = request.headers.get("content-length")
    if length is not None and int(length) > LIMIT:
        raise HTTPException(413)
    total = 0
    digest = hashlib.sha256()
    path = None
    try:
        with tempfile.NamedTemporaryFile(dir=ROOT, delete=False) as out:
            path = Path(out.name)
            async for chunk in request.stream():
                total += len(chunk)
                if total > LIMIT:
                    raise HTTPException(413)
                digest.update(chunk)
                out.write(chunk)
        if not total:
            raise HTTPException(400)
        os.replace(path, MEDIA)
        return {"bytes": total, "sha256": digest.hexdigest()}
    finally:
        if path is not None:
            path.unlink(missing_ok=True)


@api.get("/", response_class=HTMLResponse)
def page():
    return (Path(__file__).with_name("guest.html")).read_text(encoding="utf-8")
