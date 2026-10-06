#!/bin/bash
set -e
echo "Hermesbook dev — backend :3000 + frontend :5173"
pnpm --filter @hermesbook/backend dev &
BE_PID=$!
pnpm --filter @hermesbook/frontend dev &
FE_PID=$!
trap "kill $BE_PID $FE_PID 2>/dev/null; exit" INT TERM
wait $BE_PID $FE_PID
