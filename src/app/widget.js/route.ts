/**
 * Скрипт для вставки на сайт клиента:
 * <script src="https://АДРЕС/widget.js" data-channel="ID_КАНАЛА" async></script>
 * Рисует кнопку чата; окно чата открывается в iframe с нашего адреса (стили сайта ему не мешают).
 */
const SCRIPT = `(function () {
  var s = document.currentScript;
  if (!s || window.__genagentWidget) return;
  window.__genagentWidget = true;
  var channel = s.getAttribute("data-channel");
  var base = new URL(s.src).origin;
  if (!channel) return;

  fetch(base + "/api/widget/" + channel).then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
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

    var frame = null, open = false;
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
        // Язык окна — как у страницы сайта (data-lang или <html lang>).
        var lang = (s.getAttribute("data-lang") || document.documentElement.lang || "").slice(0, 2).toLowerCase();
        frame.src = base + "/w/" + channel + (lang ? "?lang=" + encodeURIComponent(lang) : "");
        frame.title = cfg.title || "Chat";
        frame.allow = "clipboard-write";
        document.body.appendChild(frame);
      }
      btn.innerHTML = open ? closeIcon : chatIcon;
      layout();
    }
    btn.onclick = function () { toggle(); };
    window.addEventListener("resize", layout);
    window.addEventListener("message", function (e) {
      if (e.origin === base && e.data && e.data.type === "genagent:close") toggle(false);
    });
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
