import { paymentAction, walletPayment } from "./wallet.js";

const form = document.querySelector("#payment-form");
const network = document.querySelector("#network");
const asset = document.querySelector("#asset");
const purpose = document.querySelector("#purpose");
const purposeHelp = document.querySelector("#purpose-help");
const amount = document.querySelector("#amount");
const amountHelp = document.querySelector("#amount-help");
const amountError = document.querySelector("#amount-error");
const assetLabel = document.querySelector("#asset-label");
const createButton = document.querySelector("#create-button");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const intentState = document.querySelector("#intent-state");
const globalError = document.querySelector("#global-error");
const copyAddress = document.querySelector("#copy-address");
const copyLabel = document.querySelector("#copy-label");
const walletLink = document.querySelector("#wallet-link");
const analyticsPanel = document.querySelector("#analytics-panel");
const analyticsGrid = document.querySelector("#analytics-grid");

let config;
let analytics;
let turnstileToken = "";
let turnstileWidget;
let submitting = false;
let pollTimer;
let pollAttempts = 0;
let openingWallet = false;
let walletPaymentUri = "";
let currentIntentId = sessionStorage.getItem("demo:intentId") ?? "";
let accessToken = sessionStorage.getItem("demo:accessToken") ?? "";
let idempotencyKey = sessionStorage.getItem("demo:idempotencyKey") ?? crypto.randomUUID();

network.addEventListener("change", () => {
  populateAssets();
  updateSelection();
});

asset.addEventListener("change", updateSelection);

purpose.addEventListener("change", () => {
  purposeHelp.textContent =
    purpose.value === "account_top_up"
      ? "The user chooses the amount before the app creates an exact payment intent."
      : "A normal one-time payment for an order or service.";
});

amount.addEventListener("input", () => {
  amountError.textContent = "";
});

copyAddress.addEventListener("click", async () => {
  const address = document.querySelector("#deposit-address").textContent;
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    copyLabel.textContent = "Copied";
    setTimeout(() => {
      copyLabel.textContent = "Copy";
    }, 1_500);
  } catch {
    showGlobalError("Copy failed. Select the address manually.");
  }
});

walletLink.addEventListener("click", async (event) => {
  if (walletLink.getAttribute("aria-disabled") === "true" || !walletPaymentUri) {
    event.preventDefault();
    return;
  }
  const provider = window.ethereum;
  if (typeof provider?.request !== "function") return;
  event.preventDefault();
  if (openingWallet) return;

  openingWallet = true;
  globalError.hidden = true;
  walletLink.textContent = "Opening wallet...";
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const payment = walletPayment(walletPaymentUri, accounts?.[0] ?? "");
    await switchWalletNetwork(provider, payment.chainId);
    await provider.request({ method: "eth_sendTransaction", params: [payment.transaction] });
  } catch (error) {
    showGlobalError(
      walletErrorCode(error) === 4001
        ? "Wallet request was cancelled."
        : "Wallet could not open this payment. Scan the QR code or copy the address.",
    );
  } finally {
    openingWallet = false;
    walletLink.textContent = "Open wallet";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!config || !turnstileToken || submitting) return;
  submitting = true;
  amountError.textContent = "";
  globalError.hidden = true;
  setStage("loading");
  updateCreateButton();
  sessionStorage.setItem("demo:idempotencyKey", idempotencyKey);

  try {
    const response = await fetch("/api/intents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: network.value,
        asset: asset.value,
        amount: amount.value,
        purpose: purpose.value,
        idempotencyKey,
        turnstileToken,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new DemoRequestError(response.status, body.error ?? "Payment failed");
    currentIntentId = body.intent.id;
    accessToken = body.accessToken;
    sessionStorage.setItem("demo:intentId", currentIntentId);
    sessionStorage.setItem("demo:accessToken", accessToken);
    sessionStorage.removeItem("demo:idempotencyKey");
    idempotencyKey = crypto.randomUUID();
    renderPayment({ intent: body.intent, sweep: null, webhookEvent: null });
    startPolling();
  } catch (error) {
    setStage(currentIntentId && accessToken ? "intent" : "empty");
    const message = error instanceof Error ? error.message : "Payment failed";
    if (error instanceof DemoRequestError && error.status === 400)
      amountError.textContent = message;
    else showGlobalError(message);
  } finally {
    submitting = false;
    turnstileToken = "";
    if (window.turnstile && turnstileWidget !== undefined) window.turnstile.reset(turnstileWidget);
    updateCreateButton();
  }
});

