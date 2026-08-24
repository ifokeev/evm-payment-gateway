import { paymentAction, walletPayment } from "./wallet.js";

const form = document.querySelector("#payment-form");
const pageShell = document.querySelector(".page-shell");
const flowTabs = document.querySelectorAll(".flow-tab[data-flow]");
const network = document.querySelector("#network");
const asset = document.querySelector("#asset");
const outputFields = document.querySelector("#output-fields");
const outputNetwork = document.querySelector("#output-network");
const outputAsset = document.querySelector("#output-asset");
const outputAmount = document.querySelector("#output-amount");
const outputAssetLabel = document.querySelector("#output-asset-label");
const destinationField = document.querySelector("#destination-field");
const destinationAddress = document.querySelector("#destination-address");
const destinationError = document.querySelector("#destination-error");
const amount = document.querySelector("#amount");
const amountHelp = document.querySelector("#amount-help");
const amountError = document.querySelector("#amount-error");
const assetLabel = document.querySelector("#asset-label");
const createButton = document.querySelector("#create-button");
const emptyState = document.querySelector("#empty-state");
const loadingState = document.querySelector("#loading-state");
const intentState = document.querySelector("#intent-state");
const withdrawalState = document.querySelector("#withdrawal-state");
const signerPanel = document.querySelector("#signer-panel");
const swapRouteSummary = document.querySelector("#swap-route-summary");
const globalError = document.querySelector("#global-error");
const copyAddress = document.querySelector("#copy-address");
const copyLabel = document.querySelector("#copy-label");
const walletLink = document.querySelector("#wallet-link");
const signedTransactionForm = document.querySelector("#signed-transaction-form");
const rawTransaction = document.querySelector("#raw-transaction");
const rawTransactionError = document.querySelector("#raw-transaction-error");
const submitTransaction = document.querySelector("#submit-transaction");
const copyProposal = document.querySelector("#copy-proposal");
const createAnother = document.querySelector("#create-another");
const withdrawalCreateAnother = document.querySelector("#withdrawal-create-another");

const initialResource = resourceRoute(window.location.pathname);
let config;
let flow = initialResource?.flow ?? "deposit";
let turnstileToken = "";
let turnstileWidget;
let submitting = false;
let pollTimer;
let pollAttempts = 0;
let openingWallet = false;
let walletPaymentUri = "";
let currentIntentId = initialResource?.flow === "deposit" ? initialResource.id : "";
let currentWithdrawalId = initialResource?.flow === "withdrawal" ? initialResource.id : "";
let currentSwapId = initialResource?.flow === "swap" ? initialResource.id : "";
let currentProposal;
let currentProposalId = "";
let currentSignerPath = "";
let idempotencyKey = crypto.randomUUID();

for (const tab of flowTabs) tab.addEventListener("click", () => openForm(tab.dataset.flow));
createAnother.addEventListener("click", () => openForm(flow));
withdrawalCreateAnother.addEventListener("click", () => openForm("withdrawal"));
window.addEventListener("popstate", restoreResource);

network.addEventListener("change", () => {
  populateAssets();
  populateOutputNetworks();
  populateOutputAssets();
  updateSelection();
});

asset.addEventListener("change", () => {
  populateOutputNetworks();
  populateOutputAssets();
  updateSelection();
});
outputNetwork.addEventListener("change", () => {
  populateOutputAssets();
  updateSelection();
});
outputAsset.addEventListener("change", updateSelection);

amount.addEventListener("input", () => {
  amountError.textContent = "";
});

