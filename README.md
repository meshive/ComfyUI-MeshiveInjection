# ComfyUI-MeshiveInjection

**Install in Meshive Pod** — a ComfyUI extension that downloads missing models **straight into your [Meshive](https://meshive.ai) pod** instead of to your computer.

When a workflow needs a model you don't have, ComfyUI lists it under **Missing Models** with a **Download** button. That button saves the file to the machine running your browser, so on a cloud pod you'd have to upload it again. This extension adds **Install in Meshive Pod** next to it: the ComfyUI server inside the pod fetches the file itself and puts it in the right model folder, ready to use.

## Features

- **Install in Meshive Pod** on every missing model, and **Install all in Meshive Pod** for the whole list — ComfyUI's own Download buttons stay where they are.
- Live progress and speed on the button; click again to cancel.
- The model shows up in node dropdowns as soon as it finishes, and the Missing Models entry clears.
- Picks the right folder on Meshive storage (see below), so installed models load again after a page reload.
- Resumes after a dropped connection, and waits for pod storage to grow instead of failing when the disk fills up.
- Verifies the SHA-256 checksum when the workflow provides one.
- Never overwrites an existing file. Pods that share one network volume can install the same model at the same time safely.

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

Some models on Hugging Face or Civitai require an account token. Set `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) and/or `CIVITAI_TOKEN` as environment variables on your pod. The token is sent only to Hugging Face / Civitai, never to the CDN they redirect to.

## Security

The download runs inside your pod, so the extension is strict about what it fetches:

- Only `https` URLs on `huggingface.co` and `civitai.com` (and their subdomains) are accepted.
- Redirects are followed manually, and every connection is refused if the host resolves to a private, loopback, link-local or other non-public address.
- Files are saved only into ComfyUI model folders, with a plain file name and a model file extension (`.safetensors`, `.sft`, `.ckpt`, `.pt`, `.pth`, `.bin`, `.gguf`, `.onnx`).

## API

The extension adds these routes to the ComfyUI server (each also under `/api`):

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/meshive/download/start` | `{url, directory, filename, hash?}` → download state |
| `POST` | `/meshive/download/cancel` | `{id}` |
| `GET` | `/meshive/download/status` | all downloads since ComfyUI started |
| `GET` | `/meshive/download/targets` | which folder each model type would be saved to, and why |

Progress is sent over the ComfyUI websocket as `meshive_download_progress`, `meshive_download_complete` and `meshive_download_error`.

## Compatibility

Tested with ComfyUI v0.31.0 (frontend 1.48.7) and v0.37.4 (frontend 1.52.7). The buttons attach to the Missing Models list in the right-hand Errors panel; if a future frontend changes that panel, the extension adds nothing rather than breaking the page.

## License

See [LICENSE](LICENSE).
