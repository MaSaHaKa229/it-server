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
# Компоненты распознавания сканов PDF — внутри server (папку server пользователь заменяет целиком)
node "$root/scripts/vendor-ocr.js" "$tmp/it-portal/server/vendor/ocr"
# nginx.conf для Windows — с переводами строк CRLF
sed -i 's/\r$//; s/$/\r/' "$tmp/it-portal/scripts/nginx.conf"
rm -f "$out/it-portal-full-update.zip"
(cd "$tmp" && zip -qr9 "$out/it-portal-full-update.zip" it-portal)
echo "Готово: $out/it-portal-full-update.zip"
