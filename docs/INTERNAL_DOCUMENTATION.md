# HYROX Ticket Monitor Internal Documentation

This is the internal handoff document for the project. It is intentionally detailed so a person or AI agent with no prior context can understand what the monitor does, how it works, how it is configured, and how to safely maintain it.

For the short GitHub-facing repository overview, see [README.md](../README.md).

This repository monitors configured HYROX event ticket pages and sends Discord alerts when new monitored athlete tickets become available or when an already-seen monitored ticket gets more available quantity.

The current setup watches:

- GoodLife HYROX Toronto | Season 26/27
- HYROX Chiba | Season 26/27, men divisions only
- AirAsia HYROX Seoul | Season 26/27
- HYROX Vancouver, waiting for the official page to expose a ticket page

The monitor is intentionally conservative. It reads public HYROX/Vivenu page data and checkout availability JSON, but it does not add tickets to cart, bypass purchase queues or checkout controls, solve captchas, reserve tickets, or interact with payment flows.

## Quick Start

Requirements:

- Node.js 18 or newer
- A Discord webhook URL if alerts should be sent

Run a read-only check:

```powershell
npm run dry-run
```

Run a real local check immediately:

```powershell
npm run check:now
```

Run a local check that respects the configured minimum interval:

```powershell
npm run check
```

Send a Discord smoke test:

```powershell
npm run notify-test
```

## File Map

`monitor.js`

The main Node.js script. It loads configuration, fetches HYROX pages, extracts ticket data, filters for monitored tickets, compares against saved state, sends Discord alerts, and writes state/log files.

`monitor.config.json`

The main configuration file. It defines the watched events, retry behavior, filters, alert rules, state/log file names, and Discord notification options.

`.github/workflows/hyrox-ticket-monitor.yml`

The GitHub Actions workflow. It runs the monitor hourly, on manual dispatch, and on pushes to `main`. It restores state from the GitHub Actions cache and sends Discord failure notifications when possible.

`package.json`

Defines the npm scripts used locally and by GitHub Actions.

`.env.example`

Template for local Discord environment variables. Copy it to `.env` for local use.

`.gitignore`

Keeps secrets, state, logs, cache files, and dependencies out of git.

## How The Monitor Works

At a high level, each run does this:

1. Loads `.env` if present.
2. Loads `monitor.config.json`.
3. Loads previous state from `monitor.state.json` locally, or `.monitor-cache/monitor.state.json` in GitHub Actions.
4. Checks each configured event.
5. Finds or uses the event ticket page.
6. Reads HYROX/Vivenu `__NEXT_DATA__` JSON from the page HTML.
7. Derives the checkout URL and reads checkout availability JSON.
8. Normalizes tickets into a smaller internal shape.
9. Filters out unwanted tickets.
10. Compares available monitored ticket IDs and quantities against the previous state.
11. Sends Discord alerts for new monitored availability or increased quantity.
12. Writes the new state only after required Discord ticket alerts are delivered.

This matters because a failed Discord send should not mark a ticket as already seen. If Discord fails for a ticket alert, the script fails and keeps the previous state so a later run can alert again.

During high-traffic public-sale windows, HYROX/Vivenu may serve a queue, waiting-room, or sale gate page at the event URL. Those pages can still include `__NEXT_DATA__` but not include `props.pageProps.event.tickets`. When that happens, the monitor treats the event page as temporarily unreadable and sends a one-time Discord alert when the event first enters that unreadable state. If the event has a previously saved checkout URL, it tries that checkout URL directly. If checkout is also unreadable, it records a temporary unreadable status, preserves the previous active ticket state, and continues checking the other events instead of failing the whole workflow.

## What It Reads From The Page

HYROX ticket pages are rendered with a `__NEXT_DATA__` script tag. The monitor extracts that JSON and uses:

- `props.pageProps.event`
- `event.tickets`
- `event.categories`
- `event._id` or `event.id`
- ticket fields like `id`, `_id`, `name`, `active`, `v`, `maxAmountPerOrder`, `minAmountPerOrder`, `relevancyDate`, and `meta`
- category fields like `ref`, `name`, `v`, and order limits

The first event page tells the script which event exists. The checkout page is then used for real availability because it exposes ticket inventory volumes.

The checkout URL is derived as:

```text
https://ticket-host.example/checkout/{eventId}
```

using the event ID from the page JSON.

## Ticket Availability Logic

A raw ticket is normalized into fields like:

- `id`
- `name`
- `active`
- `hidden`
- `isCompetition`
- `competitionClass`
- `date`
- `availableQuantity`
- `buyable`

A ticket is considered buyable only when:

- `ticket.active === true`
- computed availability quantity is greater than `0`
- the ticket is not blocked by conditional availability rules

The computed quantity uses the strictest available limit from:

- ticket inventory volume, `ticket.v`
- category inventory volume, `category.v`, when present
- event inventory volume, `event.v`, when present
- ticket/category/event order maximums
- minimum order rules

