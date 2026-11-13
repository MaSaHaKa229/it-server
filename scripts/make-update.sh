#!/usr/bin/env bash
# Собирает полный архив обновления для сервера без интернета (без node_modules и .env).
#   scripts/make-update.sh [папка-для-результата]
# В архиве: server, public, scripts, файлы проекта и УСТАНОВКА.txt (порядок установки).
# Если менялись зависимости (package.json) — node_modules нужно переносить отдельно, см. INSTALL.md.
# Исключение — распознавание сканов: его компоненты кладутся в server/vendor/ocr (scripts/vendor-ocr.js).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist-offline}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/it-portal" "$out"
git -C "$root" archive HEAD server public scripts package.json package-lock.json start-portal.bat README.md INSTALL.md .env.example \
  | tar -x -C "$tmp/it-portal"
cp "$root/scripts/UPDATE-README.txt" "$tmp/it-portal/УСТАНОВКА.txt"
# Обновление одной кнопкой: запускает scripts\update-portal.ps1
cp "$root/scripts/update-portal.cmd" "$tmp/it-portal/ОБНОВИТЬ ПОРТАЛ.cmd"
# Версия сборки — для страницы «Состояние системы»
printf '{"built":"%s","commit":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git -C "$root" rev-parse --short HEAD)" > "$tmp/it-portal/server/version.json"
# Компоненты распознавания сканов PDF — внутри server (папку server пользователь заменяет целиком)
node "$root/scripts/vendor-ocr.js" "$tmp/it-portal/server/vendor/ocr"
# Программы удалённого доступа (в git не хранятся): сборка репозитория RemoteSupport (./build.sh → dist/).
# Папку можно указать переменной REMOTE_DIST; по умолчанию — RemoteSupport-/dist рядом с этим репозиторием.
remote_dist="${REMOTE_DIST:-$root/../RemoteSupport-/dist}"
mkdir -p "$tmp/it-portal/public/remote/downloads"
for f in ITRemoteViewer.exe ITRemoteViewer-win7.exe ITRemoteAgent-x64.exe ITRemoteAgent-x86.exe; do
  if [[ -f "$remote_dist/$f" ]]; then
    cp "$remote_dist/$f" "$tmp/it-portal/public/remote/downloads/"
  else
    echo "ВНИМАНИЕ: нет $remote_dist/$f — в архиве не будет этой программы удалённого доступа" >&2
  fi
done
# nginx.conf для Windows — с переводами строк CRLF
sed -i 's/\r$//; s/$/\r/' "$tmp/it-portal/scripts/nginx.conf"
rm -f "$out/it-portal-full-update.zip"
# Архив — средствами Python: русские имена файлов помечаются как UTF-8 (утилита zip этого не делает,
# и стандартная распаковка Windows показывала вместо «УСТАНОВКА.txt» набор символов)
python3 - "$tmp" "$out/it-portal-full-update.zip" <<'PY'
import os, sys, zipfile
base, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for d, dirs, files in os.walk(os.path.join(base, 'it-portal')):
        dirs.sort()
        rel = os.path.relpath(d, base)
        z.write(d, rel)
        for f in sorted(files):
            z.write(os.path.join(d, f), os.path.join(rel, f))
PY
echo "Готово: $out/it-portal-full-update.zip"
