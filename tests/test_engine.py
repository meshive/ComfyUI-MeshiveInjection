"""Engine tests against a local HTTP server. Run from the repository root with ComfyUI's Python
(it needs aiohttp):  python -m unittest discover -s tests -v

ComfyUI itself is not needed: `folder_paths` and `server` are replaced by small stand-ins, and the
URL allow-list / public-address resolver are relaxed so the engine can talk to 127.0.0.1.
"""

import asyncio
import atexit
import errno
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import time
import types
import unittest
from pathlib import Path

import aiohttp
from aiohttp import web
from yarl import URL

ROOT = Path(__file__).resolve().parents[1]
TMP = tempfile.mkdtemp(prefix="meshive-test-")
atexit.register(shutil.rmtree, TMP, ignore_errors=True)

# ── stand-ins for ComfyUI modules ────────────────────────────────────────────
fp = types.ModuleType("folder_paths")
fp.folder_names_and_paths = {}


def _get_folder_paths(d):
    return list(fp.folder_names_and_paths[d][0])


def _get_full_path(d, name):
    for p in fp.folder_names_and_paths.get(d, ([], set()))[0]:
        full = os.path.join(p, name)
        if os.path.isfile(full):
            return full
    return None


fp.get_folder_paths = _get_folder_paths
fp.get_full_path = _get_full_path
USER_DIR = os.path.join(TMP, "user")
fp.get_user_directory = lambda: USER_DIR
sys.modules["folder_paths"] = fp


class _Server:
    def __init__(self):
        self.routes = web.RouteTableDef()
        self.events = []

    async def send(self, event, data, sid=None):
        self.events.append((event, json.loads(json.dumps(data))))


srv = types.ModuleType("server")
srv.PromptServer = type("PromptServer", (), {})
srv.PromptServer.instance = _Server()
sys.modules["server"] = srv

spec = importlib.util.spec_from_file_location("meshive_injection", ROOT / "__init__.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

m._validate_source_url = lambda url: url  # the test server is plain http on 127.0.0.1
m.SafeResolver = aiohttp.ThreadedResolver
m.PARALLEL_MIN_BYTES = 1024**2
m.MIN_SPLIT_BYTES = 128 * 1024
m.READ_BLOCK = 64 * 1024
m.WRITE_BLOCK = 64 * 1024
m.ENOSPC_POLL_SECONDS = 0.05
m.SAVE_INTERVAL = 0.2
EVENTS = srv.PromptServer.instance.events


# ── a file server with Range support and switchable misbehaviour ────────────
class FileServer:
    def __init__(self):
        self.set_data(os.urandom(8 * 1024**2 + 123))
        self.ranges = True       # honour Range
        self.head = True         # answer HEAD
        self.delay = 0.0         # seconds between 64 KiB pieces
        self.slow_start = 0.0    # extra delay for requests that start at byte 0
        self.drops = 0           # the next N responses drop the connection ...
        self.drop_after = 0      # ... after this many bytes
        self.status = None       # answer every GET with this status instead
        self.redirect = None     # answer every request with a redirect to this URL
        self.on_get = None       # called with the request on every GET
        self.sent = 0            # body bytes sent
        self.gets = []           # Range header of each GET

    def set_data(self, data):
        self.data = data
        self.etag = '"%s"' % hashlib.md5(data).hexdigest()

    async def handle(self, request):
        headers = {"ETag": self.etag}
        if self.ranges:
            headers["Accept-Ranges"] = "bytes"
        if self.redirect:
            return web.Response(status=302, headers={"Location": self.redirect})
        if request.method == "HEAD":
            return web.Response(status=200 if self.head else 405, body=self.data if self.head else b"",
                                headers=headers)
        if self.on_get:
            self.on_get(request)
        if self.status:
            return web.Response(status=self.status)
        rng = request.headers.get("Range")
        self.gets.append(rng)
        body, status = self.data, 200
        if rng and self.ranges:
            a, b = re.fullmatch(r"bytes=(\d+)-(\d*)", rng).groups()
            a, b = int(a), int(b) if b else len(self.data) - 1
            body, status = self.data[a:b + 1], 206
            headers["Content-Range"] = f"bytes {a}-{b}/{len(self.data)}"
        resp = web.StreamResponse(status=status, headers=headers)
        resp.content_length = len(body)
        await resp.prepare(request)
        drop = self.drops > 0
        if drop:
            self.drops -= 1
        sent = 0
        for i in range(0, len(body), 64 * 1024):
            piece = body[i:i + 64 * 1024]
            if drop and sent + len(piece) > self.drop_after:
                request.transport.close()
                return resp
            try:
                await resp.write(piece)
            except ConnectionError:  # the client hung up (pause, cancel, a finished range)
                return resp
            sent += len(piece)
            self.sent += len(piece)
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.slow_start and (rng or "bytes=0-").startswith("bytes=0-"):
                await asyncio.sleep(self.slow_start)
        await resp.write_eof()
        return resp


class Request:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def body_of(resp):
    return json.loads(resp.body)


class ServerCase(unittest.IsolatedAsyncioTestCase):
    """A local file server and a clean engine for every test."""

    async def asyncSetUp(self):
        self.dir = tempfile.mkdtemp(dir=TMP)
        fp.folder_names_and_paths = {"checkpoints": ([self.dir], {".safetensors"})}
        m.downloads.clear()
        m._queue.clear()
        m._running.clear()
        EVENTS.clear()
        self.fs = FileServer()
        app = web.Application()
        app.router.add_get("/{name}", self.fs.handle)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]

    async def asyncTearDown(self):
        for st in list(m.downloads.values()):
            if st["id"] in m._running:
                m._request_stop(st, "cancel")
        for _ in range(100):
            if not m._running:
                break
            await asyncio.sleep(0.05)
        await self.runner.cleanup()

    def url(self, name="model.safetensors"):
        return f"http://127.0.0.1:{self.port}/{name}"

    async def start(self, name="model.safetensors", hash_=None, url=None):
        body = {"url": url or self.url(name), "directory": "checkpoints", "filename": name}
        if hash_:
            body["hash"] = hash_
        return body_of(await m.start_download(Request(body)))

    async def control(self, action, did):
        handler = {"pause": m.pause_download, "resume": m.resume_download, "cancel": m.cancel_download}[action]
        return body_of(await handler(Request({"id": did})))

    async def wait_event(self, event, did=None, timeout=20, status=None):
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while loop.time() < end:
            for ev, data in EVENTS:
                if ev == event and (did is None or data.get("id") == did) and (status is None or data.get("status") == status):
                    return data
            await asyncio.sleep(0.02)
        self.fail(f"no {event} for {did}; events: {[(e, d.get('status')) for e, d in EVENTS][-10:]}")

    async def wait_until(self, cond, timeout=20):
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while loop.time() < end:
            if cond():
                return
            await asyncio.sleep(0.02)
        self.fail("condition not reached")

    def no_split(self):
        """For tests that count bytes: a shortened range discards what the server already sent."""
        saved = m.MIN_SPLIT_BYTES
        m.MIN_SPLIT_BYTES = 1 << 40
        self.addCleanup(setattr, m, "MIN_SPLIT_BYTES", saved)

    def dest(self, name="model.safetensors"):
        return os.path.join(self.dir, name)

    def leftovers(self):
        return [f for f in os.listdir(self.dir) if ".meshive.part" in f]


