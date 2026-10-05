#!/bin/sh
# Install the local OCR engine the library needs.
#
# Document bytes never leave this box: recognition runs here, with the language
# data installed here. There is no cloud OCR service and no model download on
# first use, so this script is the whole of the "no egress" story — if it is not
# run, `tesseract` is simply absent and every scanned document is marked failed
# (the library keeps working; only its text is missing).
#
# Pinning matters. An unpinned `apt-get install tesseract-ocr` lets a base-image
# bump change which engine a rebuild gets, which is how a working deployment
# quietly starts misreading Turkish documents. The versions below are the ones
# this feature was built and tested against.
#
# Usage: sh infra/install-ocr.sh
set -eu

TESSERACT_VERSION="5.3.4"
TESSERACT_TUR_VERSION="1.12"
POPPLER_VERSION="24.02.0"

if [ "$(id -u)" -ne 0 ]; then
  echo "This installs system packages; run it as root." >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  # The version pins below are the Debian package versions. If a distro has moved
  # on, apt reports the mismatch rather than silently installing something else —
  # check the version it names before overriding it.
  apt-get install -y --no-install-recommends \
    "tesseract-ocr=${TESSERACT_VERSION}-1" \
    "tesseract-ocr-tur=${TESSERACT_TUR_VERSION}-1" \
    "tesseract-ocr-eng=${TESSERACT_TUR_VERSION}-1" \
    "poppler-utils=${POPPLER_VERSION}-0"
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y tesseract tesseract-langpack-tur poppler-utils
elif command -v brew >/dev/null 2>&1; then
  # macOS, for development. Homebrew keeps its own version policy; the pin is the
  # minimum we test against, not something Homebrew can express.
  brew install tesseract tesseract-lang poppler
else
  echo "No supported package manager found. Install tesseract-ocr with the eng and" >&2
  echo "tur language packs, and poppler-utils for pdftoppm, then re-run." >&2
  exit 1
fi

# Prove the install rather than trusting it. `tur` is the reason this exists: an
# install without it recognises English and silently garbles Turkish.
echo "Installed languages:"
tesseract --list-langs 2>&1 | grep -E '^(eng|tur)$' || {
  echo "eng or tur language data is missing; Turkish documents will not be recognised." >&2
  exit 1
}
pdftoppm -v 2>&1 | head -1 || {
  echo "pdftoppm is missing; scanned PDFs will not be rendered." >&2
  exit 1
}
echo "OCR engine ready."