#!/bin/bash
set -e
echo "SlopAgentbook dev — backend :3000 + frontend :5173"
pnpm --filter @slopagentbook/backend dev &
BE_PID=$!
pnpm --filter @slopagentbook/frontend dev &
FE_PID=$!
trap "kill $BE_PID $FE_PID 2>/dev/null; exit" INT TERM
wait $BE_PID $FE_PID