class EngineTest(ServerCase):
    async def test_parallel_download_verifies_and_publishes(self):
        st = await self.start(hash_="sha256:" + hashlib.sha256(self.fs.data).hexdigest())
        done = await self.wait_event(m.EVT_COMPLETE, st["id"])
        self.assertEqual(done["status"], "complete")
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        ranges = [g for g in self.fs.gets if g and g != "bytes=0-0"]
        self.assertEqual(len(ranges), m.CONNECTIONS)
        self.assertEqual(self.leftovers(), [])

    async def test_free_connections_take_over_a_slow_range(self):
        self.fs.slow_start = 0.05  # the first range crawls; the others finish at once
        st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
        await self.wait_event(m.EVT_COMPLETE, st["id"])
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        segments = m.downloads[st["id"]]["segments"]
        self.assertGreater(len(segments), m.CONNECTIONS)
        # Each byte was fetched about once: a shortened range stops reading at its new end.
        self.assertLess(self.fs.sent, len(self.fs.data) * 1.2)

    async def test_pause_and_resume_after_ranges_were_split(self):
        self.fs.slow_start = 0.05
        st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
        await self.wait_until(lambda: len(m.downloads[st["id"]]["segments"]) > m.CONNECTIONS + 2)
        await self.control("pause", st["id"])
        await self.wait_event(m.EVT_PAUSED, st["id"])
        with open(m.downloads[st["id"]]["part_path"] + m.STATE_SUFFIX) as f:
            self.assertGreater(len(json.load(f)["segments"]), m.CONNECTIONS)
        self.fs.slow_start = 0
        await self.control("resume", st["id"])
        await self.wait_event(m.EVT_COMPLETE, st["id"])
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        self.assertEqual(self.leftovers(), [])

    async def test_small_file_uses_one_connection(self):
        self.fs.set_data(os.urandom(300 * 1024))
        st = await self.start()
        await self.wait_event(m.EVT_COMPLETE, st["id"])
        self.assertEqual(len([g for g in self.fs.gets if g and g != "bytes=0-0"]), 1)
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)

    async def test_dropped_connections_resume_in_place(self):
        self.no_split()
        self.fs.drops, self.fs.drop_after = 3, 200 * 1024
        st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
        await self.wait_event(m.EVT_COMPLETE, st["id"])
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        # Continued from where each connection dropped: well under twice the file was sent.
        self.assertLess(self.fs.sent, len(self.fs.data) * 1.5)

    async def test_pause_frees_the_queue_and_resume_continues(self):
        self.no_split()
        self.fs.delay = 0.05
        a = await self.start("a.safetensors")
        b = await self.start("b.safetensors")
        self.assertEqual(b["status"], "queued")  # one at a time
        await self.wait_until(lambda: m.downloads[a["id"]]["downloaded"] > 2 * 1024**2)
        self.assertEqual((await self.control("pause", a["id"]))["status"], "pausing")
        paused = await self.wait_event(m.EVT_PAUSED, a["id"])
        self.assertEqual(paused["status"], "paused")
        with open(m.downloads[a["id"]]["part_path"] + m.STATE_SUFFIX) as f:
            record = json.load(f)
        on_disk = sum(s[2] for s in record["segments"])
        self.assertGreater(on_disk, 0)
        # The paused download gave up its slot: b runs now.
        await self.wait_until(lambda: m.downloads[b["id"]]["status"] == "downloading")
        sent_before = self.fs.sent
        self.fs.delay = 0
        resumed = await self.control("resume", a["id"])
        self.assertEqual(resumed["status"], "queued")
        await self.wait_event(m.EVT_COMPLETE, b["id"])
        await self.wait_event(m.EVT_COMPLETE, a["id"])
        with open(self.dest("a.safetensors"), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        # a fetched only what it was missing after the resume (b took one full copy).
        self.assertLessEqual(self.fs.sent - sent_before, 2 * len(self.fs.data) - on_disk + 1024**2)
        self.assertEqual(self.leftovers(), [])

    async def test_restart_resumes_from_the_progress_record(self):
        self.no_split()
        self.fs.delay = 0.05
        a = await self.start()
        await self.wait_until(lambda: m.downloads[a["id"]]["downloaded"] > 2 * 1024**2)
        await self.control("pause", a["id"])
        await self.wait_event(m.EVT_PAUSED, a["id"])
        on_disk = m.downloads[a["id"]]["downloaded"]
        m.downloads.clear()  # ComfyUI restarted: only the files remain
        self.fs.delay, sent_before = 0, self.fs.sent
        b = await self.start()
        self.assertNotEqual(a["id"], b["id"])
        await self.wait_event(m.EVT_COMPLETE, b["id"])
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        self.assertLessEqual(self.fs.sent - sent_before, len(self.fs.data) - on_disk + 1024**2)

    async def test_changed_file_on_server_starts_over(self):
        self.fs.delay = 0.05
        a = await self.start()
        await self.wait_until(lambda: m.downloads[a["id"]]["downloaded"] > 2 * 1024**2)
        await self.control("pause", a["id"])
        await self.wait_event(m.EVT_PAUSED, a["id"])
        self.fs.set_data(os.urandom(3 * 1024**2))  # new revision, new size and ETag
        self.fs.delay = 0
        await self.control("resume", a["id"])
        await self.wait_event(m.EVT_COMPLETE, a["id"])
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)

    async def test_pause_while_queued_and_cancel_while_paused(self):
        self.fs.delay = 0.05
        a = await self.start("a.safetensors")
        b = await self.start("b.safetensors")
        self.assertEqual((await self.control("pause", b["id"]))["status"], "paused")
        await self.wait_until(lambda: m.downloads[a["id"]]["downloaded"] > 512 * 1024)
        await self.control("pause", a["id"])
        await self.wait_event(m.EVT_PAUSED, a["id"])
        self.assertTrue(os.path.exists(m.downloads[a["id"]]["part_path"]))
        self.assertEqual((await self.control("cancel", a["id"]))["status"], "cancelled")
        cancelled = await self.wait_event(m.EVT_ERROR, a["id"])
        self.assertEqual(cancelled["error"], "cancelled")
        self.assertEqual(self.leftovers(), [])
        self.assertEqual(m.downloads[b["id"]]["status"], "paused")  # never started on its own

    async def test_cancel_right_after_pause_is_not_lost(self):
        self.fs.delay = 0.05
        a = await self.start()
        await self.wait_until(lambda: m.downloads[a["id"]]["downloaded"] > 512 * 1024)
        await self.control("pause", a["id"])
        await self.control("cancel", a["id"])  # before the pause has finished
        await self.wait_event(m.EVT_ERROR, a["id"])
        await self.wait_until(lambda: not m._running)
        self.assertEqual(m.downloads[a["id"]]["status"], "cancelled")
        self.assertEqual(self.leftovers(), [])

    async def test_resume_and_cancel_while_the_pause_is_wrapping_up(self):
        self.fs.delay = 0.05
        a = await self.start()
        await self.wait_until(lambda: m.downloads[a["id"]]["downloaded"] > 512 * 1024)
        real_emit = m._emit

        async def slow_paused_event(event, payload):
            if event == m.EVT_PAUSED:
                await asyncio.sleep(0.3)  # hold the run in _running after it is already "paused"
            await real_emit(event, payload)

        m._emit = slow_paused_event
        try:
            await self.control("pause", a["id"])
            await self.wait_until(lambda: m.downloads[a["id"]]["status"] == "paused")
            self.assertIn(a["id"], m._running)
            await self.control("resume", a["id"])
            self.assertEqual((await self.control("cancel", a["id"]))["status"], "cancelled")
            await self.wait_until(lambda: not m._running)
        finally:
            m._emit = real_emit
        await asyncio.sleep(0.2)  # nothing may start after the old run leaves
        self.assertEqual(m.downloads[a["id"]]["status"], "cancelled")
        self.assertEqual(self.leftovers(), [])

    async def test_cancel_while_downloading_removes_partial_files(self):
        self.fs.delay = 0.05
        a = await self.start()
        await self.wait_until(lambda: m.downloads[a["id"]]["downloaded"] > 512 * 1024)
        self.assertEqual((await self.control("cancel", a["id"]))["status"], "cancelling")
        await self.wait_event(m.EVT_ERROR, a["id"])
        await self.wait_until(lambda: not m._running)
        self.assertEqual(m.downloads[a["id"]]["status"], "cancelled")
        self.assertEqual(self.leftovers(), [])
        self.assertFalse(os.path.exists(self.dest()))

    async def test_duplicate_start_returns_the_same_download(self):
        self.fs.delay = 0.05
        a = await self.start()
        b = await self.start()
        self.assertEqual(a["id"], b["id"])

    async def test_existing_file_without_checksum_is_left_alone(self):
        with open(self.dest(), "wb") as f:
            f.write(b"old")
        st = await self.start()
        self.assertEqual(st["status"], "exists")
        self.assertEqual(self.fs.gets, [])

    async def test_existing_file_that_matches_is_not_downloaded(self):
        with open(self.dest(), "wb") as f:
            f.write(self.fs.data)
        st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
        done = await self.wait_event(m.EVT_COMPLETE, st["id"])
        self.assertEqual(done["status"], "exists")
        self.assertEqual(self.fs.gets, [])

    async def test_existing_file_that_fails_its_checksum_is_replaced(self):
        with open(self.dest(), "wb") as f:
            f.write(b"corrupt")
        st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
        done = await self.wait_event(m.EVT_COMPLETE, st["id"])
        self.assertEqual(done["status"], "complete")
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        self.assertEqual(self.leftovers(), [])

    async def test_old_file_is_kept_when_the_url_fails(self):
        with open(self.dest(), "wb") as f:
            f.write(b"old")
        self.fs.head, self.fs.status = False, 404
        st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
        await self.wait_event(m.EVT_ERROR, st["id"])
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), b"old")

    async def test_old_file_is_kept_when_the_new_copy_fails_too(self):
        # The workflow's checksum is simply wrong: the file on disk is what the URL serves.
        with open(self.dest(), "wb") as f:
            f.write(self.fs.data)
        st = await self.start(hash_="1" * 64)
        err = await self.wait_event(m.EVT_ERROR, st["id"])
        self.assertIn("sha256 mismatch", err["error"])
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        self.assertEqual(self.leftovers(), [])

    async def test_old_file_is_removed_first_only_when_space_is_short(self):
        with open(self.dest(), "wb") as f:
            f.write(b"corrupt")
        seen = []
        self.fs.on_get = lambda request: seen.append(os.path.exists(self.dest()))
        real = m._room_for_both
        m._room_for_both = lambda st, total: False
        try:
            st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
            await self.wait_event(m.EVT_COMPLETE, st["id"])
        finally:
            m._room_for_both = real
        self.assertFalse(seen[0])  # gone before the first byte was requested
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)

    async def test_full_disk_during_a_replacement_keeps_the_old_file(self):
        with open(self.dest(), "wb") as f:
            f.write(b"corrupt")

        def full(fd, data, offset):
            raise OSError(errno.ENOSPC, "No space left on device")

        real_write, real_wait = m._pwrite, m.ENOSPC_WAIT_SECONDS
        m._pwrite, m.ENOSPC_WAIT_SECONDS = full, 0.3
        try:
            st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
            err = await self.wait_event(m.EVT_ERROR, st["id"])
        finally:
            m._pwrite, m.ENOSPC_WAIT_SECONDS = real_write, real_wait
        self.assertIn("still in place", err["error"])
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), b"corrupt")

    async def test_file_elsewhere_is_left_alone(self):
        other = tempfile.mkdtemp(dir=TMP)
        fp.folder_names_and_paths = {"checkpoints": ([self.dir, other], {".safetensors"})}
        with open(os.path.join(other, "model.safetensors"), "wb") as f:
            f.write(b"someone else's")
        st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
        self.assertEqual(st["status"], "exists")
        self.assertEqual(self.fs.gets, [])
        with open(os.path.join(other, "model.safetensors"), "rb") as f:
            self.assertEqual(f.read(), b"someone else's")

    async def test_failed_fsync_fails_the_download(self):
        real, calls = os.fsync, {"n": 0}

        def failing_fsync(fd):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError(errno.EIO, "Input/output error")
            return real(fd)

        os.fsync = failing_fsync
        try:
            st = await self.start()
            err = await self.wait_event(m.EVT_ERROR, st["id"])
        finally:
            os.fsync = real
        self.assertIn("writing to disk failed", err["error"])
        self.assertFalse(os.path.exists(self.dest()))

    async def test_redirect_to_a_private_address_is_refused(self):
        self.fs.redirect = "https://10.0.0.1/model.safetensors"
        st = await self.start()
        err = await self.wait_event(m.EVT_ERROR, st["id"])
        self.assertIn("non-public", err["error"])

    async def test_checksum_mismatch_after_download_removes_the_file(self):
        st = await self.start(hash_="0" * 64)
        err = await self.wait_event(m.EVT_ERROR, st["id"])
        self.assertIn("sha256 mismatch", err["error"])
        self.assertFalse(os.path.exists(self.dest()))
        self.assertEqual(self.leftovers(), [])

    async def test_server_without_range_support_streams_once(self):
        self.fs.ranges = False
        st = await self.start()
        await self.wait_event(m.EVT_COMPLETE, st["id"])
        self.assertEqual(self.fs.gets[-1], None)
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)

    async def test_size_from_range_probe_when_head_fails(self):
        self.fs.head = False
        st = await self.start()
        await self.wait_event(m.EVT_COMPLETE, st["id"])
        self.assertIn("bytes=0-0", self.fs.gets)
        self.assertEqual(len([g for g in self.fs.gets if g and g != "bytes=0-0"]), m.CONNECTIONS)

    async def test_ignored_range_mid_file_fails_instead_of_corrupting(self):
        orig = self.fs.handle

        async def ignore_range_after_probe(request):
            if request.headers.get("Range", "").startswith("bytes=0-") or request.method == "HEAD":
                return await orig(request)
            self.fs.ranges = False
            try:
                return await orig(request)
            finally:
                self.fs.ranges = True

        app = web.Application()
        app.router.add_get("/{name}", ignore_range_after_probe)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            st = await self.start(url=f"http://127.0.0.1:{port}/model.safetensors")
            err = await self.wait_event(m.EVT_ERROR, st["id"])
            self.assertIn("range", err["error"])
            self.assertFalse(os.path.exists(self.dest()))
        finally:
            await runner.cleanup()

    async def test_full_disk_is_waited_out(self):
        real, calls = m._pwrite, {"n": 0}

        def flaky(fd, data, offset):
            # Full from the third write on, for half a second — then the storage "grew".
            calls["n"] += 1
            if calls["n"] >= 3:
                calls.setdefault("since", time.monotonic())
                if time.monotonic() - calls["since"] < 0.5:
                    raise OSError(errno.ENOSPC, "No space left on device")
            return real(fd, data, offset)

        m._pwrite = flaky
        try:
            st = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
            await self.wait_event(m.EVT_PROGRESS, st["id"], status="waiting_storage")
            await self.wait_event(m.EVT_COMPLETE, st["id"])
        finally:
            m._pwrite = real
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)

    async def test_filesystem_without_sparse_files(self):
        # Growing the file up front fails on a nearly full disk without sparse files; the writes
        # then extend it as they go, and a pause/resume still continues from the record.
        real = os.ftruncate

        def no_prealloc(fd, size):
            if size:
                raise OSError(errno.ENOSPC, "No space left on device")
            return real(fd, size)

        os.ftruncate = no_prealloc
        self.no_split()
        try:
            self.fs.delay = 0.05
            a = await self.start(hash_=hashlib.sha256(self.fs.data).hexdigest())
            await self.wait_until(lambda: m.downloads[a["id"]]["downloaded"] > 2 * 1024**2)
            await self.control("pause", a["id"])
            await self.wait_event(m.EVT_PAUSED, a["id"])
            self.assertLess(os.path.getsize(m.downloads[a["id"]]["part_path"]), len(self.fs.data))
            self.fs.delay, sent_before = 0, self.fs.sent
            await self.control("resume", a["id"])
            await self.wait_event(m.EVT_COMPLETE, a["id"])
        finally:
            os.ftruncate = real
        with open(self.dest(), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)
        self.assertLess(self.fs.sent - sent_before, len(self.fs.data))

    async def test_http_errors_are_reported_without_retry(self):
        self.fs.status = 404
        st = await self.start()
        err = await self.wait_event(m.EVT_ERROR, st["id"])
        self.assertIn("404", err["error"])


