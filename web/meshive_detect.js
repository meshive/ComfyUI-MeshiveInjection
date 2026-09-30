import { api } from "../../scripts/api.js";

// Finds the models a workflow uses and where to get them, beyond what the frontend knows by itself.
// The frontend lists a missing model with a Download button only when the workflow carries its URL
// (a node's `properties.models`, or the workflow's own `models`). Many workflows only mention the
// link in a note, or not at all. Before a workflow is loaded we look for those links — in every
// string of the workflow, and in ComfyUI-Manager's model list when it is installed — and add them
// to the workflow's `models`, so the frontend lists those models with a Download button (and ours).
//
// The folder tables and the scoring below follow ComfyUI-RunpodDirect by Madiator2011
// (https://github.com/MadiatorLabs/ComfyUI-RunpodDirect, GPL-3.0).

export const MODEL_EXTENSIONS = [".safetensors", ".sft", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx"];

const DIRECTORY_ALIASES = {
    checkpoint: "checkpoints", checkpoints: "checkpoints", ckpt: "checkpoints",
    diffusion: "diffusion_models", diffusion_model: "diffusion_models", diffusion_models: "diffusion_models", unet: "diffusion_models",
    vae: "vae", vaes: "vae", lora: "loras", loras: "loras",
    text_encoder: "text_encoders", text_encoders: "text_encoders", textencoder: "text_encoders", clip: "clip",
    clip_vision: "clip_vision", controlnet: "controlnet",
    upscale: "upscale_models", upscale_model: "upscale_models", upscale_models: "upscale_models",
    latent_upscale: "latent_upscale_models", latent_upscale_model: "latent_upscale_models", latent_upscale_models: "latent_upscale_models",
    embeddings: "embeddings", embedding: "embeddings", hypernetwork: "hypernetworks", hypernetworks: "hypernetworks",
    style_model: "style_models", style_models: "style_models", gligen: "gligen",
    audio_encoder: "audio_encoders", audio_encoders: "audio_encoders", diffusers: "diffusers",
    model_patch: "model_patches", model_patches: "model_patches", photomaker: "photomaker",
};

const EQUIVALENTS = { diffusion_models: ["unet"], unet: ["diffusion_models"], clip: ["text_encoders"], text_encoders: ["clip"] };

const MANAGER_TYPE_TO_DIRECTORY = {
    checkpoints: "checkpoints", checkpoint: "checkpoints", unclip: "checkpoints",
    text_encoders: "text_encoders", text_encoder: "text_encoders", clip: "text_encoders",
    vae: "vae", vae_approx: "vae_approx", lora: "loras", loras: "loras",
    "t2i-adapter": "controlnet", t2i_adapter: "controlnet", "t2i-style": "controlnet", t2i_style: "controlnet", controlnet: "controlnet",
    clip_vision: "clip_vision", gligen: "gligen", upscale: "upscale_models", embedding: "embeddings", embeddings: "embeddings",
    unet: "diffusion_models", diffusion_model: "diffusion_models", diffusion_models: "diffusion_models",
    hypernetwork: "hypernetworks", hypernetworks: "hypernetworks", photomaker: "photomaker", classifiers: "classifiers",
};

export function hasModelExtension(name) {
    const lower = String(name || "").toLowerCase();
    return MODEL_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// The bare file name of a path or URL path segment.
export function baseName(raw) {
    let v = String(raw ?? "").trim().split("#")[0].split("?")[0].replace(/\\/g, "/");
    v = v.split("/").filter(Boolean).pop() ?? "";
    try { return decodeURIComponent(v).trim(); } catch { return v.trim(); }
}

// Hugging Face "blob" pages are the web view of a file; "resolve" is the file itself.
export function normalizeUrl(raw) {
    const url = String(raw ?? "").trim();
    try {
        const u = new URL(url);
        if (u.hostname === "huggingface.co" || u.hostname.endsWith(".huggingface.co")) u.pathname = u.pathname.replace("/blob/", "/resolve/");
        return u.toString();
    } catch { return url; }
}

function fileNameFromUrl(url) {
    try {
        const name = baseName(new URL(url).pathname);
        return hasModelExtension(name) ? name : null;
    } catch { return null; }
}

function urlsIn(text) {
    if (typeof text !== "string" || !text.includes("http")) return [];
    return (text.match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []).map((u) => u.replace(/[),.;:]+$/g, ""));
}

// A widget value that names a model file (not a link, not a sentence that happens to end in one).
function looksLikeModelValue(v) {
    if (typeof v !== "string") return false;
    const t = v.trim();
    return !!t && t.length <= 260 && !/[\r\n]/.test(t) && !t.includes("://") && hasModelExtension(t);
}

// Notes hold text for people, not model choices (their links are still read, as text).
const TEXT_NODE = /note|markdown|comment|label/i;

// Every node, in the graph and in subgraph definitions (and API-format prompts: {class_type, inputs}).
export function walkNodes(value, onNode, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) walkNodes(v, onNode, seen); return; }
    const type = typeof value.type === "string" ? value.type : typeof value.class_type === "string" ? value.class_type : "";
    if (type && (value.widgets_values !== undefined || value.properties?.models !== undefined || (value.inputs && typeof value.inputs === "object"))) onNode(value, type);
    for (const v of Object.values(value)) walkNodes(v, onNode, seen);
}

