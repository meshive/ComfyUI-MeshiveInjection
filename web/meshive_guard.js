import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { T, SETTING, setting, debugLog } from "./meshive_core.js";
import { workflowModels } from "./meshive_detect.js";
import { BRAND_ATTR } from "./meshive_hub.js";

// The check before a run (off by default): when a workflow is queued, the pod first confirms that
// every model it uses is there — optionally down to the checksum — and if not, the run is held with
// a list of what is missing, a button to install it in the pod, and one to queue anyway.

const OVERLAY = "data-meshive-guard";
const REPORT_TTL_MS = 10000;

let installed = false;
let bypassOnce = false;
let checking = false;
let cache = null; // {sig, at, report}

export function invalidateGuardCache() { cache = null; }

function el(tag, style = {}, text) {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (text !== undefined) e.textContent = text;
    return e;
}

async function check(categoryFor) {
    const graph = app.rootGraph ?? app.graph;
    if (!graph) return null;
    const models = await workflowModels(graph, graph.serialize?.(), categoryFor);
    if (!models.length) return null;
    const strict = !!setting(SETTING.strictHash, false);
    const sig = JSON.stringify([strict, models.map((m) => [m.filename, m.directory, m.hint, m.hash]).sort()]);
    if (cache && cache.sig === sig && Date.now() - cache.at < REPORT_TTL_MS) return cache.report;
    const res = await api.fetchApi("/meshive/models/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: models.slice(0, 512), verify_hashes: strict }),
    });
    if (!res.ok) return null;
    const report = await res.json();
    const byName = new Map(models.map((m) => [m.filename.replace(/\\/g, "/"), m]));
    for (const m of [...report.missing, ...report.unresolved]) {
        const src = byName.get(m.filename);
        if (src) Object.assign(m, { url: m.url || src.url, hash: m.hash ?? src.hash, hash_type: m.hash_type ?? src.hash_type });
    }
    cache = { sig, at: Date.now(), report };
    debugLog("check before queueing", report.missing.length, "missing,", report.unresolved.length, "unresolved");
    return report;
}

export function closeGuard() {
    document.querySelector(`div[${OVERLAY}]`)?.remove();
    document.removeEventListener("keydown", onKey, true);
}

function onKey(e) {
    if (e.key === "Escape") { e.stopPropagation(); closeGuard(); }
}

function button(label, onClick, background) {
    const b = el("button", {
        height: "32px", padding: "0 12px", borderRadius: "0.5rem", cursor: "pointer", fontSize: "0.75rem", fontWeight: "600",
        border: background ? "none" : "1px solid var(--border-default, #444)", background: background ?? "var(--secondary-background, #333)",
        color: "var(--base-foreground, #eee)",
    }, label);
    b.type = "button";
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
}

function showReport(report, { queueAnyway, install }) {
    closeGuard();
    const overlay = el("div", { position: "fixed", inset: "0", zIndex: "2000", background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" });
    overlay.setAttribute(OVERLAY, "1");
    overlay.addEventListener("click", closeGuard);
    const box = el("div", { width: "100%", maxWidth: "560px", borderRadius: "0.75rem", border: "1px solid var(--border-default, #444)", background: "var(--base-background, #1e1e1e)", color: "var(--base-foreground, #eee)", overflow: "hidden", boxShadow: "0 20px 40px rgba(0,0,0,0.35)" });
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", T.guardTitle);
    box.addEventListener("click", (e) => e.stopPropagation());

    const missing = report.missing ?? [];
    const unresolved = report.unresolved ?? [];
    const items = missing.length ? missing : unresolved;
    const list = el("div", { maxHeight: "260px", overflowY: "auto", borderRadius: "0.5rem", background: "var(--secondary-background, #262626)", border: "1px solid var(--border-subtle, #333)" });
    for (const m of items.slice(0, 40)) {
        const row = el("div", { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "8px 10px", borderBottom: "1px solid var(--border-subtle, #333)", fontSize: "0.8125rem" });
        row.append(el("span", { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, m.filename),
            el("span", { flexShrink: "0", fontSize: "0.6875rem", color: "var(--muted-foreground, #999)" },
                `${m.directory ?? "?"} · ${T.guardReason[m.reason] ?? m.reason}`));
        list.append(row);
    }
    if (items.length > 40) list.append(el("div", { padding: "8px 10px", fontSize: "0.75rem", color: "var(--muted-foreground, #999)" }, `+ ${items.length - 40}`));

    const body = el("div", { padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" });
    body.append(el("div", { fontSize: "0.8125rem", color: "var(--muted-foreground, #999)", lineHeight: "1.45" }, T.guardText), list);
    if (missing.length && unresolved.length) {
        body.append(el("div", { fontSize: "0.75rem", color: "var(--warning-background, #d97706)" }, T.guardUnresolved(unresolved.length)));
    }

    const installable = missing.filter((m) => m.url && m.directory);
    const footer = el("div", { padding: "12px 16px", borderTop: "1px solid var(--border-default, #444)", display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" });
    footer.append(button(T.cancel, closeGuard));
    if (installable.length) {
        const b = button(T.guardInstall(installable.length), () => { closeGuard(); install(installable); }, "transparent");
        // Colored by the branding stylesheet, like the install buttons in the Missing Models panel.
        b.style.removeProperty("background");
        b.style.removeProperty("color");
        b.setAttribute(BRAND_ATTR, "");
        footer.append(b);
    }
    footer.append(button(T.guardAnyway, () => { closeGuard(); queueAnyway(); }, "var(--warning-background, #d97706)"));

    box.append(el("div", { padding: "14px 16px", borderBottom: "1px solid var(--border-default, #444)", fontSize: "1rem", fontWeight: "600" }, T.guardTitle), body, footer);
    overlay.append(box);
    document.body.append(overlay);
    document.addEventListener("keydown", onKey, true);
}

// Put the check in front of app.queuePrompt, once. It stays there and reads the setting on every
// run: taking it out again could break the chain when another extension wrapped queuePrompt after us.
// `install(models)` starts installing [{filename, directory, url, hash?}].
export function syncGuard(categoryFor, install) {
    if (!setting(SETTING.guard, false)) { closeGuard(); return; }
    if (installed || typeof app.queuePrompt !== "function") return;
    installed = true;
    const inner = app.queuePrompt;
    app.queuePrompt = async function (...args) {
        if (!setting(SETTING.guard, false)) return inner.apply(this, args);
        if (bypassOnce) {
            bypassOnce = false;
            return inner.apply(this, args);
        }
        // Run pressed again while a check or its window is up: the first press is being handled.
        if (checking || document.querySelector(`div[${OVERLAY}]`)) return false;
        checking = true;
        try {
            // Only a model that is missing (or fails its checksum) holds the run; one whose folder
            // cannot be told is left to ComfyUI.
            const report = await check(categoryFor);
            if (report?.missing?.length) {
                showReport(report, {
                    queueAnyway: () => { bypassOnce = true; return app.queuePrompt(...args); },
                    install,
                });
                return false;
            }
        } catch (e) {
            console.warn("[meshive] check before queueing failed; queueing anyway", e);
        } finally {
            checking = false;
        }
        return inner.apply(this, args);
    };
}
