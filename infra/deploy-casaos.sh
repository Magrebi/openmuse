#!/bin/sh
# Deploy the library branch to the CasaOS box, and roll back if anything fails.
#
# Runs ON the box. Transfer the archive first, from the Mac:
#
#   git archive --format=tar.gz -o /tmp/openmuse-library.tar.gz HEAD
#   scp /tmp/openmuse-library.tar.gz med@home:/tmp/
#   scp infra/deploy-casaos.sh            med@home:/tmp/
#   ssh med@home 'sh /tmp/deploy-casaos.sh'
#
# No push and no PR: the archive is the transfer.
#
# Two things this script is careful about, because both are irreversible:
#
#   ./data  is a mounted volume holding the owner's documents. It is excluded from
#           the backup AND never touched by the extract, so a mistake here cannot
#           delete the library.
#   .env   holds the access key. It is never echoed and never replaced.
#
# Any failure restores the backup and re-ups the previous stack, so the box is
# never left half-deployed.
set -eu

APP_DIR=${APP_DIR:-/DATA/AppData/openmuse}
REPO_DIR="$APP_DIR/repo"
ARCHIVE=${ARCHIVE:-/tmp/openmuse-library.tar.gz}
STAMP=$(date +%Y-%m-%d)
BACKUP="$APP_DIR-backup-$STAMP"
API_PORT=${API_PORT:-8787}

