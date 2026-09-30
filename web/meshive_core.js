import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Shared by the Missing Models buttons (pod_download.js) and the downloads panel (meshive_hub.js):
// server calls, the download states the server reports, texts and small helpers.

export const VERSION = "1.4.1";

export const EVT = {
    progress: "meshive_download_progress",
    paused: "meshive_download_paused",
    resumed: "meshive_download_resumed",
    complete: "meshive_download_complete",
    error: "meshive_download_error",
};

export const SETTING = {
    verbose: "Meshive.Download.VerboseLogs",
    autoCheck: "Meshive.Download.AutoCheck",
    guard: "Meshive.Download.PreQueueGuard",
    strictHash: "Meshive.Download.StrictHashCheck",
};

const ko = (() => {
    try {
        const loc = app.extensionManager?.setting?.get?.("Comfy.Locale") || document.documentElement.lang || navigator.language;
        return String(loc).toLowerCase().startsWith("ko");
    } catch { return false; }
})();

// Button names are the same in every locale; everything else follows the locale.
export const T = ko ? {
    pod: "Install in Meshive Pod", podAll: "Install all in Meshive Pod", hub: "Meshive", download: "다운로드", chooseFolder: "저장할 모델 폴더를 선택하세요",
    hubTip: "Meshive Pod 다운로드와 설정", hubTitle: "Meshive Pod 다운로드",
    cancel: "취소", pause: "일시정지", resume: "이어받기", retry: "다시 시도",
    done: "Pod에 저장됨", doneTemp: "Pod에 저장됨(임시)",
    tempNote: "이 모델 폴더는 Pod 스토리지에 없어 시스템 디스크에 저장했습니다. 지금 바로 쓸 수 있지만 Pod 가 재시작되면 사라집니다. 유지하려면 이 폴더를 덮는 볼륨을 연결하세요.",
    queued: "대기 중", paused: "일시정지", verifying: "검증 중", waiting: "스토리지 확장 대기", failed: "실패 — 다시 시도", exists: "이미 있음",
    status: { queued: "대기", downloading: "받는 중", waiting_storage: "공간 대기", verifying: "검증", paused: "일시정지", complete: "완료", exists: "이미 있음", error: "실패", cancelled: "취소됨" },
    queuePos: (n) => `대기 ${n}번째`, conns: (n) => `연결 ${n}개`, temporary: "임시 저장",
    stats: (a, t) => `진행 ${a} / 전체 ${t}`, empty: "다운로드가 없습니다.\n누락 모델 목록에서 Install in Meshive Pod 를 누르세요.",
    refresh: "새로고침", clear: "완료 항목 지우기", close: "닫기", settings: "설정",
    verbose: "자세한 로그", verboseTip: "브라우저 콘솔에 다운로드 이벤트를 자세히 남깁니다.",
    progressTitle: "다운로드 진행", batch: (s) => `성공 ${s.ok}, 실패 ${s.failed}${s.cancelled ? `, 취소 ${s.cancelled}` : ""}${s.pending ? `, 남음 ${s.pending}` : ""}`,
    retryFailed: (n) => `실패한 것 다시 받기 (${n})`, retryUnfinished: (n) => `끝나지 않은 것 다시 받기 (${n})`,
    batchDone: (n) => `${n}개 모델이 Pod에 준비되었습니다. 바로 쓸 수 있습니다.`,
    stale: (s, c) => `Meshive 확장의 서버(${s})와 화면(${c}) 버전이 다릅니다. 방금 업데이트했다면 ComfyUI 를 재시작한 뒤 페이지를 새로고침하세요.`,
    hfTitle: "Hugging Face 토큰", hfGated: (n) => `게이트 모델 ${n}개`, hfVerify: "확인", hfVerifying: "확인 중…", hfForget: "잊기",
    hfNote: "토큰은 이 페이지에만 보관되고 다운로드 요청마다 Pod 로 전달됩니다. 어디에도 저장되지 않습니다.",
    hfBadFormat: "hf_ 로 시작하는 Hugging Face 토큰을 넣으세요.", hfEnvChecking: "Pod 환경변수 HF_TOKEN 을 확인하는 중…",
    hfEnvInvalid: "Pod 환경변수 HF_TOKEN 이 유효하지 않습니다. 아래에 토큰을 넣으세요.",
    hfOk: (name, src) => `${name} 계정으로 확인됨${src === "env" ? " (Pod 환경변수)" : ""}. 이제 설치할 수 있습니다.`,
    hfNeedsTerms: (name, n) => `${name} 계정으로 확인됨 — ${n}개 모델은 약관 동의가 필요합니다. 동의한 뒤 다시 확인하세요.`,
    hfAcceptTerms: "약관 동의", hfUnreachable: "확인 불가", hfNotFound: "없음", hfDenied: "접근 권한 없음",
    hfErr: { rejected: "Hugging Face 가 이 토큰을 받아들이지 않았습니다. 토큰이 맞는지, 읽기 권한이 있는지 확인하세요.", format: "hf_ 로 시작하는 Hugging Face 토큰을 넣으세요.", unreachable: "Pod 에서 Hugging Face 에 연결하지 못해 토큰을 확인하지 못했습니다." },
    hfSource: (src, name) => src === "page" ? `Hugging Face 토큰: 이 페이지 (${name})` : src === "env" ? "Hugging Face 토큰: Pod 환경변수 HF_TOKEN" : "Hugging Face 토큰: 없음",
    autoCheck: "누락 모델 자동 재점검", autoCheckTip: "탭으로 돌아올 때 누락 모델 목록을 다시 확인합니다(30초에 한 번까지).",
    guard: "실행 전 모델 점검", guardTip: "실행할 때 워크플로의 모델이 Pod 에 있는지 먼저 확인하고, 없으면 실행을 멈춥니다.",
    strictHash: "실행 전 체크섬 검사", strictHashTip: "실행 전 점검에서 체크섬이 있는 모델은 파일 내용까지 확인합니다. 큰 모델은 느립니다.",
    guardTitle: "누락된 모델이 있습니다", guardText: "이 워크플로에 필요한 모델 중 Pod 에 없거나 체크섬이 맞지 않는 것이 있어 실행을 멈췄습니다. 실패하거나 결과가 잘못 나오는 것을 막기 위해서입니다.",
    guardUnresolved: (n) => `${n}개 모델은 어느 폴더에 있어야 하는지 알 수 없어 확인하지 못했습니다.`,
    guardReason: { missing: "없음", hash_mismatch: "체크섬 불일치", directory_unresolved: "폴더 알 수 없음", invalid_filename: "이름 오류" },
    guardInstall: (n) => `Install in Meshive Pod (${n})`, guardAnyway: "그래도 실행", folder: "폴더",
    podSection: "Pod 서버 (이 Pod 의 ComfyUI 에 적용)",
    keepalive: "연결 유지", keepaliveTip: "45초마다 웹소켓에 ping 을 보내, 브라우저와 Pod 사이 프록시가 한가한 연결을 끊지 않게 합니다.",
    ramLimit: "Pod 메모리 한도 반영", ramTip: "컨테이너 메모리 한도를 모르는 구버전 ComfyUI 에 호스트 RAM 대신 Pod 의 한도를 알려 줍니다.",
    memNative: (l) => l ? `ComfyUI 가 Pod 메모리 한도(${l})를 직접 반영하고 있어 바꾸지 않습니다.` : "이 ComfyUI 는 컨테이너 메모리 한도를 직접 반영합니다. 바꾸지 않습니다.",
    memNotApplied: (l) => `Pod 메모리 한도 ${l} 가 있지만 아직 반영되지 않았습니다. ComfyUI 를 재시작하면 반영됩니다.`,
    memApplied: (l, h) => `ComfyUI 에 Pod 메모리 한도 ${l} 를 알려 주고 있습니다 (호스트 ${h}).`,
    memNone: "호스트 RAM 보다 작은 메모리 한도가 없어 바꿀 것이 없습니다.",
    memOff: (l) => `Pod 메모리 한도 ${l} 가 있지만 꺼져 있습니다. 켜면 바로 적용됩니다.`,
    memLocked: "Pod 환경변수 COMFYUI_MESHIVEINJECTION_NO_RAM_PATCH 로 꺼져 있습니다.",
    podWord: "Pod",
} : {
    pod: "Install in Meshive Pod", podAll: "Install all in Meshive Pod", hub: "Meshive", download: "Download", chooseFolder: "Choose a model folder",
    hubTip: "Meshive Pod downloads and settings", hubTitle: "Meshive Pod downloads",
    cancel: "Cancel", pause: "Pause", resume: "Resume", retry: "Retry",
    done: "Saved in Pod", doneTemp: "Saved in Pod (temporary)",
    tempNote: "This model folder is not on pod storage, so the file was saved to the system disk. It works now but is lost when the pod restarts. Attach a volume that covers this folder to keep it.",
    queued: "Queued", paused: "Paused", verifying: "Verifying", waiting: "Waiting for storage", failed: "Failed — retry", exists: "Already there",
    status: { queued: "Queued", downloading: "Downloading", waiting_storage: "Waiting", verifying: "Verifying", paused: "Paused", complete: "Done", exists: "Already there", error: "Failed", cancelled: "Cancelled" },
    queuePos: (n) => `#${n} in queue`, conns: (n) => `${n} connection${n === 1 ? "" : "s"}`, temporary: "temporary",
    stats: (a, t) => `${a} active / ${t} tracked`, empty: "No downloads.\nUse Install in Meshive Pod in the missing models list.",
    refresh: "Refresh", clear: "Clear finished", close: "Close", settings: "Settings",
    verbose: "Verbose logs", verboseTip: "Log download events in detail to the browser console.",
    progressTitle: "Download progress", batch: (s) => `${s.ok} succeeded, ${s.failed} failed${s.cancelled ? `, ${s.cancelled} cancelled` : ""}${s.pending ? `, ${s.pending} remaining` : ""}`,
    retryFailed: (n) => `Retry failed (${n})`, retryUnfinished: (n) => `Retry unfinished (${n})`,
    batchDone: (n) => `${n} model${n === 1 ? " is" : "s are"} ready in the pod.`,
    stale: (s, c) => `The Meshive extension differs between the server (${s}) and this page (${c}). If you just updated it, restart ComfyUI, then reload the page.`,
    hfTitle: "Hugging Face token", hfGated: (n) => `${n} gated model${n === 1 ? "" : "s"}`, hfVerify: "Verify", hfVerifying: "Verifying…", hfForget: "Forget",
    hfNote: "The token stays in this page and is sent to the pod with each download. It is never saved.",
    hfBadFormat: "Enter a Hugging Face token starting with hf_.", hfEnvChecking: "Checking HF_TOKEN from the pod environment…",
    hfEnvInvalid: "HF_TOKEN in the pod environment is not valid. Enter a token below.",
    hfOk: (name, src) => `Verified as ${name}${src === "env" ? " (pod environment)" : ""}. Ready to install.`,
    hfNeedsTerms: (name, n) => `Verified as ${name} — ${n} model${n === 1 ? " needs its" : "s need their"} terms accepted. Accept, then verify again.`,
    hfAcceptTerms: "Accept terms", hfUnreachable: "could not check", hfNotFound: "not found", hfDenied: "no access",
    hfErr: { rejected: "Hugging Face did not accept this token. Check that it is correct and has read access.", format: "Enter a Hugging Face token starting with hf_.", unreachable: "The pod could not reach Hugging Face to check the token." },
    hfSource: (src, name) => src === "page" ? `Hugging Face token: this page (${name})` : src === "env" ? "Hugging Face token: pod environment (HF_TOKEN)" : "Hugging Face token: none",
    autoCheck: "Auto missing-model checks", autoCheckTip: "Check the missing models again when you come back to the tab (at most every 30 s).",
    guard: "Check models before running", guardTip: "When you run a workflow, first check that its models are in the pod, and stop if they are not.",
    strictHash: "Checksums before running", strictHashTip: "The check before running also verifies the contents of models that have a checksum. Slow for large models.",
    guardTitle: "Missing models detected", guardText: "The run was stopped because some models this workflow needs are not in the pod or fail their checksum. This prevents a failed or broken run.",
    guardUnresolved: (n) => n === 1 ? "1 model could not be checked: the folder it belongs in is unknown." : `${n} models could not be checked: the folders they belong in are unknown.`,
    guardReason: { missing: "missing", hash_mismatch: "checksum mismatch", directory_unresolved: "unknown folder", invalid_filename: "bad name" },
    guardInstall: (n) => `Install in Meshive Pod (${n})`, guardAnyway: "Queue anyway", folder: "Folder",
    podSection: "Pod server (applies to this pod's ComfyUI)",
    keepalive: "Connection keepalive", keepaliveTip: "Ping the websocket every 45 s, so a proxy between the browser and the pod does not close an idle connection.",
    ramLimit: "Pod memory limit for ComfyUI", ramTip: "Tell a ComfyUI too old to know about container memory limits the pod's limit instead of the host's RAM.",
    memNative: (l) => l ? `ComfyUI accounts for the pod's memory limit (${l}) itself; nothing is changed.` : "This ComfyUI accounts for container memory limits itself; nothing is changed.",
    memNotApplied: (l) => `The pod has a memory limit of ${l}, not reported to ComfyUI yet. Restarting ComfyUI applies it.`,
    memApplied: (l, h) => `Reporting the pod's memory limit of ${l} to ComfyUI (host ${h}).`,
    memNone: "No memory limit below the host's RAM: nothing to change.",
    memOff: (l) => `The pod has a memory limit of ${l}, but this is off. Turning it on applies it at once.`,
    memLocked: "Turned off by COMFYUI_MESHIVEINJECTION_NO_RAM_PATCH in the pod environment.",
    podWord: "Pod",
};

