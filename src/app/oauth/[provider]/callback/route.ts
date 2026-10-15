import { completeConnect, type ConnectResult, type Provider } from "@/lib/channels/meta/connect";
import { MetaError } from "@/lib/channels/meta/http";

/**
 * Возврат после входа в Instagram/Threads (публичный адрес). Сюда может прийти и клиент студии,
 * которому переслали ссылку, — поэтому ответ — простая самостоятельная страница, без входа в студию.
 */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (provider !== "instagram" && provider !== "threads") return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  let result: ConnectResult;
  if (url.searchParams.get("error")) result = { ok: false, error: "denied" };
  else if (!code || !state) result = { ok: false, error: "state_invalid" };
  else {
    try {
      result = await completeConnect(provider as Provider, state, code);
    } catch (e) {
      console.error("oauth callback failed", e);
      result = { ok: false, error: e instanceof MetaError ? `meta: ${e.message}` : "exchange_failed" };
    }
  }
  return new Response(page(provider as Provider, result), {
    status: result.ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

const ERRORS: Record<string, string> = {
  denied: "Вход отменён. / Вхід скасовано.",
  state_invalid: "Ссылка недействительна — получите новую в студии. / Посилання недійсне — отримайте нове в студії.",
  state_expired: "Ссылка устарела (действует сутки) — получите новую. / Посилання застаріло (діє добу) — отримайте нове.",
  account_used: "Этот аккаунт уже подключён к другому агенту. / Цей акаунт уже підключено до іншого агента.",
  agent_not_found: "Агент не найден. / Агента не знайдено.",
  app_not_configured: "В студии не настроено приложение Meta. / У студії не налаштовано застосунок Meta.",
  exchange_failed: "Не удалось завершить вход. Попробуйте ещё раз. / Не вдалося завершити вхід. Спробуйте ще раз.",
};

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(provider: Provider, r: ConnectResult) {
  const name = provider === "instagram" ? "Instagram" : "Threads";
  const body = r.ok
    ? `<div class="icon ok">✓</div><h1>Готово / Готово</h1>
       <p><b>@${esc(r.username)}</b> подключён к агенту «${esc(r.agentName)}». / підключено до агента «${esc(r.agentName)}».</p>
       ${r.warning ? `<p class="warn">Аккаунт подключён, но подписку на уведомления Meta оформить не удалось — студия будет проверять новые сообщения сама. / Акаунт підключено, але підписку на сповіщення Meta оформити не вдалося.</p>` : ""}
       <p class="muted">Эту вкладку можно закрыть. / Цю вкладку можна закрити.</p>`
    : `<div class="icon err">!</div><h1>${name}: не удалось подключить</h1>
       <p>${esc(ERRORS[r.error] ?? r.error)}</p>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} — GenAgent</title><meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f7fb;color:#141824;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.c{max-width:440px;width:100%;background:#fff;border:1px solid #e3e6ef;border-radius:20px;padding:32px;text-align:center}
.icon{width:56px;height:56px;border-radius:50%;display:grid;place-items:center;margin:0 auto 16px;font-size:28px;color:#fff}
.ok{background:#12a150}.err{background:#dc3545}h1{font-size:20px;margin:0 0 8px}.muted{color:#667085;font-size:14px}
.warn{background:#fff7e6;border-radius:12px;padding:10px;font-size:14px}</style></head>
<body><div class="c">${body}</div></body></html>`;
}
