"""Install in Meshive Pod — download missing models straight into a Meshive pod.

ComfyUI's own "Download" button in the Missing Models panel is a browser download, so the file
lands on the user's computer. This extension adds an "Install in Meshive Pod" button that has the
ComfyUI server inside the pod fetch the same URL and save it into the right model folder. There is
no extra service: the browser already talks to ComfyUI through the pod's endpoint, so the extension
only adds a few routes.

Routes (ComfyUI also registers each one under the `/api` prefix):
    POST /meshive/download/start    {url, directory, filename, hash?, hash_type?, token?}
    POST /meshive/download/pause    {id}
    POST /meshive/download/resume   {id}
    POST /meshive/download/cancel   {id}
    POST /meshive/download/clear    forget finished downloads
    GET  /meshive/download/status
    GET  /meshive/download/targets  read-only: where each model folder would download to
    GET  /meshive/info              {version, host, boot}
    GET  /meshive/hf/status         {env_token}: is there a Hugging Face token in the pod environment
    POST /meshive/hf/verify         {token?, urls?}: who the token belongs to, and which URLs it can fetch
The extension's own scripts are served with no-cache headers (and X-Version), so an update is
picked up on the next page load.

Events on the ComfyUI websocket:
    meshive_download_progress | _paused | _resumed | _complete | _error

Engine:
  * Downloads run one at a time, in the order they were requested. Each one is split into up to
    CONNECTIONS byte ranges fetched in parallel and written in place into a sparse partial file.
    A connection that finishes early takes over half of the biggest range left, so the download
    does not end on a single slow connection.
  * The partial file has a small progress record next to it, so a dropped connection, a pause, a
    failure or a ComfyUI restart all continue from the bytes already on disk.
  * Pause closes the connections and frees the queue for the next download; resume puts the
    download back at the front of the queue.
  * A file that already exists is left alone, unless it is the very file this extension would
    install and the workflow gives a sha256 it does not match: then a new copy is downloaded,
    verified and swapped in, so a failed download never costs the old file. Only when the disk
    cannot hold both copies is the old one removed first.
  The parallel ranges, the queue, pause/resume, the replacement of a file that fails its checksum
  and the Hugging Face access messages follow ComfyUI-RunpodDirect by Madiator2011
  (https://github.com/MadiatorLabs/ComfyUI-RunpodDirect, GPL-3.0).

Security (this runs inside the pod, so a server-side request forgery would reach the pod's network):
  * The first URL must be https on an allowed host (huggingface.co, civitai.com and subdomains).
  * Redirects are followed by hand (at most MAX_REDIRECTS). Hugging Face and Civitai hand the
    file off to CDN hosts, so redirect targets are not allow-listed — instead every connection
    goes through `SafeResolver`, which refuses any host that resolves to a non-public address
    (private, loopback, link-local including 169.254.169.254, cluster ranges). Checking inside
    the resolver that makes the connection leaves no DNS-rebinding gap.
  * HF_TOKEN / CIVITAI_TOKEN are sent to the first host only and dropped on cross-host redirects.
    A Hugging Face token given with a request (typed into the page) follows the same rule, is used
    only for huggingface.co URLs, and is kept in memory for that download only — never returned,
    logged or written to disk.
  * A redirect to a literal non-public IP address is refused too (no name lookup happens for it).
  * Files go only into folders ComfyUI registers for models; names must be a bare file name
    with a model extension.

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
import concurrent.futures
import errno
import hashlib
import ipaddress
import json
import logging
import os
import re
import shutil
import socket
import threading
import time
import uuid
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp import web

import folder_paths
from server import PromptServer

__version__ = "1.2.0"

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

log = logging.getLogger("meshive.pod_download")

ALLOWED_HOSTS = ("huggingface.co", "civitai.com")
ALLOWED_EXTENSIONS = (".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx")
MAX_REDIRECTS = 5
# Downloads run one at a time, each over up to CONNECTIONS parallel range requests. Files up to
# PARALLEL_MIN_BYTES use a single connection. A connection that finishes early takes over half of
# the biggest range left, as long as both halves are at least MIN_SPLIT_BYTES.
MAX_CONCURRENT = 1
CONNECTIONS = 8
PARALLEL_MIN_BYTES = 32 * 1024**2
MIN_SPLIT_BYTES = 16 * 1024**2
READ_BLOCK = 1024**2
# Received data is collected up to this size before it is written.
WRITE_BLOCK = 4 * 1024**2
PROGRESS_INTERVAL = 0.1
# How often the progress record next to the partial file is brought up to date.
SAVE_INTERVAL = 5.0
# Space to leave free after a download: a completely full disk stops ComfyUI from writing outputs.
DISK_MARGIN_BYTES = 1 * 1024**3
PART_SUFFIX = ".meshive.part"
STATE_SUFFIX = ".state"
# How long to wait for storage to grow after ENOSPC before giving up.
ENOSPC_WAIT_SECONDS = 120
ENOSPC_POLL_SECONDS = 2
# A dropped connection continues where it stopped; give up after this many failures in a row that
# made no progress.
MAX_ATTEMPTS = 5
# Largest file accepted on the container's system disk (a model type with no folder on pod storage).
# A GPU pod's system disk is small, and overrunning it evicts the whole pod.
TEMPORARY_MAX_BYTES = 10 * 1024**3
ACTIVE_STATUSES = ("queued", "downloading", "waiting_storage", "verifying", "paused")
# The partial file carries the pod name, so pods sharing one network volume never write to each
# other's partial file. A pod keeps its name across restarts, so resuming still works.
_HOST_TAG = "".join(ch if ch.isalnum() or ch == "-" else "-" for ch in socket.gethostname())[:63] or "pod"

EVT_PROGRESS = "meshive_download_progress"
EVT_PAUSED = "meshive_download_paused"
EVT_RESUMED = "meshive_download_resumed"
EVT_COMPLETE = "meshive_download_complete"
EVT_ERROR = "meshive_download_error"

# id -> state. Lives only as long as the process; a restart leaves just the partial files.
downloads: dict[str, dict] = {}
# Creation order of downloads, so that a client can tell the latest attempt for a file. It starts
# over when ComfyUI restarts; `_BOOT` tells a client that happened (the downloads it knew are gone).
_seq = 0
_BOOT = uuid.uuid4().hex[:12]
# ids waiting for their turn, in order
_queue: list[str] = []
# id -> task of the downloads running now (at most MAX_CONCURRENT)
_running: dict[str, asyncio.Task] = {}
# Disk writes run here so that a slow or full disk never stalls ComfyUI's event loop.
_io_pool = concurrent.futures.ThreadPoolExecutor(max_workers=CONNECTIONS + 2, thread_name_prefix="meshive-io")

if hasattr(os, "pwrite"):
    _pwrite = os.pwrite
else:  # Windows
    _seek_lock = threading.Lock()

    def _pwrite(fd, data, offset):
        with _seek_lock:
            os.lseek(fd, offset, os.SEEK_SET)
            return os.write(fd, data)


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


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address((host or "").split("%", 1)[0])
        return True
    except ValueError:
        return False


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


def _is_host(host: str, domain: str) -> bool:
    host = (host or "").lower().rstrip(".")
    return host == domain or host.endswith("." + domain)


def _host_allowed(host: str) -> bool:
    return any(_is_host(host, h) for h in ALLOWED_HOSTS)


def _validate_source_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise ValueError("only https URLs are allowed")
    if parts.username or parts.password:
        raise ValueError("credentials in URL are not allowed")
    if not _host_allowed(parts.hostname):
        raise ValueError(f"host not allowed: {parts.hostname}")
    return url


_HF_TOKEN_RE = re.compile(r"hf_[A-Za-z0-9]{8,200}")


def _env_hf_token() -> str:
    return os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN") or ""


def _auth_headers(url: str, hf_token: str = "") -> dict:
    """Token for the first host only; redirect hops never call this. A Hugging Face token given with
    the request goes before the one in the environment."""
    host = urlsplit(url).hostname
    if _is_host(host, "huggingface.co"):
        token = hf_token or _env_hf_token()
    elif _is_host(host, "civitai.com"):
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


def _expected_sha256(value, hash_type) -> str:
    """The expected sha256 as 64 lowercase hex digits, or "" when there is none to check against.
    Other hash types are ignored rather than refused, so the model still installs."""
    v = str(value or "").strip().lower()
    if v.startswith("sha256:"):
        v = v[len("sha256:"):]
    if str(hash_type or "sha256").strip().lower() not in ("sha256", "sha-256"):
        return ""
    return v if len(v) == 64 and all(c in "0123456789abcdef" for c in v) else ""


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


def _room_for_both(st: dict, total: int) -> bool:
    """Can a new copy be downloaded while the old one (which failed its checksum) stays in place?
    Storage that grows is assumed to: if it cannot, the download fails and the old file is still there."""
    if st["managed"] and not st["temporary"]:
        return True
    return shutil.disk_usage(os.path.dirname(st["part_path"])).free >= total + DISK_MARGIN_BYTES


# ---------------------------------------------------------------------------- #
#                                 HTTP helpers                                 #
# ---------------------------------------------------------------------------- #

class DownloadError(Exception):
    def __init__(self, message: str, discard: bool = False, code: str | None = None):
        super().__init__(message)
        # The partial file cannot be continued (it would mix two versions of the file, say).
        self.discard = discard
        # For the page: "hf_auth" when a Hugging Face token (or accepting the model's terms) would help.
        self.code = code


class StorageFull(DownloadError):
    """The disk stayed full for ENOSPC_WAIT_SECONDS."""


class RetryableHTTPError(Exception):
    """A server-side hiccup (5xx, 408, 429) — worth another try."""


class ShortRead(Exception):
    """The connection ended before the requested range was complete."""


async def _open_with_redirects(session, url, headers, method="GET"):
    """Follow redirects by hand and return the final response. The token rides on the first hop only."""
    current = url
    hop_headers = dict(headers)
    for hop in range(MAX_REDIRECTS + 1):
        resp = await session.request(method, current, headers=hop_headers, allow_redirects=False)
        if resp.status in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location")
            resp.release()
            if not location:
                raise DownloadError("redirect without Location")
            nxt = urljoin(current, location)
            if urlsplit(nxt).scheme != "https":
                raise DownloadError("redirected to non-https URL")
            # An IP address is connected to without a lookup, so SafeResolver never sees it.
            if _is_ip(urlsplit(nxt).hostname) and not _is_public_ip(urlsplit(nxt).hostname):
                raise DownloadError(f"redirected to a non-public address ({urlsplit(nxt).hostname})")
            # Do not leak the token to a CDN on another host.
            if urlsplit(nxt).hostname != urlsplit(current).hostname:
                hop_headers.pop("Authorization", None)
            current = nxt
            continue
        return resp
    raise DownloadError("too many redirects")


def _hf_access_message(status: int, url: str, hf_token: str = "") -> str:
    repo = url.split("?", 1)[0].split("/resolve/", 1)[0]
    if status == 401 and not (hf_token or _env_hf_token()):
        return ("Authentication required. Enter a Hugging Face token (hf_…) in the Missing Models panel, or set "
                f"HF_TOKEN in the pod environment. For a gated model, first accept its access terms with the same "
                f"account at {repo}")
    if status == 401:
        return ("Hugging Face did not accept the token. Check that it is valid and has read access, and that its "
                f"account has accepted the model's access terms at {repo}")
    if status == 403:
        return ("Access denied. Check that your Hugging Face token has read access and that its account has "
                f"accepted the model's access terms at {repo}")
    return f"Model access is restricted. Check the repository's access requirements at {repo}"


def _http_error(resp, url: str, hf_token: str = "") -> Exception:
    """Turn a refusal into a message the user can act on. Access errors are never retried."""
    status, host = resp.status, resp.url.host
    if status in (401, 403, 451) and _is_host(host, "huggingface.co"):
        return DownloadError(_hf_access_message(status, url, hf_token), code="hf_auth")
    if status in (401, 403) and _is_host(host, "civitai.com"):
        return DownloadError(f"Civitai refused the download ({status}). This model needs an API key: "
                             "set CIVITAI_TOKEN in the pod environment.")
    if status in (401, 403, 451):
        return DownloadError(f"access denied ({status})")
    if status == 404:
        return DownloadError("file not found (404) — check the model URL")
    if status in (408, 429) or status >= 500:
        return RetryableHTTPError(f"server error {status}")
    return DownloadError(f"unexpected HTTP status {status}")


def _parse_content_range(value: str):
    """'bytes 100-199/1000' → (100, 199, 1000); the size is None when the server gives '*'."""
    m = re.fullmatch(r"\s*bytes\s+(\d+)-(\d+)/(\d+|\*)\s*", value or "")
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), None if m.group(3) == "*" else int(m.group(3))


def _retryable(e: BaseException) -> bool:
    """Only a dropped connection or a server hiccup is retried — not a blocked host, a refusal or a disk error."""
    if isinstance(e, aiohttp.ClientConnectorError):
        return not isinstance(e.os_error, BlockedAddress)
    return isinstance(e, (RetryableHTTPError, ShortRead, aiohttp.ClientPayloadError,
                          aiohttp.ServerDisconnectedError, aiohttp.ClientOSError, asyncio.TimeoutError))


async def _probe(session, url: str, hf_token: str = "") -> tuple[int, bool, str]:
    """(size, range support, ETag): HEAD first, then a one-byte range request. Size 0 means unknown."""
    total, ranges, etag = 0, False, ""
    try:
        resp = await _open_with_redirects(session, url, _auth_headers(url, hf_token), method="HEAD")
        try:
            if resp.status == 200:
                total = resp.content_length or 0
                ranges = resp.headers.get("Accept-Ranges", "").lower() == "bytes"
                etag = resp.headers.get("ETag", "")
            elif resp.status in (401, 403, 451) and _is_host(resp.url.host, "huggingface.co"):
                raise _http_error(resp, url, hf_token)  # a gated model: the range request would say the same
        finally:
            resp.release()
    except DownloadError:
        raise
    except Exception as e:  # noqa: BLE001 — some CDNs refuse HEAD on signed URLs; the range request decides
        log.debug("HEAD %s failed: %s", url, e)
    if total and ranges:
        return total, ranges, etag

    headers = _auth_headers(url, hf_token)
    headers["Range"] = "bytes=0-0"
    resp = await _open_with_redirects(session, url, headers)
    try:
        if resp.status == 206:
            cr = _parse_content_range(resp.headers.get("Content-Range"))
            if cr and cr[2]:
                total, ranges = cr[2], True
        elif resp.status == 200:
            total, ranges = resp.content_length or total, False
        else:
            raise _http_error(resp, url, hf_token)
        etag = etag or resp.headers.get("ETag", "")
    finally:
        resp.release()
    return total, ranges, etag


async def _with_retries(what: str, st: dict, make):
    failures = 0
    while True:
        try:
            return await make()
        except Exception as e:  # noqa: BLE001 — decide retry here, re-raise everything else
            failures += 1
            if not _retryable(e) or failures >= MAX_ATTEMPTS:
                raise
            log.info("download %s: %s failed (%s), retrying (%d/%d)", st["id"], what, e, failures, MAX_ATTEMPTS)
            await asyncio.sleep(min(2 ** failures, 30))


# ---------------------------------------------------------------------------- #
#                           Partial file and progress                          #
# ---------------------------------------------------------------------------- #

class _PartFile:
    """The partial file. Every write goes to `_io_pool` at an explicit offset, so parallel ranges
    share one descriptor and a slow or full disk never blocks the event loop."""

    def __init__(self, path: str, size: int | None):
        self.fd = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o644)
        try:
            if size is not None and os.fstat(self.fd).st_size < size:
                os.ftruncate(self.fd, size)  # sparse: space is only taken as data arrives
        except OSError as e:
            if e.errno not in (errno.ENOSPC, errno.EDQUOT):
                os.close(self.fd)
                raise
            # A filesystem without sparse files allocates it all now. Skip it: the writes extend the
            # file as they go, and a full disk is then waited out like any other write.
        self._inflight: set = set()
        # A failed fsync: the kernel may have dropped the data it could not write, and a later fsync
        # would not say so. Nothing is written or recorded after it.
        self.error: OSError | None = None

    async def _call(self, fn, *args):
        fut = asyncio.get_running_loop().run_in_executor(_io_pool, fn, *args)
        self._inflight.add(fut)
        fut.add_done_callback(self._settled)
        # If the caller is cancelled (pause, cancel) the write still finishes in its thread; drain()
        # waits for it so the descriptor is never closed under a running write.
        return await asyncio.shield(fut)

    def _settled(self, fut):
        self._inflight.discard(fut)
        if not fut.cancelled():
            fut.exception()  # retrieved: a caller that was cancelled never sees it

    async def write_at(self, offset: int, data: bytes, st: dict):
        """Write everything; on a full disk, wait for the storage to grow instead of failing at once."""
        if self.error:
            raise DownloadError(f"writing to disk failed: {self.error}")
        view = memoryview(data)
        deadline = None
        try:
            while view:
                try:
                    n = await self._call(_pwrite, self.fd, view, offset)
                except OSError as e:
                    if e.errno not in (errno.ENOSPC, errno.EDQUOT):
                        raise
                    now = time.monotonic()
                    if deadline is None:
                        deadline = now + ENOSPC_WAIT_SECONDS
                        if not st["waiting"]:  # once per download, not once per connection
                            log.info("download %s: storage full, waiting up to %ss for it to grow",
                                     st["id"], ENOSPC_WAIT_SECONDS)
                        st["waiting"] += 1
                    if now >= deadline:
                        raise StorageFull(
                            f"storage is full and did not grow within {ENOSPC_WAIT_SECONDS}s — the pod's storage "
                            f"limit may be reached. The partial file is kept; retry to resume.") from e
                    await asyncio.sleep(ENOSPC_POLL_SECONDS)
                    continue
                view = view[n:]
                offset += n
        finally:
            if deadline is not None:
                st["waiting"] -= 1

    async def truncate(self, size: int):
        await self._call(os.ftruncate, self.fd, size)

    async def sync(self):
        try:
            await self._call(os.fsync, self.fd)
        except OSError as e:
            self.error = self.error or e
            raise

    async def drain(self):
        while self._inflight:
            await asyncio.wait(set(self._inflight))

    def close(self):
        os.close(self.fd)


def _state_path(st: dict) -> str:
    return st["part_path"] + STATE_SUFFIX


def _remove_partial(st: dict):
    for path in (st["part_path"], _state_path(st), _state_path(st) + ".tmp"):
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError as e:
            log.warning("download %s: could not remove %s: %s", st["id"], path, e)


def _seg_size(seg: dict) -> int:
    return seg["end"] - seg["start"] + 1


def _plan(total: int) -> list[dict]:
    n = CONNECTIONS if total > PARALLEL_MIN_BYTES else 1
    step = total // n
    return [{"start": i * step, "end": (i + 1) * step - 1 if i < n - 1 else total - 1, "done": 0}
            for i in range(n)]


def _load_progress(st: dict, total: int, etag: str) -> list[dict] | None:
    """The ranges already on disk from an earlier attempt, if the record still describes this file."""
    try:
        with open(_state_path(st), encoding="utf-8") as f:
            data = json.load(f)
        on_disk = _size(st["part_path"])
        if data.get("url") != st["url"] or data.get("total") != total or on_disk > total:
            return None
        if etag and data.get("etag") and data["etag"] != etag:
            return None  # the file changed on the server since
        segments, expect = [], 0
        for start, end, done in data["segments"]:
            if start != expect or end < start or not 0 <= done <= end - start + 1:
                return None
            if done and start + done > on_disk:
                return None  # the record claims bytes the file does not have
            segments.append({"start": start, "end": end, "done": done})
            expect = end + 1
        return segments if expect == total else None
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None


def _write_json_atomic(path: str, data: dict):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


async def _save_progress(st: dict, part: _PartFile):
    # Counted bytes were written before they were counted; syncing after taking the snapshot means
    # the record never claims data that is not on disk.
    snapshot = {"url": st["url"], "total": st["total"], "etag": st.get("etag") or "",
                "segments": [[s["start"], s["end"], s["done"]] for s in st["segments"]]}
    if part.error:
        return  # the last record written before the failure is still true; a new one might not be
    try:
        await part.sync()
    except OSError as e:
        log.error("download %s: writing to disk failed: %s", st["id"], e)
        return  # the transfer stops at its next write
    try:
        await asyncio.get_running_loop().run_in_executor(_io_pool, _write_json_atomic, _state_path(st), snapshot)
    except OSError as e:
        log.warning("download %s: could not record progress: %s", st["id"], e)


async def _report(st: dict, part: _PartFile):
    """Progress events every PROGRESS_INTERVAL, speed over the last second (from bytes received —
    bytes on disk arrive in WRITE_BLOCK steps), and the progress record."""
    last, saver = None, None
    now = time.monotonic()
    window_t, window_b, next_save = now, st["received"], now + SAVE_INTERVAL
    try:
        while True:
            await asyncio.sleep(PROGRESS_INTERVAL)
            now = time.monotonic()
            if now - window_t >= 1.0:
                st["speed"] = (st["received"] - window_b) / (now - window_t)
                window_t, window_b = now, st["received"]
            pub = _public(st)
            key = (pub["downloaded"], pub["status"], int(pub["speed"]))
            if key != last:
                last = key
                await _emit(EVT_PROGRESS, pub)
            if st["resumable"] and now >= next_save and (saver is None or saver.done()):
                next_save = now + SAVE_INTERVAL
                saver = asyncio.create_task(_save_progress(st, part))
    finally:
        if saver:
            await asyncio.gather(saver, return_exceptions=True)


def _size(path: str) -> int:
    try:
        return os.path.getsize(path)
    except OSError:
        return 0


def _check_space(st: dict):
    total = st["total"]
    if st["temporary"] and total > TEMPORARY_MAX_BYTES:
        raise DownloadError(
            f"{total / 1024**3:.1f} GiB is too large for the pod's system disk (limit "
            f"{TEMPORARY_MAX_BYTES / 1024**3:.0f} GiB): '{st['directory']}' has no folder on pod storage. "
            f"Attach a volume that covers {os.path.dirname(st['dest_path'])} and retry.")
    if not total:
        return
    free = shutil.disk_usage(os.path.dirname(st["part_path"])).free
    need = total - st["downloaded"] + DISK_MARGIN_BYTES
    if free < need:
        msg = f"not enough disk space: need {need / 1024**3:.1f} GiB, free {free / 1024**3:.1f} GiB"
        if not st["managed"] or st["temporary"]:
            raise DownloadError(msg)
        # Meshive storage grows as it fills — note it and carry on.
        log.info("download %s: %s (managed storage, continuing)", st["id"], msg)


# ---------------------------------------------------------------------------- #
#                                   Transfer                                   #
# ---------------------------------------------------------------------------- #

async def _write_pending(st: dict, part: _PartFile, offset: int, pending: list) -> int:
    data = b"".join(pending)
    pending.clear()
    await part.write_at(offset, data, st)
    st["downloaded"] += len(data)
    return len(data)


async def _fetch_range(session, st: dict, seg: dict, part: _PartFile):
    """One request for the rest of a range. Bytes count as done once they are on disk; until then
    they are the range's `inflight`, which a split never hands to another connection."""
    url, start = st["url"], seg["start"] + seg["done"]
    headers = _auth_headers(url, st["token"])
    headers["Range"] = f"bytes={start}-{seg['end']}"
    resp = await _open_with_redirects(session, url, headers)
    try:
        if resp.status == 206:
            cr = _parse_content_range(resp.headers.get("Content-Range"))
            if not cr or cr[0] != start:
                raise DownloadError(f"the server answered a different range ({resp.headers.get('Content-Range')})")
            if cr[2] is not None and cr[2] != st["total"]:
                raise DownloadError("the file changed on the server during the download — retry to start over",
                                    discard=True)
        elif resp.status == 200 and start == 0:
            pass  # the whole file from its first byte: the start of it is exactly this range
        elif resp.status == 200:
            # The server ignored Range. Writing its body here would corrupt the file.
            raise DownloadError("the server stopped honouring range requests; retry later")
        else:
            raise _http_error(resp, url, st["token"])

        pending = []

        async def flush():
            n = await _write_pending(st, part, seg["start"] + seg["done"], pending)
            seg["done"] += n
            seg["inflight"] -= n

        try:
            async for chunk in resp.content.iter_chunked(READ_BLOCK):
                st["received"] += len(chunk)
                # A split may have shortened the range since the request went out.
                room = _seg_size(seg) - seg["done"] - seg["inflight"]
                if len(chunk) > room:
                    chunk = chunk[:room]
                pending.append(chunk)
                seg["inflight"] += len(chunk)
                if seg["inflight"] >= WRITE_BLOCK or seg["done"] + seg["inflight"] >= _seg_size(seg):
                    await flush()
                if seg["done"] >= _seg_size(seg):
                    break
        except (aiohttp.ClientError, asyncio.TimeoutError):
            if pending:
                await flush()  # what arrived before the drop is good
            raise
        if pending:
            await flush()
    finally:
        seg["inflight"] = 0
        resp.release()