export function setting(id, fallback) {
    try { return app.extensionManager?.setting?.get?.(id) ?? fallback; } catch { return fallback; }
}

export async function setSetting(id, value) {
    await app.extensionManager.setting.set(id, value);
}

export function debugLog(...args) {
    if (setting(SETTING.verbose, false)) console.log("[meshive]", ...args);
}

export function toast(severity, summary, detail) {
    try { app.extensionManager.toast.add({ severity, summary, detail, life: 8000 }); }
    catch { console[severity === "error" ? "error" : "log"](`[meshive] ${summary}: ${detail ?? ""}`); }
}

export function fmtBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ── Download states ─────────────────────────────────────────────────────────
// id -> the server's state for that download. Answers without a download (the file is already
// there, the request was refused) are kept under a local id, ordered after every server download
// seen so far, so "the latest attempt for this file" is simply the highest `seq`.
export const downloads = new Map();
export const keyOf = (directory, name) => `${directory}/${name}`;
export const isActive = (st) => !!st && ["queued", "downloading", "waiting_storage", "verifying", "paused"].includes(st.status);
export const isRunning = (st) => isActive(st) && st.status !== "paused";
export const isDone = (st) => !!st && ["complete", "exists"].includes(st.status);
export const isFinished = (st) => !!st && ["complete", "exists", "error", "cancelled"].includes(st.status);
export const isLocal = (st) => String(st?.id ?? "").startsWith("local:");

