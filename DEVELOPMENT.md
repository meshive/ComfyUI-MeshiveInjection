# Development notes

For contributors: how the extension works inside, the routes it adds to the ComfyUI server, and how to run the tests. Users only need the [README](README.md).

## How it works

- Downloads run one at a time. Each file is fetched over up to 8 parallel connections; a connection that finishes early takes over part of the slowest one.
- A partial download is kept next to the target as `<file>.<pod name>.meshive.part`, with a `.state` file recording which byte ranges are on disk, so it resumes after a pause, an error or a restart.
- When pod storage is full, writes wait up to 120 s for it to grow (Meshive grows pod storage as it fills).
- Finished files are published with a hard link or an atomic no-replace rename, so pods sharing one network volume can install the same model at the same time without overwriting each other. If the filesystem supports neither, the finished partial file is kept and an error is shown.
- A file that exists in the target folder but fails the workflow's SHA-256 checksum is replaced with a verified new copy.
- The extension's scripts are served without browser caching; the browser console shows the loaded version (`[meshive] Install in Meshive Pod v…`).

## Routes

The extension adds these routes to the ComfyUI server (each also under `/api`):

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/meshive/download/start` | `{url, directory, filename, hash?, token?}` → download state |
| `POST` | `/meshive/download/pause` | `{id}` |
| `POST` | `/meshive/download/resume` | `{id}` |
| `POST` | `/meshive/download/cancel` | `{id}` — also removes the partial file |
| `POST` | `/meshive/download/clear` | forgets finished downloads (files are not touched) |
| `GET` | `/meshive/download/status` | all downloads since ComfyUI started |
| `GET` | `/meshive/download/targets` | which folder each model type would be saved to, and why |
| `GET` | `/meshive/info` | `{version, host, boot}` |
| `GET` | `/meshive/models/folders` | model types and their folders |
| `POST` | `/meshive/models/check` | `{models: [{filename, directory?, hash?}], verify_hashes?}` → `{missing, unresolved}` (at most 512) |
| `POST` | `/meshive/models/verify` | `{directory, filename, hash?}` → `{exists, valid, reason}` |
| `POST` | `/meshive/models/size` | `{urls, token?}` → `{url: size}` |
| `GET` / `POST` | `/meshive/settings` | `{keepalive, cgroup_ram}` (GET also returns `keepalive_running` and `memory`) |
| `GET` | `/meshive/hf/status` | `{env_token}` |
| `POST` | `/meshive/hf/verify` | `{token?, urls?}` → `{valid, name, source, access}` |

Progress events on the ComfyUI websocket: `meshive_download_progress`, `meshive_download_paused`, `meshive_download_resumed`, `meshive_download_complete`, `meshive_download_error`.

The pod-wide settings are stored in `meshive_injection.json` in ComfyUI's user folder. `COMFYUI_MESHIVEINJECTION_NO_RAM_PATCH=1` in the pod environment turns the memory limit setting off for good.

## Tests

```bash
python -m unittest discover -s tests
```

Run them with a Python that has `aiohttp` (ComfyUI's own environment does). Node.js runs the frontend tests; the DOM button tests also need `jsdom` (set `MESHIVE_TEST_DOM_MODULE` to its module path if it is installed elsewhere) and are skipped without it.
