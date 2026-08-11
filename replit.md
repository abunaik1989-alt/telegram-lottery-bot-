# Lotto Service

A Telegram-connected lottery service for selling 300 numbered entries at 200 ETB each, collecting Bank or Telebirr payment proof, confirming payments manually, and drawing a winner from paid entries.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the Telegram/API server
- `pnpm --filter @workspace/lotto-service run dev` — run the admin console
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/db run push` — apply development schema changes
- `pnpm --filter @workspace/api-spec run codegen` — regenerate typed API clients after OpenAPI changes

## Product

- Customers use the Telegram bot to view available numbers, reserve a number, submit Bank or Telebirr payment references, and check status.
- The admin console shows the live number board, pending payment proofs, entry register, collections, and activity trail.
- Admin approval changes a number to paid; rejection releases it.
- The winner draw is protected by an admin key and can select only one paid entry.

## Stack

- pnpm workspace, TypeScript, Express 5, React + Vite
- PostgreSQL + Drizzle ORM
- OpenAPI + generated Zod schemas and React Query hooks
- Telegram Bot API polling

## Environment

- `DATABASE_URL` — provisioned PostgreSQL connection
- `TELEGRAM_BOT_TOKEN` — Telegram bot token stored as a Replit Secret
- `LOTTO_ADMIN_KEY` — private key for protected admin operations stored as a Replit Secret

## Where things live

- `lib/api-spec/openapi.yaml` — API contract
- `lib/db/src/schema/lottery.ts` — lottery database schema
- `artifacts/api-server/src/lib/lottery.ts` — reservation, payment, activity, and draw logic
- `artifacts/api-server/src/lib/telegram.ts` — Telegram commands and polling
- `artifacts/lotto-service/src/App.tsx` — admin console

## Gotchas

- The admin console requires the configured admin key on first open and stores it only in browser local storage.
- A paid number cannot be released by rejection.
- The draw is one-time and disabled while payment proofs remain pending.