destinationAddress.addEventListener("input", () => {
  destinationError.textContent = "";
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

copyProposal.addEventListener("click", async () => {
  if (!currentProposal) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(currentProposal, null, 2));
    copyProposal.textContent = "Copied";
    setTimeout(() => {
      copyProposal.textContent = "Copy proposal";
    }, 1_500);
  } catch {
    showGlobalError("Copy failed. Select the proposal fields manually.");
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
  destinationError.textContent = "";
  globalError.hidden = true;
  setStage("loading");
  updateCreateButton();

  try {
    const withdrawing = flow === "withdrawal";
    const swapping = flow === "swap";
    const endpoint = withdrawing ? "/api/withdrawals" : swapping ? "/api/swaps" : "/api/deposits";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: network.value,
        asset: asset.value,
        amount: amount.value,
        ...(withdrawing ? { destinationAddress: destinationAddress.value } : {}),
        ...(swapping
          ? {
              outputChain: outputNetwork.value,
              outputAsset: outputAsset.value,
              walletAddress: destinationAddress.value,
            }
          : {}),
        idempotencyKey,
        turnstileToken,
      }),
    });
    const body = await response.json();
    if (!response.ok)
      throw new DemoRequestError(
        response.status,
        body.error ??
          (withdrawing ? "Withdrawal failed" : swapping ? "Swap failed" : "Payment failed"),
      );
    idempotencyKey = crypto.randomUUID();
    if (withdrawing) {
      currentWithdrawalId = body.withdrawal.id;
      setResourcePath("withdrawal", currentWithdrawalId);
      renderWithdrawal(body.withdrawal);
      startWithdrawalPolling(true);
    } else if (swapping) {
      currentSwapId = body.swap.id;
      setResourcePath("swap", currentSwapId);
      renderSwap(body);
      startSwapPolling();
    } else {
      currentIntentId = body.intent.id;
      setResourcePath("deposit", currentIntentId);
      renderPayment({ intent: body.intent, sweep: null, webhookEvent: null });
      startPolling();
    }
  } catch (error) {
    setStage(
      flow === "withdrawal"
        ? currentWithdrawalId
          ? "withdrawal"
          : "empty"
        : flow === "swap"
          ? currentSwapId
            ? "intent"
            : "empty"
          : currentIntentId
            ? "intent"
            : "empty",
    );
    const message = error instanceof Error ? error.message : "Request failed";
    if (error instanceof DemoRequestError && error.status === 400) {
      if (message.toLowerCase().includes("wallet") || message.toLowerCase().includes("destination"))
        destinationError.textContent = message;
      else amountError.textContent = message;
    } else showGlobalError(message);
  } finally {
    submitting = false;
    turnstileToken = "";
    if (window.turnstile && turnstileWidget !== undefined) window.turnstile.reset(turnstileWidget);
    updateCreateButton();
  }
});

signedTransactionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentSignerPath || submitting) return;
  submitting = true;
  rawTransactionError.textContent = "";
  globalError.hidden = true;
  submitTransaction.disabled = true;
  submitTransaction.textContent = "Submitting...";
  try {
    const response = await fetch(currentSignerPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawTransaction: rawTransaction.value.trim() }),
    });
    const body = await response.json();
    if (!response.ok)
      throw new DemoRequestError(response.status, body.error ?? "Signed transaction failed");
    rawTransaction.value = "";
    if (flow === "swap") {
      renderSwap(body);
      startSwapPolling();
    } else {
      renderWithdrawal(body.withdrawal);
      startWithdrawalPolling();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Signed transaction failed";
    if (error instanceof DemoRequestError && error.status < 500)
      rawTransactionError.textContent = message;
    else showGlobalError(message);
  } finally {
    submitting = false;
    submitTransaction.disabled = false;
    submitTransaction.textContent = "Submit signed transaction";
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
    populateOutputNetworks();
    populateOutputAssets();
    updateSelection();
    network.disabled = false;
    asset.disabled = false;
    setFlow(flow, true);
  } catch (error) {
    showGlobalError(error instanceof Error ? error.message : "Demo is unavailable");
    return;
  }
  try {
    await loadTurnstile(config.turnstileSiteKey);
  } catch (error) {
    showGlobalError(error instanceof Error ? error.message : "Security check could not load");
  }
}

function populateNetworks() {
  const previous = network.value;
  network.replaceChildren();
  const seen = new Set();
  const options =
    flow === "swap"
      ? config.options.filter((option) => option.asset !== option.nativeAsset)
      : config.options;
  for (const option of options) {
    if (seen.has(option.chain)) continue;
    seen.add(option.chain);
    const item = document.createElement("option");
    item.value = option.chain;
    item.textContent = option.chainLabel;
    item.selected = option.chain === previous;
    network.append(item);
  }
}

function populateAssets() {
  const previous = asset.value;
  asset.replaceChildren();
  for (const option of config.options.filter(
    (item) => item.chain === network.value && (flow !== "swap" || item.asset !== item.nativeAsset),
  )) {
    const item = document.createElement("option");
    item.value = option.asset;
    item.textContent = option.asset;
    item.selected = option.asset === previous;
    asset.append(item);
  }
}