class PanelApiTest(ServerCase):
    """Routes the downloads panel uses."""

    async def test_queue_positions_and_creation_order(self):
        self.fs.delay = 0.05
        a = await self.start("a.safetensors")
        b = await self.start("b.safetensors")
        c = await self.start("c.safetensors")
        self.assertLess(a["seq"], b["seq"])
        self.assertLess(b["seq"], c["seq"])
        status = {d["id"]: d for d in body_of(await m.download_status(None))}
        self.assertEqual(status[a["id"]]["queue_position"], 0)  # running
        self.assertEqual(status[b["id"]]["queue_position"], 1)
        self.assertEqual(status[c["id"]]["queue_position"], 2)

    async def test_clear_forgets_only_finished_downloads(self):
        self.fs.set_data(os.urandom(200 * 1024))
        done = await self.start("done.safetensors")
        await self.wait_event(m.EVT_COMPLETE, done["id"])
        self.fs.delay = 0.05
        self.fs.set_data(os.urandom(4 * 1024**2))
        running = await self.start("running.safetensors")
        self.assertEqual(body_of(await m.clear_downloads(None))["cleared"], 1)
        self.assertNotIn(done["id"], m.downloads)
        self.assertIn(running["id"], m.downloads)
        self.assertTrue(os.path.exists(self.dest("done.safetensors")))

    async def test_info_and_scripts_are_served_uncached(self):
        info = body_of(await m.info(None))
        self.assertEqual(info["version"], m.__version__)
        self.assertEqual((await m.download_status(None)).headers["X-Meshive-Boot"], info["boot"])
        req = types.SimpleNamespace(match_info={"name": "pod_download.js"})
        resp = await m.serve_script(req)
        self.assertIn("no-cache", resp.headers["Cache-Control"])
        self.assertEqual(resp.headers["X-Version"], m.__version__)
        with self.assertRaises(web.HTTPNotFound):
            await m.serve_script(types.SimpleNamespace(match_info={"name": "missing.js"}))

    def test_versions_agree(self):
        pyproject = re.search(r'^version = "([^"]+)"', (ROOT / "pyproject.toml").read_text(), re.M).group(1)
        js = re.search(r'export const VERSION = "([^"]+)"', (ROOT / "web" / "meshive_core.js").read_text()).group(1)
        self.assertEqual(m.__version__, pyproject)
        self.assertEqual(js, pyproject)