function walkStrings(value, onString, seen = new Set()) {
    if (value == null) return;
    if (typeof value === "string") { onString(value); return; }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const v of Array.isArray(value) ? value : Object.values(value)) walkStrings(v, onString, seen);
}

const INACTIVE_MODES = new Set([2, 4]); // never / bypass

function nodeModelValues(node) {
    const out = [];
    const w = node.widgets_values;
    if (Array.isArray(w)) out.push(...w);
    else if (w && typeof w === "object") out.push(...Object.values(w));
    if (node.inputs && typeof node.inputs === "object" && !Array.isArray(node.inputs)) {
        for (const v of Object.values(node.inputs)) {
            if (typeof v === "string") out.push(v);
            else if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === "string"));
        }
    }
    return out.filter(looksLikeModelValue).map((v) => v.trim());
}

function metaOf(m) {
    const url = normalizeUrl(m?.url || "");
    return {
        url, directory: m?.directory ? String(m.directory) : null,
        hash: typeof m?.hash === "string" ? m.hash : null,
        hash_type: typeof m?.hash_type === "string" ? m.hash_type : typeof m?.hashType === "string" ? m.hashType : null,
    };
}

// name -> {name, nodeTypes, used, meta, urlRef}. `name` is the value as the node has it (it may carry
// a subfolder); `used` is false for models only mentioned in metadata or text.
export function scanWorkflow(wf) {
    const byName = new Map();
    const entry = (name) => {
        if (!byName.has(name)) byName.set(name, { name, nodeTypes: new Set(), used: false, meta: null, urlRef: null });
        return byName.get(name);
    };
    walkNodes(wf, (node, type) => {
        const active = !INACTIVE_MODES.has(node.mode);
        const values = TEXT_NODE.test(type) ? [] : nodeModelValues(node);
        if (active) for (const v of values) { const e = entry(v); e.used = true; e.nodeTypes.add(type); }
        if (Array.isArray(node.properties?.models)) {
            for (const m of node.properties.models) {
                if (!m?.name || !hasModelExtension(m.name)) continue;
                const e = entry(String(m.name));
                if (!e.meta?.url) e.meta = metaOf(m);
            }
        }
    });
    for (const m of Array.isArray(wf?.models) ? wf.models : []) {
        if (!m?.name || !hasModelExtension(m.name)) continue;
        const e = entry(String(m.name));
        if (!e.meta?.url) e.meta = metaOf(m);
    }
    // Links anywhere in the workflow (notes, markdown, titles, ...) whose file name matches a model.
    const byBase = new Map();
    for (const e of byName.values()) {
        const key = baseName(e.name).toLowerCase();
        if (!byBase.has(key)) byBase.set(key, []);
        byBase.get(key).push(e);
    }
    walkStrings(wf, (text) => {
        for (const raw of urlsIn(text)) {
            const url = normalizeUrl(raw);
            const file = fileNameFromUrl(url);
            if (!file) continue;
            for (const e of byBase.get(file.toLowerCase()) ?? []) if (!e.urlRef) e.urlRef = { url };
        }
    });
    return byName;
}

