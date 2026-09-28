#!/usr/bin/env bash
# Launches Chromium against the Gurow editor with a working WebGPU stack.
#
# On this reference laptop (Intel UHD + NVIDIA RTX 4050, Wayland/Ozone),
# Chromium's defaults do not give the app a usable hardware adapter:
#
#   plain chromium                      -> requestAdapter() returns null
#   --enable-unsafe-webgpu only         -> SwiftShader (software), and WebGPU
#                                          still reports isFallbackAdapter=false
#   + Vulkan/ANGLE, no PRIME offload    -> NVIDIA adapter, but the device is
#                                          lost with VK_ERROR_OUT_OF_DEVICE_MEMORY
#   + Vulkan/ANGLE + PRIME offload      -> NVIDIA Lovelace, no device errors
#
# Two things this script must do itself, because getting either wrong looks
# exactly like "WebGPU is broken":
#
#   1. Make sure something is actually serving the app. Otherwise the browser
#      opens on a dead URL and the editor never loads.
#   2. Use a dedicated --user-data-dir. Chromium is single-instance per profile:
#      if your normal browser is already running, `chromium <url>` just hands the
#      URL to that process and EVERY flag below is silently discarded, so you get
#      a normal tab with no WebGPU and no error explaining why.
set -euo pipefail

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3000}"
URL="${1:-http://localhost:${PORT}/}"
PROFILE_DIR="${GUROW_WEBGPU_PROFILE:-${FRONTEND_DIR}/.webgpu-profile}"

CHROMIUM="${CHROMIUM:-$(command -v chromium || command -v google-chrome-stable || command -v google-chrome || true)}"
if [ -z "${CHROMIUM}" ]; then
  echo "error: no chromium/chrome binary found; set CHROMIUM=/path/to/chromium" >&2
  exit 1
fi

url_is_up() {
  curl -sf -o /dev/null --max-time 2 "$1"
}

DEV_SERVER_PID=""
cleanup() {
  if [ -n "${DEV_SERVER_PID}" ]; then
    echo "Stopping dev server (pid ${DEV_SERVER_PID})..."
    kill "${DEV_SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if url_is_up "${URL}"; then
  echo "Using the server already running at ${URL}"
else
  echo "Nothing is serving ${URL}; starting 'bun run dev' on port ${PORT}..."
  (cd "${FRONTEND_DIR}" && PORT="${PORT}" bun run dev --port "${PORT}") &
  DEV_SERVER_PID=$!

  for _ in $(seq 1 60); do
    if url_is_up "${URL}"; then break; fi
    if ! kill -0 "${DEV_SERVER_PID}" 2>/dev/null; then
      echo "error: the dev server exited before it became reachable." >&2
      exit 1
    fi
    sleep 1
  done

  if ! url_is_up "${URL}"; then
    echo "error: dev server did not become reachable at ${URL} within 60s." >&2
    exit 1
  fi
  echo "Dev server is up at ${URL}"
fi

# Pin Chromium to the discrete GPU.
export __NV_PRIME_RENDER_OFFLOAD=1
export __GLX_VENDOR_LIBRARY_NAME=nvidia
export __VK_LAYER_NV_optimus=NVIDIA_only

mkdir -p "${PROFILE_DIR}"

echo
echo "Launching Chromium with a dedicated profile so the WebGPU flags apply."
echo "  profile: ${PROFILE_DIR}"
echo "  url:     ${URL}"
echo "Verify the adapter at chrome://gpu — 'WebGPU: Hardware accelerated' and a"
echo "Vulkan device named NVIDIA. If it says SwiftShader, the flags did not take."
echo

"${CHROMIUM}" \
  --user-data-dir="${PROFILE_DIR}" \
  --no-first-run \
  --no-default-browser-check \
  --enable-unsafe-webgpu \
  --enable-features=Vulkan \
  --use-gl=angle \
  "${URL}"