async function initialize() {
  try {
    const response = await fetch("/api/config");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Demo configuration is unavailable");
    config = body;
    populateNetworks();
    populateAssets();
    updateSelection();
    network.disabled = false;
    asset.disabled = false;
    amount.disabled = false;
    void loadAnalytics();
    await loadTurnstile(config.turnstileSiteKey);
    if (currentIntentId && accessToken) startPolling(true);
  } catch (error) {
    showGlobalError(error instanceof Error ? error.message : "Demo is unavailable");
  }
}

async function loadAnalytics() {
  analyticsPanel.dataset.state = "loading";
  analyticsGrid.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/analytics");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Live totals are unavailable");
    analytics = body;
    renderAnalytics();
    text("#analytics-updated", formatAnalyticsTime(body.generatedAt));
    analyticsPanel.dataset.state = "ready";
  } catch {
    analyticsPanel.dataset.state = "error";
    text("#analytics-updated", "Totals unavailable. Try again soon.");
  } finally {
    analyticsGrid.setAttribute("aria-busy", "false");
  }
}

function populateNetworks() {
  network.replaceChildren();
  const seen = new Set();
  for (const option of config.options) {
    if (seen.has(option.chain)) continue;
    seen.add(option.chain);
    const item = document.createElement("option");
    item.value = option.chain;
    item.textContent = option.chainLabel;
    network.append(item);
  }
}

function populateAssets() {
  const previous = asset.value;
  asset.replaceChildren();
  for (const option of config.options.filter((item) => item.chain === network.value)) {
    const item = document.createElement("option");
    item.value = option.asset;
    item.textContent = option.asset;
    item.selected = option.asset === previous;
    asset.append(item);
  }
}

function updateSelection() {
  const option = selectedOption();
  if (!option) return;
  amount.value = option.defaultAmount;
  amount.placeholder = option.defaultAmount;
  assetLabel.textContent = option.asset;
  amountHelp.textContent = `${option.minimumAmount} to ${option.maximumAmount} ${option.asset}`;
  text("#header-context", `Live ${option.chainLabel} demo`);
  text("#analytics-context", `${option.chainLabel} ${option.asset} activity in this deployment.`);
  renderAnalytics();
}

function selectedOption() {
  return config?.options.find(
    (option) => option.chain === network.value && option.asset === asset.value,
  );
}

function renderAnalytics() {
  const option = selectedOption();
  const row = analytics?.assets?.find(
    (item) => item.chain === option?.chain && item.asset === option?.asset,
  );
  if (!option || !row) return;
  text("#analytics-intents", new Intl.NumberFormat().format(row.intents));
  text("#analytics-paid", new Intl.NumberFormat().format(row.paidIntents));
  text("#analytics-confirmed", row.confirmedAmount);
  text("#analytics-collected", row.collectedAmount);
  for (const element of document.querySelectorAll("#analytics-grid dd small"))
    element.textContent = option.asset;
}

