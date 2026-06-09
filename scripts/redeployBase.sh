#!/usr/bin/env bash
set -euo pipefail

required_vars=(
  "BASE_RPC_URL"
  "BASE_EXECUTOR_PRIVATE_KEY"
  "BASE_USDC_ADDRESS"
  "VALUATOR_ADDRESS"
)

missing=()
for var_name in "${required_vars[@]}"; do
  if ! grep -qE "^${var_name}=.+" .env 2>/dev/null; then
    missing+=("${var_name}")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing required .env variables:"
  printf '  - %s\n' "${missing[@]}"
  echo
  echo "Add them to .env, then run this script again."
  exit 1
fi

npm run contracts:compile
npm run contracts:deploy:base