async def _fetch_segment(session, st: dict, seg: dict, part: _PartFile):
    try:
        failures = 0
        while seg["done"] < _seg_size(seg):
            before = seg["done"]
            try:
                await _fetch_range(session, st, seg, part)
                if seg["done"] < _seg_size(seg):
                    raise ShortRead(f"connection ended at byte {seg['start'] + seg['done']}")
            except Exception as e:  # noqa: BLE001 — decide retry here, re-raise everything else
                if seg["done"] > before:
                    failures = 0  # it made progress — count only failures in a row
                failures += 1
                if not _retryable(e) or failures >= MAX_ATTEMPTS:
                    raise
                log.info("download %s: connection lost (%s), resuming at byte %d (%d/%d)",
                         st["id"], e, seg["start"] + seg["done"], failures, MAX_ATTEMPTS)
                await asyncio.sleep(min(2 ** failures, 30))
    finally:
        st["connections"] -= 1


def _split(st: dict) -> dict | None:
    """Cut the biggest range still left in two and return the second half as a new range, or None
    when nothing is big enough to be worth another connection."""
    if st["total"] <= PARALLEL_MIN_BYTES:
        return None  # small files stay on one connection
    best, rest = None, 0
    for s in st["segments"]:
        left = s["end"] - (s["start"] + s["done"] + s.get("inflight", 0)) + 1
        if left > rest:
            best, rest = s, left
    if best is None or rest < 2 * MIN_SPLIT_BYTES:
        return None
    cut = best["start"] + best["done"] + best.get("inflight", 0) + rest // 2
    new = {"start": cut, "end": best["end"], "done": 0}
    best["end"] = cut - 1
    st["segments"].insert(st["segments"].index(best) + 1, new)  # the record keeps ranges in order
    return new