If category volume is missing, the monitor treats it as unknown rather than sold out. If category volume is explicitly `0`, it is treated as sold out.

## Ticket Filters

Global filters live under `ticketFilter` in `monitor.config.json`.

Current global behavior:

- Only athlete competition tickets are monitored.
- Charity tickets are ignored.
- Adaptive tickets are ignored.
- Spectator tickets are ignored.
- Photo packages are ignored.
- Free U12 tickets are ignored.
- Open Men, `SOLO_OPEN_M`, is treated as a priority signal.

The global ignore list is:

```json
[
  "CHARITY",
  "ADAPTIVE",
  "SPECTATOR",
  "PHOTO PACKAGE",
  "FREE U12"
]
```

Chiba has an event-specific included class list:

```json
[
  "SOLO_OPEN_M",
  "SOLO_PRO_M",
  "DOUBLES_OPEN_M",
  "DOUBLES_PRO_M",
  "RELAY_M"
]
```

That means Chiba is intentionally men-only. Other events use the global filter and will alert for any available non-charity, non-adaptive athlete ticket unless event-specific filters are added later.

## Priority Alerts

Open Men is configured as a priority signal:

```json
{
  "label": "Open Men",
  "competitionClass": "SOLO_OPEN_M",
  "nameMustNotContain": ["CHARITY"],
  "discordMessagePrefix": "PRIORITY: Open Men ticket available"
}
```

When a new Open Men ticket appears, the Discord message gets a priority header.

The monitor can also use `notifications.discord.priorityMention` if a direct mention is configured later.

## Events With No Ticket Page Yet

Vancouver currently only has an official HYROX event page configured. Seoul now has a direct Korea HYROX ticket page configured.

For events like this, the monitor:

1. Fetches the official HYROX event page.
2. Looks for likely external HYROX/Vivenu ticket-page links.
3. If no ticket page is found, records a waiting state.
4. Does not fail and does not alert just because the page says ticket sales start soon.

Once HYROX adds a real ticket page link to the official page, a later run should discover it and begin normal checkout availability monitoring.

## State Files

Local default state file:

```text
monitor.state.json
```

GitHub Actions state file:

```text
.monitor-cache/monitor.state.json
```

State stores:

- last global check time
- per-event last check time
- event name and IDs
- ticket page and checkout page URLs
- availability detector version
- currently active monitored ticket IDs
- currently active monitored ticket summaries, including available quantities
- last result counts, including changed, new-ID, quantity-increase, and priority counts
- temporary unreadable statuses for sale gates, queues, or waiting-room pages
- latest error details, only when a run fails

State is ignored by git. It is runtime data, not source code.

## Alert Behavior

Important alert settings in `monitor.config.json`:

```json
"alertOnlyOnChanges": true,
"alertOnFirstRunAvailableTickets": true
```

With the current settings:

- If an event has no previous baseline and monitored tickets are available, the monitor alerts.
- If no monitored tickets are available, the monitor quietly writes a baseline.
- After a baseline exists, the monitor alerts when a new monitored ticket ID appears or an already-seen monitored ticket has a higher available quantity than the previous run.
- Quantity-increase alerts include the current quantity and the previous quantity, for example `50 available, was 12`.
- If the availability detector version changes, existing buyable tickets can be treated as new again.
- Discord ticket alerts are required before state is saved.

This prevents a cache miss or first run from silently swallowing available tickets.

## Discord Configuration

For local runs:

1. Copy `.env.example` to `.env`.
2. Put the real Discord webhook in `.env`.
3. Keep `DISCORD_ENABLED=true`.

