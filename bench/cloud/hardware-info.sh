#!/usr/bin/env bash
#
# Zwraca jeden dokument JSON opisujący akcelerator dostępny na hoście.
# Działa dla NVIDIA/CUDA oraz AMD/ROCm i nie wymaga konkretnego dostawcy.
#
set -Eeuo pipefail

backend="unknown"
name=""
driver=""
vram_total_mb=""
details=""

if command -v nvidia-smi >/dev/null 2>&1; then
  backend="nvidia"
  IFS=',' read -r name driver vram_total_mb < <(
    nvidia-smi \
      --query-gpu=name,driver_version,memory.total \
      --format=csv,noheader,nounits |
      head -n 1 |
      sed 's/^[[:space:]]*//; s/[[:space:]]*,[[:space:]]*/,/g'
  )
  details="$(nvidia-smi 2>&1 || true)"
else
  amd_device_dir=""
  for vendor_file in /sys/class/drm/card*/device/vendor; do
    [[ -r "$vendor_file" ]] || continue
    if grep -qi '^0x1002$' "$vendor_file"; then
      amd_device_dir="${vendor_file%/vendor}"
      break
    fi
  done

  if [[ -n "$amd_device_dir" ]] ||
    command -v amd-smi >/dev/null 2>&1 ||
    command -v rocm-smi >/dev/null 2>&1; then
    backend="amd"
    name="$(
      lspci 2>/dev/null |
        grep -Eim1 '(VGA compatible controller|Display controller).*AMD' ||
        true
    )"
    driver="$(modinfo -F version amdgpu 2>/dev/null | head -n 1 || true)"

    if [[ -n "$amd_device_dir" && -r "$amd_device_dir/mem_info_vram_total" ]]; then
      vram_bytes="$(<"$amd_device_dir/mem_info_vram_total")"
      if [[ "$vram_bytes" =~ ^[0-9]+$ ]]; then
        vram_total_mb="$((vram_bytes / 1024 / 1024))"
      fi
    fi

    if command -v amd-smi >/dev/null 2>&1; then
      details="$(amd-smi static 2>&1 || true)"
    elif command -v rocm-smi >/dev/null 2>&1; then
      details="$(
        rocm-smi \
          --showproductname \
          --showdriverversion \
          --showmeminfo vram \
          --showuse \
          --showpower 2>&1 || true
      )"
    else
      details="$(lspci -nn 2>&1 | grep -Ei 'AMD|VGA|Display' || true)"
    fi
  fi
fi

jq -n \
  --arg backend "$backend" \
  --arg name "$name" \
  --arg driver "$driver" \
  --arg vram_total_mb "$vram_total_mb" \
  --arg details "$details" '
    {
      backend: $backend,
      name: (if $name == "" then null else $name end),
      driver: (if $driver == "" then null else $driver end),
      vram_total_mb: (
        if $vram_total_mb == "" then null
        else ($vram_total_mb | tonumber)
        end
      ),
      details: $details
    }
  '
