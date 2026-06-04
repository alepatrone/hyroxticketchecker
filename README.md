# HYROX Ticket Monitor

GitHub Actions monitor for HYROX ticket availability. It checks configured HYROX/Vivenu event pages and sends Discord alerts when monitored athlete tickets become available or when an already-seen ticket gets more available quantity.

This README is the short GitHub-facing overview. Detailed internal handoff documentation lives in [docs/INTERNAL_DOCUMENTATION.md](docs/INTERNAL_DOCUMENTATION.md).

## Current Events

- GoodLife HYROX Toronto | Season 26/27
- HYROX Chiba | Season 26/27, men divisions only
- AirAsia HYROX Seoul | Season 26/27
- HYROX Vancouver, waiting for a ticket page
- HYROX Tenerife | Season 26/27

## Alert Rules

The monitor alerts on:

- new monitored athlete ticket IDs
- higher available quantity for an already-seen monitored ticket
- Open Men as a priority alert
- first entry into a waiting-room/sale-gate unreadable state
- monitor or workflow failures when Discord is configured

It ignores charity, adaptive, spectator, photo package, and Free U12 tickets.

During public-sale queues or waiting-room pages, HYROX/Vivenu may temporarily stop serving normal ticket JSON. In that case the monitor sends a one-time Discord alert when the event first enters that unreadable state, tries the cached checkout URL, and if checkout is also unreadable it preserves the last known state instead of failing the whole workflow.

## Run Locally

```powershell
npm run dry-run
npm run check:now
npm run notify-test
```

`dry-run` checks live pages without writing state or sending Discord. `check:now` performs a real check immediately.

## Discord Setup

For local runs, copy `.env.example` to `.env` and set:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/replace-me/replace-me
DISCORD_ENABLED=true
```

For GitHub Actions, add a repository secret named exactly `DISCORD_WEBHOOK_URL`.

## Automation

The GitHub workflow runs hourly, on manual dispatch, and on pushes to `main`.

Workflow file:

```text
.github/workflows/hyrox-ticket-monitor.yml
```

## Documentation

Full internal project documentation is in:

[docs/INTERNAL_DOCUMENTATION.md](docs/INTERNAL_DOCUMENTATION.md)

Use that document for architecture, page parsing details, state behavior, filters, alert logic, GitHub Actions behavior, troubleshooting, and maintenance notes.

## Safety

This monitor only reads public page data and checkout availability JSON. It does not add tickets to cart, bypass purchase queues or checkout controls, solve captchas, reserve tickets, or interact with payment flows.
