import { T, hfState, hfVerify, debugLog } from "./meshive_core.js";

// The Hugging Face token section in the Missing Models panel. It appears when a missing model is a
// gated Hugging Face model (the frontend marks those rows) or failed for want of a token. A token
// typed here is checked by the pod (who it belongs to, and which of these files it can fetch) and
// then sent with each Hugging Face download from this page. It is not stored anywhere.

const MARK = "data-meshive-pod";
const TOKEN_RE = /^hf_[A-Za-z0-9]{8,200}$/;
const COLOR = {
    ok: "var(--success-background, #16a34a)", warn: "var(--warning-background, #d97706)",
    error: "var(--destructive-background, #dc2626)", muted: "var(--muted-foreground, #999)",
};

let result = null;        // the last verification: {valid, name, source, access, code, error}
let checkedFor = "";      // the files the last check covered
let busy = false;
let gen = 0;              // checks started; an answer to an older one is dropped

const section = () => document.querySelector(`div[${MARK}="hf-token"]`);
const filesOf = (gated) => gated.map((g) => g.url).sort().join("\n");

function el(tag, style = {}, text) {
    const e = document.createElement(tag);
    Object.assign(e.style, style);
    if (text !== undefined) e.textContent = text;
    return e;
}

function setText(e, text) { if (e.textContent !== text) e.textContent = text; }
function show(e, on, display = "block") { const v = on ? display : "none"; if (e.style.display !== v) e.style.display = v; }

function build() {
    const sec = el("div", { marginTop: "6px", borderRadius: "0.5rem", background: "var(--secondary-background, #262626)", overflow: "hidden", fontSize: "0.75rem" });
    sec.setAttribute(MARK, "hf-token");
    const head = el("div", { padding: "6px 10px", display: "flex", justifyContent: "space-between", gap: "8px" });
    const count = el("span", { color: COLOR.muted });
    head.append(el("span", { fontWeight: "600" }, T.hfTitle), count);

    const body = el("div", { padding: "0 10px 8px", display: "flex", flexDirection: "column", gap: "6px" });
    const inputRow = el("div", { display: "flex", gap: "6px", alignItems: "center" });
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "hf_...";
    input.autocomplete = "off";
    input.spellcheck = false;
    Object.assign(input.style, {
        flex: "1", minWidth: "0", height: "28px", padding: "0 8px", fontFamily: "monospace", fontSize: "0.75rem",
        borderRadius: "0.375rem", border: "1px solid var(--border-default, #444)", background: "var(--base-background, #1e1e1e)", color: "var(--base-foreground, #eee)",
    });
    const verify = el("button", {
        height: "28px", padding: "0 10px", border: "none", borderRadius: "0.375rem", cursor: "pointer", flexShrink: "0",
        background: "var(--primary-background, #3b82f6)", color: "var(--base-foreground, #eee)", fontSize: "0.75rem",
    }, T.hfVerify);
    verify.type = "button";
    inputRow.append(input, verify);
    const status = el("div", { lineHeight: "1.4", display: "none", overflowWrap: "anywhere" });
    const terms = el("div", { display: "none", flexDirection: "column", gap: "4px" });
    const note = el("div", { color: COLOR.muted, fontSize: "0.6875rem", lineHeight: "1.3" }, T.hfNote);
    body.append(inputRow, status, terms, note);
    sec.append(head, body);
    sec._parts = { count, inputRow, input, verify, status, terms };

    // Keep panel shortcuts (and the canvas) from seeing what is typed into the token field.
    for (const type of ["keydown", "keyup", "keypress"]) input.addEventListener(type, (e) => e.stopPropagation());
    const go = (e) => { e.preventDefault(); e.stopPropagation(); if (!busy) run(input.value.trim()); };
    verify.addEventListener("click", go);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(e); });
    return sec;
}

