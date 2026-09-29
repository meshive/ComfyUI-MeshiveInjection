import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ComfyUI's "Download" button in the Missing Models panel is a browser download, so the model
// lands on the user's computer. Next to it we add "Install in Meshive Pod", which asks the
// ComfyUI server in the pod (backend: __init__.py) to fetch the same URL itself.
//
// The hook points depend on the ComfyUI frontend version. Tested with comfyui-frontend-package
// 1.48.7 (ComfyUI v0.31.0) and 1.52.7 (v0.37.4). These versions show Missing Models in the
// right-hand "Errors" panel rather than the old modal, so we rely on:
//   * data:     the Pinia `missingModel` store's `missingModelCandidates` ({name, directory, url, hash?})
//   * position: the `data-testid="missing-model-download"` / `"missing-model-download-all"` buttons
// Re-check both whenever the frontend is upgraded. If they are gone, the extension adds nothing.

const EVT_PROGRESS = "meshive_download_progress";
const EVT_COMPLETE = "meshive_download_complete";
const EVT_ERROR = "meshive_download_error";
const ROW_TESTID = "missing-model-download";
const ALL_TESTID = "missing-model-download-all";
const MARK = "data-meshive-pod";

const ko = (() => {
    try {
        const loc = app.extensionManager?.setting?.get?.("Comfy.Locale") || document.documentElement.lang || navigator.language;
        return String(loc).toLowerCase().startsWith("ko");
    } catch { return false; }
})();
// The button text is the same in every locale; the status text follows the locale.
const T = ko
    ? { pod: "Install in Meshive Pod", podAll: "Install all in Meshive Pod", cancel: "취소", done: "Pod에 저장됨", doneTemp: "Pod에 저장됨(임시)", tempNote: "이 모델 폴더는 Pod 스토리지에 없어 시스템 디스크에 저장했습니다. 지금 바로 쓸 수 있지만 Pod 가 재시작되면 사라집니다. 유지하려면 이 폴더를 덮는 볼륨을 연결하세요.", queued: "대기 중", verifying: "검증 중", waiting: "스토리지 확장 대기", failed: "실패 — 다시 시도", exists: "이미 있음" }
    : { pod: "Install in Meshive Pod", podAll: "Install all in Meshive Pod", cancel: "Cancel", done: "Saved in Pod", doneTemp: "Saved in Pod (temporary)", tempNote: "This model folder is not on pod storage, so the file was saved to the system disk. It works now but is lost when the pod restarts. Attach a volume that covers this folder to keep it.", queued: "Queued", verifying: "Verifying", waiting: "Waiting for storage", failed: "Failed — retry", exists: "Already there" };

// key (`directory/name`) -> server state (plus a client-side error message)
const states = new Map();
const keyOf = (directory, name) => `${directory}/${name}`;

function getMissingStore() {
    try {
        const vapp = document.getElementById("vue-app")?.__vue_app__;
        const provides = vapp?._context?.provides;
        if (!provides) return null;
        for (const s of Object.getOwnPropertySymbols(provides)) {
            const v = provides[s];
            if (v && v._s instanceof Map) return v._s.get("missingModel") ?? null;
        }
    } catch { /* the frontend internals changed — add no buttons and stay out of the way */ }
    return null;
}

function candidates() {
    const store = getMissingStore();
    const list = store?.missingModelCandidates ?? [];
    const seen = new Set();
    const out = [];
    for (const c of list) {
        if (!c?.isMissing || !c.url || !c.directory || !c.name) continue;
        const k = keyOf(c.directory, c.name);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(c);
    }
    return out;
}

function toast(severity, summary, detail) {
    try { app.extensionManager.toast.add({ severity, summary, detail, life: 8000 }); }
    catch { console[severity === "error" ? "error" : "log"](`[meshive] ${summary}: ${detail ?? ""}`); }
}

function fmtBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function labelFor(st) {
    if (!st) return null;
    switch (st.status) {
        case "queued": return T.queued;
        case "downloading": {
            const pct = st.total ? `${Math.floor(st.progress)}%` : fmtBytes(st.downloaded);
            return st.speed ? `${pct} · ${fmtBytes(st.speed)}/s` : pct;
        }
        case "verifying": return T.verifying;
        case "waiting_storage": return T.waiting;
        case "complete": return st.temporary ? T.doneTemp : T.done;
        case "exists": return T.exists;
        case "error": return T.failed;
        default: return null;
    }
}

