#!/usr/bin/env bash
# Публичный HTTPS-адрес GenAgent через Caddy (один раз). Запуск на сервере:
#   bash ~/bots/genagent/caddy-add.sh agents.yabotua.com
# Наружу открыто ТОЛЬКО нужное сайтам клиентов и Meta: виджет (/widget.js, /w/*, /api/widget/*), статика Next.js,
# /api/health, возврат после входа в Instagram/Threads (/oauth/*), вебхуки Meta (/api/webhooks/*), запросы своих ботов клиентов к агенту (/api/agent/*, с ключом канала),
# документы для клиентов по неугадываемой ссылке (/d/*) и начисления баллов из CRM (/api/loyalty/*, с ключом программы) и картинки постов (/m/*, неугадываемые имена — их забирает Threads), сигналы о сбоях из систем клиента (/api/monitor/*, с ключом проверки).
# Кабинет клиента для владельцев бизнеса (/login, /portal, превью фото /api/media/* — только со входом) и открытый API студии (/api/v1/*, с ключом).
# Остальное (админка студии) — 404; она доступна только в Tailscale.
# Повторный запуск обновляет список открытых путей в уже добавленном блоке.
# Общий yabot_security не подключаем: его frame-ancestors запретил бы встраивать виджет в сайты клиентов.
#
# Как у АНКОР: копия Caddyfile → новый блок → проверка внутри контейнера Caddy → caddy reload →
# проверка, что yabotua.com отвечает. Если нет — прежний Caddyfile возвращается.
set -euo pipefail
DOMAIN="${1:-}"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "Как запускать: bash caddy-add.sh agents.yabotua.com"; exit 1; }
CADDY="$(docker ps --filter ancestor=caddy:2 --format '{{.Names}}' | head -1)"
[ -n "$CADDY" ] || { echo "Не найден контейнер Caddy"; exit 1; }
CADDYFILE="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY")"
[ -f "$CADDYFILE" ] || { echo "Не найден Caddyfile контейнера $CADDY"; exit 1; }
PUBLIC_PATHS="/widget.js /w/* /api/widget/* /api/health /_next/static/* /icon.svg /oauth/* /api/webhooks/* /api/agent/* /privacy /data-deletion /d/* /api/loyalty/* /m/* /api/monitor/* /login /portal /api/media/* /api/v1/*"
MATCHER="	@genagent_public path $PUBLIC_PATHS"
UPDATE=0
if grep -q "reverse_proxy genagent-bot:3000" "$CADDYFILE"; then
  if grep -qxF "$MATCHER" "$CADDYFILE"; then echo "GenAgent уже подключён, пути актуальны — ничего не меняю."; exit 0; fi
  UPDATE=1
fi
docker network inspect web -f '{{range .Containers}}{{.Name}} {{end}}' | grep -qw genagent-bot \
  || { echo "Контейнер genagent-bot не в сети web — сначала установите (install.sh)"; exit 1; }

TS="$(date +%Y%m%d-%H%M%S)"
cp "$CADDYFILE" "$CADDYFILE.bak-$TS"
echo "Копия: $CADDYFILE.bak-$TS"
NEW="$(mktemp)"
if [ "$UPDATE" = 1 ]; then
  echo "Обновляю список открытых путей GenAgent"
  awk -v m="$MATCHER" '/^[ 	]*@genagent_public path /{print m; next} {print}' "$CADDYFILE" > "$NEW"
else
{
  cat "$CADDYFILE"
  cat <<CADDY

# GenAgent (студия ИИ-агентов): наружу — только виджет для сайтов клиентов. Админка — в Tailscale (:8459).
$DOMAIN {
	import yabot_block
	import yabot_log
	import yabot_hidden
	encode zstd gzip
$MATCHER
	handle @genagent_public {
		reverse_proxy genagent-bot:3000 {
			header_up X-Forwarded-For {remote_host}
		}
	}
	handle {
		respond "Not found" 404
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}
}
CADDY
} > "$NEW"
fi

docker cp "$NEW" "$CADDY:/tmp/Caddyfile.new"
if ! docker exec "$CADDY" caddy validate --config /tmp/Caddyfile.new --adapter caddyfile; then
  echo "Новая конфигурация не прошла проверку — ничего не меняю."; rm -f "$NEW"; exit 1
fi
# cat >, а не cp/mv: файл подключён в контейнер отдельно — inode должен остаться тем же
cat "$NEW" > "$CADDYFILE"; rm -f "$NEW"

rollback() {
  echo "!!! ОТКАТ: $*"
  cat "$CADDYFILE.bak-$TS" > "$CADDYFILE"
  docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
  echo "Прежний Caddyfile возвращён."
  exit 1
}
docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || rollback "caddy reload не удался"

PUBLIC_IP="$(docker port "$CADDY" 443/tcp | grep -oE '^[0-9.]+' | head -1)"
PUBLIC_IP="${PUBLIC_IP:-127.0.0.1}"
sleep 3
curl -fsS -o /dev/null --max-time 10 --resolve "yabotua.com:443:$PUBLIC_IP" https://yabotua.com/ \
  || rollback "yabotua.com перестал отвечать"
echo "Caddy проксирует https://$DOMAIN → genagent-bot:3000 (только пути виджета), yabotua.com работает."
for i in $(seq 1 12); do
  if curl -fsS -o /dev/null --max-time 10 --resolve "$DOMAIN:443:$PUBLIC_IP" "https://$DOMAIN/api/health"; then
    echo "ГОТОВО: https://$DOMAIN/api/health отвечает."
    exit 0
  fi
  sleep 5
done
echo "Сертификат для $DOMAIN, видимо, ещё выпускается — проверьте через минуту: curl https://$DOMAIN/api/health"
echo "Вернуть как было: cat $CADDYFILE.bak-$TS > $CADDYFILE && docker exec $CADDY caddy reload --config /etc/caddy/Caddyfile"