// ── Folders ─────────────────────────────────────────────────────────────────
let folderKeys = null;
export async function modelFolders() {
    if (folderKeys) return folderKeys;
    try {
        const res = await api.fetchApi("/meshive/models/folders");
        if (res.ok) folderKeys = Object.keys(await res.json());
    } catch { /* an older server: the frontend's own folders are used */ }
    return folderKeys ?? [];
}

function canonical(raw, valid) {
    if (typeof raw !== "string") return null;
    const n = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!n) return null;
    if (valid.has(n)) return n;
    const alias = DIRECTORY_ALIASES[n];
    if (alias && valid.has(alias)) return alias;
    for (const alt of EQUIVALENTS[n] ?? []) if (valid.has(alt)) return alt;
    return null;
}

function score(scores, valid, raw, value) {
    const dir = canonical(raw, valid);
    if (dir && value > (scores.get(dir) ?? 0)) scores.set(dir, value);
}

// Best folder for a model from its URL path, the nodes that use it and its file name.
export function inferDirectory({ name, url, nodeTypes = [], directory = null }, folders) {
    const valid = new Set(folders);
    const scores = new Map();
    if (directory) score(scores, valid, directory, 100);
    try {
        const parts = new URL(url).pathname.toLowerCase().split("/").filter(Boolean).slice(0, -1).reverse();
        for (const seg of parts) { const dir = canonical(seg, valid); if (dir) { score(scores, valid, dir, 80); break; } }
    } catch { /* no URL hint */ }
    for (const t of nodeTypes) {
        const type = String(t).toLowerCase();
        if (type.includes("latentupscalemodelloader")) score(scores, valid, "latent_upscale_models", 86);
        if (type.includes("upscalemodelloader") || (type.includes("upscale") && !type.includes("latent"))) score(scores, valid, "upscale_models", 78);
        if (type.includes("lora")) score(scores, valid, "loras", 84);
        if (type.includes("vae")) score(scores, valid, "vae", 82);
        if (type.includes("clipvision")) score(scores, valid, "clip_vision", 82);
        if (type.includes("controlnet") || type.includes("t2iadapter")) score(scores, valid, "controlnet", 78);
        if (/textencoder|text_encode|projection|t5|gemma/.test(type)) score(scores, valid, "text_encoders", 76);
        if (type.includes("clip") && !type.includes("clipvision")) { score(scores, valid, "clip", 72); score(scores, valid, "text_encoders", 68); }
        if (type.includes("checkpoint")) score(scores, valid, "checkpoints", 78);
        if (/diffusion|unet|transformer/.test(type)) score(scores, valid, "diffusion_models", 74);
        if (type.includes("embedding") || type.includes("textualinversion")) score(scores, valid, "embeddings", 72);
    }
    const lower = baseName(name).toLowerCase();
    if (lower.includes("lora") || lower.includes("lycoris")) score(scores, valid, "loras", 64);
    if (lower.includes("vae")) score(scores, valid, "vae", 62);
    if (lower.includes("latent") && lower.includes("upscal")) score(scores, valid, "latent_upscale_models", 66);
    if (lower.includes("upscal") && !lower.includes("latent")) score(scores, valid, "upscale_models", 60);
    if (lower.includes("controlnet") || lower.includes("t2i")) score(scores, valid, "controlnet", 58);
    if (lower.includes("clip_vision") || lower.includes("clipvision")) score(scores, valid, "clip_vision", 58);
    if (/text_encoder|text-encoder|gemma|t5|projection/.test(lower)) score(scores, valid, "text_encoders", 58);
    if (lower.includes("embedding")) score(scores, valid, "embeddings", 56);
    if (lower.includes("checkpoint")) score(scores, valid, "checkpoints", 54);
    if (/transformer|diffusion|flux|hunyuan|wan|sd3|ltx/.test(lower)) score(scores, valid, "diffusion_models", 52);

    const ranked = [...scores].sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    return {
        directory: best?.[0] ?? null,
        options: ranked.map(([d]) => d),
        ambiguous: !best || (second && best[1] - second[1] <= 12),
    };
}