async def _fetch_segments(session, st: dict, part: _PartFile):
    """Up to CONNECTIONS ranges at a time. A connection that finishes its range takes over half of
    the biggest one still left, so all of them stay busy until the end."""
    waiting = [s for s in st["segments"] if s["done"] < _seg_size(s)]
    tasks: dict[asyncio.Task, dict] = {}
    st["connections"] = 0

    def fill():
        while len(tasks) < CONNECTIONS:
            seg = waiting.pop(0) if waiting else _split(st)
            if seg is None:
                return
            seg["inflight"] = 0
            st["connections"] += 1
            tasks[asyncio.create_task(_fetch_segment(session, st, seg, part))] = seg

    fill()
    try:
        while tasks:
            finished, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            errors = []
            for t in finished:
                del tasks[t]
                if not t.cancelled() and t.exception():
                    errors.append(t.exception())
            if errors:
                raise errors[0]  # one failed range fails the download
            fill()
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _fetch_stream(session, st: dict, part: _PartFile):
    """No range support (or no size): one request from the first byte. A dropped connection starts
    over, since there is no way to ask for the rest."""
    url, failures = st["url"], 0
    st["connections"] = 1
    while True:
        try:
            await part.truncate(0)
            st["downloaded"] = 0
            resp = await _open_with_redirects(session, url, _auth_headers(url, st["token"]))
            try:
                if resp.status != 200:
                    raise _http_error(resp, url, st["token"])
                offset, pending, plen = 0, [], 0
                async for chunk in resp.content.iter_chunked(READ_BLOCK):
                    st["received"] += len(chunk)
                    pending.append(chunk)
                    plen += len(chunk)
                    if plen >= WRITE_BLOCK:
                        offset += await _write_pending(st, part, offset, pending)
                        plen = 0
                if pending:
                    offset += await _write_pending(st, part, offset, pending)
            finally:
                resp.release()
            if st["total"] and offset != st["total"]:
                raise ShortRead(f"connection ended at byte {offset} of {st['total']}")
            st["total"] = offset
            return
        except Exception as e:  # noqa: BLE001 — decide retry here, re-raise everything else
            failures += 1
            if not _retryable(e) or failures >= MAX_ATTEMPTS:
                raise
            log.info("download %s: connection lost (%s), starting over (%d/%d)", st["id"], e, failures, MAX_ATTEMPTS)
            await asyncio.sleep(min(2 ** failures, 30))