class TokenTest(ServerCase):
    """A Hugging Face token typed into the page."""

    async def start_hf(self, token):
        body = {"url": "https://huggingface.co/org/repo/resolve/main/model.safetensors", "directory": "checkpoints",
                "filename": "model.safetensors", "token": token}
        real = m._pump
        m._pump = lambda: None  # queued only: no network in tests
        try:
            return await m.start_download(Request(body))
        finally:
            m._pump = real

    async def test_token_is_kept_for_the_download_but_never_shown(self):
        token = "hf_" + "a" * 34
        resp = await self.start_hf(token)
        st = m.downloads[body_of(resp)["id"]]
        self.assertEqual(st["token"], token)
        self.assertNotIn(token, json.dumps(body_of(await m.download_status(None))))
        self.assertEqual(m._auth_headers(st["url"], st["token"]), {"Authorization": f"Bearer {token}"})
        # Only for Hugging Face: a redirect hop or another host never gets it.
        self.assertEqual(m._auth_headers("https://civitai.com/api/download/models/1", token), {})

    async def test_token_typed_later_reaches_a_queued_download(self):
        first = body_of(await self.start_hf(""))
        self.assertEqual(m.downloads[first["id"]]["token"], "")
        again = body_of(await self.start_hf("hf_" + "c" * 34))
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(m.downloads[first["id"]]["token"], "hf_" + "c" * 34)
        # Cancelled: the pod lets go of the token.
        await m.cancel_download(Request({"id": first["id"]}))
        self.assertEqual(m.downloads[first["id"]]["token"], "")

    async def test_malformed_token_is_refused(self):
        resp = await self.start_hf("hf_bad token")
        self.assertEqual(resp.status, 400)
        self.assertNotIn("hf_bad", resp.text or "")

    async def test_token_is_dropped_for_other_hosts(self):
        body = {"url": self.url(), "directory": "checkpoints", "filename": "model.safetensors", "token": "hf_" + "b" * 34}
        st = m.downloads[body_of(await m.start_download(Request(body)))["id"]]
        self.assertEqual(st["token"], "")

    async def test_verify_checks_its_input(self):
        saved = {k: os.environ.pop(k, None) for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")}
        try:
            self.assertEqual((await m.hf_verify(Request({}))).status, 400)  # no token anywhere
            self.assertFalse(body_of(await m.hf_verify(Request({"token": "nope"})))["valid"])
            self.assertFalse(body_of(await m.hf_status(None))["env_token"])
        finally:
            for k, v in saved.items():
                if v is not None:
                    os.environ[k] = v

    async def test_access_check_only_asks_hugging_face(self):
        async with aiohttp.ClientSession() as session:
            self.assertEqual((await m._hf_access(session, "https://civitai.com/api/download/models/1", "hf_x"))["reason"], "not_huggingface")
            self.assertEqual((await m._hf_access(session, "http://huggingface.co/a", "hf_x"))["reason"], "unreachable")


class ModelCheckTest(ServerCase):
    """The checks behind the workflow scan and the check before a run."""

    def put(self, name, data=b"x"):
        path = os.path.join(self.dir, *name.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path

    async def check(self, models, verify=False):
        return body_of(await m.check_models(Request({"models": models, "verify_hashes": verify})))

    def test_model_names_may_carry_subfolders_but_never_leave_the_folder(self):
        self.assertEqual(m._sanitize_filename("SDXL\\model.safetensors"), "SDXL/model.safetensors")
        for bad in ("../x.safetensors", "a/../x.safetensors", "/abs.safetensors", ".hidden/x.safetensors", "a//x.safetensors", "x.txt"):
            with self.assertRaises(ValueError, msg=bad):
                m._sanitize_filename(bad)
        outside = tempfile.mkdtemp(dir=TMP)
        os.symlink(outside, os.path.join(self.dir, "link"))
        with self.assertRaises(ValueError):
            m._model_path(self.dir, "link/x.safetensors")

    async def test_install_into_a_subfolder(self):
        st = await self.start("sub/model.safetensors", url=self.url())
        await self.wait_event(m.EVT_COMPLETE, st["id"])
        with open(os.path.join(self.dir, "sub", "model.safetensors"), "rb") as f:
            self.assertEqual(f.read(), self.fs.data)

    async def test_batch_check(self):
        fp.folder_names_and_paths = {"checkpoints": ([self.dir], set()), "vae": ([tempfile.mkdtemp(dir=TMP)], set())}
        self.put("here.safetensors", b"good")
        self.put("sub/nested.safetensors")
        good = hashlib.sha256(b"good").hexdigest()
        r = await self.check([
            {"filename": "here.safetensors", "directory": "checkpoints", "hash": good},
            {"filename": "sub/nested.safetensors", "directory": "checkpoints"},
            {"filename": "gone.safetensors", "directory": "checkpoints"},
            {"filename": "here.safetensors", "directory": "vae"},          # only in another model type
            {"filename": "nowhere.safetensors"},                             # no folder known
            {"filename": "../evil.safetensors", "directory": "checkpoints"},
        ])
        self.assertEqual(sorted(x["filename"] for x in r["missing"]), ["gone.safetensors", "here.safetensors"])
        self.assertEqual([x for x in r["missing"] if x["directory"] == "vae"][0]["found_in"], ["checkpoints"])
        self.assertEqual(sorted(x["reason"] for x in r["unresolved"]), ["directory_unresolved", "invalid_filename"])
        # With checksums: a file that does not match counts as missing.
        r = await self.check([{"filename": "here.safetensors", "directory": "checkpoints", "hash": "0" * 64}], verify=True)
        self.assertEqual(r["missing"][0]["reason"], "hash_mismatch")
        r = await self.check([{"filename": "here.safetensors", "directory": "checkpoints", "hash": good}], verify=True)
        self.assertEqual(r["missing"], [])

    async def test_a_guessed_folder_is_only_a_hint(self):
        fp.folder_names_and_paths = {"checkpoints": ([self.dir], set()), "vae": ([tempfile.mkdtemp(dir=TMP)], set()),
                                     "configs": ([self.dir], set())}
        self.put("ckpt.safetensors")
        r = await self.check([
            {"filename": "ckpt.safetensors", "hint": "vae"},           # guessed wrong, but it is there
            {"filename": "new.safetensors", "hint": "vae"},            # nowhere: would go to the guess
            {"filename": "odd.safetensors", "directory": ["vae"]},     # not a folder name: ignored, no error
            {"filename": "ckpt.safetensors", "directory": "configs"},  # not a model folder
        ])
        self.assertEqual([(x["filename"], x["directory"], x.get("guessed")) for x in r["missing"]], [("new.safetensors", "vae", True)])
        self.assertEqual([x["filename"] for x in r["unresolved"]], ["odd.safetensors"])

    async def test_checksum_cache_notices_a_rewritten_file(self):
        path = self.put("same.safetensors", b"aaaa")
        st = os.stat(path)
        good = hashlib.sha256(b"aaaa").hexdigest()
        r = await self.check([{"filename": "same.safetensors", "directory": "checkpoints", "hash": good}], verify=True)
        self.assertEqual(r["missing"], [])
        with open(path, "wb") as f:
            f.write(b"bbbb")  # same size...
        os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))  # ...and the old modification time
        r = await self.check([{"filename": "same.safetensors", "directory": "checkpoints", "hash": good}], verify=True)
        self.assertEqual(r["missing"][0]["reason"], "hash_mismatch")

    async def test_existing_subfolder_model_creates_no_folder(self):
        self.put("there/model.safetensors")
        st = await self.start("there/model.safetensors", url=self.url())
        self.assertEqual(st["status"], "exists")
        st = await self.start("nowhere/model.safetensors", url=self.url())
        self.assertEqual(st["status"], "queued")
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "nowhere")))
        self.put("afile.safetensors")
        os.rename(os.path.join(self.dir, "afile.safetensors"), os.path.join(self.dir, "blocker"))
        resp = await m.start_download(Request({"url": self.url(), "directory": "checkpoints", "filename": "blocker/x.safetensors"}))
        self.assertEqual(resp.status, 400)
        self.assertIn("cannot create the folder", body_of(resp)["error"])

    async def test_single_verify(self):
        self.put("one.safetensors", b"abc")
        ok = body_of(await m.verify_model(Request({"directory": "checkpoints", "filename": "one.safetensors", "hash": hashlib.sha256(b"abc").hexdigest()})))
        self.assertEqual((ok["exists"], ok["valid"], ok["reason"]), (True, True, "ok"))
        bad = body_of(await m.verify_model(Request({"directory": "checkpoints", "filename": "one.safetensors", "hash": "1" * 64})))
        self.assertEqual(bad["reason"], "hash_mismatch")
        gone = body_of(await m.verify_model(Request({"directory": "checkpoints", "filename": "two.safetensors"})))
        self.assertFalse(gone["exists"])

    async def test_sizes_and_folders(self):
        sizes = body_of(await m.model_sizes(Request({"urls": [self.url(), "https://evil.example/x.safetensors"]})))
        self.assertEqual(sizes[self.url()], len(self.fs.data))
        self.assertIsNone(sizes["https://evil.example/x.safetensors"])  # not an allowed host
        self.assertEqual(body_of(await m.model_folders(None)), {"checkpoints": [self.dir]})


