"""Install in Meshive Pod — download missing models straight into a Meshive pod.

ComfyUI's own "Download" button in the Missing Models panel is a browser download, so the
file lands on the user's computer. This extension adds an "Install in Meshive Pod" button
that has the ComfyUI server inside the pod fetch the same URL and save it into the right
model folder. There is no extra service: the browser already talks to ComfyUI through the
pod's endpoint, so the extension only adds a few routes.

Routes (ComfyUI also registers each one under the `/api` prefix):
    POST /meshive/download/start    {url, directory, filename, hash?, hash_type?}
    POST /meshive/download/cancel   {id}
    GET  /meshive/download/status
    GET  /meshive/download/targets  read-only: where each model folder would download to

Progress is pushed over the ComfyUI websocket:
    meshive_download_progress | meshive_download_complete | meshive_download_error

Security (this runs inside the pod, so a server-side request forgery would reach the pod's network):
  * The first URL must be https on an allowed host (huggingface.co, civitai.com and subdomains).
  * Redirects are followed by hand (at most MAX_REDIRECTS). Hugging Face and Civitai hand the
    file off to CDN hosts, so redirect targets are not allow-listed — instead every connection
    goes through `SafeResolver`, which refuses any host that resolves to a non-public address
    (private, loopback, link-local including 169.254.169.254, cluster ranges). Checking inside
    the resolver that makes the connection leaves no DNS-rebinding gap.
  * HF_TOKEN / CIVITAI_TOKEN are sent to the first host only and dropped on cross-host redirects.
  * Files go only into folders ComfyUI registers for models; names must be a bare file name
    with a model extension; existing files are never overwritten.

Meshive storage:
  * A Meshive pod receives `MESHIVE_{ROLE}_DIR` environment variables for the template's
    storage-backed folders (models, output, ...). Folders outside them sit on the container's
    system disk, which is small and does not survive a restart. So in a Meshive pod the
    extension prefers model folders on mounted storage (Meshive-declared ones first) and never
    uses output/config/input/cache folders. If a model type has no folder on mounted storage,
    the file still goes into ComfyUI's own folder for that type, marked temporary (it loads
    right away but is lost when the pod restarts); only files larger than
    TEMPORARY_MAX_BYTES are refused there, since filling the system disk evicts the pod.
  * Meshive grows pod storage as it fills. A free-space check is therefore only a warning
    there, and a full disk (ENOSPC) during a write is waited out instead of failing at once.
"""

import asyncio
import errno
import hashlib
import ipaddress
import logging
import os
import shutil
import socket
import time
import uuid
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp import web

import folder_paths
from server import PromptServer

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

log = logging.getLogger("meshive.pod_download")

ALLOWED_HOSTS = ("huggingface.co", "civitai.com")
ALLOWED_EXTENSIONS = (".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx")
MAX_REDIRECTS = 5
CHUNK_SIZE = 4 * 1024 * 1024
PROGRESS_INTERVAL = 0.25
MAX_CONCURRENT = 2
# Space to leave free after a download: a completely full disk stops ComfyUI from writing outputs.
DISK_MARGIN_BYTES = 1 * 1024**3
PART_SUFFIX = ".meshive.part"
# How long to wait for storage to grow after ENOSPC before giving up.
ENOSPC_WAIT_SECONDS = 120
ENOSPC_POLL_SECONDS = 2
# A dropped connection resumes from the partial file; give up after this many failures in a row
# that made no progress.
MAX_ATTEMPTS = 5
# Largest file accepted on the container's system disk (a model type with no folder on pod storage).
# A GPU pod's system disk is small, and overrunning it evicts the whole pod.
TEMPORARY_MAX_BYTES = 10 * 1024**3
ACTIVE_STATUSES = ("queued", "downloading", "waiting_storage", "verifying")
# The partial file carries the pod name, so pods sharing one network volume never write to each
# other's partial file. A pod keeps its name across restarts, so resuming still works.
_HOST_TAG = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in socket.gethostname())[:63] or "pod"

# id -> state. Lives only as long as the process; a restart leaves just the partial files.
downloads: dict[str, dict] = {}
_tasks: dict[str, asyncio.Task] = {}
_semaphore = asyncio.Semaphore(MAX_CONCURRENT)


# ---------------------------------------------------------------------------- #
#                              Request forgery guard                           #
# ---------------------------------------------------------------------------- #

