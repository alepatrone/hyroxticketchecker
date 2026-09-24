// Telegram webhook -> GitHub Actions bridge (runs on Render as `npm start`).
//
// Telegram pushes each message here; we answer "received" right away and start the
// monitor workflow with the command as input. The workflow owns all state, so this
// service is stateless and can sleep between commands (Render free plan): the
// webhook request itself wakes it up.
//
// Required environment variables:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   TELEGRAM_WEBHOOK_SECRET   any random string, checked on every Telegram request
//   GITHUB_TOKEN              token allowed to run workflows on GITHUB_REPO
// Optional:
//   GITHUB_REPO               default alepatrone/hyroxticketchecker
//   GITHUB_WORKFLOW           default hyrox-ticket-monitor.yml
//   GITHUB_REF                default main
//   PUBLIC_URL                default RENDER_EXTERNAL_URL (set by Render)
//   CHECK_INTERVAL_MINUTES    periodic check started from here, default 10 (0 = off)

const http = require("node:http");

const env = process.env;
const botToken = env.TELEGRAM_BOT_TOKEN;
const chatId = env.TELEGRAM_CHAT_ID;
const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
const githubToken = env.GITHUB_TOKEN;
const githubRepo = env.GITHUB_REPO || "alepatrone/hyroxticketchecker";
const githubWorkflow = env.GITHUB_WORKFLOW || "hyrox-ticket-monitor.yml";
const githubRef = env.GITHUB_REF || "main";
const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
const port = env.PORT || 3000;
// GitHub's own cron is heavily delayed (runs every 1-3 hours in practice), so this
// always-on service (kept awake by UptimeRobot) starts the periodic checks itself.
// 0 disables it and leaves only the workflow's cron.
const checkIntervalMinutes = Number(env.CHECK_INTERVAL_MINUTES ?? 10);
// Not a real command: monitor.js ignores it, so the run is a plain silent check.
const AUTO_CHECK_MARKER = "/auto";

const KNOWN_COMMANDS = ["/check", "/add", "/remove", "/list", "/report"];
const COMMANDS_MENU = [
  { command: "report", description: "Mostra disponibilità eventi" },
  { command: "check", description: "Controlla biglietti adesso (anche /check città)" },
  { command: "add", description: "Aggiungi evento (es. /add <url evento HYROX>)" },
  { command: "remove", description: "Rimuovi evento (es. /remove geneva)" },
  { command: "list", description: "Elenca eventi monitorati" }
];

// Telegram retries a webhook it considers failed (e.g. during a cold start):
// remember recent update ids so the same command does not start two runs.
const seenUpdateIds = new Set();

const missing = Object.entries({
  TELEGRAM_BOT_TOKEN: botToken,
  TELEGRAM_CHAT_ID: chatId,
  TELEGRAM_WEBHOOK_SECRET: webhookSecret,
  GITHUB_TOKEN: githubToken
})
  .filter(([, value]) => !value)
  .map(([name]) => name);

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: HTTP ${response.status} ${data.description || ""}`);
  }
  return data.result;
}

function reply(text) {
  return telegram("sendMessage", { chat_id: chatId, text }).catch((error) =>
    console.error(error.message)
  );
}

function github(pathname, options = {}) {
  return fetch(`https://api.github.com/repos/${githubRepo}/actions/workflows/${githubWorkflow}${pathname}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "hyrox-ticket-monitor-webhook"
    }
  });
}

async function dispatchWorkflow(commands) {
  const response = await github("/dispatches", {
    method: "POST",
    body: JSON.stringify({ ref: githubRef, inputs: { telegram_command: commands.join("\n") } })
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`GitHub dispatch failed: HTTP ${response.status} ${body}`);
  }
}

// GitHub keeps at most ONE pending run per concurrency group and cancels the older
// pending one when another arrives, which would silently drop commands. So commands
// are queued here and dispatched only when no run is waiting to start; everything
// that piled up meanwhile goes out together in a single run.
const WAITING_STATUSES = new Set(["queued", "pending", "waiting", "requested"]);
const commandQueue = [];
let pumping = false;

