#!/bin/bash
# Deurbel installeren, of een bestaande installatie omzetten naar automatische updates.
# Gebruik:  curl -fsSL https://raw.githubusercontent.com/smikkelvriend/deurbel/main/install.sh | bash
set -e
REPO="https://github.com/smikkelvriend/deurbel.git"
DIR="$HOME/deurbel"
OLD="$HOME/deurbel-oud-$(date +%Y%m%d-%H%M%S)"

echo "=== Deurbel installeren ==="
command -v git >/dev/null || { echo "git installeren…"; sudo apt-get install -y git >/dev/null; }
command -v docker >/dev/null || { echo "Docker installeren…"; sudo apt-get install -y docker.io docker-compose-v2 >/dev/null || sudo apt-get install -y docker.io docker-compose >/dev/null; }
DOCKER="docker"; docker ps >/dev/null 2>&1 || DOCKER="sudo docker"

if [ -d "$DIR/.git" ]; then
  echo "Deurbel staat al op GitHub-updates, bijwerken…"
  cd "$DIR"
  sudo git config --global --add safe.directory "$DIR" 2>/dev/null || true
  git config --global --add safe.directory "$DIR" 2>/dev/null || true
  sudo git fetch -q origin main && sudo git reset -q --hard origin/main
else
  if [ -d "$DIR" ]; then
    echo "Bestaande installatie gevonden. Je instellingen, opnames en foto's worden meegenomen."
    (cd "$DIR" && $DOCKER compose down) || true
    mv "$DIR" "$OLD"
  fi
  git clone -q "$REPO" "$DIR"
  cd "$DIR"
  if [ -d "$OLD" ]; then
    [ -f "$OLD/.env" ] && cp "$OLD/.env" .env
    for d in deurbel-data eufy-data; do [ -d "$OLD/$d" ] && sudo mv "$OLD/$d" ./; done
    # instellingen die eerder in docker-compose.yml stonden naar .env verhuizen
    for k in STATION_IP_ADDRESSES P2P_CONNECTION_SETUP; do
      v=$(grep -oP "^\s*$k:\s*\"?\K[^\"]+" "$OLD/docker-compose.yml" 2>/dev/null | head -1 || true)
      if [ -n "$v" ] && ! grep -q "^$k=." .env 2>/dev/null; then sed -i "/^$k=/d" .env; echo "$k=$v" >> .env; echo "  $k=$v overgenomen"; fi
    done
    echo "Oude map bewaard als $OLD (mag je later weggooien)."
  fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Vul nu je gegevens in:  nano $DIR/.env"
  echo "Draai daarna dit script opnieuw."
  exit 0
fi
sed -i '/^HOST_DIR=/d' .env && echo "HOST_DIR=$DIR" >> .env

echo "Starten (de eerste keer duurt dit een paar minuten)…"
$DOCKER compose up -d --build --remove-orphans
PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8080}
echo
echo "=== Klaar! ==="
echo "Dashboard: http://$(hostname -I | awk '{print $1}'):$PORT"
echo "Updates worden vanaf nu automatisch van GitHub gehaald."