def _is_public_ip(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return False
    # Judge an IPv4-mapped IPv6 address (::ffff:10.0.0.1) by its IPv4 part.
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


class BlockedAddress(OSError):
    """A host resolved to a non-public address. Never retried."""


class SafeResolver(aiohttp.abc.AbstractResolver):
    """Resolves only hosts whose every address is public — checked on the address actually used."""

    async def resolve(self, host, port=0, family=socket.AF_INET):
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
        results = []
        for fam, _, _, _, sockaddr in infos:
            addr = sockaddr[0]
            if not _is_public_ip(addr):
                raise BlockedAddress(f"blocked non-public address {addr} for host {host}")
            results.append({
                "hostname": host, "host": addr, "port": port,
                "family": fam, "proto": 0, "flags": socket.AI_NUMERICHOST,
            })
        if not results:
            raise OSError(f"no address for host {host}")
        return results

    async def close(self):
        pass


def _host_allowed(host: str) -> bool:
    host = (host or "").lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)


def _validate_source_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise ValueError("only https URLs are allowed")
    if parts.username or parts.password:
        raise ValueError("credentials in URL are not allowed")
    if not _host_allowed(parts.hostname):
        raise ValueError(f"host not allowed: {parts.hostname}")
    return url


def _auth_headers(url: str) -> dict:
    """Token for the first host only; redirect hops never call this."""
    host = (urlsplit(url).hostname or "").lower()
    if host == "huggingface.co" or host.endswith(".huggingface.co"):
        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    elif host == "civitai.com" or host.endswith(".civitai.com"):
        token = os.environ.get("CIVITAI_TOKEN")
    else:
        token = None
    return {"Authorization": f"Bearer {token}"} if token else {}


# ---------------------------------------------------------------------------- #
#                          File names and target folders                       #
# ---------------------------------------------------------------------------- #

def _sanitize_filename(name: str) -> str:
    if not name or name != os.path.basename(name) or "\\" in name or name in (".", ".."):
        raise ValueError("invalid filename")
    if name.startswith(".") or "\x00" in name:
        raise ValueError("invalid filename")
    if not name.lower().endswith(ALLOWED_EXTENSIONS):
        raise ValueError(f"extension not allowed (allowed: {', '.join(ALLOWED_EXTENSIONS)})")
    return name


# Folders that must not receive models even though they are storage-backed: output and config
# are collected as the user's own files, input holds uploads, model_cache is the Hugging Face
# cache. Recent ComfyUI versions also register subfolders of output (output/checkpoints, ...)
# as model folders, so "it is mounted" alone is not enough.
_NON_MODEL_ROLES = {"OUTPUT", "CONFIG", "DATASET", "INPUT", "MODEL_CACHE"}


def _semantic_dirs() -> dict[str, str]:
    """`MESHIVE_{ROLE}_DIR` → {ROLE: real path}. Empty outside a Meshive pod."""
    return {k[len("MESHIVE_"):-len("_DIR")]: os.path.realpath(v) for k, v in os.environ.items()
            if k.startswith("MESHIVE_") and k.endswith("_DIR") and v.startswith("/")}


def _managed_roots() -> list[str]:
    return list(_semantic_dirs().values())


def _blocked_roots() -> list[str]:
    return [p for role, p in _semantic_dirs().items() if role in _NON_MODEL_ROLES]


def _within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def _on_mounted_storage(path: str) -> bool:
    """Is the path on a filesystem other than the root one (the container's system disk)?
    A folder that does not exist yet is judged by its nearest existing parent."""
    p = os.path.realpath(path)
    while not os.path.exists(p):
        p = os.path.dirname(p)
    return os.stat(p).st_dev != os.stat("/").st_dev


def _resolve_dest_dir(directory: str) -> tuple[str, bool, bool]:
    """(target folder, Meshive-managed storage?, temporary — on the container's system disk?)."""
    dest, managed, temporary = _resolve_dest_dir_readonly(directory, _managed_roots())
    os.makedirs(dest, exist_ok=True)
    return dest, managed, temporary


