#!/bin/sh
# Deurbel — automatische updater
# Draait in een eigen container, kijkt elke paar uur op GitHub of er een nieuwe versie is
# en bouwt de app dan opnieuw. Je .env en je gegevens blijven altijd staan.
set -u
DIR="${HOST_DIR:?HOST_DIR ontbreekt}"
cd "$DIR" || exit 1
command -v git >/dev/null 2>&1 || apk add --no-cache git >/dev/null 2>&1
git config --global --add safe.directory '*'
mkdir -p "$DIR/deurbel-data"
STATUS="$DIR/deurbel-data/update.json"
FLAG="$DIR/deurbel-data/update-now"
HOURS="${UPDATE_HOURS:-6}"
AUTO="${AUTO_UPDATE:-true}"

esc() { tr -d '\n\r' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
status() {
  cur=$(git rev-parse --short HEAD 2>/dev/null)
  latest=$(git rev-parse --short origin/main 2>/dev/null || echo "$cur")
  title=$(git log -1 --format=%s 2>/dev/null | esc)
  cdate=$(git log -1 --format=%cI 2>/dev/null)
  ltitle=$(git log -1 --format=%s origin/main 2>/dev/null | esc)
  msg=$(printf '%s' "$2" | esc)
  printf '{"state":"%s","message":"%s","current":"%s","latest":"%s","currentTitle":"%s","currentDate":"%s","latestTitle":"%s","checkedAt":"%s","auto":%s,"hours":%s}\n' \
    "$1" "$msg" "$cur" "$latest" "$title" "$cdate" "$ltitle" "$(date -Iseconds)" "$AUTO" "$HOURS" > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  echo "$(date '+%H:%M:%S') $1: $2"
}

# eufy-security-ws (koppeling met Eufy) hooguit één keer per dag bijwerken; dat downloaden kost tijd
eufy_update() {
  [ "${UPDATE_EUFY:-true}" = "true" ] || return
  stamp="$DIR/deurbel-data/.eufy-pull"
  if [ -f "$stamp" ] && [ $(( $(date +%s) - $(cat "$stamp") )) -lt 86400 ]; then return; fi
  date +%s > "$stamp"
  echo "$(date '+%H:%M:%S') eufy-security-ws bijwerken (dagelijks)"
  docker compose pull -q eufy >/dev/null 2>&1 && docker compose up -d eufy >/dev/null 2>&1
}

check() { # $1 = 1 om ook te installeren als automatisch bijwerken uit staat
  if ! git fetch -q origin main 2>/tmp/err; then status error "GitHub niet bereikbaar: $(tail -c 150 /tmp/err)"; return; fi
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then status ok "Je hebt de nieuwste versie"; eufy_update; return; fi
  if [ "$AUTO" != "true" ] && [ "$1" != "1" ]; then status available "Update beschikbaar"; return; fi
  status updating "Bijwerken naar de nieuwste versie…"
  old=$(git rev-parse HEAD)
  git reset -q --hard origin/main
  status updating "Nieuwe versie bouwen en herstarten…"
  if docker compose up -d --build deurbel >/tmp/out 2>&1; then
    status ok "Bijgewerkt naar de nieuwste versie"
  else
    git reset -q --hard "$old"
    docker compose up -d --build deurbel >/dev/null 2>&1
    status error "Bijwerken mislukt, vorige versie teruggezet: $(tail -c 200 /tmp/out)"
  fi
  # is dit script zelf veranderd? dan opnieuw starten met de nieuwe versie
  if ! git diff --quiet "$old" HEAD -- updater/update.sh; then echo "Updater vernieuwd, herstarten"; exec sh "$DIR/updater/update.sh"; fi
}

status ok "Updater gestart"
check 0
last=$(date +%s)
while true; do
  sleep 3
  if [ -f "$FLAG" ]; then
    action=$(cat "$FLAG"); rm -f "$FLAG"
    if [ "$action" = "install" ]; then check 1; else check 0; fi
    last=$(date +%s); continue
  fi
  now=$(date +%s)
  if [ $((now - last)) -ge $((HOURS * 3600)) ]; then check 0; last=$now; fi
done
