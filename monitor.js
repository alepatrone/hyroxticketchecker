const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");

const CONFIG_FILE = path.join(__dirname, "monitor.config.json");
const DOT_ENV_FILE = path.join(__dirname, ".env");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
let force = args.has("--force") || dryRun;
let targetEventKey = null;
// Set by the workflow on manual runs, or by a /check command read in one-shot mode.
let sendReportAfterCheck = process.env.HYROX_SEND_REPORT === "true";
const isBotMode = args.has("--bot");
const notifyTest = args.has("--notify-test");
const workflowFailureNotify = args.has("--workflow-failure-notify");
const AVAILABILITY_DETECTOR_VERSION = 3;
const defaultEventState = {
  lastCheckedAt: null,
  activeAthleteTicketIds: [],
  activeAthleteTickets: []
};
const defaultState = {
  lastCheckedAt: null,
  events: {}
};

if (args.has("--help")) {
  console.log(`
Usage:
  node monitor.js                 Check if enough time has passed since the last run
  node monitor.js --force          Check now, ignoring the minimum interval
  node monitor.js --dry-run        Check now without writing state or sending Telegram messages
  node monitor.js --bot            Run the continuous Telegram bot (long-running process)
  node monitor.js --notify-test    Send a test Telegram notification
  node monitor.js --workflow-failure-notify
                                  Send a GitHub workflow failure notification

Environment:
  HYROX_DISABLE_TELEGRAM_COMMANDS=1
                                  Do not read Telegram commands in one-shot mode
                                  (use it in GitHub Actions when the bot runs elsewhere)
`);
  process.exit(0);
}

function getNestedValue(object, dottedPath) {
  return dottedPath.split(".").reduce((value, key) => {
    if (value === null || value === undefined) return undefined;
    return value[key];
  }, object);
}

function slugify(value) {
  return String(value || "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "event";
}

function normalizeUrl(value) {
  return String(value || "").trim().toLowerCase().replace(/\/+$/, "");
}

function getConfiguredEvents(config, state = {}) {
  const baseEvents = Array.isArray(config.events) && config.events.length > 0
    ? config.events
    : [config.event].filter(Boolean);

  const dynamicEvents = state.dynamicEvents || [];
  // Static events from monitor.config.json can be switched off with /remove (and back on with /add).
  const removedKeys = new Set(state.removedStaticEventKeys || []);

  return [...baseEvents, ...dynamicEvents]
    .map((eventConfig, index) => ({
      ...eventConfig,
      key: eventConfig.key || slugify(eventConfig.name || eventConfig.ticketPageUrl || index)
    }))
    .filter((eventConfig) => !removedKeys.has(eventConfig.key));
}

function getStaticEvents(config) {
  return getConfiguredEvents(config, {});
}

function validateConfig(config, state = {}) {
  const mode = config.monitoring?.mode || "checkout_page_availability_json";
  if (mode !== "checkout_page_availability_json") {
    throw new Error(`Unsupported monitoring.mode: ${mode}`);
  }

  // Only fail when nothing is configured at all: removing every event with /remove is allowed.
  if (getStaticEvents(config).length === 0 && (state.dynamicEvents || []).length === 0) {
    throw new Error("No HYROX events configured.");
  }
}

function getEventState(state, eventConfig) {
  if (state.events?.[eventConfig.key]) {
    return state.events[eventConfig.key];
  }

  // Backward compatibility for the original one-event Toronto state shape.
  if (
    eventConfig.key === "toronto" &&
    Array.isArray(state.activeAthleteTicketIds)
  ) {
    return {
      lastCheckedAt: state.lastCheckedAt || null,
      eventName: state.eventName,
      eventId: state.eventId,
      ticketPageUrl: state.ticketPageUrl,
      activeAthleteTicketIds: state.activeAthleteTicketIds,
      activeAthleteTickets: state.activeAthleteTickets || [],
      lastResult: state.lastResult
    };
  }

  return { ...defaultEventState };
}

function getEventUrls(config, state = {}) {
  return [
    ...new Set(
      getConfiguredEvents(config, state)
        .flatMap((eventConfig) => [
          eventConfig.ticketPageUrl,
          eventConfig.officialEventPageUrl
        ])
        .filter(Boolean)
    )
  ];
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(filePath, fallback) {
  if (!(await exists(filePath))) return fallback;
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, raw, "utf8");
}

// NOTE: loadState/saveState now THROW on remote failures instead of silently
// returning an empty state / skipping the write. Returning the fallback on a
// read error caused the next save to overwrite the remote state (and wipe
// dynamicEvents added with /add).
async function loadState(config, fallback) {
  const binId = process.env.JSONBIN_BIN_ID;
  const apiKey = process.env.JSONBIN_API_KEY;

  if (binId && apiKey) {
    try {
      const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
        headers: { 'X-Access-Key': apiKey }
      });
      if (!response.ok) {
        if (response.status === 404) return fallback;
        throw new Error(`JSONBin read HTTP ${response.status}`);
      }
      const data = await response.json();
      return data.record || fallback;
    } catch (e) {
      console.error("Failed to read state from JSONBin:", e.message);
      throw e;
    }
  }

  return loadJson(resolveStateFile(config), fallback);
}

async function saveState(config, state) {
  const binId = process.env.JSONBIN_BIN_ID;
  const apiKey = process.env.JSONBIN_API_KEY;

  if (binId && apiKey) {
    try {
      const response = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Access-Key': apiKey
        },
        body: JSON.stringify(state)
      });
      if (!response.ok) throw new Error(`JSONBin write HTTP ${response.status}`);
      return;
    } catch (e) {
      console.error("Failed to write state to JSONBin:", e.message);
      throw e;
    }
  }

  await writeJson(resolveStateFile(config), state);
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null
  };
}

function isTemporaryTicketPageError(error) {
  const message = error?.message || String(error);
  return (
    /Could not find event\.tickets in the event page JSON/i.test(message) ||
    /Could not find the __NEXT_DATA__ JSON block/i.test(message) ||
    /Fetch failed: HTTP (429|500|502|503|504)\b/i.test(message)
  );
}