def _resolve_dest_dir_readonly(directory: str, roots: list[str]) -> tuple[str, bool, bool]:
    if directory not in folder_paths.folder_names_and_paths:
        raise ValueError(f"unknown model directory: {directory}")
    paths = folder_paths.get_folder_paths(directory)
    if not paths:
        raise ValueError(f"no path registered for: {directory}")
    temporary = False
    if not roots:
        dest = paths[0]  # not a Meshive pod: ComfyUI's default
    else:
        # ComfyUI lists legacy folder names first (diffusion_models → models/unet), so choose by
        # storage, not by order: a Meshive-declared folder first, then any other mounted folder
        # (a user volume covering a parent directory).
        blocked = _blocked_roots()
        mounted = [p for p in paths if _on_mounted_storage(p)
                   and not any(_within(os.path.realpath(p), r) for r in blocked)]
        model_roots = [r for r in roots if r not in blocked]
        declared = [p for p in mounted if any(_within(os.path.realpath(p), r) for r in model_roots)]
        if declared or mounted:
            dest = (declared or mounted)[0]
        else:
            # No folder for this type on pod storage: still install into ComfyUI's own folder so the
            # model loads, but mark it temporary.
            usable = [p for p in paths if not any(_within(os.path.realpath(p), r) for r in blocked)]
            if not usable:
                raise ValueError(f"'{directory}' has no folder that can hold models in this pod.")
            dest, temporary = usable[0], True
    return dest, bool(roots), temporary


# ---------------------------------------------------------------------------- #
#                                   Download                                   #
# ---------------------------------------------------------------------------- #

class DownloadError(Exception):
    pass


async def _open_with_redirects(session, url, headers):
    """Follow redirects by hand and return the final response. The token rides on the first hop only."""
    current = url
    hop_headers = dict(headers)
    for hop in range(MAX_REDIRECTS + 1):
        resp = await session.get(current, headers=hop_headers, allow_redirects=False)
        if resp.status in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location")
            resp.release()
            if not location:
                raise DownloadError("redirect without Location")
            nxt = urljoin(current, location)
            if urlsplit(nxt).scheme != "https":
                raise DownloadError("redirected to non-https URL")
            # Do not leak the token to a CDN on another host.
            if urlsplit(nxt).hostname != urlsplit(current).hostname:
                hop_headers.pop("Authorization", None)
            current = nxt
            continue
        return resp
    raise DownloadError("too many redirects")


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


async def _emit(event: str, payload: dict):
    await PromptServer.instance.send(event, payload)


def _size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _retryable(e: BaseException) -> bool:
    """Only a connection dropped mid-transfer is resumed — not a blocked host, an HTTP refusal or a disk error."""
    if isinstance(e, aiohttp.ClientConnectorError):
        return not isinstance(e.os_error, BlockedAddress)
    return isinstance(e, (aiohttp.ClientPayloadError, aiohttp.ServerDisconnectedError,
                          aiohttp.ClientOSError, asyncio.TimeoutError))


async def _write_all(f, data: bytes, state: dict):
    """Write everything; on a full disk, wait for the storage to grow instead of failing at once."""
    view = memoryview(data)
    deadline = None
    while view:
        try:
            n = f.write(view)
        except OSError as e:
            if e.errno not in (errno.ENOSPC, errno.EDQUOT):
                raise
            now = time.monotonic()
            if deadline is None:
                deadline = now + ENOSPC_WAIT_SECONDS
                state["status"] = "waiting_storage"
                log.info("download %s: storage full, waiting up to %ss for it to grow", state["id"], ENOSPC_WAIT_SECONDS)
                await _emit("meshive_download_progress", _public(state))
            if now >= deadline:
                raise DownloadError(
                    f"storage is full and did not grow within {ENOSPC_WAIT_SECONDS}s — the pod's storage "
                    f"limit may be reached. The partial file is kept; retry to resume.") from e
            await asyncio.sleep(ENOSPC_POLL_SECONDS)
            continue
        view = view[n:]
    if deadline is not None:
        state["status"] = "downloading"