class PodHelpersTest(unittest.IsolatedAsyncioTestCase):
    """Websocket keepalive, the memory limit report and the pod-side settings."""

    def setUp(self):
        self.saved = dict(m._settings)
        shutil.rmtree(USER_DIR, ignore_errors=True)

    def tearDown(self):
        m._settings.update(self.saved)
        os.environ.pop(m._RAM_PATCH_ENV, None)

    async def test_settings_are_saved_and_read_back(self):
        r = await m.set_settings(Request({"keepalive": False, "cgroup_ram": "yes", "other": True}))
        self.assertEqual(body_of(r)["keepalive"], False)
        with open(os.path.join(USER_DIR, m.SETTINGS_FILE)) as f:
            self.assertEqual(json.load(f), {"keepalive": False, "cgroup_ram": True})
        m._settings.update(keepalive=True)
        m._load_settings()
        self.assertFalse(m._settings["keepalive"])
        self.assertIn("memory", body_of(await m.get_settings(None)))

    async def test_the_environment_can_lock_the_memory_report_off(self):
        os.environ[m._RAM_PATCH_ENV] = "1"
        r = await m.set_settings(Request({"cgroup_ram": True}))
        self.assertEqual(r.status, 409)
        state = body_of(await m.get_settings(None))
        self.assertTrue(state["memory"]["locked_by_env"])
        self.assertFalse(state["cgroup_ram"])  # shown as off, as it is

    async def test_settings_body_must_be_an_object(self):
        for body in ([1], "x", 5, None):
            self.assertEqual((await m.set_settings(Request(body))).status, 400)

    def test_old_comfyui_ram_figures_follow_the_limit(self):
        mm = types.ModuleType("comfy.model_management")
        mm.total_ram, mm.MAX_PINNED_MEMORY = 256 * 1024.0, 200 * 1024**3
        mm.get_disk_swap_total = lambda: 0
        pkg = types.ModuleType("comfy")
        pkg.model_management = mm
        sys.modules["comfy"], sys.modules["comfy.model_management"] = pkg, mm
        try:
            m._resize_comfy_ram(24 * 1024**3)
        finally:
            del sys.modules["comfy"], sys.modules["comfy.model_management"]
        self.assertEqual(mm.total_ram, 24 * 1024.0)
        # ComfyUI's own formula on 24 GiB without swap: max(40 %, min(90 %, 20 GiB, 8 GiB)) = 9.6 GiB
        self.assertAlmostEqual(mm.MAX_PINNED_MEMORY, 24 * 1024**3 * 0.40)

    def cgroup(self, files):
        root = tempfile.mkdtemp(dir=TMP)
        for name, value in files.items():
            with open(os.path.join(root, name), "w") as f:
                f.write(value)
        return root

    def test_cgroup_limit_and_working_set(self):
        v2 = self.cgroup({"memory.max": "8589934592\n", "memory.current": "6442450944", "memory.stat": "anon 1\ninactive_file 4294967296\n"})
        self.assertEqual(m._cgroup_memory(v2, "/nonexistent"), (8 * 1024**3, 2 * 1024**3))
        unlimited = self.cgroup({"memory.max": "max", "memory.current": "100"})
        self.assertEqual(m._cgroup_memory(unlimited, "/nonexistent")[0], None)
        v1 = self.cgroup({"memory.limit_in_bytes": str(1 << 62), "memory.usage_in_bytes": "5", "memory.stat": "total_inactive_file 2\n"})
        self.assertEqual(m._cgroup_memory("/nonexistent", v1), (None, 3))

    def test_memory_report_is_capped_at_the_limit(self):
        Svmem = __import__("collections").namedtuple("svmem", "total available percent used free")
        host = Svmem(total=64 * 1024**3, available=60 * 1024**3, percent=6.0, used=4 * 1024**3, free=60 * 1024**3)
        patched = m._cgroup_aware(lambda: host, read=lambda: (16 * 1024**3, 6 * 1024**3))
        vm = patched()
        self.assertEqual((vm.total, vm.available, vm.used, vm.free), (16 * 1024**3, 10 * 1024**3, 4 * 1024**3, 10 * 1024**3))
        m._settings["cgroup_ram"] = False
        self.assertEqual(patched(), host)
        m._settings["cgroup_ram"] = True
        self.assertEqual(m._cgroup_aware(lambda: host, read=lambda: (None, 0))(), host)  # no limit

    async def test_keepalive_pings_open_sockets_only(self):
        class Ws:
            def __init__(self, closed=False, fail=False):
                self.closed, self.fail, self.pings = closed, fail, 0

            async def ping(self):
                if self.fail:
                    raise ConnectionResetError()
                self.pings += 1

        socks = {"a": Ws(), "b": Ws(closed=True), "c": Ws(fail=True)}
        srv.PromptServer.instance.sockets = socks
        try:
            await m._ping_sockets()
        finally:
            del srv.PromptServer.instance.sockets
        self.assertEqual([s.pings for s in socks.values()], [1, 0, 0])


