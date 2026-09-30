// Tests for web/meshive_detect.js (the workflow scan), run with Node (18+):  node tests/test_detect.mjs
// ComfyUI's scripts/api.js is replaced by a stand-in answering the extension's routes.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "meshive-detect-"));
mkdirSync(join(tmp, "scripts"));
mkdirSync(join(tmp, "extensions", "meshive"), { recursive: true });
writeFileSync(join(tmp, "scripts", "api.js"), `export const api = globalThis.__api;`);
copyFileSync(join(root, "web", "meshive_detect.js"), join(tmp, "extensions", "meshive", "meshive_detect.js"));

let missingOnServer = new Set();
let managerList = null;
const checked = [];
globalThis.__api = {
    async fetchApi(path, opts = {}) {
        const ok = (body) => ({ ok: true, status: 200, json: async () => body });
        if (path === "/meshive/models/folders") return ok({ checkpoints: [], diffusion_models: [], vae: [], loras: [], text_encoders: [], clip: [], upscale_models: [] });
        if (path === "/meshive/models/check") {
            const models = JSON.parse(opts.body).models;
            checked.push(...models);
            return ok({ missing: models.filter((m) => missingOnServer.has(m.filename)), unresolved: [] });
        }
        if (path.startsWith("/externalmodel/getlist") && managerList) return ok({ models: managerList });
        return { ok: false, status: 404, json: async () => ({}) };
    },
};

const d = await import(pathToFileURL(join(tmp, "extensions", "meshive", "meshive_detect.js")));
const results = [];
async function test(name, fn) {
    missingOnServer = new Set();
    managerList = null;
    checked.length = 0;
    d.folderChoices.clear();
    try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name, e]); }
}

const node = (id, type, values, extra = {}) => ({ id, type, mode: 0, widgets_values: values, properties: {}, ...extra });
const categories = { VAELoader: "vae", UNETLoader: "diffusion_models", CheckpointLoaderSimple: "checkpoints" };
const categoryFor = (t) => categories[t] ?? null;

await test("links in notes are found, and blob pages become file links", async () => {
    const wf = { nodes: [
        node(1, "VAELoader", ["ae.safetensors"]),
        node(2, "Note", ["Get it at https://huggingface.co/org/repo/blob/main/vae/ae.safetensors, then run."]),
    ] };
    const e = d.scanWorkflow(wf).get("ae.safetensors");
    assert.equal(e.used, true);
    assert.equal(e.urlRef.url, "https://huggingface.co/org/repo/resolve/main/vae/ae.safetensors");
});

await test("a note's text is not a model choice", async () => {
    const wf = { nodes: [
        node(1, "Note", ["Models: https://huggingface.co/a/b/resolve/main/x.safetensors"]),
        node(2, "MarkdownNote", ["flux1-dev.safetensors"]),
        node(3, "PrimitiveString", ["see https://h/y.safetensors"]),
    ] };
    const found = d.scanWorkflow(wf);
    assert.equal([...found.values()].filter((e) => e.used).length, 0);
});

await test("models in subgraphs and API-format prompts are found; bypassed nodes are not used", async () => {
    const wf = {
        nodes: [node(1, "VAELoader", ["top.safetensors"]), node(2, "VAELoader", ["off.safetensors"], { mode: 4 })],
        definitions: { subgraphs: [{ nodes: [node(3, "UNETLoader", ["inner.safetensors", "default"])] }] },
    };
    const found = d.scanWorkflow(wf);
    assert.equal(found.get("inner.safetensors").used, true);
    assert.equal(found.get("off.safetensors"), undefined);
    const api = { "5": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "api.safetensors" } } };
    assert.equal(d.scanWorkflow(api).get("api.safetensors").used, true);
});

await test("only missing models get a link, in the frontend's own folder for the node", async () => {
    missingOnServer = new Set(["gone.safetensors"]);
    const wf = { nodes: [
        node(1, "VAELoader", ["gone.safetensors"]),
        node(2, "VAELoader", ["here.safetensors"]),
        node(3, "Note", ["https://huggingface.co/a/b/resolve/main/gone.safetensors https://huggingface.co/a/b/resolve/main/here.safetensors"]),
    ] };
    const added = await d.seedWorkflow(wf, categoryFor);
    assert.deepEqual(added, [{ name: "gone.safetensors", url: "https://huggingface.co/a/b/resolve/main/gone.safetensors", directory: "vae" }]);
    assert.deepEqual(wf.models, added);
    assert.ok(checked.some((m) => m.filename === "here.safetensors" && m.directory === "vae"));
});

await test("a model that already has a link is left to the frontend", async () => {
    missingOnServer = new Set(["known.safetensors"]);
    const wf = { nodes: [node(1, "VAELoader", ["known.safetensors"], { properties: { models: [{ name: "known.safetensors", url: "https://huggingface.co/x/y/resolve/main/known.safetensors", directory: "vae" }] } })] };
    assert.deepEqual(await d.seedWorkflow(wf, categoryFor), []);
    assert.equal(wf.models, undefined);
});