async def _transfer(session, st: dict, total: int, ranges: bool, etag: str):
    """Fill the partial file, continuing from an earlier attempt when its record still fits."""
    segments = _load_progress(st, total, etag) if ranges and total else None
    if segments is None:
        _remove_partial(st)
        segments = _plan(total) if ranges and total else []
    else:
        log.info("download %s: resuming, %d of %d bytes already on disk",
                 st["id"], sum(s["done"] for s in segments), total)
    st.update(total=total, etag=etag, segments=segments, resumable=bool(segments),
              downloaded=sum(s["done"] for s in segments))
    _check_space(st)

    part = _PartFile(st["part_path"], total if segments else None)
    reporter = asyncio.create_task(_report(st, part))
    keep = True
    try:
        if segments:
            await _fetch_segments(session, st, part)
        else:
            await _fetch_stream(session, st, part)
        try:
            await part.sync()  # a write-back error shows up here, not in the writes
        except OSError as e:
            raise DownloadError(f"writing to disk failed: {e}") from e
    except DownloadError as e:
        keep = not e.discard
        raise
    finally:
        reporter.cancel()
        await asyncio.gather(reporter, return_exceptions=True)
        await part.drain()
        # Keep the record for a pause, a failure or the verification step — not for a cancel.
        if st["resumable"] and keep and st.get("stop_reason") != "cancel":
            await _save_progress(st, part)
        part.close()
        if not keep:
            _remove_partial(st)
        st["connections"] = 0