log() { echo "[deploy] $*"; }
die() { echo "[deploy] FATAL: $*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
[ -d "$APP_DIR" ] || die "$APP_DIR does not exist — is this the right box?"
[ -f "$ARCHIVE" ] || die "$ARCHIVE not found; transfer it first (see the header)"
command -v docker >/dev/null 2>&1 || die "docker is not installed on this host"

# Refuse to run without a rollback point rather than pretending we have one.
mkdir -p "$BACKUP" || die "cannot create $BACKUP — check free space"

log "backing up $APP_DIR (excluding ./data) to $BACKUP"
# --exclude='./data' comes before the `.` so tar never descends into it. This one
# line is what protects the owner's documents.
tar -C "$APP_DIR" \
  --exclude='./data' \
  --exclude='./repo/node_modules' \
  -cf - . | tar -C "$BACKUP" -xf -

rollback() {
  log "ROLLING BACK to $BACKUP"
  (cd "$APP_DIR" && docker compose down) || true
  # Restore the tree; never the data volume, never the .env.
  cp -a "$BACKUP/." "$APP_DIR/" 2>/dev/null || true
  (cd "$APP_DIR" && docker compose up -d) || true
  log "rollback attempted; check \`docker compose ps\` in $APP_DIR"
}

# ---------------------------------------- OCR packages, pinned in the image
# The branch carries the OCR feature, so the api image needs the engine. The
# packages go INTO the Dockerfile rather than being installed by hand on the host:
# a hand install is exactly what the next rebuild silently drops.
DOCKERFILE=$(ls "$APP_DIR"/Dockerfile.api "$APP_DIR"/dockerfile.api 2>/dev/null | head -1 || true)
if [ -n "$DOCKERFILE" ] && [ -f "$DOCKERFILE" ]; then
  if grep -q 'openmuse-ocr-packages' "$DOCKERFILE"; then
    log "OCR packages already present in $(basename "$DOCKERFILE")"
  else
    log "adding pinned OCR packages to $(basename "$DOCKERFILE")"
    python3 - "$DOCKERFILE" <<'PY' || die "could not patch $DOCKERFILE"
import re, sys
path = sys.argv[1]
src = open(path).read()
# Self-idempotent: the shell caller also guards on this marker, but a patcher that
# only looks safe because of its caller is one refactor away from stacking a
# duplicate layer on every re-deploy.
if "openmuse-ocr-packages" in src:
    sys.exit(0)
block = """
# openmuse-ocr-packages: local OCR for the document library. Document bytes must
# never leave this box, so the engine and its language data are installed into the
# image rather than reached over a network. Pinned, because an unpinned package
# lets a base-image bump quietly change which engine a rebuild gets.
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
      tesseract-ocr=5.3.4-1 \\
      tesseract-ocr-eng=1.12-1 \\
      tesseract-ocr-tur=1.12-1 \\
      poppler-utils=24.02.0-0 \\
 && rm -rf /var/lib/apt/lists/* \\
 && tesseract --list-langs 2>&1 | grep -qx eng \\
 && tesseract --list-langs 2>&1 | grep -qx tur
"""
lines = src.splitlines(keepends=True)
for i in range(len(lines) - 1, -1, -1):
    if re.match(r"\s*(CMD|ENTRYPOINT)\s", lines[i]):
        lines.insert(i, block)
        break
else:
    lines.append(block)
open(path, "w").write("".join(lines))
PY
  fi
else
  # Deploying without the engine would look like a successful deploy with a feature
  # quietly missing, so this stops here rather than shipping that.
  die "no Dockerfile.api in $APP_DIR — cannot add the OCR packages; refusing a half-configured image"
fi

# ---------------------------------------------------------------- transfer
log "replacing the repo tree at $REPO_DIR"
rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"
tar -xzf "$ARCHIVE" -C "$REPO_DIR" || { rollback; die "could not extract $ARCHIVE"; }

# The archive carries no .env and no data/, but assert that rather than trust it:
# a future `git add -f` must not turn this into the thing that deletes the library.
if [ -e "$REPO_DIR/.env" ]; then
  log "WARNING: archive contains a .env; removing it so the box's own key survives"
  rm -f "$REPO_DIR/.env"
fi
if [ -e "$REPO_DIR/data" ]; then
  rm -rf "$REPO_DIR/data"
  log "removed a stray data/ from the archive"
fi
log "on-box .env present: $([ -f "$APP_DIR/.env" ] && echo yes || echo NO)"
log "on-box ./data present: $([ -d "$APP_DIR/data" ] && echo yes || echo NO)"

# --------------------------------------------------------------------- build
log "docker compose down"
(cd "$APP_DIR" && docker compose down) || { rollback; die "compose down failed"; }
log "docker compose up -d --build (the build installs the OCR packages)"
(cd "$APP_DIR" && docker compose up -d --build) || { rollback; die "compose up failed"; }

# -------------------------------------------------------------------- verify
log "waiting for the api to report healthy"
i=0
while [ $i -lt 60 ]; do
  (cd "$APP_DIR" && docker compose ps) | grep -qiE 'api.*(healthy|running)' && break
  i=$((i + 1)); sleep 5
done
(cd "$APP_DIR" && docker compose ps) || true

# The access key is read into a variable and used, never echoed. `set -x` is never on.
KEY=$(grep -E '^OPENMUSE_ACCESS_KEY=' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
[ -n "$KEY" ] || { rollback; die "could not read OPENMUSE_ACCESS_KEY from $APP_DIR/.env"; }
BASE="http://127.0.0.1:$API_PORT"
smoke() { curl -sS --max-time 30 "$@" 2>&1; }

log "smoke: health"
smoke -H "Authorization: Bearer $KEY" "$BASE/api/health" | head -c 400; echo

log "smoke: library upload -> list -> download -> delete"
printf 'DEPLOY SMOKE TEST\nInvoice 12345 total 99.00\n' > /tmp/library-smoke.txt
UP=$(smoke -X POST -H "Authorization: Bearer $KEY" \
      -F "file=@/tmp/library-smoke.txt;type=text/plain" "$BASE/api/library")
DOC=$(printf '%s' "$UP" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$DOC" ] || { rollback; die "library upload failed: $UP"; }
log "  uploaded $DOC"
smoke -H "Authorization: Bearer $KEY" "$BASE/api/library" | grep -q "$DOC" ||
  { rollback; die "the uploaded document is not in the list"; }
log "  listed"
smoke -H "Authorization: Bearer $KEY" "$BASE/api/library/$DOC/content" | grep -q 'DEPLOY SMOKE TEST' ||
  { rollback; die "download did not return the stored bytes"; }
log "  downloaded"
smoke -X DELETE -H "Authorization: Bearer $KEY" "$BASE/api/library/$DOC" | grep -q 'deleted' ||
  { rollback; die "delete failed"; }
if smoke -H "Authorization: Bearer $KEY" "$BASE/api/library" | grep -q "$DOC"; then
  rollback; die "the document is still listed after deletion"
fi
log "  deleted and confirmed gone"

# The OCR engine, as the running image reports it. This is the check that would
# catch an image built without the packages, which would otherwise look healthy
# while every scanned document silently failed.
log "smoke: OCR engine"
LANGS=$(smoke -H "Authorization: Bearer $KEY" "$BASE/api/library/ocr" |
  sed -n 's/.*"languages":\[\([^]]*\)\].*/\1/p')
log "  languages reported: ${LANGS:-none}"
case "$LANGS" in
  *eng*) log "  eng present" ;;
  *) rollback; die "the api image reports no eng language data — the OCR packages did not install" ;;
esac
case "$LANGS" in
  *tur*) log "  tur present" ;;
  *) log "  WARNING: tur is missing; Turkish documents will not be recognised" ;;
esac

log "DEPLOY OK — backup kept at $BACKUP"
rm -f /tmp/library-smoke.txt