class PublishTest(unittest.TestCase):
    def test_hardlink_fallback_has_only_one_winner(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "model.safetensors"
            parts = [Path(directory) / f"pod-{i}.part" for i in range(8)]
            for i, part in enumerate(parts):
                part.write_bytes(f"complete model {i}".encode())
            barrier = threading.Barrier(len(parts))

            def no_links(*args):
                barrier.wait(timeout=5)
                raise OSError(errno.ENOTSUP, "hard links unavailable")

            with patch.object(m.os, "link", side_effect=no_links), ThreadPoolExecutor(max_workers=8) as pool:
                winners = list(pool.map(lambda part: m._publish(str(part), str(dest)), parts))
            self.assertEqual(sum(winners), 1)
            self.assertEqual(dest.read_bytes(), f"complete model {winners.index(True)}".encode())
            self.assertTrue(all(not part.exists() for part in parts))

    def test_fallback_preserves_existing_files_and_dangling_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "model.safetensors"
            part = Path(directory) / "pod.part"
            dest.write_bytes(b"existing model")
            with patch.object(m.os, "link", side_effect=OSError(errno.EPERM, "no hard links")):
                part.write_bytes(b"new model")
                self.assertFalse(m._publish(str(part), str(dest)))
                self.assertEqual(dest.read_bytes(), b"existing model")
                self.assertFalse(part.exists())
                if hasattr(os, "symlink") and os.name != "nt":
                    dest.unlink()
                    dest.symlink_to(Path(directory) / "absent")
                    part.write_bytes(b"new model")
                    self.assertFalse(m._publish(str(part), str(dest)))
                    self.assertTrue(dest.is_symlink())
                    self.assertFalse(part.exists())

    def test_unsupported_atomic_publish_keeps_the_completed_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            part, dest = Path(directory) / "pod.part", Path(directory) / "model.safetensors"
            part.write_bytes(b"complete model")
            with patch.object(m.os, "link", side_effect=OSError(errno.ENOTSUP, "no links")), \
                    patch.object(m, "_rename_noreplace", side_effect=OSError(errno.ENOTSUP, "no rename")):
                with self.assertRaisesRegex(m.DownloadError, "completed partial file was kept"):
                    m._publish(str(part), str(dest))
            self.assertEqual(part.read_bytes(), b"complete model")
            self.assertFalse(dest.exists())


class FrontendStateTest(unittest.TestCase):
    """web/meshive_core.js, through tests/test_core.mjs."""

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_core_state(self):
        r = subprocess.run(["node", str(ROOT / "tests" / "test_core.mjs")], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_workflow_scan(self):
        r = subprocess.run(["node", str(ROOT / "tests" / "test_detect.mjs")], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node.js is not installed")
    def test_missing_model_buttons(self):
        r = subprocess.run(["node", str(ROOT / "tests" / "test_buttons.mjs")], capture_output=True, text=True, timeout=120)
        if r.returncode == 77:
            self.skipTest(r.stdout.strip())
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class MessageTest(unittest.TestCase):
    def resp(self, status, url):
        return types.SimpleNamespace(status=status, url=URL(url))

    def test_hugging_face_access_messages_name_the_repository(self):
        url = "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"
        for status in (401, 403, 451):
            e = m._http_error(self.resp(status, url), url)
            self.assertIsInstance(e, m.DownloadError)
            self.assertEqual(e.code, "hf_auth")
            self.assertIn("https://huggingface.co/black-forest-labs/FLUX.1-dev", str(e))
            self.assertFalse(m._retryable(e))

    def test_cdn_refusal_is_not_blamed_on_hugging_face(self):
        url = "https://huggingface.co/org/repo/resolve/main/x.safetensors"
        e = m._http_error(self.resp(403, "https://cas-bridge.xethub.hf.co/abc"), url)
        self.assertEqual(str(e), "access denied (403)")

    def test_server_errors_are_retried(self):
        self.assertTrue(m._retryable(m._http_error(self.resp(503, "https://x.test/"), "https://x.test/")))
        self.assertTrue(m._retryable(m._http_error(self.resp(429, "https://x.test/"), "https://x.test/")))

    def test_expected_sha256(self):
        h = "ab" * 32
        self.assertEqual(m._expected_sha256("SHA256:" + h.upper(), None), h)
        self.assertEqual(m._expected_sha256(h, "blake3"), "")
        self.assertEqual(m._expected_sha256("xyz", None), "")

    def test_content_range(self):
        self.assertEqual(m._parse_content_range("bytes 5-9/10"), (5, 9, 10))
        self.assertEqual(m._parse_content_range("bytes 0-0/*"), (0, 0, None))
        self.assertIsNone(m._parse_content_range("items 0-1/2"))

    def test_plan_covers_the_file(self):
        for total in (1, 1024**2, 1024**2 + 1, 10 * 1024**2 + 7):
            segs = m._plan(total)
            self.assertEqual(segs[0]["start"], 0)
            self.assertEqual(segs[-1]["end"], total - 1)
            for a, b in zip(segs, segs[1:]):
                self.assertEqual(a["end"] + 1, b["start"])


class TargetTest(unittest.TestCase):
    """Where each model type goes in a Meshive pod (layout as seen in a real pod)."""

    def setUp(self):
        base = "/workspace/ComfyUI"
        self.lv = f"{base}/models/checkpoints"
        fp.folder_names_and_paths = {
            "checkpoints": ([f"{base}/models/checkpoints", f"{base}/output/checkpoints"], set()),
            "diffusion_models": ([f"{base}/models/unet", f"{base}/models/diffusion_models"], set()),
            "tensorrt": ([f"{base}/models/tensorrt"], set()),
            "loras": ([f"{base}/output/loras"], set()),
        }
        self.mounted = {f"{base}/models/checkpoints", f"{base}/models/diffusion_models", f"{base}/output/checkpoints",
                        f"{base}/output/loras"}
        self.saved = (m._on_mounted_storage, m._semantic_dirs, os.path.realpath)
        m._on_mounted_storage = lambda p: p in self.mounted
        m._semantic_dirs = lambda: {"CHECKPOINT": f"{base}/models/checkpoints",
                                    "DIFFUSION_MODEL": f"{base}/models/diffusion_models",
                                    "OUTPUT": f"{base}/output"}
        os.path.realpath = lambda p: p

    def tearDown(self):
        m._on_mounted_storage, m._semantic_dirs, os.path.realpath = self.saved

    def target(self, directory):
        return m._resolve_dest_dir_readonly(directory, list(m._semantic_dirs().values()))

    def test_declared_folder_wins_over_legacy_name(self):
        self.assertEqual(self.target("diffusion_models"), ("/workspace/ComfyUI/models/diffusion_models", True, False))

    def test_output_subfolders_are_never_used(self):
        self.assertEqual(self.target("checkpoints"), (self.lv, True, False))
        with self.assertRaises(ValueError):
            self.target("loras")

    def test_undeclared_type_is_temporary(self):
        self.assertEqual(self.target("tensorrt"), ("/workspace/ComfyUI/models/tensorrt", True, True))


if __name__ == "__main__":
    unittest.main()