let maxSeq = 0;
let lastLocalSeq = 0;
let localCount = 0;
let boot = null;
const listeners = new Set();
const resetListeners = new Set();
export function onChange(fn) { listeners.add(fn); }
// Called when the server restarted: every download this page knew about is gone.
export function onReset(fn) { resetListeners.add(fn); }
// The highest `seq` given out so far: attempts made after this point have a higher one.
export const seqMark = () => Math.max(maxSeq, lastLocalSeq);
function changed() {
    for (const fn of listeners) {
        try { fn(); } catch (e) { console.warn("[meshive] listener failed", e); }
    }
}

// `restored`: loaded after a page reload. A finish that happened before the reload is old news:
// it does not mean the file is still there, so it is not shown as "Saved" on the buttons.
export function upsert(d, restored = false) {
    if (!d?.id) return;
    const prev = downloads.get(d.id);
    // A finished download stays finished on the server; an older answer arriving late (a status poll
    // sent just before the final event) must not bring it back to life.
    if (isFinished(prev) && !isFinished(d) && d.status) return prev;
    const next = { ...(prev ?? {}), ...d };
    if (isFinished(next) && !isFinished(prev)) next.doneAt = restored ? 0 : Date.now();
    if (typeof next.seq === "number" && !isLocal(next)) maxSeq = Math.max(maxSeq, next.seq);
    downloads.set(d.id, next);
    changed();
    return next;
}

