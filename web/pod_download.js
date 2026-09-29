import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    T, EVT, SETTING, keyOf, isActive, isRunning, isDone, current, latestFor, upsert, startDownload,
    control, refreshAll, refreshModels, checkVersion, toast, fmtBytes, debugLog, onChange, onReset, seqMark,
    isHfUrl, hfEnvStatus,
} from "./meshive_core.js";
import { HUB_BUTTON_CLASS, toggleHub, rememberRequest, setInstaller } from "./meshive_hub.js";
import { ensureTokenSection } from "./meshive_token.js";

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

const ROW_TESTID = "missing-model-download";
const ALL_TESTID = "missing-model-download-all";
// The frontend's own mark on a gated Hugging Face model's row (a link to the repository).
const GATED_TESTID = "missing-model-gated-access";
const MARK = "data-meshive-pod";

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

function labelFor(st) {
    if (!st) return null;
    switch (st.status) {
        case "queued": return T.queued;
        case "paused": return st.total ? `${T.paused} · ${Math.floor(st.progress)}%` : T.paused;
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

async function install(c) {
    rememberRequest(c);
    const st = await startDownload(c);
    if (st?.status === "exists") await refreshModels(getMissingStore);
    return st;
}

// ── "Install all" batch and its progress area ───────────────────────────────
// The batch follows the latest attempt for each file made since it started — so a retry from the
// file's own button or the downloads panel counts too — and remembers the last state it saw, so a
// "Clear finished" does not turn a finished file back into a pending one.
let batch = null; // {since, entries: Map key -> {request, floor, last}}

async function startBatch(list) {
    if (!list.length) return;
    const since = seqMark();
    batch = { since, entries: new Map(list.map((c) => [keyOf(c.directory, c.name), { request: c, floor: since, last: null }])) };
    const mine = batch;
    render();
    await Promise.all(list.map(async (c) => {
        const st = await install(c);
        // The server may hand back a download that was already running (started elsewhere).
        const entry = mine.entries.get(keyOf(c.directory, c.name));
        if (st && typeof st.seq === "number" && st.seq <= entry.floor) entry.floor = st.seq - 0.25;
    }));
    settleBatch(); // everything may have been there already: no download, so no event to settle it
    render();
}

function stateOf(entry) {
    const latest = latestFor(entry.request.directory, entry.request.name);
    if (latest && latest.seq > entry.floor) entry.last = latest;
    return entry.last;
}

function batchSummary() {
    const s = { ok: 0, failed: 0, cancelled: 0, pending: 0, total: 0 };
    for (const entry of batch.entries.values()) {
        const st = stateOf(entry);
        s.total++;
        if (isDone(st)) s.ok++;
        else if (st?.status === "error") s.failed++;
        else if (st?.status === "cancelled") s.cancelled++;
        else s.pending++;
    }
    return s;
}

function retryList() {
    return [...batch.entries.values()].filter((e) => ["error", "cancelled"].includes(stateOf(e)?.status)).map((e) => e.request);
}

// The batch finished with everything in place: say so once and drop it. (The models are loaded
// already, so there is no "refresh the page" step.)
function settleBatch() {
    if (!batch) return;
    const s = batchSummary();
    if (s.pending || s.failed || s.cancelled) return;
    toast("success", "Meshive", T.batchDone(s.ok));
    batch = null;
}

// What an item in the progress area says. Unlike the file's own button it is not clickable, so no
// "retry" in the text; the retry button sits under the list.
function areaLabel(st) {
    if (!st) return T.queued;
    if (st.status === "error" || st.status === "cancelled") return T.status[st.status];
    return labelFor(st) ?? T.queued;
}

function el(tag, style, text) {
    const e = document.createElement(tag);
    Object.assign(e.style, style ?? {});
    if (text !== undefined) e.textContent = text;
    return e;
}

function ensureProgressArea(allLine) {
    let area = document.querySelector(`div[${MARK}="progress"]`);
    if (!batch || !allLine) { area?.remove(); return; }
    if (!area || area.previousElementSibling !== allLine) {
        area?.remove();
        area = el("div", { marginTop: "6px", borderRadius: "0.5rem", background: "var(--secondary-background, #262626)", overflow: "hidden", fontSize: "0.75rem" });
        area.setAttribute(MARK, "progress");
        const head = el("div", { padding: "6px 10px", display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: "2px 10px", borderBottom: "1px solid var(--border-default, #444)" });
        head.append(el("span", { fontWeight: "600" }, T.progressTitle), el("span", { color: "var(--muted-foreground, #999)" }));
        const items = el("div");
        const foot = el("div", { padding: "6px 10px", display: "none", justifyContent: "flex-end" });
        area.append(head, items, foot);
        allLine.after(area);
    }
    const [head, items, foot] = area.children;
    const s = batchSummary();
    setText(head.lastChild, T.batch(s));
    head.lastChild.style.color = s.failed ? "var(--destructive-background, #dc2626)" : "var(--muted-foreground, #999)";

    for (const child of [...items.children]) if (!batch.entries.has(child.dataset.key)) child.remove();
    for (const [key, entry] of batch.entries) {
        const { request } = entry;
        const st = stateOf(entry);
        let item = [...items.children].find((c) => c.dataset.key === key);
        if (!item) {
            item = el("div", { padding: "6px 10px" });
            item.dataset.key = key;
            const top = el("div", { display: "flex", justifyContent: "space-between", gap: "8px" });
            top.append(el("span", { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0" }, request.name),
                el("span", { flexShrink: "0", color: "var(--muted-foreground, #999)" }));
            const bar = el("div", { height: "4px", borderRadius: "9999px", background: "var(--secondary-background-hover, #444)", overflow: "hidden", margin: "4px 0" });
            bar.append(el("div", { height: "100%", width: "0%", borderRadius: "9999px", transition: "width 0.2s" }));
            const err = el("div", { color: "var(--destructive-background, #dc2626)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", display: "none" });
            item.append(top, bar, err);
            items.append(item);
        }
        const [top, bar, err] = item.children;
        const pct = st?.total ? Math.max(0, Math.min(100, st.progress || 0)) : (isDone(st) ? 100 : 0);
        setText(top.lastChild, areaLabel(st));
        const fill = bar.firstChild;
        if (fill.style.width !== `${pct}%`) fill.style.width = `${pct}%`;
        fill.style.background = st?.status === "error" ? "var(--destructive-background, #dc2626)"
            : isDone(st) ? "var(--success-background, #16a34a)" : "var(--primary-background, #3b82f6)";
        setText(err, st?.status === "error" ? (st.error || "") : "");
        err.style.display = st?.status === "error" && st.error ? "block" : "none";
    }

    const retry = s.pending ? [] : retryList();
    foot.style.display = retry.length ? "flex" : "none";
    const label = retry.length ? (s.cancelled ? T.retryUnfinished(retry.length) : T.retryFailed(retry.length)) : "";
    if (foot.dataset.label !== label) {
        foot.dataset.label = label;
        foot.replaceChildren();
        if (retry.length) {
            const native = document.querySelector(`button[data-testid="${ALL_TESTID}"]`);
            const b = native ? makeButton(native, "retry") : el("button", {}, "");
            b.textContent = label;
            b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); startBatch(retryList()); });
            foot.append(b);
        }
    }
}

// ── Buttons in the Missing Models panel ─────────────────────────────────────
function makeButton(native, kind) {
    const b = native.cloneNode(false); // copy the classes only, so it follows the theme
    b.removeAttribute("data-testid");
    b.removeAttribute("aria-label");
    b.setAttribute(MARK, kind);
    b.type = "button";
    b.disabled = false;
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
                const cur = candidates().find((x) => keyOf(x.directory, x.name) === b.dataset.key);
                if (!cur) return;
                const st = current(cur.directory, cur.name);
                if (st?.status === "paused") control("resume", st);
                else if (isActive(st)) control("cancel", st);
                else install(cur);
            });
        }
        const mine = line.firstElementChild;
        mine.dataset.key = keyOf(c.directory, c.name);
        const st = current(c.directory, c.name);
        const label = labelFor(st);
        const paused = st?.status === "paused";
        setText(mine, paused ? `${label} ▶` : isActive(st) ? `${label} ✕` : (label ?? T.pod));
        mine.disabled = isDone(st);
        mine.title = st?.error || (paused ? T.resume : isActive(st) ? T.cancel : `${c.directory}/${c.name}`);
    }
}

