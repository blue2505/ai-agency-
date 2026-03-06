#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
pnpm exec tsx src/index.ts