// ── ComfyUI-Manager's model list, when it is installed ─────────────────────
let managerIndex = null;     // file name -> entries, once loaded
let managerLoading = null;

// Load ComfyUI-Manager's model list in the background: its bundled copy first ("local", no network),
// then its cached download. Workflow loading never waits for it.
export function preloadManagerModels() {
    if (managerIndex || managerLoading) return managerLoading;
    managerLoading = (async () => {
        const index = new Map();
        for (const mode of ["local", "cache"]) {
            try {
                const res = await api.fetchApi(`/externalmodel/getlist?mode=${mode}`);
                if (!res.ok) continue;
                const list = (await res.json())?.models;
                if (!Array.isArray(list)) continue;
                for (const m of list) {
                    const file = baseName(m?.filename);
                    const url = normalizeUrl(m?.url || "");
                    if (!file || !url || !hasModelExtension(file)) continue;
                    const key = file.toLowerCase();
                    if (!index.has(key)) index.set(key, []);
                    index.get(key).push({ url, save_path: String(m.save_path || ""), type: String(m.type || "") });
                }
                break;
            } catch { /* Manager not installed */ }
        }
        managerIndex = index;
    })();
    return managerLoading;
}

function fromManager(name, nodeTypes, folders) {
    const entries = managerIndex?.get(baseName(name).toLowerCase());
    if (!entries?.length) return null;
    const valid = new Set(folders);
    const preferred = inferDirectory({ name, url: "", nodeTypes }, folders).directory;
    let best = null, bestScore = -1;
    for (const e of entries) {
        const first = e.save_path && e.save_path !== "default" ? e.save_path.replace(/\\/g, "/").split("/").filter(Boolean)[0] : "";
        const dir = canonical(first, valid) || canonical(MANAGER_TYPE_TO_DIRECTORY[e.type.toLowerCase()] || e.type, valid);
        const s = (dir ? 20 : 0) + (preferred && dir === preferred ? 30 : 0);
        if (s > bestScore) { best = { url: e.url, directory: dir }; bestScore = s; }
    }
    return best;
}

// ── Adding what we found to the workflow ────────────────────────────────────
// "name|url" -> {directory, options}: models whose folder was only guessed, for the folder picker.
export const folderChoices = new Map();
// Includes models with a URL but no known folder, so the panel can offer a folder picker.
export const discoveredModels = new Map();
export const choiceKey = (name, url) => `${name}|${url}`;

function categoryOf(nodeTypes, categoryFor) {
    for (const t of nodeTypes) { const c = categoryFor?.(t); if (c) return c; }
    return null;
}

const slash = (name) => String(name).replace(/\\/g, "/");

// Answers of the server's model check, briefly: undo and redo reload the workflow each time.
const CHECK_TTL_MS = 10000;
const checkCache = new Map(); // "name|directory|hint" -> {at, missing}

// Names (with "/" separators) of the models the server does not have, or null when it could not be asked.
export async function checkModels(models, verifyHashes = false) {
    const now = Date.now();
    const key = (m) => `${slash(m.filename)}|${m.directory ?? ""}|${m.hint ?? ""}`;
    const todo = verifyHashes ? models : models.filter((m) => !(now - (checkCache.get(key(m))?.at ?? 0) < CHECK_TTL_MS));
    if (todo.length) {
        try {
            const res = await api.fetchApi("/meshive/models/check", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ models: todo.slice(0, 512), verify_hashes: verifyHashes }),
            });
            if (!res.ok) return null;
            const r = await res.json();
            const bad = new Set([...(r.missing ?? []), ...(r.unresolved ?? [])].map((m) => m.filename));
            if (verifyHashes) return bad;
            for (const m of todo) checkCache.set(key(m), { at: now, missing: bad.has(slash(m.filename)) });
        } catch { return null; }
    }
    return new Set(models.filter((m) => checkCache.get(key(m))?.missing).map((m) => slash(m.filename)));
}