async function hasWaitingRun() {
  const response = await github("/runs?per_page=10");
  if (!response.ok) throw new Error(`GitHub runs list failed: HTTP ${response.status}`);
  const data = await response.json();
  return (data.workflow_runs || []).some((run) => WAITING_STATUSES.has(run.status));
}

async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (commandQueue.length > 0) {
      let waiting = true;
      try {
        waiting = await hasWaitingRun();
      } catch (error) {
        console.error(error.message);
      }
      if (waiting) {
        await sleep(10000);
        continue;
      }

      const queued = commandQueue.splice(0);
      // Any real command already runs a full check, so the marker is only needed alone.
      const realCommands = queued.filter((command) => command !== AUTO_CHECK_MARKER);
      const batch = realCommands.length > 0 ? realCommands : [AUTO_CHECK_MARKER];
      try {
        await dispatchWorkflow(batch);
        console.log(`Dispatched workflow for: ${batch.join(" ; ")}`);
      } catch (error) {
        console.error(error.message);
        await reply(`⚠️ Non riesco ad avviare il workflow su GitHub.\n${error.message}`);
      }
      // A new run takes a few seconds to show up in the runs list.
      await sleep(15000);
    }
  } finally {
    pumping = false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleUpdate(update) {
  if (seenUpdateIds.has(update.update_id)) return;
  seenUpdateIds.add(update.update_id);
  if (seenUpdateIds.size > 500) seenUpdateIds.delete(seenUpdateIds.values().next().value);

  const msg = update.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== String(chatId)) {
    console.log(`Ignored Telegram message from unauthorized chat ${msg.chat.id}.`);
    return;
  }

  const text = msg.text.trim().replace(/^(\/\w+)@\w+/, "$1");
  const command = text.split(/\s+/)[0].toLowerCase();

  if (command === "/start" || command === "/help") {
    await reply(`Comandi: ${KNOWN_COMMANDS.join(", ")}`);
    return;
  }
  if (!KNOWN_COMMANDS.includes(command)) return;

  commandQueue.push(text);
  await reply(`⏳ Ricevuto: ${text}\nElaboro su GitHub, ti rispondo tra circa un minuto.`);
  pumpQueue();
}

async function registerWebhook() {
  if (!publicUrl) {
    console.error("PUBLIC_URL / RENDER_EXTERNAL_URL is not set: cannot register the Telegram webhook.");
    return;
  }
  await telegram("setWebhook", {
    url: `${publicUrl}/telegram`,
    secret_token: webhookSecret,
    allowed_updates: ["message"]
  });
  await telegram("setMyCommands", { commands: COMMANDS_MENU });
  console.log(`Telegram webhook registered: ${publicUrl}/telegram`);
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/telegram") {
    if (req.headers["x-telegram-bot-api-secret-token"] !== webhookSecret) {
      res.writeHead(401).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      try {
        await handleUpdate(JSON.parse(body));
      } catch (error) {
        console.error("Failed to handle Telegram update:", error.message);
      }
      // Always 200: a non-2xx makes Telegram retry the same update over and over.
      res.writeHead(200).end();
    });
    return;
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end(missing.length ? `Missing env: ${missing.join(", ")}\n` : "HYROX webhook is running.\n");
});

server.listen(port, async () => {
  console.log(`Webhook server listening on port ${port}.`);
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(", ")}. Webhook not registered.`);
    return;
  }
  try {
    await registerWebhook();
  } catch (error) {
    console.error(error.message);
  }

  if (checkIntervalMinutes > 0) {
    console.log(`Periodic check every ${checkIntervalMinutes} minutes.`);
    setInterval(() => {
      // Skip when something is already queued: that run will check anyway.
      if (commandQueue.length > 0) return;
      commandQueue.push(AUTO_CHECK_MARKER);
      pumpQueue();
    }, checkIntervalMinutes * 60 * 1000);
  }
});
