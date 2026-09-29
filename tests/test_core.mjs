// State tests for web/meshive_core.js, run with Node (18+):  node tests/test_core.mjs
// ComfyUI's scripts/app.js and scripts/api.js are replaced by stand-ins: the module is copied into a
// temporary tree where its "../../scripts/..." imports resolve to them.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "meshive-core-"));
mkdirSync(join(tmp, "scripts"));
mkdirSync(join(tmp, "extensions", "meshive"), { recursive: true });
writeFileSync(join(tmp, "scripts", "app.js"), `export const app = globalThis.__app;`);
writeFileSync(join(tmp, "scripts", "api.js"), `export const api = globalThis.__api;`);
copyFileSync(join(root, "web", "meshive_core.js"), join(tmp, "extensions", "meshive", "meshive_core.js"));

const toasts = [];
globalThis.document = { documentElement: { lang: "en" } };
// Node 21+ has its own navigator (read-only); older ones have none.
if (!globalThis.navigator) globalThis.navigator = { language: "en" };
globalThis.__app = { extensionManager: { setting: { get: () => undefined }, toast: { add: (t) => toasts.push(t) } } };

// Server answers, by path. A function gets the request body.
let routes = {};
let bootHeader = "boot-1";
globalThis.__api = {
    async fetchApi(path, opts = {}) {
        const handler = routes[path];
        if (!handler) return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
        const body = typeof handler === "function" ? handler(opts.body ? JSON.parse(opts.body) : undefined) : handler;
        return { ok: true, status: 200, headers: new Map([["X-Meshive-Boot", bootHeader]]), json: async () => body };
    },
};

const core = await import(pathToFileURL(join(tmp, "extensions", "meshive", "meshive_core.js")));
const results = [];
async function test(name, fn) {
    core.downloads.clear();
    routes = {};
    try { await fn(); results.push(["ok", name]); } catch (e) { results.push(["FAIL", name, e]); }
}

const dl = (id, seq, status, extra = {}) => ({ id, seq, status, directory: "loras", filename: "a.safetensors", ...extra });

await test("a finished download is not brought back by a late status", async () => {
    core.upsert(dl("x", 1, "downloading"));
    core.upsert(dl("x", 1, "complete"));
    core.upsert(dl("x", 1, "downloading", { progress: 50 }));
    assert.equal(core.downloads.get("x").status, "complete");
});

await test("latest attempt wins, and local answers come after server downloads", async () => {
    core.upsert(dl("s1", 1, "error"));
    routes["/meshive/download/start"] = { status: "exists", filename: "a.safetensors", directory: "loras" };
    const first = await core.startDownload({ name: "a.safetensors", directory: "loras", url: "u" });
    const second = await core.startDownload({ name: "a.safetensors", directory: "loras", url: "u" });
    assert.ok(first.seq > 1 && second.seq > first.seq, `${first.seq} ${second.seq}`);
    assert.equal(core.latestFor("loras", "a.safetensors").id, second.id);
    core.upsert(dl("s2", 2, "queued"));
    assert.equal(core.latestFor("loras", "a.safetensors").id, "s2");
});

await test("the batch mark is past every local answer", async () => {
    routes["/meshive/download/start"] = { status: "exists", filename: "a.safetensors", directory: "loras" };
    const before = await core.startDownload({ name: "a.safetensors", directory: "loras", url: "u" });
    const mark = core.seqMark();
    assert.ok(mark >= before.seq);
    const after = await core.startDownload({ name: "a.safetensors", directory: "loras", url: "u" });
    assert.ok(after.seq > mark);
});

await test("a refused start is recorded as an error with the server's reason", async () => {
    routes = {};
    const st = await core.startDownload({ name: "a.safetensors", directory: "loras", url: "u" });
    assert.equal(st.status, "error");
    assert.match(st.error, /404/);
});

await test("a status poll drops downloads the server no longer lists", async () => {
    core.upsert(dl("gone", 1, "complete"));
    core.upsert(dl("kept", 2, "downloading"));
    routes["/meshive/download/status"] = [dl("kept", 2, "downloading", { progress: 10 })];
    await core.refreshAll();
    assert.deepEqual([...core.downloads.keys()], ["kept"]);
});