function populateOutputNetworks() {
  const previous = outputNetwork.value;
  outputNetwork.replaceChildren();
  const seen = new Set();
  for (const option of swapOutputOptions()) {
    if (seen.has(option.chain)) continue;
    seen.add(option.chain);
    const item = document.createElement("option");
    item.value = option.chain;
    item.textContent = option.chainLabel;
    item.selected = option.chain === previous;
    outputNetwork.append(item);
  }
}

function populateOutputAssets() {
  const previous = outputAsset.value;
  outputAsset.replaceChildren();
  for (const option of swapOutputOptions().filter((item) => item.chain === outputNetwork.value)) {
    const item = document.createElement("option");
    item.value = option.asset;
    item.textContent = option.asset;
    item.selected = option.asset === previous;
    outputAsset.append(item);
  }
}

function swapOutputOptions() {
  return (
    config?.options.filter(
      (option) => option.chain !== network.value || option.asset !== asset.value,
    ) ?? []
  );
}

function updateSelection() {
  const option = selectedOption();
  if (!option) return;
  amount.value = option.defaultAmount;
  amount.placeholder = option.defaultAmount;
  assetLabel.textContent = option.asset;
  amountHelp.textContent =
    flow === "swap"
      ? `The fixed demo input is ${option.defaultAmount} ${option.asset}.`
      : `${option.minimumAmount} to ${option.maximumAmount} ${option.asset}`;
  const selectedOutput = selectedOutputOption();
  outputAmount.value = selectedOutput?.defaultAmount ?? "";
  outputAssetLabel.textContent = selectedOutput?.asset ?? "";
  text("#header-context", "Live testnet demo");
}

function selectedOption() {
  return config?.options.find(
    (option) => option.chain === network.value && option.asset === asset.value,
  );
}

function selectedOutputOption() {
  return config?.options.find(
    (option) => option.chain === outputNetwork.value && option.asset === outputAsset.value,
  );
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
  createButton.textContent = submitting
    ? flow === "withdrawal"
      ? "Creating withdrawal..."
      : flow === "swap"
        ? "Creating swap..."
        : "Creating deposit..."
    : flow === "withdrawal"
      ? "Create withdrawal"
      : flow === "swap"
        ? "Create swap"
        : "Create deposit";
}

function setStage(stage) {
  pageShell.dataset.stage = stage;
  emptyState.hidden = stage !== "empty";
  loadingState.hidden = stage !== "loading";
  intentState.hidden = stage !== "intent";
  withdrawalState.hidden = stage !== "withdrawal";
  signerPanel.hidden = true;
}

