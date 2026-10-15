/**
 * Лаунчер GenAgent: запускается из GenAgent.cmd двойным кликом.
 *
 * 1. Поднимает «оболочку» на http://localhost:3210 и сразу открывает окно приложения
 *    (Edge/Chrome в режиме приложения — без вкладок и адресной строки) с экраном загрузки.
 * 2. При необходимости: npm install → первичная настройка (.env, база) → сборка.
 * 3. Запускает сервер Next.js на внутреннем порту и проксирует на него окно.
 * 4. Окно закрыли — сервер останавливается.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const PORT = 3210; // адрес окна
const APP_PORT = 3211; // внутренний сервер Next.js
const URL = `http://localhost:${PORT}`;
const DATA = path.join(ROOT, "data");
const LOG = path.join(DATA, "launcher.log");

fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(LOG, `=== ${new Date().toISOString()} ===\n`);

const state = { step: "start", ready: false, error: null, firstRun: null };
const children = new Set();
let appServer = null;
let shuttingDown = false;

function log(line) {
  fs.appendFileSync(LOG, line.endsWith("\n") ? line : line + "\n");
}

function setStep(step) {
  state.step = step;
  log(`[step] ${step}`);
}

// ---------- оболочка: экран загрузки + прокси ----------

const shell = http.createServer((req, res) => {
  if (req.url === "/__launcher/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ app: "genagent-launcher", ...state, log: state.error ? tail(40) : undefined }));
    return;
  }
  if (!state.ready) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(SPLASH);
    return;
  }
  proxy(req, res);
});

function proxy(req, res) {
  const upstream = http.request(
    { host: "127.0.0.1", port: APP_PORT, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("GenAgent: сервер недоступен");
  });
  // Клиент закрыл соединение (например, «Стоп» в тест-чате) — прерываем и запрос к серверу.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

function tail(n) {
  try {
    return fs.readFileSync(LOG, "utf8").split("\n").slice(-n).join("\n");
  } catch {
    return "";
  }
}

// ---------- шаги подготовки ----------

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true, env: process.env, ...opts });
    children.add(child);
    child.stdout?.on("data", (d) => log(String(d)));
    child.stderr?.on("data", (d) => log(String(d)));
    child.on("error", (e) => {
      children.delete(child);
      reject(e);
    });
    child.on("exit", (code) => {
      children.delete(child);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} завершился с кодом ${code}`));
    });
  });
}

const node = (script, args = []) => run(process.execPath, [script, ...args]);
const NEXT = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function newestMtime(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const name of fs.readdirSync(p)) max = Math.max(max, newestMtime(path.join(p, name)));
  return max;
}

function needsBuild() {
  const buildId = path.join(ROOT, ".next", "BUILD_ID");
  if (!fs.existsSync(buildId)) return true;
  const built = fs.statSync(buildId).mtimeMs;
  const inputs = ["src", "drizzle", "public", "package.json", "package-lock.json", "next.config.ts", "tsconfig.json"];
  return inputs.some((p) => newestMtime(path.join(ROOT, p)) > built);
}

function readEnv() {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(path.join(ROOT, ".env"), "utf8")
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
}

async function prepare() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Нужен Node.js 22.13 или новее (сейчас ${process.versions.node}). Установите LTS с nodejs.org`);
  }
  if (!fs.existsSync(NEXT) || !fs.existsSync(TSX)) {
    setStep("install");
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], {
      shell: true,
    });
  }

  const firstRun = !fs.existsSync(path.join(ROOT, ".env")) || !fs.existsSync(path.join(DATA, "genagent.db"));
  if (firstRun) {
    setStep("setup");
    await node(TSX, ["scripts/setup.ts"]);
    const env = readEnv();
    state.firstRun = { email: env.SEED_ADMIN_EMAIL, password: env.SEED_ADMIN_PASSWORD };
  }

  if (needsBuild()) {
    setStep("build");
    await node(NEXT, ["build"]);
  }

  setStep("start");
  appServer = spawn(process.execPath, [NEXT, "start", "-p", String(APP_PORT), "-H", "127.0.0.1"], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, NODE_ENV: "production" },
  });
  children.add(appServer);
  appServer.stdout.on("data", (d) => log(String(d)));
  appServer.stderr.on("data", (d) => log(String(d)));
  appServer.on("exit", (code) => {
    children.delete(appServer);
    if (!shuttingDown) fail(new Error(`Сервер остановился (код ${code})`));
  });

  for (let i = 0; i < 120; i++) {
    if (await healthy(APP_PORT, "/api/health")) {
      state.ready = true;
      setStep("ready");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Сервер не ответил за 60 секунд");
}

function healthy(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(res.statusCode === 200 ? body : null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function fail(e) {
  state.error = e instanceof Error ? e.message : String(e);
  log(`[error] ${e?.stack ?? e}`);
}

// ---------- окно приложения ----------

function findBrowser() {
  const pf = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"]].filter(Boolean);
  const candidates = [];
  for (const base of pf) {
    candidates.push(path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
    candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
  }
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Открывает окно. Возвращает процесс браузера, если удалось открыть в режиме приложения. */
function openWindow() {
  const browser = findBrowser();
  if (!browser) {
    log("Edge/Chrome не найден — открываю браузер по умолчанию");
    execFileSync("cmd", ["/c", "start", "", URL], { windowsHide: true });
    return null;
  }
  const profile = path.join(DATA, "browser-profile");
  return spawn(
    browser,
    [
      `--app=${URL}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--window-size=1440,920",
    ],
    { stdio: "ignore", windowsHide: false },
  );
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("[shutdown]");
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
  shell.close();
  setTimeout(() => process.exit(code), 500);
}

// ---------- старт ----------

shell.on("error", async (e) => {
  if (e.code === "EADDRINUSE") {
    // Уже запущено (второй двойной клик) — просто открываем ещё одно окно.
    const status = await healthy(PORT, "/__launcher/status");
    if (status && status.includes("genagent-launcher")) {
      openWindow();
      process.exit(0);
    }
    log(`Порт ${PORT} занят другой программой`);
    execFileSync("cmd", ["/c", "msg", "*", `GenAgent: порт ${PORT} занят другой программой.`], { windowsHide: true });
    process.exit(1);
  }
  fail(e);
});

shell.listen(PORT, "127.0.0.1", () => {
  log(`Оболочка: ${URL}`);
  const win = openWindow();
  if (win) {
    win.on("exit", () => {
      log("Окно закрыто");
      shutdown(0);
    });
  }
  prepare().catch(fail);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ---------- экран загрузки ----------

const SPLASH = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GenAgent</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#5b5bf0"/><path d="M28 14l3.6 9.4L41 27l-9.4 3.6L28 40l-3.6-9.4L15 27l9.4-3.6z" fill="#fff"/></svg>')}">
<style>
  :root{--bg:#f6f7fb;--card:#fff;--text:#141824;--muted:#667085;--accent:#5b5bf0;--border:#e3e6ef;--danger:#dc3545}
  @media (prefers-color-scheme:dark){:root{--bg:#0e1016;--card:#161922;--text:#eceef4;--muted:#8d94a6;--accent:#7c7cff;--border:#2a2f3d;--danger:#ff6b78}}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
  .card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:32px;box-shadow:0 20px 50px rgba(0,0,0,.06)}
  .logo{width:48px;height:48px;border-radius:14px;background:var(--accent);display:grid;place-items:center;margin-bottom:20px}
  h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted);font-size:14px;margin:0}
  ol{list-style:none;padding:0;margin:24px 0 0}li{display:flex;gap:10px;align-items:center;padding:6px 0;color:var(--muted)}
  li.active{color:var(--text);font-weight:500}li.done{color:var(--muted)}
  .dot{width:18px;height:18px;border-radius:50%;border:2px solid var(--border);flex:none}
  li.done .dot{background:var(--accent);border-color:var(--accent)}
  li.active .dot{border-color:var(--accent);border-right-color:transparent;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  .err{color:var(--danger);margin-top:20px}pre{max-height:240px;overflow:auto;background:var(--bg);border-radius:10px;padding:12px;font-size:11px;white-space:pre-wrap}
  .creds{margin-top:24px;padding:16px;border-radius:14px;background:var(--bg)}.creds b{font-family:ui-monospace,Consolas,monospace}
  button{margin-top:16px;width:100%;height:42px;border:0;border-radius:12px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
  [hidden]{display:none}
</style></head><body>
<div class="card">
  <div class="logo"><svg width="26" height="26" viewBox="14 13 28 28"><path d="M28 14l3.6 9.4L41 27l-9.4 3.6L28 40l-3.6-9.4L15 27l9.4-3.6z" fill="#fff"/></svg></div>
  <h1>GenAgent</h1><p class="muted">Студия ИИ-агентов запускается…</p>
  <ol id="steps">
    <li data-s="install"><span class="dot"></span>Установка компонентов (только первый раз)</li>
    <li data-s="setup"><span class="dot"></span>Создание базы данных</li>
    <li data-s="build"><span class="dot"></span>Сборка приложения (после обновлений, 1–2 мин)</li>
    <li data-s="start"><span class="dot"></span>Запуск сервера</li>
  </ol>
  <div id="creds" class="creds" hidden>
    <div style="font-weight:600;margin-bottom:6px">Первый запуск — данные для входа</div>
    <div>Email: <b id="email"></b></div><div>Пароль: <b id="password"></b></div>
    <p class="muted" style="margin-top:8px">Они сохранены в файле .env в папке программы.</p>
    <button id="go" disabled>Открыть GenAgent</button>
  </div>
  <div id="error" class="err" hidden><b>Не удалось запустить.</b> <span id="msg"></span>
    <p class="muted">Полный журнал: data/launcher.log</p><pre id="log"></pre></div>
</div>
<script>
const order=["install","setup","build","start"];
let creds=false;
async function poll(){
  let s;try{s=await (await fetch("/__launcher/status",{cache:"no-store"})).json()}catch{return setTimeout(poll,1000)}
  const cur=s.ready?order.length:order.indexOf(s.step);
  document.querySelectorAll("#steps li").forEach((li,i)=>{li.className=i<cur?"done":i===cur?"active":"";if(s.ready)li.className="done"});
  if(s.firstRun&&!creds){creds=true;document.getElementById("creds").hidden=false;email.textContent=s.firstRun.email;password.textContent=s.firstRun.password}
  if(s.error){document.getElementById("error").hidden=false;msg.textContent=s.error;log.textContent=s.log||"";document.querySelectorAll("#steps li.active").forEach(li=>li.className="");return}
  if(s.ready){if(creds){go.disabled=false;go.onclick=()=>location.replace("/login")}else location.replace("/");return}
  setTimeout(poll,700);
}
poll();
</script></body></html>`;
