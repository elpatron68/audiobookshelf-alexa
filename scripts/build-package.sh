#!/usr/bin/env bash
#
# Builds the AWS Lambda deployment ZIP package for the Audiobookshelf Alexa Skill.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LAMBDA_DIR="${REPO_ROOT}/lambda"
ZIP_PATH="${REPO_ROOT}/audiobookshelf-alexa.zip"

echo "=========================================================="
echo "  Building Audiobookshelf Alexa Skill Lambda Package      "
echo "=========================================================="

cd "${LAMBDA_DIR}"

echo ""
echo "[1/3] Installing dependencies..."
npm install

echo ""
echo "[2/3] Running test suite..."
npm test
echo "--> All tests passed."

echo ""
echo "[3/3] Creating ZIP archive..."
rm -f "${ZIP_PATH}"
zip -r "${ZIP_PATH}" . -x "test/*"

echo ""
echo "=========================================================="
echo "  SUCCESS! Package created: ${ZIP_PATH}"
echo "=========================================================="
