const state = { items: [], nextCursor: null, selectedId: "" };

async function initialize() {
  document.querySelector("#refresh-inbox").addEventListener("click", () => loadInbox(false));
  document.querySelector("#load-more").addEventListener("click", () => loadInbox(true));
  document.querySelector("#signer-form").addEventListener("submit", submitTransaction);
  await loadInbox(false);
}

async function loadInbox(append) {
  setBusy(true);
  clearError();
  try {
    const query =
      append && state.nextCursor ? `?cursor=${encodeURIComponent(state.nextCursor)}` : "";
    const response = await fetch(`/api/signer/withdrawals${query}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Signer inbox is unavailable");
    state.items = append ? [...state.items, ...body.items] : body.items;
    state.nextCursor = body.nextCursor;
    renderInbox();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Signer inbox is unavailable");
  } finally {
    setBusy(false);
  }
}

function renderInbox() {
  const list = document.querySelector("#inbox-list");
  document.querySelector("#inbox-count").textContent =
    `${state.items.length} proposal${state.items.length === 1 ? "" : "s"}`;
  document.querySelector("#load-more").hidden = !state.nextCursor;
  if (state.items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "inbox-empty";
    empty.textContent = "No proposals need a signature.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...state.items.map(inboxItem));
}

function inboxItem(item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "inbox-item";
  button.dataset.selected = String(item.id === state.selectedId);
  button.addEventListener("click", () => selectProposal(item.id));

  const top = document.createElement("span");
  top.className = "inbox-item-top";
  top.append(
    label(humanize(item.purpose), "purpose-badge"),
    label(timeLeft(item.expiresAt), "inbox-expiry"),
  );
  const amount = label(`${item.amount} ${item.asset}`, "inbox-amount");
  const route = label(
    `${humanize(item.chain)} → ${shortAddress(item.destinationAddress)}`,
    "inbox-route",
  );
  const reference = label(item.swapId ?? item.externalId ?? item.id, "inbox-reference");
  button.append(top, amount, route, reference);
  return button;
}

async function selectProposal(id) {
  state.selectedId = id;
  renderInbox();
  setBusy(true);
  clearError();
  try {
    const response = await fetch(`/api/signer/withdrawals/${encodeURIComponent(id)}/proposal`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Proposal is unavailable");
    renderProposal(body.withdrawal);
  } catch (error) {
    showError(error instanceof Error ? error.message : "Proposal is unavailable");
  } finally {
    setBusy(false);
  }
}

function renderProposal(withdrawal) {
  document.querySelector("#review-empty").hidden = true;
  document.querySelector("#review-content").hidden = false;
  document.querySelector("#review-purpose").textContent = humanize(withdrawal.purpose);
  document.querySelector("#review-amount").textContent = `${withdrawal.amount} ${withdrawal.asset}`;
  document.querySelector("#review-reference").textContent = withdrawal.swapId
    ? `${withdrawal.swapId} · ${withdrawal.depositIntentId}`
    : withdrawal.externalId;
  document
    .querySelector("#review-summary")
    .replaceChildren(
      detail("Network", humanize(withdrawal.chain)),
      detail("Chain ID", withdrawal.proposal.chainId),
      detail("From", withdrawal.proposal.from, true),
      detail("To", withdrawal.proposal.to, true),
      detail("Value", withdrawal.proposal.value),
      detail("Maximum gas", withdrawal.proposal.maxGas),
      detail("Maximum gas price", `${withdrawal.proposal.maxGasPriceWei} wei`),
      detail("Data", withdrawal.proposal.data, true, "review-data"),
    );
  document.querySelector("#signed-transaction").value = "";
}

async function submitTransaction(event) {
  event.preventDefault();
  const rawTransaction = document.querySelector("#signed-transaction").value.trim();
  if (!/^0x[0-9a-f]+$/i.test(rawTransaction)) {
    showError("Enter a signed raw transaction in hexadecimal format");
    return;
  }
  setBusy(true);
  clearError();
  try {
    const response = await fetch(
      `/api/signer/withdrawals/${encodeURIComponent(state.selectedId)}/transaction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawTransaction }),
      },
    );
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Signed transaction was rejected");
    state.items = state.items.filter((item) => item.id !== state.selectedId);
    state.selectedId = "";
    document.querySelector("#review-content").hidden = true;
    document.querySelector("#review-empty").hidden = false;
    renderInbox();
  } catch (error) {
    showError(error instanceof Error ? error.message : "Signed transaction was rejected");
  } finally {
    setBusy(false);
  }
}

function detail(name, value, code = false, className = "") {
  const wrapper = document.createElement("div");
  if (className) wrapper.className = className;
  const term = document.createElement("dt");
  term.textContent = name;
  const description = document.createElement("dd");
  const content = code ? document.createElement("code") : document.createElement("span");
  content.textContent = String(value ?? "");
  description.append(content);
  wrapper.append(term, description);
  return wrapper;
}

function label(value, className) {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = String(value ?? "");
  return element;
}

function shortAddress(value) {
  const address = String(value ?? "");
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

function timeLeft(value) {
  const minutes = Math.max(0, Math.ceil((new Date(value).valueOf() - Date.now()) / 60_000));
  return minutes > 60 ? `${Math.ceil(minutes / 60)}h left` : `${minutes}m left`;
}

function humanize(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function setBusy(value) {
  document.querySelector("#signer-main").setAttribute("aria-busy", String(value));
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = value;
  });
}

function showError(message) {
  const error = document.querySelector("#signer-error");
  error.textContent = `${message}.`;
  error.hidden = false;
}

function clearError() {
  document.querySelector("#signer-error").hidden = true;
}

initialize();