await test("ComfyUI-Manager's list fills in a link once it has loaded (loading never holds up a workflow)", async () => {
    missingOnServer = new Set(["mystery_lora.safetensors"]);
    managerList = [{ filename: "mystery_lora.safetensors", url: "https://huggingface.co/m/l/resolve/main/mystery_lora.safetensors", save_path: "default", type: "lora" }];
    const wf = { nodes: [node(1, "SomeCustomLoader", ["mystery_lora.safetensors"])] };
    await d.preloadManagerModels();
    const added = await d.seedWorkflow(wf, categoryFor);
    assert.equal(added.length, 1);
    assert.equal(added[0].directory, "loras");
    // Without a folder from the frontend the server gets a hint, not a folder to insist on.
    assert.ok(checked.some((m) => m.filename === "mystery_lora.safetensors" && m.hint && !m.directory));
});

await test("a guessed, ambiguous folder offers a choice", async () => {
    missingOnServer = new Set(["flux_t5.safetensors"]);
    const wf = { nodes: [node(1, "SomeCustomLoader", ["flux_t5.safetensors"]), node(2, "Note", ["https://huggingface.co/a/b/resolve/main/flux_t5.safetensors"])] };
    const [added] = await d.seedWorkflow(wf, categoryFor);
    const choice = d.folderChoices.get(d.choiceKey(added.name, added.url));
    assert.ok(choice.options.length > 1 && choice.options.includes(added.directory));
});

await test("a slow server does not hold up loading a workflow", async () => {
    const real = globalThis.__api.fetchApi;
    globalThis.__api.fetchApi = (path, opts) => path === "/meshive/models/check" ? new Promise(() => {}) : real(path, opts);
    try {
        const wf = { nodes: [node(1, "VAELoader", ["slow.safetensors"]), node(2, "Note", ["https://huggingface.co/a/b/resolve/main/slow.safetensors"])] };
        const t0 = Date.now();
        assert.deepEqual(await d.seedWorkflow(wf, categoryFor, 200), []);
        assert.ok(Date.now() - t0 < 1000);
        assert.equal(wf.models, undefined);
    } finally { globalThis.__api.fetchApi = real; }
});

await test("folder inference weighs the URL, the node and the name", async () => {
    const folders = ["checkpoints", "diffusion_models", "vae", "loras", "text_encoders", "clip", "upscale_models"];
    assert.equal(d.inferDirectory({ name: "x.safetensors", url: "https://h/a/vae/x.safetensors" }, folders).directory, "vae");
    assert.equal(d.inferDirectory({ name: "x.safetensors", url: "", nodeTypes: ["LoraLoader"] }, folders).directory, "loras");
    const guess = d.inferDirectory({ name: "flux_t5.safetensors", url: "" }, folders);
    assert.equal(guess.ambiguous, true);
    assert.ok(guess.options.includes("text_encoders") && guess.options.includes("diffusion_models"));
});

await test("the check before a run looks at the live graph's model pickers only", async () => {
    const combo = (name, value) => ({ type: "combo", name, value });
    const live = { _nodes: [
        { type: "VAELoader", mode: 0, widgets: [combo("vae_name", "SDXL/sub.safetensors")], properties: {} },
        { type: "UNETLoader", mode: 0, widgets: [combo("unet_name", "u.safetensors")], properties: { models: [{ name: "u.safetensors", url: "https://huggingface.co/q/r/resolve/main/u.safetensors", directory: "diffusion_models", hash: "ab".repeat(32) }] } },
        { type: "SaveLora", mode: 0, widgets: [{ type: "text", name: "filename", value: "out.safetensors" }], properties: {} },      // not a picker
        { type: "VAELoader", mode: 4, widgets: [combo("vae_name", "bypassed.safetensors")], properties: {} },                      // bypassed
        { type: "VAELoader", mode: 0, widgets: [combo("vae_name", "linked.safetensors")], inputs: [{ widget: { name: "vae_name" }, link: 7 }], properties: {} },
        { type: "Custom", mode: 0, subgraph: { _nodes: [{ type: "EfficientLoader", mode: 0, widgets: [combo("ckpt", "flux-inner.safetensors")], properties: {} }] }, widgets: [] },
    ] };
    const list = await d.workflowModels(live, { nodes: [] }, categoryFor);
    const by = Object.fromEntries(list.map((m) => [m.filename, m]));
    assert.deepEqual(Object.keys(by).sort(), ["SDXL/sub.safetensors", "flux-inner.safetensors", "u.safetensors"]);
    assert.equal(by["SDXL/sub.safetensors"].directory, "vae");
    assert.equal(by["u.safetensors"].hash, "ab".repeat(32));
    assert.equal(by["flux-inner.safetensors"].directory, undefined);  // folder unknown: only a hint
    assert.equal(by["flux-inner.safetensors"].hint, "diffusion_models");
});

rmSync(tmp, { recursive: true, force: true });
let failed = 0;
for (const [state, name, err] of results) {
    console.log(`${state} ${name}`);
    if (err) { failed++; console.log(err); }
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
