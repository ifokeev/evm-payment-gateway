const number = new Intl.NumberFormat();
const withdrawalOrder = [
  "awaiting_signature",
  "submitted",
  "confirming",
  "complete",
  "failed",
  "expired",
];
const swapOrder = [
  "awaiting_input",
  "input_confirming",
  "input_confirmed",
  "awaiting_signature",
  "output_submitted",
  "complete",
  "refund_required",
  "refund_awaiting_signature",
  "refund_submitted",
  "refunded",
  "expired",
  "reorged",
];

async function initialize() {
  const main = document.querySelector("#analytics-main");
  try {
    const [configResponse, analyticsResponse] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/analytics"),
    ]);
    const [config, analytics] = await Promise.all([
      configResponse.json(),
      analyticsResponse.json(),
    ]);
    if (!configResponse.ok || !analyticsResponse.ok) {
      throw new Error(analytics.error ?? config.error ?? "Analytics are unavailable");
    }
    render(config, analytics);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analytics are unavailable";
    text("#analytics-updated", "Totals unavailable");
    text("#analytics-error", `${message}. Try again soon.`);
    document.querySelector("#analytics-error").hidden = false;
  } finally {
    main.setAttribute("aria-busy", "false");
  }
}

function render(config, analytics) {
  const assets = Array.isArray(analytics.assets) ? analytics.assets : [];
  text("#deposit-total", number.format(sum(assets.map((row) => row.intents))));
  text("#paid-total", number.format(sum(assets.map((row) => row.paidIntents))));
  text("#withdrawal-total", number.format(sum(Object.values(analytics.withdrawals ?? {}))));
  text("#swap-total", number.format(sum(Object.values(analytics.swaps ?? {}))));
  text("#analytics-updated", formatUpdated(analytics.generatedAt));

  const networks = new Map(
    (Array.isArray(config.options) ? config.options : []).map((option) => [
      option.chain,
      option.chainLabel,
    ]),
  );
  const rows = document.querySelector("#settlement-rows");
  rows.replaceChildren(...assets.map((row) => settlementRow(row, networks.get(row.chain))));
  renderStatuses("#withdrawal-statuses", analytics.withdrawals, withdrawalOrder);
  renderStatuses("#swap-statuses", analytics.swaps, swapOrder);
}

function settlementRow(row, networkLabel) {
  const element = document.createElement("tr");
  const confirmed = Number(row.confirmedAmount);
  const collected = Number(row.collectedAmount);
  element.append(
    cell(networkLabel ?? humanize(row.chain), "network-cell"),
    cell(row.asset),
    cell(number.format(row.intents), "numeric-cell"),
    cell(number.format(row.paidIntents), "numeric-cell"),
    amountCell(row.confirmedAmount, row.asset, "confirmed", confirmed > 0 ? 1 : 0),
    amountCell(
      row.collectedAmount,
      row.asset,
      "collected",
      confirmed > 0 && Number.isFinite(collected) ? collected / confirmed : 0,
    ),
  );
  return element;
}

function cell(value, className = "") {
  const element = document.createElement("td");
  element.textContent = String(value ?? "");
  if (className) element.className = className;
  return element;
}

function amountCell(amount, asset, tone, progress) {
  const element = cell(`${amount ?? "0"} ${asset ?? ""}`, "amount-cell");
  const line = document.createElement("span");
  line.className = "amount-line";
  line.dataset.tone = tone;
  line.style.setProperty("--amount-progress", `${Math.min(1, Math.max(0, progress)) * 100}%`);
  line.setAttribute("aria-hidden", "true");
  element.append(line);
  return element;
}

function renderStatuses(selector, statuses = {}, order) {
  const container = document.querySelector(selector);
  const keys = [
    ...order.filter((status) => Number(statuses[status]) > 0),
    ...Object.keys(statuses).filter(
      (status) => !order.includes(status) && Number(statuses[status]) > 0,
    ),
  ];
  if (keys.length === 0) {
    const empty = document.createElement("div");
    empty.className = "analytics-empty";
    const label = document.createElement("dt");
    label.textContent = "No activity yet.";
    empty.append(label);
    container.replaceChildren(empty);
    return;
  }
  container.replaceChildren(
    ...keys.map((status) => {
      const row = document.createElement("div");
      row.dataset.status = status;
      const label = document.createElement("dt");
      const marker = document.createElement("span");
      marker.className = "status-dot";
      marker.setAttribute("aria-hidden", "true");
      label.append(marker, humanize(status));
      const count = document.createElement("dd");
      count.textContent = number.format(statuses[status]);
      row.append(label, count);
      return row;
    }),
  );
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function formatUpdated(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Updated recently";
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
  return `Updated ${day} · ${time} UTC`;
}

function humanize(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function text(selector, value) {
  document.querySelector(selector).textContent = String(value ?? "");
}

initialize();
