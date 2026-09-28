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
# The last configuration is what this script uses.
set -euo pipefail

URL="${1:-http://localhost:3000/}"

CHROMIUM="${CHROMIUM:-$(command -v chromium || command -v google-chrome-stable || command -v google-chrome)}"
if [ -z "${CHROMIUM}" ]; then
  echo "error: no chromium/chrome binary found; set CHROMIUM=/path/to/chromium" >&2
  exit 1
fi

# Pin Chromium to the discrete GPU.
export __NV_PRIME_RENDER_OFFLOAD=1
export __GLX_VENDOR_LIBRARY_NAME=nvidia
export __VK_LAYER_NV_optimus=NVIDIA_only

exec "${CHROMIUM}" \
  --enable-unsafe-webgpu \
  --enable-features=Vulkan \
  --use-gl=angle \
  "${URL}"