const isActive = (st) => st && ["queued", "downloading", "waiting_storage", "verifying"].includes(st.status);
const isDone = (st) => st && ["complete", "exists"].includes(st.status);
// "Saved" only matters until the Missing list refreshes. If the same model is still missing after
// that, the file is gone (deleted, or the pod moved to fresh storage) — forget it so it can be
// installed again.
const DONE_TTL_MS = 10000;
function freshState(key) {
    const st = states.get(key);
    if (isDone(st) && Date.now() - (st.doneAt ?? 0) > DONE_TTL_MS) { states.delete(key); return undefined; }
    return st;
}

async function startOne(c) {
    const key = keyOf(c.directory, c.name);
    let res;
    try {
        res = await api.fetchApi("/meshive/download/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: c.url, directory: c.directory, filename: c.name, hash: c.hash, hash_type: c.hash_type }),
        });
    } catch (e) {
        states.set(key, { status: "error", error: String(e), filename: c.name, directory: c.directory });
        return render();
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        states.set(key, { status: "error", error: body.error || `HTTP ${res.status}`, filename: c.name, directory: c.directory });
        toast("error", c.name, body.error || `HTTP ${res.status}`);
    } else {
        states.set(key, { ...body, directory: c.directory, filename: c.name, doneAt: Date.now() });
        if (body.status === "exists") await refreshModels();
    }
    render();
}

async function cancelOne(st) {
    if (!st?.id) return;
    await api.fetchApi("/meshive/download/cancel", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: st.id }),
    }).catch(() => {});
}

// Make the new file show up in model dropdowns and drop out of the Missing list right away.
async function refreshModels() {
    try { await app.refreshComboInNodes?.(); } catch (e) { console.warn("[meshive] refreshComboInNodes failed", e); }
    try { await getMissingStore()?.refreshMissingModels?.(); } catch (e) { console.warn("[meshive] refreshMissingModels failed", e); }
    // Node error outlines only clear on the next canvas redraw.
    try { app.canvas?.setDirty?.(true, true); } catch { /* the next redraw will pick it up */ }
}

function onServerEvent(ev) {
    const d = ev.detail;
    if (!d?.filename) return;
    const key = keyOf(d.directory, d.filename);
    const prev = states.get(key);
    if (prev?.id && d.id && prev.id !== d.id) return; // a late event from an earlier attempt
    states.set(key, { ...(prev ?? {}), ...d, doneAt: Date.now() });
    if (ev.type === EVT_ERROR && d.error === "cancelled") states.delete(key);
    if (ev.type === EVT_ERROR && d.error && d.error !== "cancelled") toast("error", d.filename, d.error);
    if (ev.type === EVT_COMPLETE) {
        if (d.temporary) toast("warn", d.filename, T.tempNote);
        refreshModels();
    }
    render();
}

// ── DOM ─────────────────────────────────────────────────────────────────────
function makeButton(native, kind) {
    const b = native.cloneNode(false); // copy the classes only, so it follows the theme
    b.removeAttribute("data-testid");
    b.removeAttribute("aria-label");
    b.setAttribute(MARK, kind);
    b.type = "button";
    // Our text is longer than the built-in one: wrap in a narrow panel instead of clipping or
    // overflowing (the copied classes carry whitespace-nowrap and a fixed height).
    Object.assign(b.style, { whiteSpace: "normal", height: "auto", minHeight: "1.75rem", maxWidth: "100%", textAlign: "center", lineHeight: "1.2", paddingTop: "4px", paddingBottom: "4px" });
    return b;
}

// Write only on change: MutationObserver would otherwise react to our own writes (assigning
// textContent is a childList change even when the value is the same) and loop forever.
function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
}

function rowModelName(nativeBtn) {
    // The name button in the same row has title=<file name>; aria-label depends on the locale.
    const row = nativeBtn.parentElement;
    return row?.querySelector("button[title]")?.title
        || (nativeBtn.getAttribute("aria-label") || "").replace(/^Download\s+/i, "");
}