# ---------------------------------------------------------------------------- #
#                               Queue and lifecycle                            #
# ---------------------------------------------------------------------------- #

class _Stopped(Exception):
    """Pause or cancel was requested."""


async def _unless_stopped(st: dict, coro):
    """Run `coro`, but give up on it as soon as pause or cancel is requested."""
    task = asyncio.ensure_future(coro)
    stop = asyncio.ensure_future(st["stop"].wait())
    try:
        await asyncio.wait({task, stop}, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        task.cancel()
        raise
    finally:
        stop.cancel()
    if task.done():
        return task.result()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    raise _Stopped()


def _request_stop(st: dict, reason: str):
    if st.get("stop_reason") != "cancel":  # a cancel is never turned back into a pause
        st["stop_reason"] = reason
    st["stop"].set()
    st["abort"].set()


class _HashAborted(Exception):
    pass


def _sha256_file(path: str, abort: threading.Event) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b""):
            if abort.is_set():
                raise _HashAborted()
            h.update(block)
    return h.hexdigest()


async def _hash_file(st: dict, path: str) -> str:
    return await asyncio.get_running_loop().run_in_executor(None, _sha256_file, path, st["abort"])


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


async def _download(st: dict):
    """One download from start to finish. Raises _Stopped on pause/cancel, anything else on failure."""
    dest_path = st["dest_path"]
    if st["replace"] and not st.get("mismatch") and os.path.exists(dest_path):
        st["status"] = "verifying"
        await _emit(EVT_PROGRESS, _public(st))
        if await _unless_stopped(st, _hash_file(st, dest_path)) == st["hash"]:
            st["status"] = "exists"
            return
        st["mismatch"] = True  # remembered, so a resume does not hash the old file again
        log.warning("download %s: %s does not match the expected sha256 — downloading a new copy",
                    st["id"], dest_path)

    st.update(status="downloading", error=None, error_code=None, speed=0)
    await _emit(EVT_PROGRESS, _public(st))
    timeout = aiohttp.ClientTimeout(total=None, connect=30, sock_read=60)
    connector = aiohttp.TCPConnector(resolver=SafeResolver(), limit=CONNECTIONS + 2)
    # Uncompressed: byte counts and Content-Range must describe the file itself.
    async with aiohttp.ClientSession(connector=connector, timeout=timeout, trust_env=False,
                                     read_bufsize=READ_BLOCK, auto_decompress=False,
                                     headers={"Accept-Encoding": "identity"}) as session:
        total, ranges, etag = await _unless_stopped(
            st, _with_retries("size check", st, lambda: _probe(session, st["url"], st["token"])))
        # The URL answered, so a new copy can be fetched. Keep the old file until it is verified,
        # unless the disk cannot hold both.
        if st.get("mismatch") and os.path.exists(dest_path) and not _room_for_both(st, total):
            log.warning("download %s: not enough space for two copies — removing the old file first", st["id"])
            try:
                os.remove(dest_path)
            except OSError as e:
                raise DownloadError(f"{dest_path} does not match the expected checksum and could not be "
                                    f"removed: {e.strerror or e}") from e
        try:
            await _unless_stopped(st, _transfer(session, st, total, ranges, etag))
        except StorageFull as e:
            if st.get("mismatch") and os.path.exists(dest_path):
                raise DownloadError(f"{e} The old copy, which does not match the checksum, is still in place — "
                                    f"remove it to make room.") from e
            raise

    part_path, size = st["part_path"], _size(st["part_path"])
    if size != st["total"] or (st["resumable"] and st["downloaded"] != st["total"]):
        _remove_partial(st)
        raise DownloadError(f"size mismatch: got {size}, expected {st['total']}")
    if st["hash"]:
        st.update(status="verifying", speed=0)
        await _emit(EVT_PROGRESS, _public(st))
        if await _unless_stopped(st, _hash_file(st, part_path)) != st["hash"]:
            _remove_partial(st)  # a corrupt file is not worth resuming
            raise DownloadError("sha256 mismatch — the downloaded file was removed")

    if st.get("mismatch") and os.path.exists(dest_path):
        os.replace(part_path, dest_path)  # the verified copy takes the old one's place atomically
        published = True
    else:
        published = _publish(part_path, dest_path)
    _remove_partial(st)  # the progress record
    st.update(status="complete" if published else "exists", downloaded=size, total=size, speed=0)