function isTemporaryUnreadableStatus(status) {
  return (
    status === "event_page_temporarily_unreadable_checkout_readable" ||
    status === "ticket_page_temporarily_unreadable" ||
    status === "ticket_checkout_temporarily_unreadable"
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadDotEnv() {
  if (!(await exists(DOT_ENV_FILE))) return;
  const raw = await fs.readFile(DOT_ENV_FILE, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalIndex = trimmed.indexOf("=");
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

async function fetchText(url, config) {
  const controller = new AbortController();
  const timeoutMs = (config.monitoring.timeoutSeconds || 30) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": config.monitoring.userAgent || "hyrox-ticket-monitor/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`Fetch failed: HTTP ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function extractNextData(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/
  );

  if (!match) {
    throw new Error("Could not find the __NEXT_DATA__ JSON block in the page.");
  }

  return JSON.parse(match[1]);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractUrlsFromHtml(html, baseUrl) {
  const rawUrls = new Set();
  const attributePattern = /\b(?:href|src|data-[a-z0-9_-]+)=["']([^"']+)["']/gi;
  const absoluteUrlPattern = /https?:\/\/[^\s"'<>\\]+/gi;
  let match;

  while ((match = attributePattern.exec(html)) !== null) {
    rawUrls.add(match[1]);
  }

  while ((match = absoluteUrlPattern.exec(html)) !== null) {
    rawUrls.add(match[0]);
  }

  return [...rawUrls]
    .map((url) => decodeHtmlEntities(url))
    .map((url) => {
      try {
        return new URL(url, baseUrl).href;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isLikelyTicketPageUrl(candidateUrl, officialEventPageUrl) {
  try {
    const candidate = new URL(candidateUrl);
    const official = new URL(officialEventPageUrl);

    if (candidate.href === official.href) return false;
    if (candidate.hostname === official.hostname) return false;
    if (!/hyrox|vivenu/i.test(candidate.hostname)) return false;
    if (!/^\/event\/[^/]+\/?$/i.test(candidate.pathname)) return false;

    return true;
  } catch {
    return false;
  }
}

function discoverTicketPageUrl(officialPageHtml, eventConfig) {
  if (!eventConfig.officialEventPageUrl) return null;

  const urls = extractUrlsFromHtml(officialPageHtml, eventConfig.officialEventPageUrl);
  return urls.find((url) => isLikelyTicketPageUrl(url, eventConfig.officialEventPageUrl)) || null;
}

function summarizeOfficialPage(officialPageHtml, eventConfig) {
  const text = stripHtml(officialPageHtml);
  const candidateTicketPageUrls = eventConfig.officialEventPageUrl
    ? extractUrlsFromHtml(officialPageHtml, eventConfig.officialEventPageUrl)
        .filter((url) => isLikelyTicketPageUrl(url, eventConfig.officialEventPageUrl))
    : [];

  return {
    ticketSalesStartSoon: /ticket sales start soon/i.test(text),
    candidateTicketPageUrls
  };
}

function getTicketId(ticket) {
  return ticket.id || ticket._id;
}

function getEventCategory(event, ticket) {
  return (event.categories || []).find((category) => category.ref === ticket.categoryRef);
}

function volumeOrFallback(value, fallback) {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.max(value, 0);
}

function getTicketAvailability(ticket, event) {
  const category = getEventCategory(event, ticket);
  const ticketVolume = volumeOrFallback(ticket.v, 0);
  const categoryVolume = category ? volumeOrFallback(category.v, Infinity) : Infinity;
  const eventVolume = volumeOrFallback(event.v, Infinity);
  const ticketOrderMax = volumeOrFallback(ticket.maxAmountPerOrder, Infinity);
  const categoryOrderMax = volumeOrFallback(category?.maxAmountPerOrder, Infinity);
  const eventOrderMax = volumeOrFallback(event.max, Infinity);
  const minOrderAmount = volumeOrFallback(ticket.minAmountPerOrder, 0);
  const minOrderRule = volumeOrFallback(ticket.minAmountPerOrderRule, 0);
  let quantity = Math.min(
    ticketVolume,
    categoryVolume,
    eventVolume,
    ticketOrderMax,
    categoryOrderMax,
    eventOrderMax
  );

  if (minOrderRule <= 1 && quantity < minOrderAmount) {
    quantity = 0;
  }

  const blockedByRules =
    ticket.conditionalAvailability === true &&
    ticket.conditionalAvailabilityMode === "blockAddToCart" &&
    Array.isArray(ticket.rules) &&
    ticket.rules.length > 0;

  return {
    quantity,
    blockedByRules,
    ticketVolume,
    categoryVolume: Number.isFinite(categoryVolume) ? categoryVolume : null,
    eventVolume: Number.isFinite(eventVolume) ? eventVolume : null,
    categoryName: category?.name || null
  };
}

function normalizeTicket(ticket, event) {
  const availability = getTicketAvailability(ticket, event);

  return {
    id: getTicketId(ticket),
    name: ticket.name,
    active: ticket.active === true,
    hidden: ticket.styleOptions?.hiddenInSelectionArea === true,
    isCompetition: ticket.meta?.is_competition,
    competitionClass: ticket.meta?.competition_class_matching_key,
    competitionDayIndex: ticket.meta?.competition_day_idx,
    date: ticket.relevancyDate?.start || null,
    availableQuantity: availability.quantity,
    buyable:
      ticket.active === true &&
      availability.quantity > 0 &&
      availability.blockedByRules === false,
    availability
  };
}

function ticketNameHasAny(ticket, fragments) {
  const name = String(ticket.name || "").toUpperCase();
  return fragments.some((fragment) => name.includes(String(fragment).toUpperCase()));
}

function getTicketsById(tickets = []) {
  const ticketsById = new Map();

  for (const ticket of tickets) {
    if (ticket?.id) {
      ticketsById.set(ticket.id, ticket);
    }
  }

  return ticketsById;
}

function isQuantityIncrease(ticket, previousTicket) {
  return (
    previousTicket &&
    typeof ticket.availableQuantity === "number" &&
    typeof previousTicket.availableQuantity === "number" &&
    ticket.availableQuantity > previousTicket.availableQuantity
  );
}

function getChangedTickets(availableTickets, eventState, detectorChanged, alertOnlyOnChanges) {
  if (!alertOnlyOnChanges) {
    return {
      alertTickets: availableTickets,
      newTickets: availableTickets,
      quantityIncreaseTickets: []
    };
  }

  const previousTicketsById = getTicketsById(
    detectorChanged ? [] : eventState.activeAthleteTickets || []
  );
  const previousActiveIds = new Set(
    detectorChanged ? [] : eventState.activeAthleteTicketIds || []
  );
  const newTickets = availableTickets.filter((ticket) => !previousActiveIds.has(ticket.id));
  const quantityIncreaseTickets = availableTickets.filter((ticket) =>
    isQuantityIncrease(ticket, previousTicketsById.get(ticket.id))
  );
  const changedTicketIds = new Set([
    ...newTickets.map((ticket) => ticket.id),
    ...quantityIncreaseTickets.map((ticket) => ticket.id)
  ]);
  const alertTickets = availableTickets
    .filter((ticket) => changedTicketIds.has(ticket.id))
    .map((ticket) => {
      const previousTicket = previousTicketsById.get(ticket.id);
      if (!isQuantityIncrease(ticket, previousTicket)) {
        return ticket;
      }

      return {
        ...ticket,
        previousAvailableQuantity: previousTicket.availableQuantity
      };
    });

  return {
    alertTickets,
    newTickets,
    quantityIncreaseTickets
  };
}

function readBooleanEnv(name) {
  return undefined;
}

function shouldNotify(config, type) {
  const notifyOn = config.notifications?.telegram?.notifyOn;
  if (!Array.isArray(notifyOn)) return true;
  return notifyOn.includes(type);
}

function shouldNotifyTicketAlert(config, priorityTickets) {
  if (
    priorityTickets.length > 0 &&
    shouldNotify(config, "priority_ticket_became_active")
  ) {
    return true;
  }

  return (
    shouldNotify(config, "new_active_athlete_ticket") ||
    shouldNotify(config, "ticket_became_active")
  );
}

function shouldNotifyTemporaryUnreadableAlert(config) {
  return shouldNotify(config, "ticket_page_temporarily_unreadable");
}

function resolveStateFile(config) {
  const configuredPath = process.env.HYROX_STATE_FILE || config.monitoring.stateFile;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, configuredPath);
}

function resolveLogFile(config) {
  const configuredPath = process.env.HYROX_LOG_FILE || config.monitoring.logFile || "monitor.log";
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, configuredPath);
}

function resolveErrorNotifiedFile(config) {
  const configuredPath = process.env.HYROX_ERROR_NOTIFIED_FILE;
  if (!configuredPath) return null;

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(__dirname, configuredPath);
}

async function appendLog(config, level, message, details = {}) {
  const entry = {
    at: new Date().toISOString(),
    level,
    message,
    ...details
  };
  const line = `${JSON.stringify(entry)}\n`;

  try {
    const logFile = resolveLogFile(config);
    await fs.mkdir(path.dirname(logFile), { recursive: true });
    await fs.appendFile(logFile, line, "utf8");
  } catch (logError) {
    console.error("Failed to write monitor log:", logError.message);
  }
}

async function markErrorNotified(config) {
  const markerFile = resolveErrorNotifiedFile(config);
  if (!markerFile) return;

  try {
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    await fs.writeFile(markerFile, new Date().toISOString(), "utf8");
  } catch (error) {
    console.error("Failed to write error notification marker:", error.message);
  }
}

async function withRetries(config, label, operation) {
  const attempts = Math.max(1, config.monitoring.retryAttempts || 1);
  const delayMs = Math.max(0, config.monitoring.retryDelaySeconds || 0) * 1000;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      await appendLog(config, "warn", `${label} failed`, {
        attempt,
        attempts,
        error: serializeError(error)
      });

      if (attempt < attempts && delayMs > 0) {
        console.warn(`${label} failed on attempt ${attempt}/${attempts}; retrying.`);
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

function isPriorityTicket(ticket, prioritySignals) {
  return prioritySignals.some((signal) => {
    if (signal.competitionClass && ticket.competitionClass !== signal.competitionClass) {
      return false;
    }

    if (signal.nameContains && !ticketNameHasAny(ticket, [signal.nameContains])) {
      return false;
    }

    if (
      signal.nameMustNotContain &&
      ticketNameHasAny(ticket, signal.nameMustNotContain)
    ) {
      return false;
    }

    return true;
  });
}

function mergeTicketFilter(config, eventConfig) {
  const globalFilter = config.ticketFilter || {};
  const eventFilter = eventConfig.ticketFilter || {};

  return {
    ...globalFilter,
    ...eventFilter,
    availableWhen: {
      ...(globalFilter.availableWhen || {}),
      ...(eventFilter.availableWhen || {})
    },
    ignoreNamesContaining:
      eventFilter.ignoreNamesContaining || globalFilter.ignoreNamesContaining || [],
    includedCompetitionClasses:
      eventFilter.includedCompetitionClasses || globalFilter.includedCompetitionClasses || [],
    excludedCompetitionClasses:
      eventFilter.excludedCompetitionClasses || globalFilter.excludedCompetitionClasses || [],
    prioritySignals:
      eventFilter.prioritySignals || globalFilter.prioritySignals || []
  };
}

function filterInterestingTickets(rawTickets, filter, event) {
  const ignoredNames = filter.ignoreNamesContaining || [];
  const includedClasses =
    filter.includedCompetitionClasses?.length > 0
      ? new Set(filter.includedCompetitionClasses)
      : null;
  const excludedClasses = new Set(filter.excludedCompetitionClasses || []);
  const availableField = filter.availableWhen?.field || "buyable";
  const availableValue = filter.availableWhen?.equals ?? true;

  return rawTickets
    .map((ticket) => normalizeTicket(ticket, event))
    .filter((ticket) => ticket.id)
    .filter((ticket) => !ticket.hidden)
    .filter((ticket) => !ticketNameHasAny(ticket, ignoredNames))
    .filter((ticket) => {
      if (!filter.onlyAthleteTickets) return true;
      return getNestedValue({ meta: { is_competition: ticket.isCompetition } }, filter.competitionMetaField) === filter.competitionMetaValue;
    })
    .filter((ticket) => !includedClasses || includedClasses.has(ticket.competitionClass))
    .filter((ticket) => !excludedClasses.has(ticket.competitionClass))
    .filter((ticket) => ticket[availableField] === availableValue)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function formatDateInTimeZone(value, timeZone) {
  if (!value) return "unknown date";

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10);
  if (!timeZone) return date.toISOString().slice(0, 10);

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    if (!year || !month || !day) return date.toISOString().slice(0, 10);
    return `${year}-${month}-${day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatTicket(ticket, eventConfig = {}) {
  const date = formatDateInTimeZone(ticket.date, eventConfig.eventDates?.timezone);
  const available =
    typeof ticket.availableQuantity === "number"
      ? `, ${ticket.availableQuantity} available`
      : "";
  const previousAvailable =
    typeof ticket.previousAvailableQuantity === "number"
      ? `, was ${ticket.previousAvailableQuantity}`
      : "";
  return `${ticket.name} (${ticket.competitionClass || "unknown class"}, ${date}${available}${previousAvailable})`;
}

function buildTicketAlertMessage({ config, eventConfig, event, changedTickets, priorityTickets, ticketFilter }) {
  const lines = [];
  const eventName = event?.name || eventConfig.name || "HYROX event";

  if (priorityTickets.length > 0) {
    const priorityPrefix =
      ticketFilter.prioritySignals?.[0]?.priorityMessagePrefix ||
      "PRIORITY ticket available";
    lines.push(`${priorityPrefix}: ${eventName}`);
    for (const ticket of priorityTickets) {
      lines.push(`- ${formatTicket(ticket, eventConfig)}`);
    }
    lines.push("");
  }

  lines.push(`${eventName} new or increased monitored athlete ticket availability detected.`);
  for (const ticket of changedTickets) {
    lines.push(`- ${formatTicket(ticket, eventConfig)}`);
  }
  lines.push("");
  lines.push(eventConfig.ticketPageUrl);

  return lines.join("\n").slice(0, 4000);
}

function buildTemporaryUnreadableMessage({ eventConfig, status, error, ticketPageUrl, checkoutPageUrl }) {
  const runUrl = getGitHubRunUrl();
  const lines = [
    `HYROX ticket page visibility changed: ${eventConfig.name}`,
    `Status: ${status}`,
    `Reason: ${error?.message || "Ticket page temporarily unreadable."}`,
    "",
    "This usually means HYROX/Vivenu is serving a queue, waiting room, or sale gate instead of normal ticket JSON."
  ];

  if (checkoutPageUrl) {
    lines.push("The monitor will try cached checkout availability JSON when it is still publicly readable.");
  } else {
    lines.push("No cached checkout URL is available yet, so the monitor preserved the last known state.");
  }

  lines.push("");
  lines.push(ticketPageUrl);

  if (checkoutPageUrl) {
    lines.push(checkoutPageUrl);
  }

  if (runUrl) {
    lines.push("");
    lines.push(`GitHub run: ${runUrl}`);
  }

  return lines.filter(Boolean).join("\n").slice(0, 1900);
}

async function sendTelegramMessage(config, content) {
  const telegram = config.notifications?.telegram || {};
  const botToken = process.env[telegram.botTokenEnvVar || "TELEGRAM_BOT_TOKEN"];
  const chatId = process.env[telegram.chatIdEnvVar || "TELEGRAM_CHAT_ID"];
  const enabled = telegram.enabled === true;

  if (!enabled) return false;

  if (!botToken) {
    throw new Error(
      `Telegram is enabled in config, but ${telegram.botTokenEnvVar || "TELEGRAM_BOT_TOKEN"} is not set in environment/GitHub Secrets. Please verify the Secret name in GitHub Repository Settings.`
    );
  }
  if (!chatId) {
    throw new Error(
      `Telegram is enabled in config, but ${telegram.chatIdEnvVar || "TELEGRAM_CHAT_ID"} is not set in environment/GitHub Secrets. Please verify the Secret name in GitHub Repository Settings.`
    );
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ chat_id: chatId, text: content })
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ description: "Unknown error" }));
    throw new Error(`Telegram API failed: HTTP ${response.status} ${body.description}`);
  }

  return true;
}

function getGitHubRunUrl() {
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;

  if (!serverUrl || !repository || !runId) return null;
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

function buildMonitorErrorMessage(config, state, error, context = {}) {
  const runUrl = getGitHubRunUrl();
  const serialized = serializeError(error);
  const lines = [
    "HYROX ticket monitor problem after retries.",
    `Stage: ${context.stage || "unknown"}`,
    `Error: ${serialized.name}: ${serialized.message}`,
    ""
  ];

  lines.push(...getEventUrls(config, state));

  if (runUrl) {
    lines.push("");
    lines.push(`GitHub run: ${runUrl}`);
  }

  return lines.filter(Boolean).join("\n").slice(0, 1900);
}

function deriveCheckoutPageUrl(eventConfig, event) {
  if (eventConfig.checkoutPageUrl) return eventConfig.checkoutPageUrl;

  const eventId = event?._id || event?.id;
  if (!eventId) {
    throw new Error(`Could not derive checkout URL because ${eventConfig.name} has no event ID.`);
  }

  const ticketPage = new URL(eventConfig.ticketPageUrl);
  const checkoutPage = new URL(`/checkout/${eventId}`, ticketPage);
  checkoutPage.search = ticketPage.search;
  return checkoutPage.href;
}

function validateEventTickets(event, eventConfig, sourceLabel) {
  if (!event || !Array.isArray(event.tickets)) {
    throw new Error(`Could not find event.tickets in the ${sourceLabel} JSON for ${eventConfig.name}.`);
  }
}

function validateCheckoutAvailability(event, eventConfig) {
  validateEventTickets(event, eventConfig, "checkout page");

  if (!event.tickets.some((ticket) => Object.prototype.hasOwnProperty.call(ticket, "v"))) {
    throw new Error(`Could not find checkout ticket availability volumes for ${eventConfig.name}.`);
  }
}

function buildUnavailableTicketPageState({
  eventConfig,
  eventState,
  checkedAt,
  ticketPageUrl,
  checkoutPageUrl,
  status,
  error
}) {
  const activeAthleteTickets = eventState.activeAthleteTickets || [];
  const serializedError = error ? serializeError(error) : null;

  return {
    ...eventState,
    lastCheckedAt: checkedAt,
    eventName: eventState.eventName || eventConfig.name,
    eventId: eventState.eventId,
    officialEventPageUrl: eventConfig.officialEventPageUrl,
    ticketPageUrl,
    checkoutPageUrl: checkoutPageUrl || eventState.checkoutPageUrl || null,
    availabilityDetectorVersion:
      eventState.availabilityDetectorVersion || AVAILABILITY_DETECTOR_VERSION,
    activeAthleteTicketIds: eventState.activeAthleteTicketIds || [],
    activeAthleteTickets,
    lastResult: {
      status,
      preservedPreviousAvailability: true,
      lastKnownAvailableMatchedTicketCount: activeAthleteTickets.length,
      error: serializedError,
      availableMatchedTicketCount: null,
      changedMatchedTicketCount: 0,
      newMatchedTicketCount: 0,
      quantityIncreaseMatchedTicketCount: 0,
      priorityChangedMatchedTicketCount: 0,
      priorityNewMatchedTicketCount: 0,
      priorityQuantityIncreaseMatchedTicketCount: 0
    }
  };
}

function maybeQueueTemporaryUnreadableAlert({
  config,
  alertMessages,
  eventConfig,
  eventState,
  status,
  error,
  ticketPageUrl,
  checkoutPageUrl
}) {
  const previousStatus = eventState.lastResult?.status;

  if (isTemporaryUnreadableStatus(previousStatus)) {
    console.log("Temporary unreadable state already reported for this event.");
    return;
  }

  if (!shouldNotifyTemporaryUnreadableAlert(config)) {
    console.log("Telegram temporary unreadable notification type disabled.");
    return;
  }

  alertMessages.push(
    buildTemporaryUnreadableMessage({
      eventConfig,
      status,
      error,
      ticketPageUrl,
      checkoutPageUrl
    })
  );
}

function buildWorkflowFailureMessage(config, state = {}) {
  const runUrl = getGitHubRunUrl();
  const headline = runUrl
    ? "HYROX ticket monitor workflow failed outside the monitor script."
    : "TEST: HYROX ticket monitor workflow-failure notification.";
  const lines = [
    headline
  ];

  lines.push(...getEventUrls(config, state));

  if (runUrl) {
    lines.push("");
    lines.push(`GitHub run: ${runUrl}`);
  }

  return lines.filter(Boolean).join("\n").slice(0, 1900);
}

async function notifyMonitorError(config, state, error, context = {}) {
  if (!shouldNotify(config, "monitor_error_after_retries")) {
    console.log("Telegram error notification type disabled.");
    await markErrorNotified(config);
    return;
  }

  const message = buildMonitorErrorMessage(config, state, error, context);

  try {
    const sent = await sendTelegramMessage(config, message);
    console.log(sent ? "Telegram error notification sent." : "Telegram error notification disabled.");
    if (sent) {
      await markErrorNotified(config);
    }
  } catch (notificationError) {
    console.error("Failed to send Telegram error notification:", notificationError.message);
  }
}

async function recordMonitorError(config, state, error, context = {}) {
  const nextState = {
    ...defaultState,
    ...state,
    lastErrorAt: new Date().toISOString(),
    lastError: {
      stage: context.stage || "unknown",
      ...serializeError(error)
    }
  };

  await saveState(config, nextState);
  await appendLog(config, "error", "Monitor failed", {
    stage: context.stage || "unknown",
    error: serializeError(error)
  });
}

function shouldSkipForInterval(state, config) {
  if (force || !state.lastCheckedAt) return false;

  const minimumMinutes = config.monitoring.minimumMinutesBetweenChecks || 0;
  if (minimumMinutes <= 0) return false;

  const lastCheckedAt = new Date(state.lastCheckedAt).getTime();
  if (!Number.isFinite(lastCheckedAt)) return false;

  const elapsedMs = Date.now() - lastCheckedAt;
  return elapsedMs < minimumMinutes * 60 * 1000;
}

async function setTelegramCommands(config) {
  const telegram = config.notifications?.telegram || {};
  const botToken = process.env[telegram.botTokenEnvVar || "TELEGRAM_BOT_TOKEN"];
  if (!botToken || !telegram.enabled) return;

  const commands = [
    { command: "report", description: "Mostra disponibilità eventi" },
    { command: "check", description: "Controlla biglietti adesso (anche /check città)" },
    { command: "add", description: "Aggiungi evento (es. /add <url evento HYROX>)" },
    { command: "remove", description: "Rimuovi evento (es. /remove milan)" },
    { command: "list", description: "Elenca eventi monitorati" }
  ];

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands })
    });
    console.log("Comandi Telegram impostati con successo.");
  } catch (e) {
    console.error("Errore impostazione comandi Telegram:", e.message);
  }
}

