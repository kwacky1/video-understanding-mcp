#!/bin/sh
set -eu

MODEL_NAME="large-v3-turbo-q5_0"
MODEL_FILE="ggml-${MODEL_NAME}.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}"
MODEL_SHA256="394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"
OUTPUT_DIR="${1:-${HOME}/.local/share/video-understanding-mcp/models}"
OUTPUT_PATH="${OUTPUT_DIR}/${MODEL_FILE}"
TEMP_PATH="${OUTPUT_PATH}.partial"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: $0 [output-directory]"
  echo "Downloads and SHA-256 verifies ${MODEL_FILE}."
  exit 0
fi

mkdir -p "${OUTPUT_DIR}"

verify_checksum() {
  path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "${MODEL_SHA256}" "${path}" | sha256sum --check -
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${path}" | awk '{print $1}')"
    if [ "${actual}" != "${MODEL_SHA256}" ]; then
      echo "Checksum verification failed for ${path}" >&2
      return 1
    fi
    echo "${path}: OK"
  else
    echo "sha256sum or shasum is required to verify the model" >&2
    return 1
  fi
}

if [ -f "${OUTPUT_PATH}" ]; then
  echo "${OUTPUT_PATH} already exists; verifying checksum."
  if verify_checksum "${OUTPUT_PATH}"; then
    echo "Set VU_WHISPER_MODEL_PATH=${OUTPUT_PATH}"
    exit 0
  fi
  echo "Removing the invalid existing model and downloading a verified copy." >&2
  rm -f "${OUTPUT_PATH}"
fi

trap 'rm -f "${TEMP_PATH}"' EXIT HUP INT TERM
curl --fail --location --retry 5 --output "${TEMP_PATH}" "${MODEL_URL}"
if ! verify_checksum "${TEMP_PATH}"; then
  echo "Downloaded model was not installed." >&2
  exit 1
fi
mv "${TEMP_PATH}" "${OUTPUT_PATH}"
trap - EXIT HUP INT TERM

echo "Set VU_WHISPER_MODEL_PATH=${OUTPUT_PATH}"