// After every server download seen so far (whose seq go up by 1), and after every earlier local answer.
function recordLocal(directory, filename, fields) {
    lastLocalSeq = Math.max(maxSeq + 0.5, lastLocalSeq + 1e-6);
    return upsert({ id: `local:${++localCount}`, seq: lastLocalSeq, directory, filename, ...fields });
}

export function latestFor(directory, filename) {
    const key = keyOf(directory, filename);
    let best = null;
    for (const d of downloads.values()) {
        if (keyOf(d.directory, d.filename) === key && (!best || d.seq >= best.seq)) best = d;  // ties: the later entry
    }
    return best;
}

// "Saved" only matters until the Missing list refreshes. If the same model is still missing after
// that, the file is gone (deleted, or the pod moved to fresh storage) — forget it so it can be
// installed again.
const DONE_TTL_MS = 10000;
export function current(directory, filename) {
    const st = latestFor(directory, filename);
    if (isDone(st) && Date.now() - (st.doneAt ?? 0) > DONE_TTL_MS) return undefined;
    return st;
}

// ── Hugging Face token ──────────────────────────────────────────────────────
// Typed into the page: kept here only (never in storage) and sent with each Hugging Face download.
const hf = { token: null, name: "", envToken: false };
export const hfState = () => ({ ...hf, token: undefined, hasPageToken: !!hf.token });
export const isHfUrl = (url) => { try { const h = new URL(url).hostname; return h === "huggingface.co" || h.endsWith(".huggingface.co"); } catch { return false; } };