// Add a URL (and folder) for every missing model a node uses that the workflow does not describe.
// `categoryFor(nodeType)` is the frontend's own folder for a node type: a match there is what lets
// the frontend attach the URL to its row. Gives up (adding nothing) after `budgetMs`, since the
// frontend waits for this before showing the workflow. Returns the entries added.
export async function seedWorkflow(wf, categoryFor, budgetMs = 1500, { reset = true, isCurrent = () => true } = {}) {
    if (!wf || typeof wf !== "object") return [];
    const deadline = Date.now() + budgetMs;
    if (reset) { folderChoices.clear(); discoveredModels.clear(); }
    const choices = new Map();
    const found = scanWorkflow(wf);
    let todo = [...found.values()].filter((e) => e.used && (!e.meta?.url || (!e.meta.directory && !categoryOf(e.nodeTypes, categoryFor))));
    if (!todo.length) return [];
    const TIMEOUT = Symbol("timeout");
    const withinBudget = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(TIMEOUT), Math.max(0, deadline - Date.now())))]);
    const folders = await withinBudget(modelFolders());
    if (folders === TIMEOUT) return [];
    const guess = (e, url) => inferDirectory({ name: e.name, url, nodeTypes: [...e.nodeTypes] }, folders).directory;
    // Only models that are actually missing: the ones on disk need no link (and the workflow is
    // left as it was for them).
    const missing = await withinBudget(checkModels(todo.map((e) => {
        const directory = categoryOf(e.nodeTypes, categoryFor);
        return directory ? { filename: e.name, directory } : { filename: e.name, hint: guess(e, e.urlRef?.url || "") };
    })));
    if (missing === TIMEOUT) return [];
    if (missing) todo = todo.filter((e) => missing.has(slash(e.name)));
    const added = [];
    for (const e of todo) {
        let url = e.meta?.url || e.urlRef?.url, hint = e.meta?.directory ?? null;
        if (!url) {
            const m = fromManager(e.name, [...e.nodeTypes], folders);
            if (m) { url = m.url; hint = m.directory; }
        }
        if (!url) continue;
        let directory = categoryOf(e.nodeTypes, categoryFor);
        if (!directory) {
            const r = inferDirectory({ name: e.name, url, nodeTypes: [...e.nodeTypes], directory: hint }, folders);
            directory = r.directory;
            if (!directory || (r.ambiguous && r.options.length > 1)) {
                choices.set(choiceKey(e.name, url), { directory, options: directory ? r.options : [...folders].sort() });
            }
        }
        added.push({ name: e.name, url, directory, ...(e.meta?.hash ? { hash: e.meta.hash } : {}), ...(e.meta?.hash_type ? { hash_type: e.meta.hash_type } : {}) });
    }
    // A delayed check must not change the picker or workflow after the user switches graphs.
    if (!isCurrent()) return [];
    for (const [key, choice] of choices) folderChoices.set(key, choice);
    for (const model of added) discoveredModels.set(choiceKey(model.name, model.url), model);
    if (added.length) {
        const existing = Array.isArray(wf.models) ? wf.models : [];
        wf.models = [...existing, ...added.filter((m) => !existing.some((e) => e.name === m.name && e.url === m.url))];
    }
    return added;
}

// Manager may finish before, during or after graph configuration. Supplement the current graph
// once it is configured; never reload it, and discard answers for a graph that was replaced.
export function createWorkflowLinker(categoryFor, snapshot, apply) {
    let generation = 0, configured = false, managerReady = false, supplement = null;
    const finish = async () => {
        if (!configured || !managerReady) return;
        const mine = generation;
        if (supplement?.generation === mine) return supplement.promise;
        const isCurrent = () => mine === generation && configured;
        const promise = (async () => {
            const wf = snapshot();
            const added = await seedWorkflow(wf, categoryFor, 1500, { reset: false, isCurrent });
            if (added.length && isCurrent()) apply(added);
            return added;
        })();
        supplement = { generation: mine, promise };
        return promise;
    };
    return {
        async beforeConfigure(wf) {
            const mine = ++generation;
            configured = false;
            return seedWorkflow(wf, categoryFor, 1500, { isCurrent: () => mine === generation });
        },
        afterConfigure() { configured = true; return finish(); },
        managerLoaded() { managerReady = true; return finish(); },
    };
}

