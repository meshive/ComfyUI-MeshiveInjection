# ComfyUI-MeshiveInjection

**Install in Meshive Pod** — a ComfyUI extension that downloads missing models **straight into your [Meshive](https://meshive.ai) pod** instead of to your computer.

When a workflow needs a model you don't have, ComfyUI lists it under **Missing Models** with a **Download** button. That button saves the file to the machine running your browser, so on a cloud pod you'd have to upload it again. This extension adds **Install in Meshive Pod** next to it: the ComfyUI server inside the pod fetches the file itself and puts it in the right model folder, ready to use.

## Features

- **Install in Meshive Pod** on every missing model, and **Install all in Meshive Pod** for the whole list — ComfyUI's own Download buttons stay where they are.
- Fast: each file is fetched over up to 8 parallel connections, and a connection that finishes early takes over part of the slowest one, so the download does not end on a single slow connection.
- Downloads run one at a time, in the order you started them.
- Live progress and speed on the button; click again to cancel. A paused download frees the queue for the next one, and clicking its button resumes it.
- **Install all** shows the progress of the whole batch in the Missing Models panel, with a one-click retry for anything that failed or was cancelled.
- A **Meshive** button in the top bar opens the downloads panel: every download in the pod with progress, speed, size, connections and queue position, and Pause / Resume / Cancel / Retry for each. Its settings are also under *Settings → Meshive*.
- The model shows up in node dropdowns as soon as it finishes, and the Missing Models entry clears.
- **Finds download links the workflow only mentions.** Many workflows put model links in a note instead of in the model metadata, so ComfyUI lists those models without a Download button. When a workflow loads, the extension looks for such links (in notes and any other text in the workflow, and in ComfyUI-Manager's model list when it is installed) and adds them for the models that are actually missing — ComfyUI then lists them with its Download button, and ours. If the Manager list arrives after the workflow loads, its links are added to the current graph automatically. When the right folder can only be guessed or is unknown, a folder choice appears next to the button; an unknown folder must be selected before installing.
- Models in subfolders of a model folder (`SDXL/model.safetensors`) are installed into that subfolder.
- Missing models that ComfyUI offers no Download button for (it does not for some file types, such as `.gguf`) get a browser **Download** action as well as *Install in Meshive Pod* when they have a supported URL. Browser downloads use the browser's own authentication; the page token is used only for pod installs.
- Shows the size of models ComfyUI could not size by itself.
- Checks the missing models again when you come back to the tab (*Auto missing-model checks*, on by default).
- **Pod server settings** in the downloads panel, kept on the pod (ComfyUI's user folder):
  - *Connection keepalive* (on): pings the browser's websocket every 45 s so a proxy between the browser and the pod does not close an idle connection.
  - *Pod memory limit for ComfyUI* (on): ComfyUI v0.37 and later read the container's memory limit themselves, and are left alone. An older ComfyUI is told the pod's limit instead of the host's RAM (leaving reclaimable file cache out of "used"), so it does not plan for memory the pod cannot use. `COMFYUI_MESHIVEINJECTION_NO_RAM_PATCH=1` in the pod environment turns this off for good.
- **Check models before running** (off by default): when you run a workflow, the pod first confirms that the models its model pickers select are there — optionally down to their checksums — and if one is missing, holds the run with a list of what is missing, an *Install in Meshive Pod* button and *Queue anyway*.
- Picks the right folder on Meshive storage (see below), so installed models load again after a page reload.
- Continues where it stopped after a dropped connection, a pause, a failure or a ComfyUI restart, and waits for pod storage to grow instead of failing when the disk fills up.
- Verifies the SHA-256 checksum when the workflow provides one. If the file is already in the folder it would install into but does not match the checksum, a new copy is downloaded, verified and swapped in (the old file is removed first only when the disk cannot hold both).
- Otherwise never overwrites an existing file. Pods that share one network volume can install the same model at the same time safely. Publishing uses hard links or an atomic rename that refuses an existing destination. If the filesystem supports neither, the completed partial file is kept and an error is shown instead of risking an overwrite.

## Installation

**ComfyUI Manager:** search for "ComfyUI-MeshiveInjection" (or "Install in Meshive Pod") and install.

**Manually:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/meshive/ComfyUI-MeshiveInjection.git
```

Restart ComfyUI. The extension has no dependencies beyond ComfyUI itself.

## Where models are saved

In a Meshive pod the extension saves each model type to a folder on the pod's storage:

1. the folder the Meshive template sets up for that model type (for example `models/checkpoints`), otherwise
2. any folder for that type that sits on an attached volume.

Output, input, workflow and cache folders are never used for models.

If a model type has no folder on pod storage (some custom-node model types, in a pod without a volume), the model is still installed into ComfyUI's own folder for that type, so it loads right away. It is marked **temporary** because that folder is on the pod's system disk and is lost when the pod restarts; attach a volume that covers the folder to keep it. Files over 10 GiB are not accepted there, since filling the system disk would stop the pod.

Outside a Meshive pod, models go to ComfyUI's default folder for their type.

## Gated models

Some models on Hugging Face or Civitai require an account token.

- **Hugging Face, in the page:** when a missing model is gated (or a download fails for want of a token), a *Hugging Face token* box appears in the Missing Models panel. Paste a token (`hf_…`) and press **Verify**: the pod checks whom it belongs to and which of the listed files it can fetch, and links to the model pages whose terms you still need to accept. The token stays in the page only — it is sent to the pod with each Hugging Face download and never saved; **Forget** in the downloads panel drops it.
- **In the pod environment:** set `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) and/or `CIVITAI_TOKEN`. A Hugging Face token found there is checked automatically when gated models show up.

A token is sent only to Hugging Face / Civitai themselves, never to the CDN they redirect to.

## Security

The download runs inside your pod, so the extension is strict about what it fetches:

- Only `https` URLs on `huggingface.co` and `civitai.com` (and their subdomains) are accepted.
- Redirects are followed manually, and every connection is refused if the host is or resolves to a private, loopback, link-local or other non-public address.
- Files are saved only into ComfyUI model folders, with a plain file name and a model file extension (`.safetensors`, `.sft`, `.ckpt`, `.pt`, `.pth`, `.bin`, `.gguf`, `.onnx`).

## API

The extension adds these routes to the ComfyUI server (each also under `/api`):

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/meshive/download/start` | `{url, directory, filename, hash?, token?}` → download state |
| `POST` | `/meshive/download/pause` | `{id}` — stops the transfer and keeps what is on disk |
| `POST` | `/meshive/download/resume` | `{id}` — puts it back at the front of the queue |
| `POST` | `/meshive/download/cancel` | `{id}` — stops it and removes the partial file |
| `POST` | `/meshive/download/clear` | forgets finished downloads (files are not touched) |
| `GET` | `/meshive/download/status` | all downloads since ComfyUI started |
| `GET` | `/meshive/download/targets` | which folder each model type would be saved to, and why |
| `GET` | `/meshive/info` | `{version, host, boot}` |
| `GET` | `/meshive/models/folders` | model types and their folders |
| `POST` | `/meshive/models/check` | `{models: [{filename, directory?, hash?}], verify_hashes?}` → `{missing, unresolved}` (at most 512) |
| `POST` | `/meshive/models/verify` | `{directory, filename, hash?}` → `{exists, valid, reason}` |
| `POST` | `/meshive/models/size` | `{urls, token?}` → `{url: size}` |
| `GET` | `/meshive/settings` | `{keepalive, cgroup_ram, keepalive_running, memory}` |
| `POST` | `/meshive/settings` | `{keepalive?, cgroup_ram?}` |
| `GET` | `/meshive/hf/status` | `{env_token}` — is there a Hugging Face token in the pod environment |
| `POST` | `/meshive/hf/verify` | `{token?, urls?}` → `{valid, name, source, access}` (without `token`, checks the pod's own) |

Progress is sent over the ComfyUI websocket as `meshive_download_progress`, `meshive_download_paused`, `meshive_download_resumed`, `meshive_download_complete` and `meshive_download_error`.

The extension's scripts are served without browser caching, so an update takes effect on the next page load; the browser console shows the version (`[meshive] Install in Meshive Pod v…`).

A partial download is kept next to the target as `<file>.<pod name>.meshive.part`, with a `.state` file that records which byte ranges are already on disk.

## Compatibility

Tested with ComfyUI v0.31.0 (frontend 1.48.7) and v0.37.4 (frontend 1.52.7). The buttons attach to the Missing Models list in the right-hand Errors panel; if a future frontend changes that panel, the extension adds nothing rather than breaking the page.

## Development

The download engine has tests that run against a local HTTP server, without ComfyUI:

```bash
python -m unittest discover -s tests
```

Run them with a Python that has `aiohttp` (ComfyUI's own environment does). Node.js runs the frontend state and detection tests. The optional DOM button tests also need `jsdom`; set `MESHIVE_TEST_DOM_MODULE` to its module path if it is installed outside this repository. Without `jsdom`, only those DOM tests are skipped. No frontend build is needed.

## Acknowledgements

The parallel range downloads, the download queue, pause/resume, reinstalling a file that fails its checksum, the Hugging Face access messages, the downloads panel, the install-all progress, the Hugging Face token check, the workflow scan with its folder tables, the check before running, the websocket keepalive and the memory limit report follow [ComfyUI-RunpodDirect](https://github.com/MadiatorLabs/ComfyUI-RunpodDirect) by Madiator2011 (GPL-3.0).

## License

GPL-3.0 — see [LICENSE](LICENSE).