function buildReportLines(config, state, eventsToReport) {
  const lines = [];
  for (const e of eventsToReport) {
    const evState = state.events?.[e.key];
    let statusStr = "🔴 Esaurito";
    if (!evState) {
      statusStr = "⚪ Mai controllato";
    } else if (evState.lastResult?.status === "error_fetching_page") {
      statusStr = "⚠️ Errore pagina web";
    } else if (evState.lastResult?.status === "waiting_for_ticket_page") {
      statusStr = "⏳ In attesa di vendite";
    } else {
      const count = evState.lastResult?.availableMatchedTicketCount ?? 0;
      if (count > 0) statusStr = "🟢 " + count + " disp.";
    }
    lines.push(`- ${e.name}: ${statusStr}`);

    if (evState && evState.lastResult?.availableMatchedTicketCount > 0 && evState.activeAthleteTickets) {
      for (const ticket of evState.activeAthleteTickets) {
        lines.push(`  └ ${ticket.name}: ${ticket.availableQuantity} disp.`);
      }
    }
  }
  return lines;
}

async function processTelegramCommands(config, state) {
  const telegram = config.notifications?.telegram || {};
  const botToken = process.env[telegram.botTokenEnvVar || "TELEGRAM_BOT_TOKEN"];
  const chatId = process.env[telegram.chatIdEnvVar || "TELEGRAM_CHAT_ID"];

  if (!telegram.enabled || !botToken || !chatId) return { triggerCheck: false, stateModified: false };

  let triggerCheck = false;
  let stateModified = false;

  // A command forwarded by the webhook service (webhook.js) arrives as a workflow input:
  // the webhook already received it, so there is nothing to poll (and polling would 409).
  const forwardedCommand = (process.env.HYROX_TELEGRAM_COMMAND || "").trim();

  try {
    let updates;

    if (forwardedCommand) {
      updates = [{ message: { chat: { id: chatId }, text: forwardedCommand } }];
    } else {
      const offset = state.telegramUpdateOffset ? state.telegramUpdateOffset + 1 : undefined;
      const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
      const body = offset ? { offset, allowed_updates: ["message"] } : { allowed_updates: ["message"] };

      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        // Most common causes: 409 (a webhook is set, e.g. webhook.js on Render), 401 (bad token).
        const errorBody = await response.text().catch(() => "");
        console.error(`Telegram getUpdates failed: HTTP ${response.status} ${errorBody}`);
        return { triggerCheck, stateModified };
      }
      const data = await response.json();
      if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) return { triggerCheck, stateModified };
      updates = data.result;
    }

    if (!state.dynamicEvents) state.dynamicEvents = [];

    for (const update of updates) {
      if (update.update_id !== undefined) {
        state.telegramUpdateOffset = Math.max(state.telegramUpdateOffset || 0, update.update_id);
      }

      const msg = update.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== String(chatId)) {
        console.log(`Ignored Telegram message from unauthorized chat ${msg.chat.id}.`);
        continue;
      }

      // Handle "/add@MyBot url" (groups) and bare commands sent from the Telegram menu.
      const text = msg.text.trim().replace(/^(\/\w+)@\w+/, "$1");

      // One failing command must not abort the remaining updates (the offset is already advanced).
      try {
        if (text === "/add" || text.startsWith("/add ")) {
          const eventInput = text.slice(4).trim();

          if (!eventInput) {
            await sendTelegramMessage(
              config,
              "ℹ️ Uso: /add <url completo della pagina evento>\n" +
                "Esempio: /add https://hyrox.com/event/goodlife-hyrox-toronto-26-27/"
            );
            continue;
          }

          let eventUrl = eventInput;

          if (!/^https?:\/\//i.test(eventUrl)) {
            let slug = eventUrl.toLowerCase().replace(/\s+/g, '-');
            if (!slug.startsWith('hyrox-')) {
              slug = 'hyrox-' + slug;
            }
            eventUrl = `https://hyrox.com/event/${slug}/`;
          }

          try {
            new URL(eventUrl);
          } catch {
            await sendTelegramMessage(config, `⚠️ URL non valido: ${eventUrl}`);
            continue;
          }

          const normalized = normalizeUrl(eventUrl);
          const matchesUrl = (e) =>
            [e.officialEventPageUrl, e.ticketPageUrl]
              .filter(Boolean)
              .some((u) => normalizeUrl(u) === normalized);

          const removedStatic = getStaticEvents(config).find(
            (e) => (state.removedStaticEventKeys || []).includes(e.key) && matchesUrl(e)
          );
          if (removedStatic) {
            state.removedStaticEventKeys = state.removedStaticEventKeys.filter((k) => k !== removedStatic.key);
            stateModified = true;
            await sendTelegramMessage(config, `✅ Evento riattivato:\n${removedStatic.name}`);
            continue;
          }

          const alreadyMonitored = getConfiguredEvents(config, state).some((e) =>
            [e.officialEventPageUrl, e.ticketPageUrl]
              .filter(Boolean)
              .some((u) => normalizeUrl(u) === normalized)
          );

          if (alreadyMonitored) {
            await sendTelegramMessage(config, `⚠️ Questo evento è già monitorato.`);
            continue;
          }

          // Make sure the page really exists before saving it.
          try {
            await fetchText(eventUrl, config);
          } catch (fetchError) {
            await sendTelegramMessage(
              config,
              `⚠️ Non riesco ad aprire questa pagina (${fetchError.message}).\n` +
                `Controlla l'URL e riprova con l'indirizzo completo:\n${eventUrl}`
            );
            continue;
          }

          const newEvent = {
            key: slugify(eventUrl),
            name: `(Dynamic) ${eventUrl.split('/').filter(Boolean).pop()}`,
            officialEventPageUrl: eventUrl
          };

          state.dynamicEvents.push(newEvent);
          stateModified = true;
          await sendTelegramMessage(config, `✅ Evento aggiunto alla coda di monitoraggio:\n${eventUrl}`);
          console.log(`Added dynamic event via Telegram: ${eventUrl}`);
        } else if (text === '/list') {
          const allEvents = getConfiguredEvents(config, state);
          const lines = allEvents.map(e => `- ${e.name}\n  ${e.officialEventPageUrl || e.ticketPageUrl}`);
          await sendTelegramMessage(config, `📋 Eventi monitorati attualmente (${allEvents.length}):\n\n${lines.join('\n\n')}`);
        } else if (text === '/remove' || text.startsWith('/remove ')) {
          const query = text.slice(7).trim().toLowerCase();

          if (!query) {
            await sendTelegramMessage(config, "ℹ️ Uso: /remove <parte del nome o dell'URL>\nUsa /list per vedere gli eventi.");
            continue;
          }

          const matchesQuery = (e) =>
            [e.officialEventPageUrl, e.ticketPageUrl, e.name, e.key]
              .some((v) => v?.toLowerCase().includes(query));

          const removedDynamic = state.dynamicEvents.filter(matchesQuery);
          state.dynamicEvents = state.dynamicEvents.filter((e) => !matchesQuery(e));

          const removedKeys = new Set(state.removedStaticEventKeys || []);
          const removedStatic = getStaticEvents(config).filter((e) => !removedKeys.has(e.key) && matchesQuery(e));
          if (removedStatic.length > 0) {
            state.removedStaticEventKeys = [...removedKeys, ...removedStatic.map((e) => e.key)];
          }

          const removedNames = [...removedDynamic, ...removedStatic].map((e) => `- ${e.name}`);
          if (removedNames.length > 0) {
            stateModified = true;
            await sendTelegramMessage(
              config,
              `🗑️ Rimosso dal monitoraggio:\n${removedNames.join("\n")}` +
                (removedStatic.length > 0 ? `\n\nPer riattivarlo: /add <url evento>` : "")
            );
          } else {
            await sendTelegramMessage(config, `⚠️ Nessun evento corrisponde a "${query}". Usa /list per vedere gli eventi.`);
          }
        } else if (text === '/report') {
          const allEvents = getConfiguredEvents(config, state);
          const lines = buildReportLines(config, state, allEvents);
          await sendTelegramMessage(config, `📊 Report Disponibilità:\n\n${lines.join('\n')}`);
        } else if (text === '/check' || text.startsWith('/check ')) {
          const parts = text.split(' ');
          if (parts.length > 1) {
            const query = parts.slice(1).join(' ').toLowerCase();
            const allEvents = getConfiguredEvents(config, state);
            const event = allEvents.find(e => e.key.includes(query) || (e.name && e.name.toLowerCase().includes(query)));
            if (event) {
              if (!forwardedCommand) await sendTelegramMessage(config, `⏳ Avvio controllo immediato per:\n${event.name}...`);
              targetEventKey = event.key;
              triggerCheck = true;
            } else {
              await sendTelegramMessage(config, `⚠️ Evento non trovato: ${query}`);
            }
          } else {
            if (!forwardedCommand) await sendTelegramMessage(config, `⏳ Avvio controllo immediato di tutti gli eventi...`);
            targetEventKey = null;
            triggerCheck = true;
          }
        }
      } catch (commandError) {
        console.error(`Failed to handle Telegram command "${text}":`, commandError.message);
      }
    }
  } catch (err) {
    console.error("Failed to process Telegram commands:", err.message);
  }

  return { triggerCheck, stateModified };
}

