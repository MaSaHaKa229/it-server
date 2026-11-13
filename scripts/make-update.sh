#!/usr/bin/env bash
# Собирает полный архив обновления для сервера без интернета (без node_modules и .env).
#   scripts/make-update.sh [папка-для-результата]
# В архиве: server, public, scripts, файлы проекта и УСТАНОВКА.txt (порядок установки).
# Если менялись зависимости (package.json) — node_modules нужно переносить отдельно, см. INSTALL.md.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/dist-offline}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/it-portal" "$out"
git -C "$root" archive HEAD server public scripts package.json package-lock.json start-portal.bat README.md INSTALL.md .env.example \
  | tar -x -C "$tmp/it-portal"
cp "$root/scripts/UPDATE-README.txt" "$tmp/it-portal/УСТАНОВКА.txt"
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
(cd "$tmp" && zip -qr9 "$out/it-portal-full-update.zip" it-portal)
echo "Готово: $out/it-portal-full-update.zip"