// Update only missing candidates that lack usable metadata; keep the frontend's node/widget IDs.
export function enrichMissingCandidates(list, models) {
    return list.map((c) => {
        if (!c.isMissing || (c.url && c.directory)) return c;
        const m = models.find((m) => m.name === c.name && (!c.url || c.url === m.url)
            && (!c.directory || !m.directory || c.directory === m.directory));
        return m ? { ...c, url: c.url || m.url, directory: c.directory || m.directory,
            hash: c.hash || m.hash, hash_type: c.hash_type || m.hash_type } : c;
    });
}

// Persist discovered metadata on the live nodes, so a later native refresh or save keeps the URL.
export function attachModelMetadata(graph, models, categoryFor) {
    const seen = new Set();
    const visit = (g) => {
        if (!g || seen.has(g)) return;
        seen.add(g);
        for (const node of g._nodes ?? g.nodes ?? []) {
            if (INACTIVE_MODES.has(node.mode)) continue;
            if (node.subgraph) visit(node.subgraph);
            const names = new Set((node.widgets ?? []).filter((w) => w.type === "combo").map((w) => w.value));
            const directory = categoryFor?.(node.type);
            for (const m of models) {
                if (!names.has(m.name) || (directory && m.directory && directory !== m.directory)) continue;
                node.properties ??= {};
                const embedded = node.properties.models ??= [];
                const metadata = { name: m.name, url: m.url, directory: m.directory,
                    ...(m.hash ? { hash: m.hash } : {}), ...(m.hash_type ? { hash_type: m.hash_type } : {}) };
                const existing = embedded.find((e) => e.name === m.name && (!e.url || e.url === m.url));
                if (existing) Object.assign(existing, metadata);
                else embedded.push(metadata);
            }
        }
    };
    visit(graph);
}

// The models the live graph selects in its model pickers — the combo widgets the frontend itself
// checks — skipping bypassed or muted nodes (and what is inside them) and inputs fed by a link.
export function liveModelChoices(graph) {
    const out = [];
    const seen = new Set();
    const visit = (g) => {
        if (!g || seen.has(g)) return;
        seen.add(g);
        for (const node of g._nodes ?? g.nodes ?? []) {
            if (INACTIVE_MODES.has(node.mode)) continue;
            if (node.subgraph) visit(node.subgraph);
            for (const w of node.widgets ?? []) {
                if (w?.type !== "combo" || !looksLikeModelValue(w.value)) continue;
                const input = node.inputs?.find((i) => i?.widget?.name === w.name);
                if (input?.link != null) continue;
                out.push({ name: String(w.value).trim(), nodeType: node.type, meta: getSelectedMeta(node, w.value) });
            }
        }
    };
    visit(graph);
    return out;
}

function getSelectedMeta(node, value) {
    const m = (node.properties?.models ?? []).find((x) => x?.name === value);
    return m ? metaOf(m) : null;
}

// The models to check before a run: what the live graph selects, with the folder the node reads
// from when known (`directory`), else a guess (`hint`), and any link the workflow mentions.
export async function workflowModels(graph, wf, categoryFor) {
    const folders = await modelFolders();
    const scanned = scanWorkflow(wf ?? {});
    const out = new Map();
    for (const c of liveModelChoices(graph)) {
        const s = scanned.get(c.name);
        const meta = c.meta?.url ? c.meta : s?.meta;
        const url = meta?.url || s?.urlRef?.url || "";
        const known = categoryFor?.(c.nodeType) || c.meta?.directory;
        const item = { filename: c.name, url, hash: meta?.hash ?? null, hash_type: meta?.hash_type ?? null };
        if (known) item.directory = known;
        else item.hint = inferDirectory({ name: c.name, url, nodeTypes: [c.nodeType] }, folders).directory;
        out.set(`${c.name}|${item.directory ?? ""}`, item);
    }
    return [...out.values()];
}