Example:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/replace-me/replace-me
DISCORD_ENABLED=true
```

For GitHub Actions:

1. Open the GitHub repository.
2. Go to Settings -> Secrets and variables -> Actions.
3. Add a repository secret named exactly `DISCORD_WEBHOOK_URL`.

Do not commit a real webhook URL.

The Discord notification types are configured here:

```json
"notifyOn": [
  "new_active_athlete_ticket",
  "ticket_became_active",
  "priority_ticket_became_active",
  "ticket_page_temporarily_unreadable",
  "monitor_error_after_retries"
]
```

## GitHub Actions

The workflow runs on:

- manual dispatch from the GitHub Actions tab
- push to `main`
- hourly schedule at minute `17`

The hourly schedule is:

```yaml
- cron: "17 * * * *"
```

GitHub schedules use UTC. One hourly run is used to cover Toronto, Chiba, Seoul, and Vancouver without mapping separate time-zone windows.

The workflow:

1. Checks out the repo.
2. Installs Node.js 20.
3. Creates `.monitor-cache`.
4. Restores `.monitor-cache` from GitHub Actions cache.
5. Deletes stale `.monitor-cache/error-notified`.
6. Runs either a Discord smoke test or the monitor.
7. Sends a generic Discord failure message with `npm run notify-workflow-failure` if the workflow fails after the repository has been checked out.
8. Uploads `.monitor-cache` as a diagnostic artifact on failure.

The monitor uses these GitHub-specific environment variables:

```yaml
HYROX_STATE_FILE: .monitor-cache/monitor.state.json
HYROX_LOG_FILE: .monitor-cache/monitor.log
HYROX_ERROR_NOTIFIED_FILE: .monitor-cache/error-notified
```

## Commands

`npm run dry-run`

Checks all configured events immediately. It does not write state and does not send Discord messages.

`npm run check:now`

Checks all configured events immediately. It writes state and sends Discord alerts when required.

`npm run check`

Checks only if the last successful check is older than `minimumMinutesBetweenChecks`.

`npm run notify-test`

Sends a Discord test message if Discord is configured and enabled.

`npm run notify-workflow-failure`

Sends the same workflow-failure style notification used by the monitor script.

## Adding A New Event

Add a new object to the `events` array in `monitor.config.json`.

If the ticket page is already known:

```json
{
  "key": "example",
  "name": "HYROX Example",
  "officialEventPageUrl": "https://hyrox.com/event/example/",
  "ticketPageUrl": "https://region.hyrox.com/event/example-ticket-slug",
  "eventDates": {
    "start": "2026-12-01",
    "end": "2026-12-02",
    "timezone": "America/Toronto"
  }
}
```

If ticket sales have not started yet, omit `ticketPageUrl` and keep `officialEventPageUrl`:

```json
{
  "key": "example",
  "name": "HYROX Example",
  "officialEventPageUrl": "https://hyrox.com/event/example/",
  "eventDates": {
    "start": "2026-12-01",
    "end": "2026-12-02",
    "timezone": "America/Toronto"
  }
}
```

Then run:

```powershell
npm run dry-run
```

## Changing Filters

To ignore another ticket type globally, add a string to:

```json
"ignoreNamesContaining": []
```

The match is case-insensitive and checks the ticket name.

To restrict one event to specific competition classes, add an event-level `ticketFilter`:

```json
"ticketFilter": {
  "includedCompetitionClasses": ["SOLO_OPEN_M"]
}
```

To add another priority class, add another object to `prioritySignals`.

## Error Handling

Network and Discord operations are retried using:

```json
"retryAttempts": 3,
"retryDelaySeconds": 10
```

When the monitor fails after retries:

- it writes details to the log file
- it records `lastError` in state
- it tries to send a Discord error notification
- it exits with a failure code

After a later successful run, stale `lastError` data is cleared from the new state.

Some ticket-page problems are handled without failing the workflow. If the event page temporarily lacks `event.tickets`, lacks `__NEXT_DATA__`, or returns transient HTTP statuses such as `429`, `500`, `502`, `503`, or `504`, the monitor treats it as a temporary sale-page/readability issue. It sends a Discord alert only when the event transitions from a normal/readable state into a temporary unreadable state; repeated unreadable runs stay quiet until the event becomes readable again. It will use a cached checkout URL if one exists. If both the event page and checkout page are unreadable, it writes `ticket_page_temporarily_unreadable` or `ticket_checkout_temporarily_unreadable` in event state and preserves the previous active ticket IDs and quantities. This avoids repeated Discord error spam during public-sale waiting rooms while still making the condition visible in logs/state.

## Logs And Diagnostics

Local log file:

```text
monitor.log
```

GitHub Actions log file:

```text
.monitor-cache/monitor.log
```

On GitHub workflow failure, `.monitor-cache` is uploaded as an artifact named:

```text
monitor-diagnostics
```

Use that artifact to inspect state and logs from the failed run.

## Security Notes

Never commit:

- `.env`
- real Discord webhook URLs
- `monitor.state.json`
- `monitor.log`
- `.monitor-cache`

These are already ignored by `.gitignore`.

GitHub Actions should receive the webhook only through the repository secret named `DISCORD_WEBHOOK_URL`.

## Known Limitations

- The monitor can miss very short ticket drops if the check interval is too long.
- GitHub Actions schedules are not real-time and can be delayed.
- If HYROX changes the page structure or removes `__NEXT_DATA__`, the parser may need to be updated.
- If HYROX adds a queue, captcha, or other anti-bot gate before public page data, the monitor preserves state and backs off from treating that run as reliable data. If a previously learned checkout availability JSON URL is still publicly readable, it may use that data, but it does not add tickets to cart or bypass purchase controls.
- The monitor only reports availability. It does not reserve tickets, add tickets to cart, or interact with payment flows.

## Current Expected Dry Run Shape

With the current live event pages, a healthy dry-run looks like:

```text
Checked GoodLife HYROX Toronto | Season 26/27.
Available monitored athlete tickets: 0

Checked HYROX Chiba | Season 26/27.
Available monitored athlete tickets: 0

Checked AirAsia | HYROX Seoul | Season 26/27.
Available monitored athlete tickets: 15

Checked HYROX Vancouver.
No ticket page found yet on the official event page.
```

Exact ticket counts and page text can change as HYROX updates the events. For Seoul, current first-wave/general-sale behavior may show the same ticket IDs with a different available quantity; the monitor now alerts on those quantity increases.