async function main(injectedState) {
  await loadDotEnv();

  const config = await loadJson(CONFIG_FILE);
  const state = injectedState || await loadState(config, defaultState);
  validateConfig(config, state);

  if (notifyTest) {
    const sampleEventName = config.events?.[0]?.name || "HYROX Event";
    const sampleEventUrl = config.events?.[0]?.officialEventPageUrl || "https://hyrox.com/";
    const mockMessage = `🧪 TEST: Esempio notifica biglietti HYROX\n\n` +
      `PRIORITY: Open Men ticket available: ${sampleEventName}\n` +
      `- Mens Open (SOLO_OPEN_M, 2026-11-20, 15 available)\n\n` +
      `${sampleEventName} new or increased monitored athlete ticket availability detected.\n` +
      `- Mens Open (SOLO_OPEN_M, 2026-11-20, 15 available)\n` +
      `- Womens Pro (SOLO_PRO_W, 2026-11-20, 4 available, was 1)\n\n` +
      `${sampleEventUrl}`;

    const sent = await sendTelegramMessage(
      config,
      mockMessage
    );
    console.log(sent ? "Sent Telegram test notification." : "Telegram notification disabled.");
    return state;
  }

  if (workflowFailureNotify) {
    const sent = await sendTelegramMessage(config, buildWorkflowFailureMessage(config, state));
    console.log(sent ? "Sent Telegram workflow failure notification." : "Telegram notification disabled.");
    return state;
  }

  // One-shot mode (e.g. GitHub Actions): read Telegram commands BEFORE the interval check,
  // so /add, /remove and /check are never lost because the last check was "too recent".
  // In bot mode the continuous loop handles commands itself. Set
  // HYROX_DISABLE_TELEGRAM_COMMANDS=1 in the workflow if the bot runs elsewhere, so that
  // only ONE process consumes Telegram updates.
  if (
    !isBotMode &&
    !dryRun &&
    process.env.HYROX_DISABLE_TELEGRAM_COMMANDS !== "1"
  ) {
    const previousOffset = state.telegramUpdateOffset;
    const commandResult = await processTelegramCommands(config, state);

    if (commandResult.triggerCheck) {
      force = true;
      sendReportAfterCheck = true;
    }

    if (commandResult.stateModified || state.telegramUpdateOffset !== previousOffset) {
      await saveState(config, state);
    }
  }

  if (shouldSkipForInterval(state, config)) {
    console.log(
      `Skipped. Last checked at ${state.lastCheckedAt}; minimum interval is ${config.monitoring.minimumMinutesBetweenChecks} minutes. Use --force to check now.`
    );
    return state;
  }

  let configuredEvents = getConfiguredEvents(config, state);
  if (targetEventKey) {
    configuredEvents = configuredEvents.filter(e => e.key === targetEventKey);
  }

  const checkedAt = new Date().toISOString();
  const nextState = {
    ...state,
    events: {
      ...(state.events || {})
    },
    lastCheckedAt: checkedAt
  };

  const alertMessages = [];

  for (const eventConfig of configuredEvents) {
    const eventState = getEventState(state, eventConfig);
    let ticketPageUrl = eventConfig.ticketPageUrl;

    if (!ticketPageUrl) {
      if (!eventConfig.officialEventPageUrl) {
        throw new Error(`No ticketPageUrl or officialEventPageUrl configured for ${eventConfig.name}.`);
      }

      let officialPageHtml;
      try {
        officialPageHtml = await withRetries(
          config,
          `Fetch official event page for ${eventConfig.name}`,
          () => fetchText(eventConfig.officialEventPageUrl, config)
        );
      } catch (error) {
        nextState.events[eventConfig.key] = {
          lastCheckedAt: checkedAt,
          eventName: eventConfig.name,
          officialEventPageUrl: eventConfig.officialEventPageUrl,
          ticketPageUrl: null,
          checkoutPageUrl: null,
          availabilityDetectorVersion: AVAILABILITY_DETECTOR_VERSION,
          activeAthleteTicketIds: [],
          activeAthleteTickets: [],
          lastResult: {
            status: "error_fetching_page",
            error: serializeError(error),
            availableMatchedTicketCount: 0
          }
        };
        console.log(`Checked ${eventConfig.name}. Error: ${error.message}`);
        continue;
      }

      const officialPageSummary = summarizeOfficialPage(officialPageHtml, eventConfig);
      ticketPageUrl = discoverTicketPageUrl(officialPageHtml, eventConfig);

      if (!ticketPageUrl) {
        nextState.events[eventConfig.key] = {
          lastCheckedAt: checkedAt,
          eventName: eventConfig.name,
          officialEventPageUrl: eventConfig.officialEventPageUrl,
          ticketPageUrl: null,
          checkoutPageUrl: null,
          availabilityDetectorVersion: AVAILABILITY_DETECTOR_VERSION,
          activeAthleteTicketIds: [],
          activeAthleteTickets: [],
          lastResult: {
            status: "waiting_for_ticket_page",
            officialPageTicketSalesStartSoon: officialPageSummary.ticketSalesStartSoon,
            candidateTicketPageUrlCount: officialPageSummary.candidateTicketPageUrls.length,
            availableMatchedTicketCount: 0,
            changedMatchedTicketCount: 0,
            newMatchedTicketCount: 0,
            quantityIncreaseMatchedTicketCount: 0,
            priorityChangedMatchedTicketCount: 0,
            priorityNewMatchedTicketCount: 0,
            priorityQuantityIncreaseMatchedTicketCount: 0
          }
        };

        console.log(`Checked ${eventConfig.name}.`);
        console.log("No ticket page found yet on the official event page.");
        if (officialPageSummary.ticketSalesStartSoon) {
          console.log("Official page currently says: Ticket sales start soon.");
        }
        continue;
      }

      console.log(`Discovered ticket page for ${eventConfig.name}: ${ticketPageUrl}`);
    }

    const resolvedEventConfig = {
      ...eventConfig,
      ticketPageUrl
    };
    let pageEvent = null;
    let checkoutPageUrl = null;
    let eventPageError = null;

    try {
      pageEvent = await withRetries(config, `Fetch event page for ${eventConfig.name}`, async () => {
        const nextData = extractNextData(await fetchText(ticketPageUrl, config));
        const eventFromPage = nextData.props?.pageProps?.event;

        validateEventTickets(eventFromPage, resolvedEventConfig, "event page");

        return eventFromPage;
      });
      checkoutPageUrl = deriveCheckoutPageUrl(resolvedEventConfig, pageEvent);
    } catch (error) {
      if (!isTemporaryTicketPageError(error)) {
        throw error;
      }

      eventPageError = error;
      checkoutPageUrl = eventState.checkoutPageUrl || null;

      if (!checkoutPageUrl) {
        maybeQueueTemporaryUnreadableAlert({
          config,
          alertMessages,
          eventConfig: resolvedEventConfig,
          eventState,
          status: "ticket_page_temporarily_unreadable",
          error,
          ticketPageUrl,
          checkoutPageUrl
        });

        nextState.events[eventConfig.key] = buildUnavailableTicketPageState({
          eventConfig: resolvedEventConfig,
          eventState,
          checkedAt,
          ticketPageUrl,
          checkoutPageUrl,
          status: "ticket_page_temporarily_unreadable",
          error
        });

        console.log(`Checked ${eventConfig.name}.`);
        console.log("Ticket page temporarily unreadable; preserving previous availability state.");
        console.log(`Reason: ${error.message}`);
        continue;
      }

      console.warn(`Ticket event page temporarily unreadable for ${eventConfig.name}; using cached checkout URL.`);
      console.warn(`Reason: ${error.message}`);
      maybeQueueTemporaryUnreadableAlert({
        config,
        alertMessages,
        eventConfig: resolvedEventConfig,
        eventState,
        status: "event_page_temporarily_unreadable_checkout_readable",
        error,
        ticketPageUrl,
        checkoutPageUrl
      });
    }

    let checkoutEvent = null;
    try {
      checkoutEvent = await withRetries(config, `Fetch checkout availability for ${eventConfig.name}`, async () => {
        const nextData = extractNextData(await fetchText(checkoutPageUrl, config));
        const eventFromCheckout = nextData.props?.pageProps?.event;

        validateCheckoutAvailability(eventFromCheckout, resolvedEventConfig);

        return eventFromCheckout;
      });
    } catch (error) {
      if (!eventPageError && !isTemporaryTicketPageError(error)) {
        throw error;
      }

      maybeQueueTemporaryUnreadableAlert({
        config,
        alertMessages,
        eventConfig: resolvedEventConfig,
        eventState,
        status: "ticket_checkout_temporarily_unreadable",
        error,
        ticketPageUrl,
        checkoutPageUrl
      });

      nextState.events[eventConfig.key] = buildUnavailableTicketPageState({
        eventConfig: resolvedEventConfig,
        eventState,
        checkedAt,
        ticketPageUrl,
        checkoutPageUrl,
        status: "ticket_checkout_temporarily_unreadable",
        error
      });

      console.log(`Checked ${eventConfig.name}.`);
      console.log("Ticket checkout temporarily unreadable; preserving previous availability state.");
      console.log(`Reason: ${error.message}`);
      continue;
    }

    const event = {
      ...(pageEvent || {}),
      ...checkoutEvent,
      tickets: checkoutEvent.tickets,
      categories: checkoutEvent.categories || pageEvent?.categories || []
    };

    const ticketFilter = mergeTicketFilter(config, resolvedEventConfig);
    const availableTickets = filterInterestingTickets(event.tickets, ticketFilter, event);
    const detectorChanged =
      !!eventState.lastCheckedAt &&
      eventState.availabilityDetectorVersion !== AVAILABILITY_DETECTOR_VERSION;
    const firstRun = !eventState.lastCheckedAt;
    const alertOnFirstRun = config.monitoring.alertOnFirstRunAvailableTickets === true;
    const alertOnlyOnChanges = config.monitoring.alertOnlyOnChanges !== false;
    const changedTickets = getChangedTickets(
      availableTickets,
      eventState,
      detectorChanged,
      alertOnlyOnChanges
    );
    const alertTickets = firstRun
      ? (alertOnFirstRun ? availableTickets : [])
      : changedTickets.alertTickets;
    const newTickets = firstRun ? alertTickets : changedTickets.newTickets;
    const quantityIncreaseTickets = firstRun ? [] : changedTickets.quantityIncreaseTickets;
    const priorityTickets = alertTickets.filter((ticket) =>
      isPriorityTicket(ticket, ticketFilter.prioritySignals || [])
    );
    const priorityNewTickets = newTickets.filter((ticket) =>
      isPriorityTicket(ticket, ticketFilter.prioritySignals || [])
    );
    const priorityQuantityIncreaseTickets = quantityIncreaseTickets.filter((ticket) =>
      isPriorityTicket(ticket, ticketFilter.prioritySignals || [])
    );

    nextState.events[eventConfig.key] = {
      lastCheckedAt: checkedAt,
      eventName: event.name || eventState.eventName || eventConfig.name,
      eventId: event._id || event.id || eventState.eventId,
      officialEventPageUrl: eventConfig.officialEventPageUrl,
      ticketPageUrl,
      checkoutPageUrl,
      availabilityDetectorVersion: AVAILABILITY_DETECTOR_VERSION,
      activeAthleteTicketIds: availableTickets.map((ticket) => ticket.id),
      activeAthleteTickets: availableTickets,
      lastResult: {
        status: eventPageError
          ? "event_page_temporarily_unreadable_checkout_readable"
          : "ok",
        eventPageTemporarilyUnreadable: !!eventPageError,
        eventPageTemporaryUnreadableError: eventPageError ? serializeError(eventPageError) : null,
        pageTicketCount: event.tickets.length,
        availableMatchedTicketCount: availableTickets.length,
        changedMatchedTicketCount: alertTickets.length,
        newMatchedTicketCount: newTickets.length,
        quantityIncreaseMatchedTicketCount: quantityIncreaseTickets.length,
        priorityChangedMatchedTicketCount: priorityTickets.length,
        priorityNewMatchedTicketCount: priorityNewTickets.length,
        priorityQuantityIncreaseMatchedTicketCount: priorityQuantityIncreaseTickets.length
      }
    };

    console.log(`Checked ${event.name || eventState.eventName || eventConfig.name}.`);
    console.log(`Page ticket types: ${event.tickets.length}`);
    console.log(`Available monitored athlete tickets: ${availableTickets.length}`);

    if (availableTickets.length > 0) {
      for (const ticket of availableTickets) {
        console.log(`- ${formatTicket(ticket, resolvedEventConfig)}`);
      }
    }

    if (firstRun && alertTickets.length === 0) {
      console.log(dryRun ? "Dry run only; no baseline state written for this event." : "Baseline saved for this event; no alert sent on first run.");
      continue;
    }

    if (firstRun) {
      console.log("First run has available monitored tickets; alerting because alertOnFirstRunAvailableTickets is enabled.");
    }

    if (detectorChanged && availableTickets.length > 0) {
      console.log("Availability detector changed; current buyable tickets are being treated as new.");
    }

    if (alertTickets.length === 0) {
      console.log("No new or increased available monitored athlete tickets for this event since the last run.");
      continue;
    }

    const message = buildTicketAlertMessage({
      config,
      eventConfig: resolvedEventConfig,
      event,
      changedTickets: alertTickets,
      priorityTickets,
      ticketFilter
    });

    console.log("New or increased available monitored athlete tickets detected:");
    for (const ticket of alertTickets) {
      const priority = priorityTickets.some((priorityTicket) => priorityTicket.id === ticket.id)
        ? " PRIORITY"
        : "";
      console.log(`- ${formatTicket(ticket, resolvedEventConfig)}${priority}`);
    }

    if (shouldNotifyTicketAlert(config, priorityTickets)) {
      alertMessages.push(message);
    } else {
      console.log("Telegram ticket notification type disabled; state will still be updated.");
    }
  }

  if (alertMessages.length === 0) {
    if (!dryRun) {
      await saveState(config, nextState);
    }
    return nextState;
  }

  if (dryRun) {
    console.log("Dry run only; Telegram notification not sent.");
    console.log(alertMessages.join("\n\n---\n\n"));
    return nextState;
  }

  for (let i = 0; i < alertMessages.length; i++) {
    if (i > 0) {
      await sleep(1000);
    }
    const message = alertMessages[i];
    const sent = await withRetries(config, "Send Telegram ticket notification", () =>
      sendTelegramMessage(config, message)
    );
    if (!sent) {
      throw new Error("Telegram notification was required for ticket alerts, but Telegram is disabled.");
    }
    console.log(sent ? "Telegram notification sent." : "Telegram notification disabled.");
  }

  if (!dryRun) {
    await saveState(config, nextState);
  }

  return nextState;
}

