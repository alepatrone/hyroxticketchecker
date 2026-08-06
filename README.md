# 🏋️‍♂️ HYROX Ticket Monitor

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot%20Integration-blue.svg?logo=telegram)](https://telegram.org/)
[![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-Automated-blue.svg?logo=github-actions)](https://github.com/features/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An intelligent, non-intrusive automated ticket monitor for **HYROX** events worldwide. Powered by **Node.js** and **GitHub Actions**, it tracks ticket page states, extracts underlying Vivenu checkout APIs, and delivers instant, interactive notifications via **Telegram**.

---

## ✨ Features

- **🎯 Smart Ticket Detection**: Extracts structured data directly from HYROX/Vivenu `__NEXT_DATA__` and internal checkout APIs.
- **📱 Interactive Telegram Bot**: Manage monitored events on-the-fly using custom bot commands (`/add`, `/list`, `/remove`, `/status`, `/check`).
- **⚡ Priority Signal Alerting**: Configure high-priority notifications for competitive classes (e.g., *Open Men*, *Pro*, *Doubles*).
- **⏳ Sale Gate & Queue Handling**: Gracefully handles ticket queues, waiting rooms, and temporary sale gates without throwing phantom error alerts.
- **🔄 Increase & Restock Tracking**: Detects both newly published ticket categories and quantity increases on existing tickets.
- **🤖 Autonomous GitHub Actions**: Runs continuously on custom schedules (e.g., hourly) with automated state caching and workflow error reporting.

---

## 🏃 Monitored Events Overview

The monitor tracks pre-configured static events as well as dynamically added events via Telegram:

| Event | Status | Details |
| :--- | :--- | :--- |
| **HYROX Milan** | 🟢 Monitored | Season 26/27 (Dec 5–6, 2026) |

---

## 🤖 Telegram Bot Commands

When running in bot mode (`npm run bot` or `--bot`), you can interact directly with the monitor in Telegram:

| Command | Action |
| :--- | :--- |
| `/add <url>` | Dynamically register a new HYROX event URL to watch. |
| `/list` | List all static and dynamic events currently monitored. |
| `/remove <url>` | Remove a dynamically added event. |
| `/status` | View active ticket counts and last check results for all events. |
| `/check [event]` | Trigger an immediate manual availability check. |

---

## 🚀 Quick Start

### Prerequisites
- **Node.js**: `v18.0.0` or higher
- **Telegram Bot**: Created via [@BotFather](https://t.me/BotFather)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/alepatrone/hyroxticketchecker.git
cd hyroxticketchecker
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in your Telegram Credentials:
```env
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_CHAT_ID=-100123456789
```

### 3. Execution Commands
```bash
# Perform a read-only test check without modifying state or sending Telegram messages
npm run dry-run

# Run an immediate manual check and dispatch Telegram alerts if tickets are available
npm run check:now

# Start the continuous Telegram Bot mode with command polling
npm run bot

# Send a smoke-test message to verify Telegram configuration
npm run notify-test
```

---

## ⚙️ Configuration (`monitor.config.json`)

Customize event tracking, filters, and priority alerts in `monitor.config.json`:

```json
{
  "events": [
    {
      "key": "toronto",
      "name": "GoodLife HYROX Toronto | Season 26/27",
      "officialEventPageUrl": "https://hyrox.com/event/goodlife-hyrox-toronto-26-27/"
    }
  ],
  "ticketFilter": {
    "onlyAthleteTickets": true,
    "ignoreNamesContaining": ["CHARITY", "ADAPTIVE", "SPECTATOR", "PHOTO PACKAGE"],
    "prioritySignals": [
      {
        "label": "Open Men",
        "competitionClass": "SOLO_OPEN_M",
        "priorityMessagePrefix": "🚨 PRIORITY: Open Men ticket available"
      }
    ]
  }
}
```

---

## ⏰ Continuous GitHub Actions Setup

The repository includes an automated workflow `.github/workflows/hyrox-ticket-monitor.yml` that checks ticket availability on a regular schedule.

To enable GitHub Actions alerts:
1. Go to your repository settings: **Settings > Secrets and variables > Actions**
2. Add the following **Repository Secrets**:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`

---

## 🛡️ Ethics & Safety Policy

This software is strictly designed for **read-only monitoring & availability notification**:
- ❌ **No Botting / Auto-Checkout**: Does not reserve tickets, solve CAPTCHAs, or add items to cart.
- ❌ **No Queue Bypassing**: Respects Vivenu and HYROX public rate limits and queue mechanisms.
- 🟢 **Public Data Only**: Extracts publicly available page state data.

---

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