async def _run(st: dict):
    did, shutting_down = st["id"], False
    try:
        await _download(st)
        await _emit(EVT_COMPLETE, _public(st))
    except _Stopped:
        st["speed"] = 0
        if st["stop_reason"] == "cancel":
            _remove_partial(st)
            st["status"] = "cancelled"
            await _emit(EVT_ERROR, {**_public(st), "error": "cancelled"})
        else:
            st["status"] = "paused"
            await _emit(EVT_PAUSED, _public(st))
    except asyncio.CancelledError:
        st["status"] = "cancelled"  # ComfyUI is shutting down; the partial file stays for next time
        shutting_down = True
        raise
    except Exception as e:  # noqa: BLE001 — every failure is shown to the user with its reason
        log.warning("download %s failed: %s", did, e)
        st.update(status="error", error=str(e), error_code=getattr(e, "code", None), speed=0)
        await _emit(EVT_ERROR, _public(st))
    finally:
        if st["status"] not in ACTIVE_STATUSES:
            st["token"] = ""  # done with it (a paused download keeps it for its resume)
        if _running.get(did) is asyncio.current_task():
            del _running[did]
        if not shutting_down:
            _pump()


def _pump():
    """Start queued downloads while there is a free slot."""
    while len(_running) < MAX_CONCURRENT and _queue:
        did = _queue.pop(0)
        st = downloads.get(did)
        if st and st["status"] == "queued":
            _running[did] = asyncio.create_task(_run(st))


