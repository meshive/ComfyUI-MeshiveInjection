import {
    T, SETTING, VERSION, downloads, isActive, isFinished, isLocal, onChange, control, clearFinished,
    refreshAll, startDownload, fmtBytes, setting, setSetting, debugLog, hfState, forgetHfToken,
} from "./meshive_core.js";
import { resetTokenSection } from "./meshive_token.js";

// The downloads panel behind the "Meshive" button in the top bar: every download the pod knows
// about, with pause / resume / cancel / retry, and the extension's settings.

export const HUB_BUTTON_CLASS = "meshive-hub-btn";
const POLL_MS = 3000;
const MAX_ROWS = 60;

let panel = null;
let listEl = null;
let statsEl = null;
let tokenEl = null;
let pollTimer = 0;
let renderTimer = 0;
const rows = new Map(); // download id -> row element
// Requests made from this page, by file, so a failed or cancelled download can be retried from here.
const requests = new Map();
// How a retry is made: the Missing Models side installs through its own function, which also
// refreshes the model lists when the file turns out to be there already.
let installer = startDownload;

export function rememberRequest(c) {
    requests.set(`${c.directory}/${c.name}`, { ...c });
}

export function setInstaller(fn) { installer = fn; }

function el(tag, style = {}, text) {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (text !== undefined) e.textContent = text;
    return e;
}

// Write only on change: rows are refreshed up to ten times a second, and rewriting identical
// text would still churn the DOM (and any MutationObserver watching it).
function setText(e, text) { if (e.textContent !== text) e.textContent = text; }
function setStyle(e, key, value) { if (e.style[key] !== value) e.style[key] = value; }

const COLOR = {
    downloading: "var(--primary-background, #3b82f6)", queued: "var(--warning-background, #d97706)",
    paused: "var(--warning-background, #d97706)", waiting_storage: "var(--warning-background, #d97706)",
    verifying: "var(--primary-background, #3b82f6)", complete: "var(--success-background, #16a34a)",
    exists: "var(--success-background, #16a34a)", error: "var(--destructive-background, #dc2626)",
    cancelled: "var(--muted-foreground, #888)",
};

function button(label, onClick, primary = false) {
    const b = el("button", {
        border: primary ? "none" : "1px solid var(--border-default, #444)", borderRadius: "0.375rem",
        background: primary ? "var(--primary-background, #3b82f6)" : "var(--secondary-background, #333)",
        color: "var(--base-foreground, #eee)", height: "24px", padding: "0 8px", fontSize: "0.6875rem", cursor: "pointer",
    }, label);
    b.type = "button";
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
}

function actionsFor(st) {
    const out = [];
    if (["queued", "downloading", "waiting_storage", "verifying"].includes(st.status)) out.push("pause");
    if (st.status === "paused") out.push("resume");
    if (isActive(st)) out.push("cancel");
    if (["error", "cancelled"].includes(st.status) && requests.has(`${st.directory}/${st.filename}`)) out.push("retry");
    return out;
}

function runAction(action, st) {
    if (action === "retry") return installer(requests.get(`${st.directory}/${st.filename}`));
    return control(action, st);
}

