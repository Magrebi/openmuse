#!/bin/sh
# Re-verify every previously-claimed fix by reverting it and confirming a test fails.
#
# "Trust but verify": the previous rounds reported that each fix had a regression
# test. This re-applies each defect and re-runs the suite, recording pass/fail per
# mutation. A fix with no failing test shows up here as "NOT CAUGHT".
#
# Read-only with respect to git: every mutation is reverted from a backup.
set -u
cd "$(dirname "$0")/.." || exit 1

LIB=apps/server/src/library.ts
FMT=apps/server/src/library-format.ts
DB=apps/server/src/db.ts
OCR=apps/server/src/ocr.ts
Q=apps/server/src/ocr-queue.ts
OUT=${1:-/tmp/mutation-recheck.log}
: > "$OUT"

mkdir -p /tmp/recheck
for f in "$LIB" "$FMT" "$DB" "$OCR" "$Q"; do cp "$f" "/tmp/recheck/$(basename "$f")"; done

restore() {
  cp "/tmp/recheck/$(basename "$1")" "$1"
}

# mutate <name> <file> <python-replacement-expr> <test-file...>
mutate() {
  name=$1; file=$2; expr=$3; shift 3
  restore "$file"
  FILE="$file" EXPR="$expr" python3 -c '
import os
p = os.environ["FILE"]; s = open(p).read()
exec(os.environ["EXPR"])
open(p, "w").write(s)
' 2>/dev/null
  if cmp -s "$file" "/tmp/recheck/$(basename "$file")"; then
    echo "SETUP-ERROR $name (mutation did not apply)" >> "$OUT"
    restore "$file"
    return
  fi
  if npx tsx --test "$@" > /tmp/recheck/run.log 2>&1; then
    echo "NOT CAUGHT  $name" >> "$OUT"
  else
    echo "caught      $name" >> "$OUT"
  fi
  restore "$file"
}

echo "== library round: path, MIME, quota, fence, share token ==" >> "$OUT"

mutate "1 safeFilename: leading-dot strip" "$FMT" \
  's=s.replace(chr(39)+".replace(/^[.\\s]+/, \"\")"+chr(39), chr(39)+".replace(/^\\s+/, \"\")"+chr(39))' \
  tests/library-format.test.ts tests/library.test.ts

mutate "2 resolveMimeType: trust declared type" "$FMT" \
  's=s.replace("if (claimed && !WEAK_DECLARATIONS.has(claimed) && claimed !== sniffed)","if (false)")' \
  tests/library-format.test.ts tests/library.test.ts

mutate "3 downloadHeaders: serve inline" "$FMT" \
  's=s.replace("`attachment; filename=","`inline; filename=")' \
  tests/library-format.test.ts tests/library.test.ts

mutate "4 documentBlock: drop truncation marker" "$FMT" \
  's=s.replace("...(input.truncated ? [TRUNCATION_MARKER] : []),","")' \
  tests/library-format.test.ts tests/library.test.ts

mutate "5 documentBlock: no fence neutralisation" "$FMT" \
  's=s.replace("const neutralise = (text: string) => text.replaceAll(FENCE_TOKEN, \"[removed]\");","const neutralise = (text: string) => text;")' \
  tests/library-format.test.ts tests/library.test.ts

mutate "6 quota: non-atomic read-then-write" "$DB" \
  's=s.replace("AND safe_bigint(data->>\x27used\x27)+$2::bigint <= $5::bigint","")' \
  tests/library.test.ts

mutate "7 getLiveShare: bare timestamptz cast" "$DB" \
  's=s.replace("AND safe_timestamptz(data->>\x27expiresAt\x27) > now()","AND (data->>\x27expiresAt\x27)::timestamptz > now()")' \
  tests/library.test.ts

mutate "8 createShare: no NaN clamp" "$LIB" \
  's=s.replace("const requested = Number.isFinite(days) ? Math.floor(days) : SHARE_DEFAULT_DAYS;","const requested = Math.floor(days);")' \
  tests/library.test.ts

mutate "9 delete: leave the share token row" "$LIB" \
  's=s.replace("      this.withdrawTokens(document.id),\n","")' \
  tests/library.test.ts

echo "== OCR round: subprocess, hybrid, pipeline ==" >> "$OUT"

mutate "10 hybrid PDF: all-or-nothing OCR check" "$LIB" \
  's=s.replace("&& (mimeType !== \"application/pdf\" || (await this.pdfHasUnreadPages(bytes)));","&& true;")' \
  tests/ocr.test.ts

mutate "11 upload returns pre-index record" "$LIB" \
  's=s.replace("return (await this.db.get<LibraryDocument>(owner, DOCS, id)) ?? document;","return document;")' \
  tests/ocr.test.ts

mutate "12 ocr run(): enable the shell" "$OCR" \
  's=s.replace("      shell: false,","      shell: true,")' \
  tests/ocr.test.ts

mutate "13 ocr run(): inherit full env" "$OCR" \
  's=s.replace("for (const key of [\"PATH\", \"HOME\"]) {","Object.assign(env, process.env);\n    for (const key of [] as string[]) {")' \
  tests/ocr.test.ts

mutate "14 parseLanguages: stop validating" "$OCR" \
  's=s.replace("  if (!LANGUAGE_PATTERN.test(value))","  if (false)")' \
  tests/ocr.test.ts

mutate "15 ocr run(): no SIGKILL on timeout" "$OCR" \
  's=s.replace("      result.timedOut = true;\n      kill(false);","      result.timedOut = true;")' \
  tests/ocr.test.ts

mutate "16 queue: abort not threaded to the job" "$Q" \
  's=s.replace("await job.run(controller.signal);","await job.run(new AbortController().signal);")' \
  tests/ocr.test.ts

mutate "17 delete: do not abort in-flight OCR" "$LIB" \
  's=s.replace("    this.ocr?.abort(document.id);\n","")' \
  tests/ocr.test.ts

mutate "18 runOcr: no re-check before indexing" "$LIB" \
  's=s.replace("      if (!(await this.db.get(owner, DOCS, id))) {\n        await this.db.remove(owner, TEXTS, id);\n        return { text: \"\", truncated: false, ocr: true };\n      }\n","")' \
  tests/ocr.test.ts

echo "" >> "$OUT"
echo "summary:" >> "$OUT"
grep -c '^caught' "$OUT" >> "$OUT"
grep -c '^NOT CAUGHT' "$OUT" >> "$OUT"
cat "$OUT"