async def _emit(event: str, payload: dict):
    await PromptServer.instance.send(event, payload)


def _public(st: dict) -> dict:
    total, done = st.get("total") or 0, st.get("downloaded") or 0
    status = st["status"]
    if status == "downloading" and st.get("waiting"):
        status = "waiting_storage"
    return {
        "id": st["id"], "filename": st["filename"], "directory": st["directory"],
        "status": status, "downloaded": done, "total": total,
        "progress": (done / total * 100) if total else 0,
        "speed": st.get("speed", 0), "error": st.get("error"), "error_code": st.get("error_code"),
        "path": st.get("dest_path"), "temporary": st.get("temporary", False),
        "connections": st.get("connections", 0), "resumable": st.get("resumable", False),
        "seq": st["seq"], "queue_position": _queue.index(st["id"]) + 1 if st["id"] in _queue else 0,
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
        expected = _expected_sha256(body.get("hash"), body.get("hash_type"))
        # A Hugging Face token typed into the page: only for Hugging Face, and only while this download lives.
        token = str(body.get("token") or "")
        if token and not _HF_TOKEN_RE.fullmatch(token):
            raise ValueError("that is not a Hugging Face token (hf_…)")
        if not _is_host(urlsplit(url).hostname, "huggingface.co"):
            token = ""
        # Already present in any folder ComfyUI searches (attached assets, legacy folder names, ...)?
        # Without a checksum there is nothing to judge it by, so it counts as installed.
        existing = folder_paths.get_full_path(directory, filename)
        if existing and not expected:
            return web.json_response({"status": "exists", "filename": filename, "directory": directory})
        dest_dir, managed, temporary = _resolve_dest_dir(directory)
        dest_path = os.path.join(dest_dir, filename)
        # Only the file this extension would install is replaced when it fails the checksum. One
        # elsewhere (a legacy folder, a shared or extra model path) is not ours to touch, and a new
        # copy here would not be the one ComfyUI loads — it counts as installed.
        replace = bool(existing) and os.path.abspath(existing) == os.path.abspath(dest_path)
        if (existing and not replace) or (not existing and os.path.exists(dest_path)):
            return web.json_response({"status": "exists", "filename": filename, "directory": directory})
    except (ValueError, TypeError) as e:
        return _bad(str(e))
    except Exception:  # malformed JSON and the like
        return _bad("invalid request body")

    # Same target already queued, running or paused: hand back that download instead of starting another.
    # A token given now (typed after "Install all", say) is for it too.
    for st in downloads.values():
        if st["dest_path"] == dest_path and st["status"] in ACTIVE_STATUSES:
            if token and not st["token"] and _is_host(urlsplit(st["url"]).hostname, "huggingface.co"):
                st["token"] = token
            return web.json_response(_public(st))

    global _seq
    _seq += 1
    st = {
        "id": uuid.uuid4().hex[:12], "seq": _seq, "url": url, "filename": filename, "directory": directory,
        "dest_path": dest_path, "part_path": f"{dest_path}.{_HOST_TAG}{PART_SUFFIX}", "managed": managed,
        "temporary": temporary, "hash": expected, "replace": replace, "token": token, "status": "queued",
        "downloaded": 0, "received": 0, "total": 0, "speed": 0, "error": None, "connections": 0, "resumable": False,
        "segments": [], "waiting": 0, "stop": asyncio.Event(), "abort": threading.Event(), "stop_reason": None,
    }
    downloads[st["id"]] = st
    _queue.append(st["id"])
    _pump()
    return web.json_response(_public(st))


async def _download_from(request):
    try:
        did = str((await request.json()).get("id", ""))
    except Exception:
        return None, _bad("invalid request body")
    st = downloads.get(did)
    return (st, None) if st else (None, _bad("no such download", 404))


@PromptServer.instance.routes.post("/meshive/download/pause")
async def pause_download(request):
    st, err = await _download_from(request)
    if err:
        return err
    # Waiting in the queue: just take it out. Checked first — a download resumed while its previous
    # run is still wrapping up is back in the queue although that run has not left _running yet.
    if st["id"] in _queue:
        _queue.remove(st["id"])
        st["status"] = "paused"
        await _emit(EVT_PAUSED, _public(st))
        return web.json_response(_public(st))
    if st["id"] in _running and st["status"] != "paused":
        _request_stop(st, "pause")
        return web.json_response({"id": st["id"], "status": "pausing"})
    return _bad("no such active download", 404)


@PromptServer.instance.routes.post("/meshive/download/resume")
async def resume_download(request):
    st, err = await _download_from(request)
    if err:
        return err
    if st["status"] != "paused":
        return _bad("download is not paused", 409)
    st.update(status="queued", stop_reason=None)
    st["stop"].clear()
    st["abort"].clear()
    _queue.insert(0, st["id"])  # asked for by the user just now: next in line
    await _emit(EVT_RESUMED, _public(st))
    _pump()
    return web.json_response(_public(st))


@PromptServer.instance.routes.post("/meshive/download/cancel")
async def cancel_download(request):
    st, err = await _download_from(request)
    if err:
        return err
    # Queued or paused: nothing is transferring, so remove it here (a paused run may still be
    # wrapping up in _running, but it no longer touches the files).
    if st["id"] in _queue or st["status"] == "paused":
        if st["id"] in _queue:
            _queue.remove(st["id"])
        _remove_partial(st)
        st.update(status="cancelled", speed=0, token="")
        await _emit(EVT_ERROR, {**_public(st), "error": "cancelled"})
        return web.json_response({"id": st["id"], "status": "cancelled"})
    if st["id"] in _running:
        _request_stop(st, "cancel")
        return web.json_response({"id": st["id"], "status": "cancelling"})
    return _bad("no such active download", 404)


@PromptServer.instance.routes.post("/meshive/download/clear")
async def clear_downloads(request):
    """Forget finished downloads (complete, already there, failed, cancelled). Files are not touched."""
    done = [did for did, st in downloads.items() if st["status"] not in ACTIVE_STATUSES]
    for did in done:
        del downloads[did]
    return web.json_response({"cleared": len(done)})


@PromptServer.instance.routes.get("/meshive/download/status")
async def download_status(request):
    return web.json_response([_public(s) for s in downloads.values()], headers={"X-Meshive-Boot": _BOOT})


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


@PromptServer.instance.routes.get("/meshive/hf/status")
async def hf_status(request):
    return web.json_response({"env_token": bool(_env_hf_token())})


async def _hf_access(session, url: str, token: str) -> dict:
    """Can this token fetch this URL? Asked the way a download would (HEAD, same redirect rules)."""
    try:
        _validate_source_url(url)
        if not _is_host(urlsplit(url).hostname, "huggingface.co"):
            return {"accessible": False, "reason": "not_huggingface"}
        resp = await _open_with_redirects(session, url, _auth_headers(url, token), method="HEAD")
    except (ValueError, DownloadError, aiohttp.ClientError, asyncio.TimeoutError, OSError):
        return {"accessible": False, "reason": "unreachable"}
    try:
        repo = url.split("?", 1)[0].split("/resolve/", 1)[0]
        if resp.status == 200:
            return {"accessible": True}
        if resp.status in (401, 403, 451):
            # GatedRepo: the account has not accepted the model's terms (or is waiting for approval).
            gated = resp.headers.get("X-Error-Code") == "GatedRepo" or resp.status == 403
            return {"accessible": False, "reason": "terms" if gated else "denied", "repo": repo}
        if resp.status == 404:
            return {"accessible": False, "reason": "not_found", "repo": repo}
        return {"accessible": False, "reason": f"http_{resp.status}", "repo": repo}
    finally:
        resp.release()


@PromptServer.instance.routes.post("/meshive/hf/verify")
async def hf_verify(request):
    """Check a Hugging Face token (the one given, else the pod's HF_TOKEN) and what it can fetch."""
    try:
        body = await request.json()
        token = str(body.get("token") or "")
        urls = [u for u in (body.get("urls") or []) if isinstance(u, str)][:16]
    except Exception:
        return _bad("invalid request body")
    source = "page"
    if not token:
        token, source = _env_hf_token(), "env"
    if not token:
        return _bad("no Hugging Face token")
    if not _HF_TOKEN_RE.fullmatch(token):
        return web.json_response({"valid": False, "source": source, "code": "format",
                                  "error": "that is not a Hugging Face token (hf_…)"})
    timeout = aiohttp.ClientTimeout(total=20)
    connector = aiohttp.TCPConnector(resolver=SafeResolver(), limit=8)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout, trust_env=False) as session:
        try:
            async with session.get("https://huggingface.co/api/whoami-v2",
                                   headers={"Authorization": f"Bearer {token}"}, allow_redirects=False) as resp:
                if resp.status == 401:
                    return web.json_response({"valid": False, "source": source, "code": "rejected",
                                              "error": "Hugging Face did not accept the token"})
                if resp.status != 200:
                    return web.json_response({"valid": False, "source": source, "code": "unreachable",
                                              "error": f"could not check the token (HTTP {resp.status})"})
                name = (await resp.json()).get("name") or ""
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, ValueError) as e:
            return web.json_response({"valid": False, "source": source, "code": "unreachable",
                                      "error": f"could not reach Hugging Face ({e})"})
        access = await asyncio.gather(*(_hf_access(session, u, token) for u in urls))
    return web.json_response({"valid": True, "source": source, "name": name, "access": dict(zip(urls, access))})


@PromptServer.instance.routes.get("/meshive/info")
async def info(request):
    return web.json_response({"version": __version__, "host": _HOST_TAG, "boot": _BOOT})


# ComfyUI serves this folder's scripts at /extensions/<folder name>/ as static files a browser may
# cache. Routes registered here are matched before that static route, so the scripts are served from
# here instead, marked to be revalidated on every page load. (A folder name that would not be a plain
# path segment keeps ComfyUI's own static route.)
_EXT_NAME = os.path.basename(os.path.dirname(os.path.abspath(__file__)))
_WEB_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


async def serve_script(request):
    path = os.path.join(_WEB_ROOT, request.match_info["name"])
    if not os.path.isfile(path):
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={
        "Cache-Control": "no-cache, must-revalidate", "Pragma": "no-cache", "Expires": "0",
        "X-Version": __version__,
    })


if re.fullmatch(r"[A-Za-z0-9_.-]+", _EXT_NAME):
    PromptServer.instance.routes.get(f"/extensions/{_EXT_NAME}/{{name:[A-Za-z0-9_.-]+\\.js}}")(serve_script)