async def _fetch_to_part(session, state: dict) -> int:
    """Fill the partial file with one request (resuming if it exists). Returns the total size received."""
    part_path = state["part_path"]
    resume_from = _size(part_path)
    headers = _auth_headers(state["url"])
    if resume_from:
        headers["Range"] = f"bytes={resume_from}-"

    resp = await _open_with_redirects(session, state["url"], headers)
    try:
        if resp.status in (401, 403):
            raise DownloadError(
                f"access denied ({resp.status}). Gated model: set HF_TOKEN / CIVITAI_TOKEN in the pod environment.")
        if resp.status == 416 and resume_from:
            return resume_from  # the partial file is already complete — go on to verification
        if resp.status not in (200, 206):
            raise DownloadError(f"unexpected HTTP status {resp.status}")
        if resp.status == 200 and resume_from:
            resume_from = 0  # the server ignored Range — start over
        length = resp.content_length
        if not state["total"] and length is not None:
            state["total"] = length + resume_from

        total = state["total"]
        if state["temporary"] and total > TEMPORARY_MAX_BYTES:
            raise DownloadError(
                f"{total / 1024**3:.1f} GiB is too large for the pod's system disk (limit "
                f"{TEMPORARY_MAX_BYTES / 1024**3:.0f} GiB): '{state['directory']}' has no folder on pod storage. "
                f"Attach a volume that covers {os.path.dirname(state['dest_path'])} and retry.")
        if total:
            free = shutil.disk_usage(os.path.dirname(part_path)).free
            need = total - resume_from + DISK_MARGIN_BYTES
            if free < need:
                msg = f"not enough disk space: need {need / 1024**3:.1f} GiB, free {free / 1024**3:.1f} GiB"
                if not state["managed"] or state["temporary"]:
                    raise DownloadError(msg)
                # Meshive storage grows as it fills — note it and carry on.
                log.info("download %s: %s (managed storage, continuing)", state["id"], msg)

        downloaded = resume_from
        state["downloaded"] = downloaded
        last_emit = 0.0
        window_t, window_b = time.monotonic(), downloaded
        # Unbuffered, so partial writes and ENOSPC surface here instead of being hidden by a buffer
        # (which would put the resume offset in the wrong place).
        with open(part_path, "ab" if resume_from else "wb", buffering=0) as f:
            async for chunk in resp.content.iter_chunked(CHUNK_SIZE):
                await _write_all(f, chunk, state)
                downloaded += len(chunk)
                state["downloaded"] = downloaded
                now = time.monotonic()
                if now - last_emit >= PROGRESS_INTERVAL:
                    span = now - window_t
                    if span >= 1.0:
                        state["speed"] = (downloaded - window_b) / span
                        window_t, window_b = now, downloaded
                    last_emit = now
                    await _emit("meshive_download_progress", _public(state))
        return downloaded
    finally:
        resp.release()


def _publish(part_path: str, dest_path: str) -> bool:
    """Give the partial file its real name without overwriting anything. False if another pod got there first."""
    try:
        os.link(part_path, dest_path)  # atomic: fails with EEXIST if the target exists
    except FileExistsError:
        os.remove(part_path)
        return False
    except OSError as e:
        if e.errno not in (errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EXDEV, errno.EMLINK):
            raise
        if os.path.exists(dest_path):  # filesystem without hard links: check, then rename
            os.remove(part_path)
            return False
        os.replace(part_path, dest_path)
        return True
    os.remove(part_path)
    return True


async def _run_download(state: dict):
    did = state["id"]
    dest_path, part_path = state["dest_path"], state["part_path"]
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
    connector = aiohttp.TCPConnector(resolver=SafeResolver(), limit=4)
    try:
        async with _semaphore:
            state["status"] = "downloading"
            async with aiohttp.ClientSession(connector=connector, timeout=timeout, trust_env=False) as session:
                failures = 0
                while True:
                    before = _size(part_path)
                    try:
                        total = await _fetch_to_part(session, state)
                        break
                    except Exception as e:  # noqa: BLE001 — decide retry here, re-raise everything else
                        if _size(part_path) > before:
                            failures = 0  # it made progress — count only failures in a row
                        failures += 1
                        if not _retryable(e) or failures >= MAX_ATTEMPTS:
                            raise
                        log.info("download %s: connection lost (%s), resuming (%d/%d)", did, e, failures, MAX_ATTEMPTS)
                        state["status"] = "downloading"
                        await asyncio.sleep(min(2 ** failures, 30))

            if state["total"] and total != state["total"]:
                raise DownloadError(f"size mismatch: got {total}, expected {state['total']}")

            expected = (state.get("hash") or "").lower()
            if expected:
                state["status"] = "verifying"
                await _emit("meshive_download_progress", _public(state))
                actual = await asyncio.get_running_loop().run_in_executor(None, _sha256_file, part_path)
                if actual != expected:
                    os.remove(part_path)  # a corrupt file is not worth resuming
                    raise DownloadError("sha256 mismatch — file removed")

            published = _publish(part_path, dest_path)
            state.update(status="complete" if published else "exists", downloaded=total, total=total)
            await _emit("meshive_download_complete", _public(state))
    except asyncio.CancelledError:
        state["status"] = "cancelled"
        if os.path.exists(part_path):
            try:
                os.remove(part_path)
            except OSError:
                pass
        await _emit("meshive_download_error", {**_public(state), "error": "cancelled"})
        raise
    except Exception as e:  # noqa: BLE001 — every failure is shown to the user with its reason
        log.warning("download %s failed: %s", did, e)
        state.update(status="error", error=str(e))
        await _emit("meshive_download_error", _public(state))
    finally:
        _tasks.pop(did, None)