function loadTurnstile(siteKey) {
  return new Promise((resolve, reject) => {
    window.onDemoTurnstileLoad = () => {
      if (typeof window.turnstile?.render !== "function") {
        reject(new Error("Security check could not load"));
        return;
      }
      turnstileWidget = window.turnstile.render("#turnstile-widget", {
        sitekey: siteKey,
        action: "create_intent",
        theme: "auto",
        appearance: "interaction-only",
        size: "flexible",
        callback(token) {
          turnstileToken = token;
          updateCreateButton();
        },
        "expired-callback"() {
          turnstileToken = "";
          updateCreateButton();
        },
        "error-callback"() {
          turnstileToken = "";
          showGlobalError("Security check could not load. Please refresh the page.");
          updateCreateButton();
        },
      });
      resolve();
    };
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onDemoTurnstileLoad";
    script.async = true;
    script.onerror = () => reject(new Error("Security check could not load"));
    document.head.append(script);
  });
}

function updateCreateButton() {
  createButton.disabled = !config || !turnstileToken || submitting;
  createButton.textContent = submitting ? "Creating payment..." : "Create payment";
}

function setStage(stage) {
  emptyState.hidden = stage !== "empty";
  loadingState.hidden = stage !== "loading";
  intentState.hidden = stage !== "intent";
}

function renderPayment(state) {
  const { intent, sweep, webhookEvent } = state;
  setStage("intent");
  globalError.hidden = true;
  const status = String(intent.status ?? "pending");
  const titles = {
    pending: "Waiting for payment",
    underpaid: "Payment underpaid",
    confirming: "Payment confirming",
    paid: "Payment confirmed",
    expired: "Payment expired",
    reorged: "Payment reorged",
  };
  const details = {
    pending: "Waiting for an on-chain transfer.",
    underpaid: intent.expired
      ? "The payment window closed before the full amount arrived."
      : `${intent.remainingAmount} ${intent.asset} remains to be paid.`,
    confirming: `Waiting for ${intent.requiredConfirmations} confirmations on ${humanize(intent.chain)}.`,
    paid: "The required network confirmations were reached.",
    expired: "Create a new payment intent to try again.",
    reorged: "A confirmed transaction is no longer canonical.",
  };
  document.querySelector(".intent-header").dataset.status = status;
  text("#status-title", titles[status] ?? "Payment status updated");
  text("#status-detail", details[status] ?? "Payment state updated.");
  text("#metadata-network", humanize(intent.chain));
  text("#intent-id", intent.id);
  text("#created-time", formatDate(intent.createdAt));
  text("#expiry-time", formatExpiry(intent.expiresAt));
  const toppingUp = status === "underpaid" && !intent.expired;
  text(
    "#send-label",
    toppingUp ? "Send remaining" : status === "paid" ? "Amount paid" : "Send exactly",
  );
  text("#amount-due", toppingUp ? intent.remainingAmount : intent.expectedAmount);
  text("#amount-due-asset", intent.asset);
  text("#deposit-address", intent.depositAddress);

  const action = paymentAction(intent);
  const paymentContent = document.querySelector("#payment-content");
  const paymentClosed = document.querySelector("#payment-closed");
  const paymentQr = document.querySelector("#payment-qr");
  paymentContent.hidden = !action.uri;
  paymentClosed.hidden = Boolean(action.uri);
  if (action.uri) {
    walletPaymentUri = action.uri;
    walletLink.href = action.uri;
    walletLink.removeAttribute("aria-disabled");
    if (
      typeof intent.topUpQrCodeDataUrl === "string" &&
      intent.topUpQrCodeDataUrl.startsWith("data:image/svg+xml;base64,")
    ) {
      paymentQr.src = intent.topUpQrCodeDataUrl;
    }
  } else {
    walletPaymentUri = "";
    walletLink.href = "#intent-state";
    walletLink.setAttribute("aria-disabled", "true");
    paymentQr.removeAttribute("src");
    text("#payment-closed-title", action.title);
    text("#payment-closed-detail", action.detail);
  }

  const transactions = Array.isArray(intent.transactions) ? intent.transactions : [];
  const unpaidExpired = Boolean(intent.expired) && transactions.length === 0;
  renderConfirmation(intent, transactions);
  renderTransactions(transactions, status, intent.chain);
  renderDelivery(webhookEvent, unpaidExpired);
  renderSweep(sweep, unpaidExpired);
}

