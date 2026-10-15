# Выкладка GenAgent на сервер YABOT. Запуск из папки проекта (PowerShell):
#   Первый раз (код + база + секреты + домен):
#     powershell -ExecutionPolicy Bypass -File .\deploy\upload.ps1 -WithData -WithSecrets -Domain agents.yabotua.com
#   Обновление кода (база и секреты на сервере не трогаются):
#     powershell -ExecutionPolicy Bypass -File .\deploy\upload.ps1
# Ключи:
#   -WithData     перенести базу с этого компьютера (только если на сервере базы ещё нет)
#   -WithSecrets  собрать secrets.env из локального .env (только если на сервере его ещё нет)
#   -Domain       публичный адрес для виджета: попадёт в PUBLIC_URL и подключится в Caddy
param(
    [string]$Server = "yabot",
    [string]$AdminOrigin = "yabot.taila51a60.ts.net:8459",
    [switch]$WithData,
    [switch]$WithSecrets,
    [string]$Domain = ""
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

Write-Host "==> Проверка типов и линтер"
npx tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw "Ошибки типов — выкладку отменяю" }
npm run lint --silent
if ($LASTEXITCODE -ne 0) { throw "Линтер нашёл ошибки — выкладку отменяю" }

Write-Host "==> Сборка для сервера (.next-deploy)"
$env:BUILD_STANDALONE = "1"
$env:ALLOWED_ACTION_ORIGINS = $AdminOrigin
$env:NEXT_TELEMETRY_DISABLED = "1"
try {
    npx next build
    if ($LASTEXITCODE -ne 0) { throw "Сборка не удалась" }
} finally {
    Remove-Item Env:BUILD_STANDALONE, Env:ALLOWED_ACTION_ORIGINS -ErrorAction SilentlyContinue
}

$Work = Join-Path $env:TEMP ("genagent-upload-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$Stage = Join-Path $Work "genagent-upload"
New-Item -ItemType Directory -Force (Join-Path $Stage "app"), (Join-Path $Stage "deploy") | Out-Null
try {
    Write-Host "==> Собираю приложение"
    robocopy (Join-Path $Root ".next-deploy\standalone") (Join-Path $Stage "app") /E /XD data .git .claude /XF ".env*" "*.db" "*.db-wal" "*.db-shm" /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy: ошибка копирования сборки ($LASTEXITCODE)" }
    foreach ($pair in @(@(".next-deploy\static", "app\.next-deploy\static"), @("public", "app\public"), @("drizzle", "app\drizzle"))) {
        robocopy (Join-Path $Root $pair[0]) (Join-Path $Stage $pair[1]) /E /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy: ошибка копирования $($pair[0])" }
    }

    # файлы для сервера — с LF (bash и docker не любят CRLF)
    foreach ($f in "compose.yml", "install.sh", "caddy-add.sh") {
        $txt = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "server\$f")) -replace "`r", ""
        [IO.File]::WriteAllText((Join-Path $Stage "deploy\$f"), $txt, (New-Object Text.UTF8Encoding $false))
    }

    if ($WithSecrets) {
        Write-Host "==> Готовлю secrets.env из .env"
        $keep = "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"
        $lines = New-Object Collections.Generic.List[string]
        foreach ($l in [IO.File]::ReadAllLines((Join-Path $Root ".env"))) {
            if ($l -match '^\s*([A-Z0-9_]+)\s*=(.*)$' -and $keep -contains $Matches[1] -and $Matches[2].Trim() -ne "") {
                $lines.Add("$($Matches[1])=$($Matches[2].Trim())")
            }
        }
        # Свой ключ сессий для сервера: локальные входы там недействительны.
        $bytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $lines.Add("SESSION_PASSWORD=" + (($bytes | ForEach-Object { $_.ToString("x2") }) -join ""))
        if ($Domain) { $lines.Add("PUBLIC_URL=https://$Domain") }
        [IO.File]::WriteAllText((Join-Path $Stage "secrets.env"), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
    }

    if ($WithData) {
        Write-Host "==> Готовлю копию базы"
        New-Item -ItemType Directory -Force (Join-Path $Stage "data") | Out-Null
        # согласованный снимок (вместе с журналом WAL), можно и при открытой программе
        node (Join-Path $PSScriptRoot "snapshot-db.mjs") "data/genagent.db" (Join-Path $Stage "data\genagent.db")
        if ($LASTEXITCODE -ne 0) { throw "Не удалось скопировать базу" }
    }

    Write-Host "==> Упаковываю и загружаю на $Server"
    $Tar = Join-Path $Work "genagent-upload.tar.gz"
    tar -czf $Tar -C $Work genagent-upload
    if ($LASTEXITCODE -ne 0) { throw "tar не сработал" }
    # в домашнюю папку deploy (закрыта для других), а не в общий /tmp: в архиве могут быть секреты и база
    scp -o BatchMode=yes $Tar "${Server}:genagent-upload.tar.gz"
    if ($LASTEXITCODE -ne 0) { throw "scp не сработал" }

    Write-Host "==> Устанавливаю на сервере"
    $remote = "set -e; umask 077; cd ~ && rm -rf genagent-upload && tar -xzf genagent-upload.tar.gz && rm -f genagent-upload.tar.gz; " +
              "trap 'rm -rf ~/genagent-upload' EXIT; bash ~/genagent-upload/deploy/install.sh ~/genagent-upload"
    ssh $Server $remote
    if ($LASTEXITCODE -ne 0) { throw "Установка на сервере не удалась — смотрите сообщения выше" }

    if ($Domain) {
        Write-Host "==> Подключаю домен $Domain в Caddy"
        ssh $Server "bash ~/bots/genagent/caddy-add.sh $Domain"
        if ($LASTEXITCODE -ne 0) { throw "Caddy: домен не подключён — смотрите сообщения выше" }
    }
    Write-Host "ГОТОВО. Студия: https://$AdminOrigin"

    # Копия истории на GitHub (закрытый репозиторий hudineugene/genagent) — после успешной выкладки.
    # Отправляются записанные изменения (git commit); не получилось — выкладка всё равно состоялась.
    $ErrorActionPreference = "Continue"  # сообщения git в stderr Windows PowerShell иначе считает ошибкой
    Push-Location $Root
    if (git remote 2>$null) {
        git push -q origin HEAD *> $null
        if ($LASTEXITCODE -eq 0) { Write-Host "История отправлена на GitHub." }
        else { Write-Host "История на GitHub не отправилась (нет сети или вход устарел) — выкладка при этом прошла. Вручную: git push" -ForegroundColor Yellow }
    }
    Pop-Location
}
finally {
    # во временной папке могли лежать база и секреты — убираем
    Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