def _public(state: dict) -> dict:
    total, done = state.get("total") or 0, state.get("downloaded") or 0
    return {
        "id": state["id"], "filename": state["filename"], "directory": state["directory"],
        "status": state["status"], "downloaded": done, "total": total,
        "progress": (done / total * 100) if total else 0,
        "speed": state.get("speed", 0), "error": state.get("error"),
        "path": state.get("dest_path"), "temporary": state.get("temporary", False),
    }


# ---------------------------------------------------------------------------- #
#                                    Routes                                    #
# ---------------------------------------------------------------------------- #

def _bad(msg: str, status: int = 400):
    return web.json_response({"error": msg}, status=status)


@PromptServer.instance.routes.post("/meshive/download/start")
async def start_download(request):
    try:
        body = await request.json()
        url = _validate_source_url(str(body.get("url", "")))
        filename = _sanitize_filename(str(body.get("filename", "")))
        directory = str(body.get("directory", ""))
        if directory not in folder_paths.folder_names_and_paths:
            raise ValueError(f"unknown model directory: {directory}")
        # Already present in any folder ComfyUI searches (attached assets, legacy folder names, ...)?
        if folder_paths.get_full_path(directory, filename):
            return web.json_response({"status": "exists", "filename": filename, "directory": directory})
        dest_dir, managed, temporary = _resolve_dest_dir(directory)
    except (ValueError, TypeError) as e:
        return _bad(str(e))
    except Exception:  # malformed JSON and the like
        return _bad("invalid request body")

    dest_path = os.path.join(dest_dir, filename)
    if os.path.exists(dest_path):
        return web.json_response({"status": "exists", "filename": filename, "directory": directory})

    # Same target already downloading: hand back that download instead of starting another.
    for st in downloads.values():
        if st["dest_path"] == dest_path and st["status"] in ACTIVE_STATUSES:
            return web.json_response(_public(st))

    hash_ = str(body.get("hash", "") or "").lower()
    if hash_ and (str(body.get("hash_type", "sha256")).lower() != "sha256" or len(hash_) != 64):
        hash_ = ""  # only sha256 is verified; anything else is ignored

    state = {
        "id": uuid.uuid4().hex[:12], "url": url, "filename": filename, "directory": directory,
        "dest_path": dest_path, "part_path": f"{dest_path}.{_HOST_TAG}{PART_SUFFIX}", "managed": managed,
        "temporary": temporary, "hash": hash_, "status": "queued", "downloaded": 0, "total": 0, "speed": 0, "error": None,
    }
    downloads[state["id"]] = state
    _tasks[state["id"]] = asyncio.create_task(_run_download(state))
    return web.json_response(_public(state))


@PromptServer.instance.routes.post("/meshive/download/cancel")
async def cancel_download(request):
    try:
        did = str((await request.json()).get("id", ""))
    except Exception:
        return _bad("invalid request body")
    task = _tasks.get(did)
    if not task:
        return _bad("no such active download", 404)
    task.cancel()
    return web.json_response({"id": did, "status": "cancelling"})


@PromptServer.instance.routes.get("/meshive/download/status")
async def download_status(request):
    return web.json_response([_public(s) for s in downloads.values()])


@PromptServer.instance.routes.get("/meshive/download/targets")
async def download_targets(request):
    """Read-only: which folder each model type would download to, and why."""
    roots = _managed_roots()
    out = {}
    for directory in sorted(folder_paths.folder_names_and_paths):
        if directory in ("custom_nodes", "configs"):
            continue
        cands = []
        for p in folder_paths.get_folder_paths(directory):
            real = os.path.realpath(p)
            mounted = _on_mounted_storage(p)
            probe = real
            while not os.path.exists(probe):
                probe = os.path.dirname(probe)
            cands.append({"path": p, "mounted": mounted,
                          "declared": any(_within(real, r) for r in roots),
                          "blocked": any(_within(real, r) for r in _blocked_roots()),
                          "free_bytes": shutil.disk_usage(probe).free})
        entry = {"candidates": cands}
        try:
            dest, managed, temporary = _resolve_dest_dir_readonly(directory, roots)
            entry.update(dest=dest, managed=managed, temporary=temporary)
        except ValueError as e:
            entry["error"] = str(e)
        out[directory] = entry
    return web.json_response({"managed_roots": roots, "host": _HOST_TAG, "targets": out})