function setFlow(next, initializing = false) {
  if (submitting || !["deposit", "withdrawal", "swap"].includes(next)) return;
  const changed = flow !== next;
  flow = next;
  pageShell.dataset.flow = flow;
  clearTimeout(pollTimer);
  for (const tab of flowTabs) tab.setAttribute("aria-selected", String(tab.dataset.flow === flow));
  outputFields.hidden = flow !== "swap";
  outputNetwork.disabled = !config || flow !== "swap";
  outputAsset.disabled = !config || flow !== "swap";
  destinationField.hidden = flow === "deposit";
  destinationAddress.disabled = !config || flow === "deposit";
  amount.disabled = !config || flow === "swap";
  text("#network-label", flow === "swap" ? "Input network" : "Network");
  text("#asset-title", flow === "swap" ? "Input asset" : "Asset");
  text("#amount-title", flow === "swap" ? "Fixed input amount" : "Amount");
  text(
    "#form-title",
    flow === "deposit"
      ? "Create deposit"
      : flow === "withdrawal"
        ? "Create withdrawal"
        : "Fixed testnet quote",
  );
  text(
    "#lifecycle-title",
    flow === "deposit"
      ? "Deposit lifecycle"
      : flow === "withdrawal"
        ? "Withdrawal lifecycle"
        : "Swap lifecycle",
  );
  text("#destination-label", flow === "swap" ? "Your wallet address" : "Destination address");
  text(
    "#destination-help",
    flow === "swap"
      ? "The demo sends the swap output or a refund to this address."
      : "Review this recipient before you approve the withdrawal.",
  );
  text(
    "#page-title",
    flow === "deposit"
      ? "Deposit crypto."
      : flow === "withdrawal"
        ? "Withdraw crypto."
        : "Swap across chains.",
  );
  text(
    "#intro-copy",
    flow === "deposit"
      ? "Create an exact testnet payment and follow it to treasury collection."
      : flow === "withdrawal"
        ? "Create an exact proposal, approve it, and follow it to settlement."
        : "Use a fixed testnet quote and follow the input, collection, and treasury output.",
  );
  text(
    "#empty-title",
    flow === "deposit"
      ? "Receive funds at a unique address."
      : flow === "withdrawal"
        ? "Review each withdrawal before approval."
        : "Send the output or refund to one wallet.",
  );
  text(
    "#empty-detail",
    flow === "deposit"
      ? "Create an intent to receive a unique address, QR code, and wallet link."
      : flow === "withdrawal"
        ? "Create a proposal to review its exact transaction fields."
        : "Create a fixed quote to receive the input address and exact output terms.",
  );
  const depositSteps = [
    ["Create deposit", "Ready"],
    ["Waiting for payment", "Pending"],
    ["Confirmations", "Pending"],
    ["Treasury collection", "Pending"],
    ["Complete", "Pending"],
  ];
  const withdrawalSteps = [
    ["Create proposal", "Ready"],
    ["Approve transaction", "Pending"],
    ["Broadcast", "Pending"],
    ["Confirmations", "Pending"],
    ["Complete", "Pending"],
  ];
  const swapSteps = [
    ["Create quote", "Ready"],
    ["Waiting for input", "Pending"],
    ["Treasury collection", "Pending"],
    ["Approve output", "Pending"],
    ["Complete", "Pending"],
  ];
  const steps =
    flow === "deposit" ? depositSteps : flow === "withdrawal" ? withdrawalSteps : swapSteps;
  const stepNames = ["one", "two", "three", "four", "five"];
  for (const [index, [title, detail]] of steps.entries()) {
    text(`#empty-step-${stepNames[index]}`, title);
    text(`#empty-step-${stepNames[index]}-detail`, detail);
  }
  text(
    "#loading-message",
    flow === "deposit"
      ? "Allocating a dedicated deposit address..."
      : flow === "withdrawal"
        ? "Locking the withdrawal proposal..."
        : "Locking the input and output terms...",
  );
  populateNetworks();
  populateAssets();
  populateOutputNetworks();
  populateOutputAssets();
  updateSelection();
  if (changed && !initializing) {
    turnstileToken = "";
    if (window.turnstile && turnstileWidget !== undefined) window.turnstile.reset(turnstileWidget);
  }
  updateCreateButton();
  if (flow === "deposit" && currentIntentId) startPolling(true);
  else if (flow === "withdrawal" && currentWithdrawalId) startWithdrawalPolling(true);
  else if (flow === "swap" && currentSwapId) startSwapPolling(true);
  else setStage("empty");
}

function renderPayment(state) {
  const { intent, sweep, webhookEvent } = state;
  setStage("intent");
  globalError.hidden = true;
  swapRouteSummary.hidden = true;
  document.querySelector("#swap-output-activity").hidden = true;
  text("#transactions-title", "On-chain activity");
  text("#delivery-title", "Payment update");
  text("#sweep-title", "Treasury collection");
  text("#intent-id-label", "Deposit ID");
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
    expired: "Create a new deposit intent to try again.",
    reorged: "A confirmed transaction is no longer canonical.",
  };
  document.querySelector(".intent-header").dataset.status = status;
  text("#status-title", titles[status] ?? "Deposit status updated");
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
    text("#create-another", flow === "swap" ? "Create new swap" : "Create new deposit");
  }

  const transactions = Array.isArray(intent.transactions) ? intent.transactions : [];
  const unpaidExpired = Boolean(intent.expired) && transactions.length === 0;
  renderConfirmation(intent, transactions);
  renderTransactions(transactions, status, intent.chain);
  renderDelivery(webhookEvent, unpaidExpired);
  renderSweep(sweep, unpaidExpired);
}