export function forgetHfToken() {
    hf.token = null;
    hf.name = "";
    changed();
}

export async function hfEnvStatus() {
    try {
        const res = await api.fetchApi("/meshive/hf/status");
        if (res.ok) hf.envToken = !!(await res.json()).env_token;
    } catch { /* an older server: no environment check */ }
    return hf.envToken;
}

// Check a token — the one given, else the one this page already uses, else the pod's HF_TOKEN — and
// which of `urls` it can fetch. A valid given token is kept for the downloads that follow; the
// page's own token is dropped if Hugging Face no longer accepts it.
export async function hfVerify(token, urls) {
    const use = token || hf.token || undefined;
    let r;
    try { r = await post("/meshive/hf/verify", { token: use, urls }); }
    catch (e) { return { valid: false, code: "unreachable", error: String(e) }; }
    if (!r.ok) return { valid: false, error: r.body.error || `HTTP ${r.status}` };
    if (r.body.valid && token) { hf.token = token; hf.name = r.body.name || ""; changed(); }
    else if (!token && use && r.body.code === "rejected") forgetHfToken();
    return r.body;
}

// File sizes for these URLs (null when unknown), asked by the pod the way a download would ask.
export async function sizesOf(urls) {
    try {
        const token = urls.some(isHfUrl) ? hf.token ?? undefined : undefined;
        const r = await post("/meshive/models/size", { urls, token });
        return r.ok ? r.body : {};
    } catch { return {}; }
}

