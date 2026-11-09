#!/usr/bin/env bash
# Met à jour Freebox Monitor : récupère la dernière image, recrée le conteneur, vérifie qu'il repart,
# puis supprime les anciennes images.
#
# Usage : ./update.sh [-f|--force] [dossier]
#   dossier     dossier qui contient docker-compose.yml (défaut : celui du script, sinon ~/freebox-monitor)
#   -f/--force  recrée le conteneur même si l'image n'a pas changé
#
# Installation dans la VM : copier ce fichier à côté de docker-compose.yml puis `chmod +x update.sh`.
set -euo pipefail

SERVICE=freebox-monitor
FORCE=0
DIR=""

for arg in "$@"; do
  case "$arg" in
    -f|--force) FORCE=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) DIR="$arg" ;;
  esac
done

if [ -t 1 ]; then VERT=$'\e[32m'; ROUGE=$'\e[31m'; JAUNE=$'\e[33m'; GRAS=$'\e[1m'; RAZ=$'\e[0m'
else VERT=""; ROUGE=""; JAUNE=""; GRAS=""; RAZ=""; fi
info()   { echo "${GRAS}==>${RAZ} $*"; }
ok()     { echo "${VERT}✔${RAZ} $*"; }
alerte() { echo "${JAUNE}!${RAZ} $*"; }
echec()  { echo "${ROUGE}✘ $*${RAZ}" >&2; exit 1; }

# Dossier de la stack
if [ -z "$DIR" ]; then
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [ -f "$script_dir/docker-compose.yml" ] || [ -f "$script_dir/compose.yml" ]; then DIR="$script_dir"
  else DIR="$HOME/freebox-monitor"; fi
fi
[ -d "$DIR" ] || echec "Dossier introuvable : $DIR"
cd "$DIR"
[ -f docker-compose.yml ] || [ -f compose.yml ] || echec "Pas de docker-compose.yml dans $DIR"

command -v docker >/dev/null || echec "Docker n'est pas installé"
docker compose version >/dev/null 2>&1 || echec "Le plugin « docker compose » est absent"
docker info >/dev/null 2>&1 || echec "Impossible de parler à Docker (ajouter l'utilisateur au groupe docker, ou lancer avec sudo)"

IMAGE=$(docker compose config --images 2>/dev/null | head -n1)
[ -n "$IMAGE" ] || echec "Image introuvable dans le fichier compose"

# Version d'une image : commit court (label posé par la CI) et date de construction
version_de() {
  local ref=$1 rev created
  rev=$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref" 2>/dev/null || true)
  created=$(docker image inspect -f '{{.Created}}' "$ref" 2>/dev/null || true)
  [ -n "$created" ] || { echo "aucune"; return; }
  created=$(date -d "$created" '+%d/%m/%Y %H:%M' 2>/dev/null || echo "${created%%.*}")
  if [ -n "$rev" ] && [ "$rev" != "<no value>" ]; then echo "${rev:0:7} du $created"; else echo "image du $created"; fi
}

AVANT_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)
AVANT=$(version_de "$IMAGE")
info "Dossier : $DIR"
info "Image   : $IMAGE (actuelle : $AVANT)"

info "Téléchargement de la dernière image…"
if ! sortie=$(docker compose pull "$SERVICE" 2>&1); then
  echo "$sortie" >&2
  if grep -qiE 'denied|unauthorized' <<<"$sortie"; then
    echec "Accès refusé à ghcr.io : se connecter avec un jeton read:packages
   echo <jeton> | docker login ghcr.io -u jhenninot --password-stdin"
  fi
  echec "Échec du téléchargement de l'image"
fi
APRES_ID=$(docker image inspect -f '{{.Id}}' "$IMAGE")

if [ "$AVANT_ID" = "$APRES_ID" ] && [ "$FORCE" -eq 0 ]; then
  # L'image est à jour, mais le conteneur tourne-t-il bien sur elle ?
  CONT_ID=$(docker compose ps -q "$SERVICE" 2>/dev/null || true)
  CONT_IMG=$( [ -n "$CONT_ID" ] && docker inspect -f '{{.Image}}' "$CONT_ID" 2>/dev/null || true)
  if [ -n "$CONT_ID" ] && [ "$CONT_IMG" = "$APRES_ID" ]; then
    ok "Déjà à jour ($AVANT), rien à faire. (--force pour recréer quand même)"
    exit 0
  fi
  alerte "Image déjà présente mais le conteneur ne l'utilise pas : il va être recréé"
fi

info "Recréation du conteneur…"
docker compose up -d --remove-orphans "$SERVICE"

# Attendre que le healthcheck de l'image passe à « healthy » (2 min au plus)
CONT_ID=$(docker compose ps -q "$SERVICE")
info "Attente du démarrage…"
etat=""
for _ in $(seq 1 60); do
  etat=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONT_ID" 2>/dev/null || echo "?")
  case "$etat" in
    healthy) break ;;
    unhealthy|exited|dead) break ;;
  esac
  sleep 2
done

if [ "$etat" != "healthy" ]; then
  alerte "Le conteneur n'est pas en bonne santé (état : $etat). Derniers journaux :"
  docker compose logs --tail 30 "$SERVICE" >&2 || true
  echec "Mise à jour faite mais l'appli ne répond pas"
fi
ok "Conteneur démarré et en bonne santé"

info "Nettoyage des anciennes images…"
docker image prune -f >/dev/null && ok "Anciennes images supprimées"

APRES=$(version_de "$IMAGE")
PORT=$(docker compose port "$SERVICE" 8080 2>/dev/null | sed 's/.*://' || true)
echo
ok "${GRAS}Freebox Monitor mis à jour${RAZ} : $AVANT → $APRES"
[ -n "$PORT" ] && echo "   http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
exit 0