await test("a server restart resets the page's downloads", async () => {
    let resets = 0;
    core.onReset(() => resets++);
    bootHeader = "boot-A";
    routes["/meshive/download/status"] = [dl("old", 7, "downloading")];
    await core.refreshAll();
    resets = 0; // counted from here: the page now knows boot-A
    bootHeader = "boot-B";
    routes["/meshive/download/status"] = [dl("new", 1, "queued")];
    await core.refreshAll();
    assert.equal(resets, 1);
    assert.deepEqual([...core.downloads.keys()], ["new"]);
    assert.equal(core.latestFor("loras", "a.safetensors").id, "new");
    assert.ok(core.seqMark() < 7);
});

await test("a finish from before a page reload is not shown as just saved", async () => {
    bootHeader = "boot-B";
    routes["/meshive/download/status"] = [dl("done", 3, "complete")];
    await core.refreshAll(true);
    assert.equal(core.current("loras", "a.safetensors"), undefined);
    core.upsert(dl("fresh", 4, "downloading"));
    core.upsert(dl("fresh", 4, "complete"));
    assert.equal(core.current("loras", "a.safetensors").id, "fresh");
});

await test("an unknown or older server version is reported", async () => {
    toasts.length = 0;
    routes = {};
    await core.checkVersion();
    assert.equal(toasts.length, 1);
    routes["/meshive/info"] = { version: core.VERSION, host: "pod", boot: "b" };
    toasts.length = 0;
    await core.checkVersion();
    assert.equal(toasts.length, 0);
});

await test("a verified token goes with Hugging Face downloads only, until forgotten", async () => {
    const sent = [];
    routes["/meshive/hf/verify"] = { valid: true, source: "page", name: "me", access: {} };
    routes["/meshive/download/start"] = (body) => { sent.push(body); return { status: "exists" }; };
    const token = "hf_abcdefgh12345";
    const r = await core.hfVerify(token, []);
    assert.equal(r.valid, true);
    assert.equal(core.hfState().hasPageToken, true);
    assert.equal(core.hfState().token, undefined);  // never handed out
    await core.startDownload({ name: "a.safetensors", directory: "loras", url: "https://huggingface.co/o/r/resolve/main/a.safetensors" });
    await core.startDownload({ name: "b.safetensors", directory: "loras", url: "https://civitai.com/api/download/models/1" });
    core.forgetHfToken();
    await core.startDownload({ name: "a.safetensors", directory: "loras", url: "https://huggingface.co/o/r/resolve/main/a.safetensors" });
    assert.equal(sent[0].token, token);
    assert.equal(sent[1].token, undefined);
    assert.equal(sent[2].token, undefined);
});

await test("checking again without typing uses the page's token, and drops it once rejected", async () => {
    const asked = [];
    routes["/meshive/hf/verify"] = (body) => { asked.push(body.token); return { valid: true, source: "page", name: "me", access: {} }; };
    await core.hfVerify("hf_pagetoken12345", []);
    await core.hfVerify("", []);
    assert.deepEqual(asked, ["hf_pagetoken12345", "hf_pagetoken12345"]);
    routes["/meshive/hf/verify"] = (body) => { asked.push(body.token); return { valid: false, source: "page", code: "rejected" }; };
    await core.hfVerify("", []);
    assert.equal(core.hfState().hasPageToken, false);
});

await test("a rejected token is not kept", async () => {
    routes["/meshive/hf/verify"] = { valid: false, error: "Hugging Face did not accept the token" };
    const r = await core.hfVerify("hf_wrongtoken123", []);
    assert.equal(r.valid, false);
    assert.equal(core.hfState().hasPageToken, false);
});

rmSync(tmp, { recursive: true, force: true });
let failed = 0;
for (const [state, name, err] of results) {
    console.log(`${state} ${name}`);
    if (err) { failed++; console.log(err); }
}
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