// Check `typed`, or with nothing typed, the token already in use (this page's, else the pod's).
async function run(typed) {
    const sec = section();
    if (!sec) return;
    const st = hfState();
    if ((typed && !TOKEN_RE.test(typed)) || (!typed && !st.hasPageToken && !st.envToken)) {
        result = { valid: false, code: "format" };
        update(sec);
        return;
    }
    const mine = ++gen;
    const gated = sec._gated ?? [];
    busy = true;
    update(sec);
    let r;
    try { r = await hfVerify(typed, gated.map((g) => g.url)); }
    catch (e) { r = { valid: false, code: "unreachable", error: String(e) }; }
    if (mine !== gen) return;
    busy = false;
    result = r;
    checkedFor = filesOf(gated);
    const now = section(); // the panel may have re-rendered while the pod was checking
    if (now && r.valid && typed) now._parts.input.value = "";
    debugLog("hf verify", r.valid, r.source, r.name);
    if (now) update(now);
}

function reasonText(reason) {
    if (reason === "terms") return T.hfAcceptTerms;
    if (reason === "not_found") return T.hfNotFound;
    if (reason === "denied") return T.hfDenied;
    return T.hfUnreachable;
}

function update(sec) {
    const p = sec._parts;
    const gated = sec._gated ?? [];
    const st = hfState();
    setText(p.count, T.hfGated(gated.length));
    setText(p.verify, busy ? T.hfVerifying : T.hfVerify);
    p.verify.disabled = busy;

    let text = "", color = COLOR.muted, denied = [], unchecked = [];
    if (busy && !p.input.value && st.envToken && !st.hasPageToken) text = T.hfEnvChecking;
    else if (result && !result.valid) {
        text = result.source === "env" && result.code === "rejected" ? T.hfEnvInvalid : (T.hfErr[result.code] ?? result.error ?? "");
        color = COLOR.error;
    } else if (result?.valid) {
        denied = gated.filter((g) => result.access?.[g.url] && !result.access[g.url].accessible);
        // Files the last check did not cover (the list grew since) are not known to work yet.
        unchecked = gated.filter((g) => !result.access?.[g.url]);
        text = denied.length ? T.hfNeedsTerms(result.name, denied.length) : T.hfOk(result.name, result.source);
        color = denied.length ? COLOR.warn : COLOR.ok;
    }
    setText(p.status, text);
    if (p.status.style.color !== color) p.status.style.color = color;
    show(p.status, !!text);

    // The input stays available unless a token already works for every one of these files.
    const allGood = result?.valid && !denied.length && !unchecked.length;
    show(p.inputRow, !allGood, "flex");

    const sig = denied.map((g) => g.url).join("\n");
    if (p.terms.dataset.sig !== sig) {
        p.terms.dataset.sig = sig;
        p.terms.replaceChildren(...denied.map((g) => {
            const row = el("div", { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" });
            const a = result.access[g.url];
            const link = el("a", { color: "var(--primary-background, #3b82f6)", flexShrink: "0" }, reasonText(a.reason));
            if (a.repo) { link.href = a.repo; link.target = "_blank"; link.rel = "noopener noreferrer"; }
            row.append(el("span", { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0" }, g.name), link);
            return row;
        }));
    }
    show(p.terms, denied.length > 0, "flex");
}

// `gated`: the missing Hugging Face models ({name, directory, url}) that need a token.
export function ensureTokenSection(anchor, gated) {
    let sec = section();
    if (!anchor || !gated.length) { sec?.remove(); return; }
    if (!sec || sec.previousElementSibling !== anchor) {
        const typed = sec?._parts.input.value ?? "";
        sec?.remove();
        sec = build();
        sec._parts.input.value = typed; // the panel re-rendered under us: keep what was typed
        anchor.after(sec);
    }
    sec._gated = gated;
    update(sec);

    // A token is already in use (this page's, or the pod's) but has not been checked against these
    // files: check it, once per set of files.
    const st = hfState();
    if ((st.hasPageToken || st.envToken) && !busy && checkedFor !== filesOf(gated)) {
        checkedFor = filesOf(gated);
        run("");
    }
}

// Forget the verification shown (the page's token was forgotten).
export function resetTokenSection() {
    result = null;
    checkedFor = "";
    gen++;
    busy = false;
    const sec = section();
    if (sec) update(sec);
}