// Missing Hugging Face models that need a token: gated by the frontend's mark, or refused for want of one.
function gatedCandidates(cands) {
    const out = [];
    for (const native of document.querySelectorAll(`button[data-testid="${ROW_TESTID}"]`)) {
        if (!native.parentElement?.querySelector(`[data-testid="${GATED_TESTID}"]`)) continue;
        const c = cands.find((x) => x.name === rowModelName(native));
        if (c && isHfUrl(c.url) && !out.includes(c)) out.push(c);
    }
    for (const c of cands) {
        if (!out.includes(c) && isHfUrl(c.url) && current(c.directory, c.name)?.error_code === "hf_auth") out.push(c);
    }
    return out;
}

function ensureAllButton() {
    const native = document.querySelector(`button[data-testid="${ALL_TESTID}"]`);
    const box = native?.parentElement;
    let line = box?.nextElementSibling?.getAttribute?.(MARK) === "all" ? box.nextElementSibling : null;
    // Drop a stale line if the built-in button went away or was re-rendered.
    for (const stale of document.querySelectorAll(`div[${MARK}="all"]`)) if (stale !== line) stale.remove();
    if (!native) { ensureProgressArea(null); ensureTokenSection(null, []); return; }
    const cands = candidates();
    // None of the batch's models is missing any more (installed, or another workflow was loaded):
    // the progress area has nothing left to show. The downloads panel still lists them.
    if (batch && ![...batch.entries.keys()].some((k) => cands.some((c) => keyOf(c.directory, c.name) === k))) batch = null;
    if (!cands.length) { line?.remove(); ensureProgressArea(null); ensureTokenSection(null, []); return; }
    if (!line) {
        // On the same line as the built-in "Download all" it would clip that button's text in a
        // narrow panel — use a line of its own.
        line = document.createElement("div");
        line.setAttribute(MARK, "all");
        Object.assign(line.style, { display: "flex", justifyContent: "flex-end", paddingTop: "4px" });
        const b = makeButton(native, "all-button");
        line.append(b);
        box.after(line);
        b.addEventListener("click", (e) => {
            e.preventDefault(); e.stopPropagation();
            // The server runs one download at a time and queues the rest.
            startBatch(candidates().filter((c) => { const st = current(c.directory, c.name); return !isActive(st) && !isDone(st); }));
        });
    }
    const mine = line.firstElementChild;
    // A paused download does not hold up the others: it is resumed from its own row.
    const pending = cands.filter((c) => { const st = current(c.directory, c.name); return !isDone(st) && !isActive(st); });
    const active = cands.filter((c) => isRunning(current(c.directory, c.name)));
    setText(mine, active.length ? `${T.podAll} (${active.length}…)` : `${T.podAll} (${pending.length})`);
    mine.disabled = active.length > 0 || pending.length === 0;
    ensureProgressArea(line);
    const area = line.nextElementSibling?.getAttribute?.(MARK) === "progress" ? line.nextElementSibling : line;
    ensureTokenSection(area, gatedCandidates(cands));
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

function onServerEvent(ev) {
    const d = ev.detail;
    if (!d?.id) return;
    debugLog(ev.type, d.filename, d.status, d.error ?? "");
    upsert(d);
    if (ev.type === EVT.error && d.error && d.error !== "cancelled") toast("error", d.filename, d.error);
    if (ev.type === EVT.complete) {
        if (d.temporary) toast("warn", d.filename, T.tempNote);
        refreshModels(getMissingStore);
    }
    if (ev.type === EVT.complete || ev.type === EVT.error) settleBatch();
}

let serverInfo = null;

app.registerExtension({
    name: "meshive.podDownload",
    settings: [
        {
            id: SETTING.verbose,
            category: ["Meshive", "Downloads", "Verbose logs"],
            name: "Verbose logs",
            tooltip: "Log download events in detail to the browser console.",
            type: "boolean",
            defaultValue: false,
        },
    ],
    actionBarButtons: [
        {
            icon: "icon-[lucide--cloud-download]",
            label: T.hub,
            tooltip: T.hubTip,
            class: HUB_BUTTON_CLASS,
            onClick: () => toggleHub(serverInfo),
        },
    ],
    async setup() {
        for (const t of Object.values(EVT)) api.addEventListener(t, onServerEvent);
        // After a lost connection (ComfyUI restarted, say) the events in between are gone: ask again.
        api.addEventListener("reconnected", () => refreshAll());
        onChange(render);
        onReset(() => { batch = null; });
        setInstaller(install);
        serverInfo = await checkVersion();
        await hfEnvStatus();
        // After a reload, pick up what the server is doing (and did) since it started.
        await refreshAll(true);
        new MutationObserver(render).observe(document.body, { childList: true, subtree: true });
        render();
    },
});