async function startBotLoop() {
  console.log("🤖 Avviato in modalità Bot Continuo. Il bot risponderà immediatamente su Telegram.");
  console.log("Attenzione: tieni questa finestra aperta per mantenere il bot in ascolto.");
  console.log("Premi Ctrl+C per fermarlo.\n");

  await loadDotEnv();
  const config = await loadJson(CONFIG_FILE);

  await setTelegramCommands(config);

  const port = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('HYROX Bot is running.\n');
  });
  server.listen(port, () => {
    console.log(`🌐 Server web avviato sulla porta ${port} (necessario per Render).`);
  });

  let state = await loadState(config, defaultState);
  let lastAutoCheckTime = 0;

  while (true) {
    try {
      validateConfig(config, state);
      const oldOffset = state.telegramUpdateOffset;

      const result = await processTelegramCommands(config, state);

      // Commands are persisted immediately, so a later reload/scan cannot lose them.
      if (state.telegramUpdateOffset !== oldOffset || result.stateModified) {
        await saveState(config, state);
      }

      if (result.triggerCheck) {
        console.log("\nEseguo scansione immediata richiesta da Telegram...");
        force = true;
        // Reload the shared state first: another process (e.g. GitHub Actions) may have
        // updated it since it was loaded, and we must not overwrite it with a stale copy.
        state = await loadState(config, state);
        const newState = await main(state);
        if (newState) state = newState;
        force = false;
        console.log("Scansione immediata completata.\n");

        let allEvents = getConfiguredEvents(config, state);

        if (targetEventKey) {
          allEvents = allEvents.filter(e => e.key === targetEventKey);
        }

        const lines = buildReportLines(config, state, allEvents);
        await sendTelegramMessage(config, `✅ Controllo completato!\n\n📊 Report Aggiornato:\n\n${lines.join('\n')}`);

        targetEventKey = null;
      } else {
        const minimumMinutes = config.monitoring?.minimumMinutesBetweenChecks || 15;
        if (!shouldSkipForInterval(state, config) && (Date.now() - lastAutoCheckTime > minimumMinutes * 60 * 1000)) {
          console.log("\nAvvio scansione automatica periodica...");
          state = await loadState(config, state);
          const newState = await main(state);
          if (newState) state = newState;
          lastAutoCheckTime = Date.now();
          console.log("Scansione automatica periodica completata.\n");
        }
      }
    } catch (e) {
      force = false;
      console.error("Bot loop error:", e.message);
      // Back off so a failing remote (e.g. JSONBin rate limit) is not hammered every 3 seconds.
      await sleep(15000);
    }
    await sleep(3000);
  }
}