function renderSwap(state) {
  const { swap, intent, sweep, webhookEvent, payout } = state;
  renderPayment({ intent, sweep, webhookEvent });
  swapRouteSummary.hidden = false;
  document.querySelector("#swap-output-activity").hidden = false;
  const status = String(swap.status ?? "awaiting_input");
  const titles = {
    awaiting_input: "Waiting for swap input",
    input_confirming: "Swap input confirming",
    input_confirmed: "Collecting swap input",
    awaiting_signature: "Output signature required",
    output_submitted: "Swap output submitted",
    complete: "Swap complete",
    expired: "Swap quote expired",
    refund_required: "Swap refund required",
    refund_awaiting_signature: "Refund signature required",
    refund_submitted: "Swap refund submitted",
    refunded: "Swap refunded",
    reorged: "Swap reorged",
  };
  const details = {
    awaiting_input: "Send the exact token input before the quote expires.",
    input_confirming: "The input waits for the required network confirmations.",
    input_confirmed: "The confirmed input moves to the treasury.",
    awaiting_signature: "Approve the exact output proposal to continue.",
    output_submitted: "The output transaction waits for network confirmation.",
    complete: "The input and output reached their required confirmation depths.",
    expired: "The quote expired without usable input.",
    refund_required: "The app prepares a refund for the collected input.",
    refund_awaiting_signature: "Approve the exact refund proposal to continue.",
    refund_submitted: "The refund transaction waits for network confirmation.",
    refunded: "The refund reached the required confirmation depth.",
    reorged: "A linked transaction changed after swap coordination.",
  };
  document.querySelector(".intent-header").dataset.status = status;
  text("#status-title", titles[status] ?? "Swap updated");
  text("#status-detail", swap.lastError || details[status] || "Swap state updated.");
  text(
    "#swap-input-route",
    `${swap.input.expectedAmount} ${swap.input.asset} on ${humanize(swap.input.chain)}`,
  );
  text(
    "#swap-output-route",
    `${swap.output.amount} ${swap.output.asset} on ${humanize(swap.output.chain)}`,
  );
  text("#swap-destination", swap.output.destinationAddress);
  text("#intent-id-label", "Swap ID");
  text("#intent-id", swap.id);
  text("#expiry-time", formatExpiry(swap.quoteExpiresAt));
  text("#transactions-title", "Swap input");
  renderSwapOutput(swap, payout);
  renderSigner(payout, `/api/swaps/${encodeURIComponent(swap.id)}/transaction`);
}

function renderWithdrawal(withdrawal) {
  setStage("withdrawal");
  globalError.hidden = true;
  const status = String(withdrawal.status ?? "awaiting_signature");
  const titles = {
    awaiting_signature: "Treasury signature required",
    submitted: "Withdrawal submitted",
    confirming: "Withdrawal confirming",
    complete: "Withdrawal complete",
    failed: "Withdrawal failed",
    expired: "Withdrawal expired",
  };
  const details = {
    awaiting_signature: "Review and approve the exact proposal.",
    submitted: "The signed transaction was validated and broadcast.",
    confirming: `Waiting for ${withdrawal.requiredConfirmations} network confirmations.`,
    complete: "The withdrawal reached the required confirmation depth.",
    failed: withdrawal.lastError || "The transaction did not complete.",
    expired: "No signed transaction was accepted before expiry.",
  };
  document.querySelector("#withdrawal-header").dataset.status = status;
  text("#withdrawal-status-title", titles[status] ?? "Withdrawal updated");
  text("#withdrawal-status-detail", details[status] ?? "Withdrawal state updated.");
  text("#withdrawal-amount", withdrawal.amount);
  text("#withdrawal-asset", withdrawal.asset);
  text("#withdrawal-source", withdrawal.sourceAddress);
  text("#withdrawal-destination", withdrawal.destinationAddress);
  text("#withdrawal-network", humanize(withdrawal.chain));
  text("#withdrawal-id", withdrawal.id);
  text("#withdrawal-created", formatDate(withdrawal.createdAt));
  text("#withdrawal-expiry", formatExpiry(withdrawal.expiresAt));

  renderSigner(withdrawal, `/api/withdrawals/${encodeURIComponent(withdrawal.id)}/transaction`);
  withdrawalCreateAnother.hidden = !["complete", "failed", "expired"].includes(status);

  setActivityState("#proposal-activity", "#proposal-badge", "success", "Ready");
  const signatureState =
    status === "awaiting_signature" ? "active" : status === "expired" ? "warning" : "success";
  setActivityState(
    "#signature-activity",
    "#signature-badge",
    signatureState,
    status === "awaiting_signature" ? "Waiting" : status === "expired" ? "Expired" : "Validated",
  );
  const signatureStatus = document.querySelector("#signature-status");
  signatureStatus.replaceChildren(
    paragraph(
      status === "awaiting_signature"
        ? "Waiting for transaction approval."
        : status === "expired"
          ? "No signature was registered before expiry."
          : "The app verified the transaction signature.",
      "muted",
    ),
  );

  const chainStates = {
    awaiting_signature: ["idle", "Waiting", "Broadcast starts after signature validation."],
    submitted: ["detected", "Broadcast", "The transaction is waiting to enter a block."],
    confirming: ["active", "Confirming", "The transaction is in a canonical block."],
    complete: ["success", "Complete", "The required confirmation depth was reached."],
    failed: ["warning", "Failed", withdrawal.lastError || "The transaction failed."],
    expired: ["idle", "Not sent", "The proposal expired without a transaction."],
  };
  const [chainState, chainBadge, chainDetail] =
    chainStates[status] ?? chainStates.awaiting_signature;
  setActivityState("#withdrawal-chain-activity", "#withdrawal-chain-badge", chainState, chainBadge);
  const chainStatus = document.querySelector("#withdrawal-chain-status");
  chainStatus.replaceChildren(paragraph(chainDetail, "muted"));
  if (withdrawal.transaction?.hash) {
    const reference = document.createElement(withdrawal.transaction.explorerUrl ? "a" : "span");
    reference.className = "transaction-hash";
    reference.textContent = `Tx: ${withdrawal.transaction.hash}`;
    if (withdrawal.transaction.explorerUrl) {
      reference.href = withdrawal.transaction.explorerUrl;
      reference.target = "_blank";
      reference.rel = "noreferrer";
    }
    chainStatus.append(reference);
  }
}

