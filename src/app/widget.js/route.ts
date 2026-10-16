/**
 * Скрипт для вставки на сайт клиента:
 * <script src="https://АДРЕС/widget.js" data-channel="ID_КАНАЛА" data-lang="es" data-context="Объект: Villa Sol, 550 000 €" async></script>
 * Рисует кнопку чата; окно чата открывается в iframe с нашего адреса (стили сайта ему не мешают).
 * Окну передаются адрес и заголовок страницы и data-context — агент знает, что посетитель смотрит.
 * Команды для сайта (например, кнопка «Спросить об этом объекте» на карточке):
 *   GenAgent.open() / GenAgent.close()
 *   GenAgent.setContext("Объект: Villa Sol (V-012), 550 000 €, Финестрат")  — или объект { "Объект": "…", "Цена": "…" }
 *   GenAgent.ask("Есть ли скидка на эту виллу?")  — открыть окно и задать вопрос от имени посетителя
 */
const SCRIPT = `(function () {
  var s = document.currentScript;
  if (!s || window.__genagentWidget) return;
  window.__genagentWidget = true;
  var channel = s.getAttribute("data-channel");
  var base = new URL(s.src).origin;
  if (!channel) return;
  // Язык окна — как у страницы сайта (data-lang или <html lang>)
  var lang = (s.getAttribute("data-lang") || document.documentElement.lang || "").slice(0, 2).toLowerCase();
  var ctx = s.getAttribute("data-context") || "";
  var queue = [];
  function asText(x) {
    if (!x) return "";
    if (typeof x === "string") return x;
    return Object.keys(x).map(function (k) { return k + ": " + x[k]; }).join("\\n");
  }
  // До загрузки окна команды сайта копятся и уходят, когда окно готово
  var api = window.GenAgent = window.GenAgent || {};
  api.setContext = function (x) { ctx = asText(x).slice(0, 1000); post({ type: "genagent:context" }); };
  api.open = function () { queue.push(["open"]); };
  api.close = function () { queue.push(["close"]); };
  api.ask = function (text) { queue.push(["ask", String(text || "")]); };
  var frame = null, ready = false;
  function post(msg) {
    if (!frame || !ready) return;
    if (msg.type === "genagent:context") { msg.page = { url: location.href, title: document.title }; msg.context = ctx; msg.lang = lang; }
    frame.contentWindow.postMessage(msg, base);
  }

  fetch(base + "/api/widget/" + channel + (lang ? "?lang=" + encodeURIComponent(lang) : "")).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
    if (!data || !data.config) return;
    var cfg = data.config;
    var side = cfg.position === "left" ? "left" : "right";

    var btn = document.createElement("button");
    btn.setAttribute("aria-label", cfg.title || "Chat");
    btn.style.cssText = "position:fixed;bottom:20px;" + side + ":20px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;z-index:2147483646;box-shadow:0 8px 24px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;transition:transform .2s;background:" + cfg.color;
    var chatIcon = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    var closeIcon = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    btn.innerHTML = chatIcon;
    btn.onmouseenter = function () { btn.style.transform = "scale(1.06)"; };
    btn.onmouseleave = function () { btn.style.transform = "none"; };

    var open = false;
    function layout() {
      if (!frame) return;
      var mobile = window.innerWidth < 500;
      frame.style.cssText = mobile
        ? "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483647;background:#fff;"
        : "position:fixed;bottom:92px;" + side + ":20px;width:380px;height:min(620px,calc(100vh - 120px));border:0;border-radius:18px;z-index:2147483647;box-shadow:0 16px 48px rgba(0,0,0,.22);background:#fff;";
      frame.style.display = open ? "block" : "none";
    }
    function toggle(v) {
      open = v === undefined ? !open : v;
      if (open && !frame) {
        frame = document.createElement("iframe");
        frame.src = base + "/w/" + channel + (lang ? "?lang=" + encodeURIComponent(lang) : "");
        frame.title = cfg.title || "Chat";
        frame.allow = "clipboard-write";
        document.body.appendChild(frame);
      }
      btn.innerHTML = open ? closeIcon : chatIcon;
      layout();
    }
    btn.onclick = function () { hideTeaser(); toggle(); };
    // Приглашение к разговору: облачко у кнопки, один раз за визит; закрыли или открыли чат — больше не показываем
    var teaser = null, teaserKey = "genagent_teaser_" + channel;
    function seen() { try { return sessionStorage.getItem(teaserKey) === "1"; } catch (e) { return false; } }
    function markSeen() { try { sessionStorage.setItem(teaserKey, "1"); } catch (e) {} }
    function hideTeaser() { if (teaser) { teaser.remove(); teaser = null; } markSeen(); }
    if (cfg.teaser && !seen()) {
      setTimeout(function () {
        if (open || seen()) return;
        teaser = document.createElement("div");
        teaser.setAttribute("role", "button");
        teaser.style.cssText = "position:fixed;bottom:92px;" + side + ":20px;max-width:min(280px,calc(100vw - 40px));padding:12px 34px 12px 14px;background:#fff;color:#111;border-radius:14px;box-shadow:0 8px 28px rgba(0,0,0,.18);font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;cursor:pointer;z-index:2147483646;";
        teaser.textContent = cfg.teaser;
        var x = document.createElement("button");
        x.setAttribute("aria-label", "×");
        x.textContent = "×";
        x.style.cssText = "position:absolute;top:4px;right:6px;width:24px;height:24px;border:0;background:transparent;color:#888;font-size:18px;line-height:1;cursor:pointer;";
        x.onclick = function (e) { e.stopPropagation(); hideTeaser(); };
        teaser.appendChild(x);
        teaser.onclick = function () { hideTeaser(); toggle(true); };
        document.body.appendChild(teaser);
        markSeen();
      }, Math.max(3, Number(cfg.teaserDelay) || 20) * 1000);
    }
    window.addEventListener("resize", layout);
    window.addEventListener("message", function (e) {
      if (e.origin !== base || !e.data) return;
      if (e.data.type === "genagent:close") toggle(false);
      // Окно загрузилось — передаём страницу и контекст, выполняем отложенный вопрос
      if (e.data.type === "genagent:ready") {
        ready = true;
        post({ type: "genagent:context" });
        var asks = pendingAsk; pendingAsk = [];
        asks.forEach(function (t) { post({ type: "genagent:ask", text: t }); });
      }
    });
    var pendingAsk = [];
    api.open = function () { hideTeaser(); toggle(true); };
    api.close = function () { toggle(false); };
    api.ask = function (text) {
      text = String(text || "").trim();
      if (!text) return;
      toggle(true);
      if (ready) post({ type: "genagent:ask", text: text }); else pendingAsk.push(text);
    };
    queue.forEach(function (q) { q[0] === "ask" ? api.ask(q[1]) : q[0] === "open" ? api.open() : api.close(); });
    queue = [];
    document.body.appendChild(btn);
  }).catch(function () {});
})();
`;

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