async function run() {
  if (isBotMode) {
    await startBotLoop();
    return;
  }

  let config = null;
  let state = defaultState;
  let stateLoaded = false;
  let stage = "startup";

  try {
    await loadDotEnv();
    config = await loadJson(CONFIG_FILE);
    state = await loadState(config, defaultState);
    stateLoaded = true;
    stage = "monitor";
    const finalState = await main(state);

    // Ticket alerts only fire on changes, so a manual run (workflow_dispatch or /check)
    // would otherwise finish silently. Always answer it with the current report.
    if (sendReportAfterCheck && !dryRun && !notifyTest && !workflowFailureNotify && finalState) {
      let reportEvents = getConfiguredEvents(config, finalState);
      if (targetEventKey) reportEvents = reportEvents.filter((e) => e.key === targetEventKey);
      const lines = buildReportLines(config, finalState, reportEvents);
      await sendTelegramMessage(
        config,
        `✅ Controllo completato!\n\n📊 Report:\n\n${lines.join("\n") || "Nessun evento monitorato."}`
      );
    }
  } catch (error) {
    console.error(error.stack || error.message || error);

    if (config && !dryRun) {
      try {
        let latestState = state;
        let canSaveState = stateLoaded;

        try {
          latestState = await loadState(config, state);
          canSaveState = true;
        } catch (stateError) {
          console.error("Could not reload state while handling error:", stateError.message);
        }

        if (canSaveState) {
          await recordMonitorError(config, latestState, error, { stage });
        } else {
          // Never persist the empty default state: it would overwrite the real remote state.
          await appendLog(config, "error", "Monitor failed (state unavailable, not saved)", {
            stage,
            error: serializeError(error)
          });
        }
        await notifyMonitorError(config, latestState, error, { stage });
      } catch (handlingError) {
        console.error("Failed while handling monitor error:", handlingError.stack || handlingError.message || handlingError);
      }
    } else if (dryRun) {
      console.error("Dry run only; error state and Telegram error notification were not written.");
    }

    process.exitCode = 1;
  }
}

run().catch(async (error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