function renderSigner(withdrawal, path) {
  if (!withdrawal) {
    currentProposal = undefined;
    currentProposalId = "";
    currentSignerPath = "";
    signerPanel.hidden = true;
    return;
  }
  if (withdrawal.proposal && typeof withdrawal.proposal === "object") {
    currentProposal = withdrawal.proposal;
    currentProposalId = withdrawal.id;
  } else if (currentProposalId !== withdrawal.id) {
    currentProposal = undefined;
    currentProposalId = "";
  }
  const awaitingSignature = withdrawal.status === "awaiting_signature";
  currentSignerPath = currentProposal && awaitingSignature ? path : "";
  signerPanel.hidden = !currentProposal;
  signedTransactionForm.hidden = !awaitingSignature;
  copyProposal.disabled = !currentProposal;
  text(
    "#signer-title",
    withdrawal.purpose === "refund"
      ? "Approve refund"
      : withdrawal.purpose === "swap"
        ? "Approve swap output"
        : "Approve withdrawal",
  );
  if (!currentProposal) return;
  text("#proposal-chain", currentProposal.chainId);
  text("#proposal-to", currentProposal.to);
  text("#proposal-value", currentProposal.value);
  text("#proposal-gas", currentProposal.maxGas);
  text("#proposal-gas-price", `${currentProposal.maxGasPriceWei} wei`);
  text("#proposal-data", currentProposal.data);
}