// Settings that act on the ComfyUI server itself: {keepalive, cgroup_ram, memory}.
export async function podSettings() {
    try {
        const res = await api.fetchApi("/meshive/settings");
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

export async function setPodSetting(key, value) {
    const r = await post("/meshive/settings", { [key]: value });
    if (!r.ok) throw new Error(r.body.error || `HTTP ${r.status}`);
    return r.body;
}

// ── Server calls ────────────────────────────────────────────────────────────
async function post(path, body) {
    const res = await api.fetchApi(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

// Start (or join) the download of one model: {name, directory, url, hash?, hash_type?}.
// Returns the state it ended up in.
export async function startDownload(c) {
    let r;
    try {
        r = await post("/meshive/download/start", {
            url: c.url, directory: c.directory, filename: c.name, hash: c.hash, hash_type: c.hash_type,
            token: hf.token && isHfUrl(c.url) ? hf.token : undefined,
        });
    } catch (e) {
        return recordLocal(c.directory, c.name, { status: "error", error: String(e) });
    }
    if (!r.ok) {
        const error = r.body.error || `HTTP ${r.status}`;
        toast("error", c.name, error);
        return recordLocal(c.directory, c.name, { status: "error", error });
    }
    debugLog("start", c.name, r.body);
    if (r.body.id) return upsert(r.body);
    return recordLocal(c.directory, c.name, { status: r.body.status || "exists" });
}

export async function control(action, st) {
    if (!st?.id || isLocal(st)) return;
    try {
        const r = await post(`/meshive/download/${action}`, { id: st.id });
        if (!r.ok) toast("warn", st.filename ?? "", r.body.error || `HTTP ${r.status}`);
        else if (r.body.id && r.body.filename) upsert(r.body);
        debugLog(action, st.filename, r.body);
    } catch (e) { toast("error", st.filename ?? "", String(e)); }
}

export async function clearFinished() {
    try { await post("/meshive/download/clear", {}); } catch { /* the list refresh below shows what is left */ }
    for (const [id, st] of downloads) if (isFinished(st)) downloads.delete(id);
    changed();
}

export async function refreshAll(restored = false) {
    try {
        const res = await api.fetchApi("/meshive/download/status");
        if (!res.ok) return;
        const list = await res.json();
        const serverBoot = res.headers.get("X-Meshive-Boot");
        if (boot && serverBoot && serverBoot !== boot) {
            // ComfyUI restarted: what this page knew is gone, and `seq` starts over.
            downloads.clear();
            maxSeq = lastLocalSeq = 0;
            for (const fn of resetListeners) { try { fn(); } catch (e) { console.warn("[meshive] reset listener failed", e); } }
            restored = true;
        }
        boot = serverBoot || boot;
        const seen = new Set(list.map((d) => d.id));
        for (const d of list) upsert(d, restored && !downloads.has(d.id));
        // Not listed any more: cleared on the server (from another tab, say). The server never
        // forgets a download that is still going, so this only drops finished ones.
        for (const [id, st] of downloads) if (!isLocal(st) && !seen.has(id)) downloads.delete(id);
        changed();
    } catch { /* the buttons and the panel work without it */ }
}

// Make a new file show up in model dropdowns and drop out of the Missing list right away.
// `quiet`: only look again at which models are missing (the model lists are reloaded once, without
// the frontend's "updated" notices) — for checks the user did not ask for.
export async function refreshModels(getMissingStore, quiet = false) {
    const store = getMissingStore();
    if (quiet) {
        try { await store?.refreshMissingModels?.(); } catch (e) { console.warn("[meshive] refreshMissingModels failed", e); }
        return;
    }
    try { await app.refreshComboInNodes?.(); } catch (e) { console.warn("[meshive] refreshComboInNodes failed", e); }
    // The definitions were just reloaded above: no need to reload them again.
    try { await store?.refreshMissingModels?.({ reloadDefs: false }); } catch (e) { console.warn("[meshive] refreshMissingModels failed", e); }
    // Node error outlines only clear on the next canvas redraw.
    try { app.canvas?.setDirty?.(true, true); } catch { /* the next redraw will pick it up */ }
}

export async function checkVersion() {
    console.info(`[meshive] Install in Meshive Pod v${VERSION}`);
    try {
        const res = await api.fetchApi("/meshive/info");
        // No such route: the server still runs a version from before it existed.
        const info = res.ok ? await res.json() : null;
        if (info?.version !== VERSION) toast("warn", "Meshive", T.stale(info?.version ?? "< 1.1.0", VERSION));
        return info;
    } catch { return null; }
}
