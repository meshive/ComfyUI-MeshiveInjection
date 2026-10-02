# Install in Meshive Pod

A ComfyUI extension for [Meshive](https://meshive.ai) pods: missing models are downloaded **straight into your pod**, not to your computer.

When a workflow needs a model you don't have, ComfyUI lists it under **Missing Models** with a **Download** button. That button saves the file to *your* computer — on a cloud pod you would then have to upload it again. This extension puts an **Install in Pod** button next to it. The pod downloads the model itself, saves it in the right folder, and the model is ready to use right away.

## Installation

The extension is not in the ComfyUI-Manager list yet. Install it from GitHub:

- **In ComfyUI-Manager:** choose *Install via Git URL* and enter `https://github.com/meshive/ComfyUI-MeshiveInjection`. (If that option is disabled by the Manager's security setting, use the terminal instead.)
- **Or in a terminal on the pod:**

  ```bash
  cd ComfyUI/custom_nodes
  git clone https://github.com/meshive/ComfyUI-MeshiveInjection.git
  ```

Then restart ComfyUI and reload the page. Nothing else needs to be installed.

## How to use it

1. **Open a workflow.** If models are missing, ComfyUI shows an error. Open the error panel on the right and find **Missing Models**.
2. **Click *Install in Pod*** under a model — or ***Install all in Pod*** under the list to get every missing model. ComfyUI's own **Download** buttons stay where they were.
3. **Watch it on the button.** It shows the progress and speed. When it is done, the model appears in the node's dropdown and disappears from the Missing Models list — no page reload needed.

To follow all downloads, click the **Meshive** button in the top bar. It opens the downloads panel, where you can pause, resume, cancel or retry each download.

### What the button shows

| Button | Meaning | Clicking it |
|---|---|---|
| **Install in Pod** | Not installed yet | Starts the download |
| **Queued** | Waiting — downloads run one at a time | Cancels it |
| **42% · 85 MB/s ✕** | Downloading | Cancels it |
| **Paused · 42% ▶** | Paused; the downloaded part is kept | Resumes it |
| **Waiting for storage** | The pod's storage is growing to make room | Cancels it |
| **Verifying** | Checking the file against the workflow's checksum | Cancels it |
| **Saved in Pod** | Done | — |
| **Already there** | The pod already had this model | — |
| **Saved in Pod (temporary)** | Done, but on a disk that is wiped when the pod restarts (see [Where models are saved](#where-models-are-saved)) | — |
| **Failed — retry** | Something went wrong; hover over it to see why | Tries again |

A download that stops halfway — a lost connection, a pause, ComfyUI restarting — continues from where it stopped next time.

### Models whose download link is only in a note

Many workflows put the download links in a note instead of attaching them to the model, so ComfyUI can't offer a Download button for those models. When you open a workflow, the extension looks for such links — in notes and other text in the workflow, and in ComfyUI-Manager's model list if you have it — and adds them. Those models then get a Download button and *Install in Pod* like any other.

If the extension can't tell which folder a model belongs in, a **folder choice** appears next to its button. Pick the folder before installing.

ComfyUI shows no Download button for some file types (such as `.gguf`). Those models still get *Install in Pod*, and a **Download** link for your computer.

## Models that need a login (gated models)

Some models on Hugging Face require you to log in and accept their terms first.

- **Hugging Face:** a **Hugging Face token** box appears in the Missing Models panel when a model needs one. Paste your token (it starts with `hf_`) and click **Verify**. The pod checks the token and shows links to any models whose terms you still have to accept on the Hugging Face website. Then install as usual.
  - The token stays in this browser page only and is never saved. The pod uses it only to download from Hugging Face. To drop it, use **Forget** in the downloads panel (or reload the page).
- **Pod environment variables:** you can also set `HF_TOKEN` (Hugging Face) or `CIVITAI_TOKEN` (Civitai) on your pod. The extension uses them automatically.

## Where models are saved

In a Meshive pod, each model goes into its model folder (for example `models/checkpoints` or `models/loras`) **on the pod's storage**, so it is still there after a restart and loads again when you reload the page.

If a model type has no folder on the pod's storage (this can happen with some custom-node model types, in a pod without a volume), the model is saved in ComfyUI's own folder on the pod's system disk. It works right away, but the button says **(temporary)**: it will be gone after the pod restarts. To keep such models, attach a volume that covers that folder. Files larger than 10 GB are not saved on the system disk, because filling it would stop the pod.

The extension never saves models into the output, input or workflow folders, and never overwrites a file that is already there.

Outside a Meshive pod, models go to ComfyUI's usual folder for their type.

## Settings

Under **Settings → Meshive** (and in the downloads panel):

| Setting | Default | What it does |
|---|---|---|
| Auto missing-model checks | On | When you come back to the tab, check the Missing Models list again, in case a model was added or removed in the meantime. |
| Check models before running | Off | When you click Run, first check that the workflow's models are in the pod. If one is missing, the run is paused with a list of what is missing, a button to install it, and *Queue anyway*. |
| Checksums before running | Off | With the check above, also verify the files' contents when the workflow gives a checksum. Slow for large models. |
| Verbose logs | Off | Write details about downloads to the browser console, for troubleshooting. |

Two more settings, in the downloads panel only, apply to the whole pod:

| Setting | Default | What it does |
|---|---|---|
| Connection keepalive | On | Keeps the connection between your browser and the pod alive when idle, so the page doesn't keep reconnecting. |
| Pod memory limit for ComfyUI | On | Only matters for old ComfyUI versions (before v0.37), which don't know the pod's memory limit and may use more memory than the pod has. Newer versions handle this themselves and are left alone. |

## Troubleshooting

- **There is no *Install in Pod* button for a model.** The workflow doesn't say where to download that model from. Look it up on Hugging Face or Civitai and download it another way — for example through ComfyUI-Manager's model list.
- **The button is greyed out.** Choose a folder in the folder choice next to it, or the model is already installed.
- **"Authentication required" or "Access denied".** The model is gated: see [Models that need a login](#models-that-need-a-login-gated-models).
- **"Storage is full and did not grow".** The pod's storage limit was reached. Free up space or increase the limit, then click the button again — the download continues where it stopped.
- **"The Meshive extension differs between the server and this page".** The extension was updated. Restart ComfyUI, then reload the page.

## Security

The download runs inside your pod, so the extension only fetches what it should:

- Only secure (`https`) links from **huggingface.co** and **civitai.com** are downloaded.
- It refuses to connect to private or internal network addresses, even through redirects.
- Files are saved only into ComfyUI model folders, and only model file types (`.safetensors`, `.sft`, `.ckpt`, `.pt`, `.pth`, `.bin`, `.gguf`, `.onnx`).
- Tokens are sent only to Hugging Face or Civitai themselves — never to the download servers they redirect to.

## Compatibility

Tested with ComfyUI v0.31.0 and v0.37.4. The buttons appear in the Missing Models list of the error panel on the right. If a future ComfyUI changes that panel, the extension adds nothing rather than breaking the page.

Contributing? See [DEVELOPMENT.md](DEVELOPMENT.md).

## Acknowledgements

Much of this extension follows [ComfyUI-RunpodDirect](https://github.com/MadiatorLabs/ComfyUI-RunpodDirect) by Madiator2011 (GPL-3.0): the parallel downloads and queue, pause and resume, the downloads panel, the Hugging Face token check, finding download links in workflows and the check before running.

## License

GPL-3.0 — see [LICENSE](LICENSE).