async function switchWalletNetwork(provider, chainId) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    const option = config?.options.find((item) => `0x${item.chainId.toString(16)}` === chainId);
    if (walletErrorCode(error) !== 4902 || !option) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: option.chainLabel,
          nativeCurrency: { name: option.nativeAsset, symbol: option.nativeAsset, decimals: 18 },
          rpcUrls: [option.walletRpcUrl],
          blockExplorerUrls: [option.explorerUrl],
        },
      ],
    });
  }
}

function walletErrorCode(error) {
  if (!error || typeof error !== "object") return 0;
  if (typeof error.code === "number") return error.code;
  return typeof error.data?.originalError?.code === "number" ? error.data.originalError.code : 0;
}

function renderConfirmation(intent, transactions) {
  const required = Number(intent.requiredConfirmations);
  const observed =
    intent.status === "paid"
      ? required
      : Math.max(
          0,
          ...transactions
            .filter((transaction) => transaction.canonical !== false)
            .map((transaction) => Number(transaction.confirmations) || 0),
        );
  const completed = Math.min(observed, required);
  const track = document.querySelector("#confirmation-track");
  track.replaceChildren();
  track.hidden = !Number.isSafeInteger(required) || required < 1 || required > 6;
  if (!track.hidden) {
    for (let index = 0; index < required; index += 1) {
      const step = document.createElement("span");
      step.className = "confirmation-step";
      step.dataset.complete = String(index < completed);
      if (index >= completed) step.textContent = String(index + 1);
      track.append(step);
    }
  }
  text(
    "#confirmation-summary",
    Number.isSafeInteger(required) && required > 0
      ? `${completed} of ${required} confirmation${required === 1 ? "" : "s"}`
      : "Waiting for confirmations",
  );
}

function renderTransactions(transactions, status, chain) {
  const container = document.querySelector("#transactions");
  container.replaceChildren();
  if (!transactions.length) {
    const expired = status === "expired";
    setActivityState("#chain-activity", "#chain-status", "idle", expired ? "Expired" : "Waiting");
    container.append(
      paragraph(
        expired ? "No payment was received before expiry." : "No transaction detected yet.",
        "muted",
      ),
    );
    return;
  }
  if (status === "paid")
    setActivityState("#chain-activity", "#chain-status", "success", "Confirmed");
  else if (
    status === "reorged" ||
    transactions.some((transaction) => transaction.canonical === false)
  )
    setActivityState("#chain-activity", "#chain-status", "warning", "Reorg");
  else setActivityState("#chain-activity", "#chain-status", "detected", "Detected");
  for (const transaction of transactions) {
    const item = document.createElement("div");
    item.className = "transaction-item";
    item.append(
      paragraph(
        transaction.canonical === false
          ? "Transaction removed by a chain reorganization"
          : `Transfer detected on ${humanize(chain)}`,
      ),
    );
    const hash = document.createElement(transaction.explorerUrl ? "a" : "span");
    hash.className = "transaction-hash";
    hash.textContent = transaction.hash ? `Tx: ${transaction.hash}` : "Unknown transaction";
    if (transaction.explorerUrl) {
      hash.href = transaction.explorerUrl;
      hash.target = "_blank";
      hash.rel = "noreferrer";
    }
    item.append(hash);
    container.append(item);
  }
}

function renderDelivery(event, unpaidExpired) {
  const container = document.querySelector("#delivery-status");
  container.replaceChildren();
  if (!event) {
    setActivityState(
      "#delivery-activity",
      "#delivery-badge",
      unpaidExpired ? "idle" : "active",
      unpaidExpired ? "Not sent" : "Waiting",
    );
    container.append(
      paragraph(
        unpaidExpired
          ? "No success webhook was created."
          : "Secure webhook delivery to your endpoint",
        "muted",
      ),
    );
    return;
  }
  const reorged = event.type === "payment.reorged";
  setActivityState(
    "#delivery-activity",
    "#delivery-badge",
    reorged ? "warning" : "success",
    reorged ? "Reorg" : "Delivered",
  );
  container.append(paragraph(humanize(event.type)));
  const id = document.createElement("span");
  id.className = "transaction-hash";
  id.textContent = event.id;
  container.append(id);
}