function makeRow(st) {
    const row = el("div", { padding: "8px 10px", borderBottom: "1px solid var(--border-subtle, #333)", display: "flex", flexDirection: "column", gap: "5px" });
    const top = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" });
    const name = el("span", { minWidth: "0", flex: "1", fontSize: "0.8125rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    const badge = el("span", { flexShrink: "0", fontSize: "0.625rem", fontWeight: "600", textTransform: "uppercase", borderRadius: "9999px", padding: "2px 7px" });
    top.append(name, badge);
    const bar = el("div", { width: "100%", height: "4px", borderRadius: "9999px", background: "var(--secondary-background-hover, #444)", overflow: "hidden" });
    const fill = el("div", { height: "100%", width: "0%", borderRadius: "9999px", transition: "width 0.2s" });
    bar.append(fill);
    const info = el("div", { display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "0.6875rem", color: "var(--muted-foreground, #999)" });
    const left = el("span");
    const right = el("span", { textAlign: "right" });
    info.append(left, right);
    const error = el("div", { fontSize: "0.6875rem", color: "var(--destructive-background, #dc2626)", lineHeight: "1.3", wordBreak: "break-word", display: "none" });
    const actions = el("div", { display: "flex", justifyContent: "flex-end", gap: "6px" });
    row.append(top, bar, info, error, actions);
    row._parts = { name, badge, fill, left, right, error, actions };
    row.dataset.meshiveHubRow = st.id;
    return row;
}

function updateRow(row, st) {
    const p = row._parts;
    setText(p.name, st.filename);
    p.name.title = st.path || `${st.directory}/${st.filename}`;
    const color = COLOR[st.status] ?? COLOR.downloading;
    setText(p.badge, T.status[st.status] ?? st.status);
    setStyle(p.badge, "background", `color-mix(in srgb, ${color} 35%, transparent)`);
    const pct = st.total ? Math.max(0, Math.min(100, st.progress || 0)) : (isFinished(st) && st.status !== "error" ? 100 : 0);
    setStyle(p.fill, "width", `${pct}%`);
    setStyle(p.fill, "background", color);

    const bits = [];
    if (st.total) bits.push(`${pct.toFixed(1)}%`);
    if (st.status === "downloading" && st.speed) bits.push(`${fmtBytes(st.speed)}/s`);
    if (st.status === "downloading" && st.connections) bits.push(T.conns(st.connections));
    if (st.status === "queued" && st.queue_position) bits.push(T.queuePos(st.queue_position));
    if (st.temporary) bits.push(T.temporary);
    setText(p.left, bits.join(" · "));
    setText(p.right, st.total ? `${fmtBytes(st.downloaded)} / ${fmtBytes(st.total)}` : (st.downloaded ? fmtBytes(st.downloaded) : ""));
    setText(p.error, st.status === "error" ? (st.error || "") : "");
    setStyle(p.error, "display", st.status === "error" && st.error ? "block" : "none");

    // Rebuild the buttons only when the set of actions changes, so a click is never lost to a re-render.
    const acts = actionsFor(st);
    if (row.dataset.actions !== acts.join()) {
        row.dataset.actions = acts.join();
        p.actions.replaceChildren(...acts.map((a) => button(T[a], () => runAction(a, downloads.get(st.id) ?? st), a === "resume" || a === "retry")));
        setStyle(p.actions, "display", acts.length ? "flex" : "none");
    }
}

const ORDER = { downloading: 0, waiting_storage: 0, verifying: 0, queued: 1, paused: 2, error: 3, cancelled: 4, complete: 5, exists: 5 };

function renderToken() {
    const st = hfState();
    const src = st.hasPageToken ? "page" : st.envToken ? "env" : "none";
    const [text, forget] = tokenEl.children;
    setText(text, T.hfSource(src, st.name));
    setStyle(forget, "display", st.hasPageToken ? "inline-block" : "none");
}

function render() {
    renderTimer = 0;
    if (!panel) return;
    renderToken();
    const list = [...downloads.values()].filter((d) => !isLocal(d));
    list.sort((a, b) => (ORDER[a.status] ?? 6) - (ORDER[b.status] ?? 6)
        || (a.status === "queued" ? (a.queue_position || 0) - (b.queue_position || 0) : b.seq - a.seq));
    setText(statsEl, T.stats(list.filter(isActive).length, list.length));

    const shown = list.slice(0, MAX_ROWS);
    const keep = new Set(shown.map((d) => d.id));
    for (const [id, row] of rows) if (!keep.has(id)) { row.remove(); rows.delete(id); }
    let prev = null;
    for (const st of shown) {
        let row = rows.get(st.id);
        if (!row) { row = makeRow(st); rows.set(st.id, row); }
        updateRow(row, st);
        const expected = prev ? prev.nextSibling : listEl.firstChild;
        if (expected !== row) listEl.insertBefore(row, expected);
        prev = row;
    }
    let empty = listEl.querySelector("[data-meshive-empty]");
    if (!shown.length && !empty) {
        empty = el("div", { padding: "18px 12px", fontSize: "0.75rem", color: "var(--muted-foreground, #999)", textAlign: "center", whiteSpace: "pre-line" }, T.empty);
        empty.dataset.meshiveEmpty = "1";
        listEl.append(empty);
    } else if (shown.length && empty) empty.remove();
}

function scheduleRender() {
    if (panel && !renderTimer) renderTimer = setTimeout(render, 100);
}

function position() {
    if (!panel) return;
    const margin = 12;
    const width = panel.offsetWidth || 380;
    let left = window.innerWidth - width - margin;
    let top = 56;
    const btn = document.querySelector(`.${HUB_BUTTON_CLASS}`);
    if (btn) {
        const r = btn.getBoundingClientRect();
        left = Math.min(Math.max(margin, r.right - width), window.innerWidth - width - margin);
        top = r.bottom + 8;
    }
    panel.style.left = `${Math.max(margin, left)}px`;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(240, window.innerHeight - top - margin)}px`;
}

function settingRow(id, label, tip, fallback = false) {
    const row = el("label", { display: "flex", alignItems: "flex-start", gap: "8px", cursor: "pointer" });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!setting(id, fallback);
    cb.style.marginTop = "2px";
    cb.addEventListener("change", async () => {
        try { await setSetting(id, cb.checked); } catch (e) { cb.checked = !cb.checked; console.warn("[meshive] setting failed", e); }
    });
    const text = el("div", { display: "flex", flexDirection: "column", gap: "2px" });
    text.append(el("span", { fontSize: "0.75rem" }, label), el("span", { fontSize: "0.6875rem", color: "var(--muted-foreground, #999)", lineHeight: "1.3" }, tip));
    row.append(cb, text);
    return row;
}

function onKey(e) { if (e.key === "Escape") closeHub(); }
function onPointer(e) {
    if (!panel || panel.contains(e.target) || document.querySelector(`.${HUB_BUTTON_CLASS}`)?.contains(e.target)) return;
    closeHub();
}

export function closeHub() {
    if (!panel) return;
    clearInterval(pollTimer);
    clearTimeout(renderTimer);
    pollTimer = renderTimer = 0;
    panel.remove();
    panel = listEl = statsEl = tokenEl = null;
    rows.clear();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("resize", position);
    markButton(false);
}

// Shows the top-bar button as pressed while the panel is open. Inline: the frontend's own utility
// classes live in a CSS layer whose !important rules would beat a stylesheet of ours.
function markButton(open) {
    const btn = document.querySelector(`.${HUB_BUTTON_CLASS}`);
    if (open) btn?.style.setProperty("background", "var(--secondary-background-hover, rgba(127,127,127,0.25))", "important");
    else btn?.style.removeProperty("background");
}

export function openHub(info) {
    if (panel) return;
    panel = el("div", {
        position: "fixed", zIndex: "1100", width: "380px", maxWidth: "calc(100vw - 24px)", display: "flex", flexDirection: "column",
        borderRadius: "0.7rem", border: "1px solid var(--border-default, #444)", background: "var(--base-background, #1e1e1e)",
        color: "var(--base-foreground, #eee)", boxShadow: "0 12px 30px rgba(0,0,0,0.38)", overflow: "hidden",
    });
    panel.dataset.meshiveHub = "1";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", T.hubTitle);

    const header = el("div", { padding: "10px 12px", borderBottom: "1px solid var(--border-default, #444)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" });
    const title = el("div", { display: "flex", flexDirection: "column" });
    title.append(el("span", { fontSize: "0.875rem", fontWeight: "600" }, T.hubTitle),
        el("span", { fontSize: "0.6875rem", color: "var(--muted-foreground, #999)" }, `v${VERSION}${info?.host ? ` · ${T.podWord} ${info.host}` : ""}`));
    const x = button("×", closeHub);
    x.setAttribute("aria-label", T.close);
    Object.assign(x.style, { border: "none", background: "transparent", fontSize: "1rem" });
    header.append(title, x);

    const body = el("div", { padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px", minHeight: "0", overflow: "hidden" });
    const card = el("div", { border: "1px solid var(--border-subtle, #333)", borderRadius: "0.5rem", background: "var(--secondary-background, #262626)", display: "flex", flexDirection: "column", minHeight: "0", overflow: "hidden" });
    const cardHead = el("div", { padding: "8px 10px", display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-subtle, #333)", fontSize: "0.75rem" });
    statsEl = el("span", { color: "var(--muted-foreground, #999)", fontSize: "0.6875rem" });
    cardHead.append(el("span", { fontWeight: "600" }, T.hubTitle), statsEl);
    listEl = el("div", { overflowY: "auto", minHeight: "60px", maxHeight: "340px" });
    card.append(cardHead, listEl);

    const settings = document.createElement("details");
    Object.assign(settings.style, { border: "1px solid var(--border-subtle, #333)", borderRadius: "0.5rem", background: "var(--secondary-background, #262626)", padding: "6px 8px" });
    const summary = el("summary", { cursor: "pointer", fontSize: "0.75rem", fontWeight: "600" }, T.settings);
    const settingsBody = el("div", { display: "flex", flexDirection: "column", gap: "6px", paddingTop: "6px" });
    settingsBody.append(
        settingRow(SETTING.autoCheck, T.autoCheck, T.autoCheckTip, true),
        settingRow(SETTING.guard, T.guard, T.guardTip),
        settingRow(SETTING.strictHash, T.strictHash, T.strictHashTip),
        settingRow(SETTING.verbose, T.verbose, T.verboseTip),
    );
    tokenEl = el("div", { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px", fontSize: "0.6875rem", color: "var(--muted-foreground, #999)" });
    tokenEl.append(el("span"), button(T.hfForget, () => { forgetHfToken(); resetTokenSection(); }));
    settingsBody.append(tokenEl);
    settings.append(summary, settingsBody);

    const footer = el("div", { display: "flex", justifyContent: "flex-end", gap: "8px" });
    footer.append(button(T.clear, () => clearFinished()), button(T.refresh, () => refreshAll()), button(T.close, closeHub, true));
    body.append(card, settings, footer);
    panel.append(header, body);
    document.body.append(panel);

    markButton(true);
    position();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", position);
    render();
    refreshAll();
    pollTimer = setInterval(() => refreshAll(), POLL_MS);
    debugLog("hub opened");
}

export function toggleHub(info) {
    if (panel) closeHub(); else openHub(info);
}

onChange(scheduleRender);
