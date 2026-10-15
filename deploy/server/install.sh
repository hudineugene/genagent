#!/usr/bin/env bash
# Установка / обновление GenAgent на сервере YABOT. Запускает deploy/upload.ps1 (с компьютера):
#   bash ~/genagent-upload/deploy/install.sh ~/genagent-upload
# В ~/genagent-upload лежит то, что привёз upload.ps1:
#   app/          — автономная сборка (server.js, .next-deploy, node_modules, public, drizzle)
#   deploy/       — compose.yml, install.sh, caddy-add.sh
#   secrets.env   — (необязательно) кладётся, только если на сервере его ещё нет
#   data/genagent.db — (необязательно, первый перенос) база с компьютера
#
# Что делает (sudo не нужен):
#  - ~/bots/genagent/{app,data}; папку данных отдаёт пользователю контейнера 20009 (через docker);
#  - новый код кладёт в app, прежний сохраняет как app.prev;
#  - проверяет compose (~/hub/compose-check.py), запускает и ждёт: контейнер работает без перезапусков,
#    /api/health отвечает 200. Если нет — сам возвращает прежний код.
# Данные (~/bots/genagent/data) при обновлении не трогает; перенесённую базу кладёт, только если там пусто.
set -euo pipefail
SRC="${1:-}"
[ -n "$SRC" ] && [ -d "$SRC/app" ] && [ -d "$SRC/deploy" ] || { echo "Как запускать: bash install.sh ~/genagent-upload"; exit 1; }
NAME=genagent
DIR="$HOME/bots/$NAME"
DATA="$DIR/data"
UIDGID="20009:20009"
TS="$(date +%Y%m%d-%H%M%S)"
say() { echo "==> $*"; }
# Права на папку данных меняем через одноразовый контейнер: sudo не нужен, docker есть у deploy.
as_root() { docker run --rm -v "$DATA:/data" node:24-slim sh -c "$1"; }

mkdir -p "$DIR" "$DATA"

# 1) первый перенос базы — только если на сервере её ещё нет
if [ -f "$SRC/data/genagent.db" ]; then
  if as_root "test -f /data/genagent.db"; then
    say "В $DATA уже есть genagent.db — перенесённую базу НЕ кладу (чтобы не затереть рабочую)"
  else
    say "Кладу перенесённую базу"
    docker run --rm -v "$SRC/data:/src:ro" -v "$DATA:/data" node:24-slim cp /src/genagent.db /data/genagent.db
  fi
fi
as_root "mkdir -p /data/backups && chown -R $UIDGID /data && chmod 700 /data"

# 2) файлы развёртывания и секреты
[ -f "$DIR/compose.yml" ] && cp "$DIR/compose.yml" "$DIR/compose.yml.bak-$TS"
for f in compose.yml install.sh caddy-add.sh; do cp "$SRC/deploy/$f" "$DIR/$f"; done
chmod 644 "$DIR/compose.yml" "$DIR/install.sh" "$DIR/caddy-add.sh"
if [ -f "$SRC/secrets.env" ]; then
  if [ -f "$DIR/secrets.env" ]; then
    say "secrets.env на сервере уже есть — не перезаписываю (менять: nano $DIR/secrets.env)"
  else
    install -m 600 "$SRC/secrets.env" "$DIR/secrets.env"
    say "Секреты установлены ($DIR/secrets.env, права 600)"
  fi
fi
[ -f "$DIR/secrets.env" ] || { echo "Нет $DIR/secrets.env — первый раз запустите upload.ps1 с -WithSecrets"; exit 1; }