function renderSwapOutput(swap, payout) {
  const refunding = String(swap.status).startsWith("refund_") || swap.status === "refunded";
  text("#swap-output-title", refunding ? "Swap refund" : "Swap output");
  const states = {
    awaiting_input: ["idle", "Waiting", "The output starts after treasury collection."],
    input_confirming: ["idle", "Waiting", "The input waits for network confirmation."],
    input_confirmed: ["active", "Collecting", "The input moves to the treasury."],
    awaiting_signature: ["active", "Signature", "The output proposal waits for approval."],
    output_submitted: ["detected", "Submitted", "The output transaction is on the network."],
    complete: ["success", "Complete", "The output reached the required confirmation depth."],
    expired: ["idle", "Expired", "The quote expired without usable input."],
    refund_required: ["warning", "Refund", "The app prepares the refund proposal."],
    refund_awaiting_signature: ["active", "Signature", "The refund proposal waits for approval."],
    refund_submitted: ["detected", "Submitted", "The refund transaction is on the network."],
    refunded: ["success", "Refunded", "The refund reached the required confirmation depth."],
    reorged: ["warning", "Reorg", "Manual treasury reconciliation is required."],
  };
  const [state, badge, detail] = states[swap.status] ?? states.awaiting_input;
  setActivityState("#swap-output-activity", "#swap-output-badge", state, badge);
  const container = document.querySelector("#swap-output-status");
  container.replaceChildren(paragraph(detail, "muted"));
  if (payout?.transaction?.hash) {
    const reference = document.createElement(payout.transaction.explorerUrl ? "a" : "span");
    reference.className = "transaction-hash";
    reference.textContent = `Tx: ${payout.transaction.hash}`;
    if (payout.transaction.explorerUrl) {
      reference.href = payout.transaction.explorerUrl;
      reference.target = "_blank";
      reference.rel = "noreferrer";
    }
    container.append(reference);
  }
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
  const reorged = event.type === "deposit.reorged";
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
    if (flow !== "deposit" || !currentIntentId || pollAttempts >= 360) return;
    pollAttempts += 1;
    try {
      const response = await fetch(`/api/deposits/${encodeURIComponent(currentIntentId)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Deposit status is unavailable");
      if (flow !== "deposit") return;
      renderPayment(body);
      const done =
        ["complete", "external"].includes(body.sweep?.status) &&
        ["deposit.succeeded", "deposit.reorged"].includes(body.webhookEvent?.type);
      if (done) return;
    } catch (error) {
      showGlobalError(error instanceof Error ? error.message : "Deposit status is unavailable");
    }
    pollTimer = setTimeout(poll, 5_000);
  };
  pollTimer = setTimeout(poll, immediate ? 0 : 5_000);
}

function startWithdrawalPolling(immediate = false) {
  clearTimeout(pollTimer);
  pollAttempts = 0;
  const poll = async () => {
    if (flow !== "withdrawal" || !currentWithdrawalId || pollAttempts >= 360) return;
    pollAttempts += 1;
    try {
      const response = await fetch(`/api/withdrawals/${encodeURIComponent(currentWithdrawalId)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Withdrawal status is unavailable");
      if (flow !== "withdrawal") return;
      renderWithdrawal(body.withdrawal);
      if (["complete", "failed", "expired"].includes(body.withdrawal.status)) return;
    } catch (error) {
      showGlobalError(error instanceof Error ? error.message : "Withdrawal status is unavailable");
    }
    pollTimer = setTimeout(poll, 5_000);
  };
  pollTimer = setTimeout(poll, immediate ? 0 : 5_000);
}

function startSwapPolling(immediate = false) {
  clearTimeout(pollTimer);
  const poll = async () => {
    if (flow !== "swap" || !currentSwapId) return;
    let delay = 5_000;
    try {
      const response = await fetch(`/api/swaps/${encodeURIComponent(currentSwapId)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Swap status is unavailable");
      if (flow !== "swap") return;
      renderSwap(body);
      if (["complete", "refunded", "reorged"].includes(body.swap.status)) return;
      if (body.swap.status === "expired") delay = 30_000;
    } catch (error) {
      showGlobalError(error instanceof Error ? error.message : "Swap status is unavailable");
    }
    pollTimer = setTimeout(poll, delay);
  };
  pollTimer = setTimeout(poll, immediate ? 0 : 5_000);
}

function clearResources() {
  currentIntentId = "";
  currentWithdrawalId = "";
  currentSwapId = "";
  currentProposal = undefined;
  currentProposalId = "";
  currentSignerPath = "";
}

function resourceRoute(pathname) {
  const match = pathname.match(/^\/(deposits|withdrawals|swaps)\/([^/]+)$/);
  if (!match) return null;
  const definitions = {
    deposits: ["deposit", /^di_[A-Za-z0-9_-]+$/],
    withdrawals: ["withdrawal", /^wd_[A-Za-z0-9_-]+$/],
    swaps: ["swap", /^swp_[A-Za-z0-9_-]+$/],
  };
  const [resourceFlow, idPattern] = definitions[match[1]];
  return idPattern.test(match[2]) ? { flow: resourceFlow, id: match[2] } : null;
}

function setResourcePath(resourceFlow, id) {
  const collections = { deposit: "deposits", withdrawal: "withdrawals", swap: "swaps" };
  window.history.pushState(null, "", `/${collections[resourceFlow]}/${encodeURIComponent(id)}`);
}

function openForm(nextFlow) {
  const wasResource = Boolean(resourceRoute(window.location.pathname));
  clearResources();
  window.history[wasResource ? "pushState" : "replaceState"](null, "", "/");
  setFlow(nextFlow);
}

function restoreResource() {
  clearResources();
  const resource = resourceRoute(window.location.pathname);
  flow = resource?.flow ?? "deposit";
  if (resource?.flow === "deposit") currentIntentId = resource.id;
  if (resource?.flow === "withdrawal") currentWithdrawalId = resource.id;
  if (resource?.flow === "swap") currentSwapId = resource.id;
  setFlow(flow, true);
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