function renderSweep(sweep, unpaidExpired) {
  const container = document.querySelector("#sweep-status");
  container.replaceChildren();
  if (!sweep || sweep.status === "not_queued") {
    setActivityState(
      "#sweep-activity",
      "#sweep-badge",
      "idle",
      unpaidExpired ? "Not needed" : "Queued",
    );
    container.append(
      paragraph(unpaidExpired ? "No funds to collect." : "Collection to treasury wallet", "muted"),
    );
    return;
  }
  const completed = ["complete", "external"].includes(sweep.status);
  setActivityState(
    "#sweep-activity",
    "#sweep-badge",
    completed ? "success" : "active",
    sweep.status,
  );
  container.append(paragraph(humanize(sweep.status)));
  if (Array.isArray(sweep.transactions) && sweep.transactions.length) {
    container.append(
      paragraph(
        `${sweep.transactions.length} treasury transaction${sweep.transactions.length === 1 ? "" : "s"}`,
        "muted",
      ),
    );
    for (const transaction of sweep.transactions) {
      const reference = document.createElement(transaction.explorerUrl ? "a" : "span");
      reference.className = "transaction-hash";
      reference.textContent = transaction.hash ? `Treasury tx: ${transaction.hash}` : "Treasury tx";
      if (transaction.explorerUrl) {
        reference.href = transaction.explorerUrl;
        reference.target = "_blank";
        reference.rel = "noreferrer";
      }
      container.append(reference);
    }
  }
}

function startPolling(immediate = false) {
  clearTimeout(pollTimer);
  pollAttempts = 0;
  const poll = async () => {
    if (!currentIntentId || !accessToken || pollAttempts >= 360) return;
    pollAttempts += 1;
    try {
      const response = await fetch(`/api/intents/${encodeURIComponent(currentIntentId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const body = await response.json();
      if (!response.ok) {
        if (response.status === 401) clearStoredPayment();
        throw new Error(body.error ?? "Payment status is unavailable");
      }
      renderPayment(body);
      const done =
        ["complete", "external"].includes(body.sweep?.status) &&
        ["payment.succeeded", "payment.reorged"].includes(body.webhookEvent?.type);
      if (done) {
        await loadAnalytics();
        return;
      }
    } catch (error) {
      showGlobalError(error instanceof Error ? error.message : "Payment status is unavailable");
    }
    pollTimer = setTimeout(poll, 5_000);
  };
  pollTimer = setTimeout(poll, immediate ? 0 : 5_000);
}

function clearStoredPayment() {
  currentIntentId = "";
  accessToken = "";
  sessionStorage.removeItem("demo:intentId");
  sessionStorage.removeItem("demo:accessToken");
}

function showGlobalError(message) {
  globalError.textContent = message;
  globalError.hidden = false;
}

function setActivityState(sectionSelector, badgeSelector, state, label) {
  document.querySelector(sectionSelector).dataset.state = state;
  text(badgeSelector, humanize(label));
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Not available"
    : date.toLocaleString(undefined, { timeZone: "UTC", timeZoneName: "short" });
}

function formatExpiry(value) {
  const seconds = Math.max(0, Math.floor((new Date(value).valueOf() - Date.now()) / 1_000));
  if (!Number.isFinite(seconds)) return "Not available";
  if (seconds === 0) return "Expired";
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatAnalyticsTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Updated recently";
  return `Updated ${date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  })}`;
}

function text(selector, value) {
  document.querySelector(selector).textContent = String(value ?? "");
}

function paragraph(value, className = "") {
  const element = document.createElement("p");
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function humanize(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

class DemoRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

initialize();
