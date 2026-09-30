// DOM regression tests for the Missing Models buttons. Optional development dependency: jsdom.
// Set MESHIVE_TEST_DOM_MODULE to a module path when jsdom is installed outside this repository.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let JSDOM;
try { ({ JSDOM } = await import(process.env.MESHIVE_TEST_DOM_MODULE || "jsdom")); }
catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    console.log("SKIP: jsdom is not installed (optional DOM tests)");
    process.exit(77);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "meshive-buttons-"));
mkdirSync(join(tmp, "scripts"));
mkdirSync(join(tmp, "extensions", "meshive"), { recursive: true });
writeFileSync(join(tmp, "scripts", "app.js"), "export const app = globalThis.__app;");
writeFileSync(join(tmp, "scripts", "api.js"), "export const api = globalThis.__api;");
for (const name of ["pod_download.js", "meshive_core.js", "meshive_hub.js", "meshive_token.js", "meshive_detect.js", "meshive_guard.js"])
    copyFileSync(join(root, "web", name), join(tmp, "extensions", "meshive", name));
const dom = new JSDOM('<html lang="en"><head></head><body><div id="vue-app"></div><main id="errors"></main></body></html>', { url: "https://comfy.test/", pretendToBeVisual: true });
for (const name of ["window", "document", "MutationObserver", "Option"]) globalThis[name] = dom.window[name];
const url = (file) => `https://huggingface.co/org/repo/resolve/main/${file}`;
const models = [
    { name: "standard.safetensors", directory: "checkpoints", url: url("standard.safetensors"), isMissing: true },
    { name: "weights.gguf", directory: "checkpoints", url: url("weights.gguf"), isMissing: true },
    { name: "unknown.safetensors", directory: null, isMissing: true },
];
const requests = [];
let extension;
const store = { missingModelCandidates: models, fileSizes: {}, setFileSize() {}, refreshMissingModels() {} };
const pinia = { _s: new Map([["missingModel", store], ["modelToNode", { getCategoryForNodeType: () => null }]]) };
document.getElementById("vue-app").__vue_app__ = { _context: { provides: { [Symbol("pinia")]: pinia } } };
const wf = { nodes: [{ id: 1, type: "CustomWeightsLoader", widgets_values: ["unknown.safetensors"], properties: {} },
    { id: 2, type: "Note", widgets_values: [url("unknown.safetensors")] }] };
const graph = { _nodes: [{ type: "CustomWeightsLoader", widgets: [{ type: "combo", value: "unknown.safetensors" }], properties: {} }], serialize: () => wf };
globalThis.__app = { graph, rootGraph: graph, registerExtension: (e) => { extension = e; },
    extensionManager: { setting: { get: () => undefined }, toast: { add() {} } }, queuePrompt() {}, refreshComboInNodes() {} };
globalThis.__api = {
    addEventListener() {},
    async fetchApi(path, opts = {}) {
        const body = opts.body ? JSON.parse(opts.body) : null;
        const ok = (body) => ({ ok: true, status: 200, headers: new Map(), json: async () => body });
        if (path === "/meshive/models/folders") return ok({ checkpoints: [], loras: [], vae: [] });
        if (path === "/meshive/models/check") return ok({ missing: body.models, unresolved: [] });
        if (path === "/meshive/info") return ok({ version: "1.4.1" });
        if (path === "/meshive/hf/status") return ok({ env_token: false });
        if (path === "/meshive/download/status") return ok([]);
        if (path === "/meshive/models/size") return ok({});
        if (path === "/meshive/download/start") {
            requests.push(body);
            return ok({ id: `download-${requests.length}`, seq: requests.length, status: "queued", directory: body.directory, filename: body.filename });
        }
        return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
    },
};
const panel = document.getElementById("errors");
const markup = () => `<div id="standard"><button title="standard.safetensors">standard.safetensors</button><button data-testid="missing-model-download">Download</button></div>
<div id="gguf"><button title="weights.gguf">weights.gguf</button><button data-testid="missing-model-locate">Locate</button></div>
<div id="unknown"><span title="unknown.safetensors">unknown.safetensors</span><button>Copy URL</button></div>
<div><button data-testid="missing-model-download-all">Download all</button></div>`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
const podFor = (id) => document.getElementById(id).nextElementSibling.querySelector('[data-meshive-pod="row-button"]');
let tests = 0;
function check(name, fn) { fn(); tests++; console.log(`ok ${name}`); }
try {
    await import(pathToFileURL(join(tmp, "extensions", "meshive", "pod_download.js")));
    await extension.beforeConfigureGraph(wf);
    panel.innerHTML = markup();
    await extension.setup();
    extension.afterConfigureGraph();
    await settle();
    check("native Download is retained; GGUF gets both download actions", () => {
        assert.equal(document.querySelectorAll('button[data-testid="missing-model-download"]').length, 1);
        const browser = document.querySelector('#gguf a[data-meshive-pod="browser-download"]');
        assert.equal(browser.href, models[1].url);
        assert.equal(browser.download, "weights.gguf");
        assert.equal(browser.target, "_blank");
        assert.equal(browser.rel, "noopener noreferrer");
        assert.equal(podFor("gguf").textContent, "Install in Meshive Pod");
    });
    check("an unknown directory keeps both actions but disables pod install until chosen", () => {
        assert.ok(document.querySelector('#unknown a[data-meshive-pod="browser-download"]'));
        assert.equal(podFor("unknown").disabled, true);
        assert.equal(document.querySelector('[data-meshive-pod="all-button"]').textContent, "Install all in Meshive Pod (2)");
        assert.deepEqual([...document.querySelector('#unknown + div select').options].map((o) => o.value), ["", "checkpoints", "loras", "vae"]);
    });
    document.querySelector('[data-meshive-pod="all-button"]').click();
    await settle();
    check("Install all never sends an unresolved directory to the server", () => {
        assert.equal(requests.length, 2);
        assert.ok(requests.every((r) => r.directory === "checkpoints"));
        assert.ok(requests.every((r) => r.filename !== "unknown.safetensors"));
    });
    const picker = document.querySelector('#unknown + div select');
    picker.value = "loras";
    picker.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await settle();
    check("choosing a folder enables installation and persists only model metadata", () => {
        assert.equal(podFor("unknown").disabled, false);
        assert.deepEqual(graph._nodes[0].properties.models, [{ name: "unknown.safetensors", url: url("unknown.safetensors"), directory: "loras" }]);
    });
    podFor("unknown").click();
    await settle();
    check("the chosen folder is used in the install request", () => {
        assert.equal(requests.at(-1).directory, "loras");
        assert.equal(requests.at(-1).filename, "unknown.safetensors");
    });
    panel.innerHTML = markup();
    await settle();
    check("rerendering creates no duplicate buttons and retains the selected folder", () => {
        assert.equal(document.querySelectorAll('[data-meshive-pod="row-button"]').length, 3);
        assert.equal(document.querySelectorAll('[data-meshive-pod="browser-download"]').length, 2);
        assert.equal(document.querySelector('#unknown + div select').value, "loras");
    });
    for (const invalid of ["javascript:alert(1)", "https://huggingface.co.evil.test/model.gguf", "https://user:secret@huggingface.co/model.gguf"]) {
        models[1].url = invalid;
        panel.append(document.createElement("span"));
        await settle();
        assert.equal(document.querySelector('#gguf a[data-meshive-pod="browser-download"]'), null);
    }
    check("unsafe browser URLs are never offered as links", () => {});
    console.log(`${tests}/${tests} passed`);
} finally {
    dom.window.close();
    rmSync(tmp, { recursive: true, force: true });
}