// The row button goes on its own line under the built-in row. The panel row is only ~200px wide
// by default; in the same row the file name column shrinks to a few pixels and wraps one
// character per line.
function ensureRowButtons() {
    const cands = candidates();
    // When the panel re-renders a row, our line can be left behind — drop lines not under a built-in row.
    for (const line of document.querySelectorAll(`div[${MARK}="row"]`)) {
        if (!line.previousElementSibling?.querySelector?.(`button[data-testid="${ROW_TESTID}"]`)) line.remove();
    }
    for (const native of document.querySelectorAll(`button[data-testid="${ROW_TESTID}"]`)) {
        const row = native.parentElement;
        if (!row?.parentElement) continue;
        const name = rowModelName(native);
        const c = cands.find((x) => x.name === name);
        let line = row.nextElementSibling?.getAttribute?.(MARK) === "row" ? row.nextElementSibling : null;
        if (!c) { line?.remove(); continue; }
        if (!line) {
            line = document.createElement("div");
            line.setAttribute(MARK, "row");
            Object.assign(line.style, { display: "flex", justifyContent: "flex-end", paddingBottom: "2px" });
            const b = makeButton(native, "row-button");
            line.append(b);
            row.after(line);
            b.addEventListener("click", (e) => {
                e.preventDefault(); e.stopPropagation();
                const st = states.get(b.dataset.key);
                const cur = candidates().find((x) => keyOf(x.directory, x.name) === b.dataset.key);
                if (isActive(st)) cancelOne(st); else if (cur) startOne(cur);
            });
        }
        const mine = line.firstElementChild;
        mine.dataset.key = keyOf(c.directory, c.name);
        const st = freshState(mine.dataset.key);
        const label = labelFor(st);
        setText(mine, isActive(st) ? `${label} ✕` : (label ?? T.pod));
        mine.disabled = isDone(st);
        mine.title = st?.error || (isActive(st) ? T.cancel : `${c.directory}/${c.name}`);
    }
}

function ensureAllButton() {
    const native = document.querySelector(`button[data-testid="${ALL_TESTID}"]`);
    const box = native?.parentElement;
    let line = box?.nextElementSibling?.getAttribute?.(MARK) === "all" ? box.nextElementSibling : null;
    // Drop a stale line if the built-in button went away or was re-rendered.
    for (const stale of document.querySelectorAll(`div[${MARK}="all"]`)) if (stale !== line) stale.remove();
    if (!native) return;
    const cands = candidates();
    if (!cands.length) { line?.remove(); return; }
    if (!line) {
        // On the same line as the built-in "Download all" it would clip that button's text in a
        // narrow panel — use a line of its own.
        line = document.createElement("div");
        line.setAttribute(MARK, "all");
        Object.assign(line.style, { display: "flex", justifyContent: "flex-end", paddingTop: "4px" });
        const b = makeButton(native, "all-button");
        line.append(b);
        box.after(line);
        b.addEventListener("click", async (e) => {
            e.preventDefault(); e.stopPropagation();
            for (const c of candidates()) {
                const st = freshState(keyOf(c.directory, c.name));
                if (!isActive(st) && !isDone(st)) startOne(c); // the server runs two at a time and queues the rest
            }
        });
    }
    const mine = line.firstElementChild;
    const pending = cands.filter((c) => !isDone(freshState(keyOf(c.directory, c.name))));
    const active = cands.filter((c) => isActive(states.get(keyOf(c.directory, c.name))));
    setText(mine, active.length ? `${T.podAll} (${active.length}…)` : `${T.podAll} (${pending.length})`);
    mine.disabled = active.length > 0 || pending.length === 0;
}

// Not requestAnimationFrame: it does not run while the tab is hidden, so progress received in the
// background would not reach the buttons and the buttons would not appear at all. This only
// batches DOM changes, so a short timer is enough.
let pending = 0;
function render() {
    if (pending) return;
    pending = setTimeout(() => {
        pending = 0;
        try { ensureRowButtons(); ensureAllButton(); } catch (e) { console.warn("[meshive] inject failed", e); }
    }, 50);
}

app.registerExtension({
    name: "meshive.podDownload",
    async setup() {
        for (const t of [EVT_PROGRESS, EVT_COMPLETE, EVT_ERROR]) api.addEventListener(t, onServerEvent);
        // After a reload, keep showing downloads that are still running.
        try {
            const res = await api.fetchApi("/meshive/download/status");
            // Only running ones — an old "complete" does not mean the file is still there.
            if (res.ok) for (const st of await res.json()) if (isActive(st)) states.set(keyOf(st.directory, st.filename), st);
        } catch { /* the buttons work without it */ }
        new MutationObserver(render).observe(document.body, { childList: true, subtree: true });
        render();
    },
});