# 2б) библиотеки смыслового поиска и расшифровки голосовых (≈200 МБ) — отдельно от кода, ставятся один раз на версию
TRANSFORMERS_VERSION="4.3.1"
OPUS_VERSION="1.7.5"
VENDOR_STAMP="transformers@$TRANSFORMERS_VERSION ogg-opus-decoder@$OPUS_VERSION"
VENDOR="$DIR/vendor"
if [ "$(cat "$VENDOR/.installed" 2>/dev/null || true)" != "$VENDOR_STAMP" ]; then
  say "Ставлю библиотеки: $VENDOR_STAMP"
  rm -rf "$VENDOR.new" && mkdir -p "$VENDOR.new"
  echo '{"name":"genagent-vendor","private":true}' > "$VENDOR.new/package.json"
  docker run --rm -v "$VENDOR.new:/vendor" -w /vendor node:24-slim     npm install --omit=dev --ignore-scripts --no-audit --no-fund "@huggingface/transformers@$TRANSFORMERS_VERSION" "ogg-opus-decoder@$OPUS_VERSION" >/dev/null     || { echo "Не удалось поставить библиотеки — смысловой поиск и голосовые будут недоступны, поиск по словам работает"; }
  if [ -d "$VENDOR.new/node_modules/@huggingface/transformers" ]; then
    # Бинарники для Windows и macOS серверу не нужны
    docker run --rm -v "$VENDOR.new:/vendor" node:24-slim sh -c 'rm -rf /vendor/node_modules/onnxruntime-node/bin/napi-v*/win32 /vendor/node_modules/onnxruntime-node/bin/napi-v*/darwin; chmod -R a+rX /vendor'
    echo "$VENDOR_STAMP" > "$VENDOR.new/.installed"
    docker run --rm -v "$DIR:/d" node:24-slim rm -rf /d/vendor
    mv "$VENDOR.new" "$VENDOR"
  fi
fi
mkdir -p "$VENDOR"

# 3) новый код; прежний — в app.prev для отката
rm -rf "$DIR/app.new"
cp -r "$SRC/app" "$DIR/app.new"
mkdir -p "$DIR/app.new/.next-deploy/cache"
chmod -R a+rX "$DIR/app.new"
HAD_PREV=0
if [ -d "$DIR/app" ]; then rm -rf "$DIR/app.prev"; mv "$DIR/app" "$DIR/app.prev"; HAD_PREV=1; fi
mv "$DIR/app.new" "$DIR/app"

rollback() {
  echo "!!! ОТКАТ: $*"
  cd "$DIR"
  docker compose logs --tail 40 || true
  if [ "$HAD_PREV" = 1 ]; then
    rm -rf "$DIR/app.failed"; mv "$DIR/app" "$DIR/app.failed"; mv "$DIR/app.prev" "$DIR/app"
    [ -f "$DIR/compose.yml.bak-$TS" ] && cp "$DIR/compose.yml.bak-$TS" "$DIR/compose.yml"
    docker compose up -d --force-recreate && echo "Возвращён прежний код (неудачный — в app.failed)."
  else
    docker compose down || true
    echo "Это была первая установка — контейнер остановлен. Код остался в $DIR/app."
  fi
  exit 1
}

# 4) проверка и запуск
cd "$DIR"
if [ -f "$HOME/hub/compose-check.py" ]; then
  python3 "$HOME/hub/compose-check.py" "$DIR" || rollback "compose-файл не прошёл проверку"
fi
say "Запускаю"
# --force-recreate: папка app только что заменена, а работающий контейнер держит старую.
docker compose up -d --remove-orphans --force-recreate || rollback "docker compose up не удался"
HEALTH_OK=0
for i in $(seq 1 20); do
  sleep 3
  ST="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' genagent-bot 2>/dev/null || echo "missing 0")"
  [ "$ST" = "running 0" ] || continue
  if curl -fsS --max-time 5 http://127.0.0.1:3019/api/health >/dev/null 2>&1; then HEALTH_OK=1; break; fi
done
ST="$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' genagent-bot 2>/dev/null || echo "missing 0")"
[ "$ST" = "running 0" ] || rollback "genagent-bot в состоянии «$ST»"
[ "$HEALTH_OK" = 1 ] || rollback "/api/health не ответил 200"
say "ГОТОВО: genagent-bot работает. Админка: https://yabot.taila51a60.ts.net:8459"
docker logs --tail 8 genagent-bot 2>&1 | sed 's/^/    /'
