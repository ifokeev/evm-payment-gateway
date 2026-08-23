import { type Address, getAddress, isAddress, isAddressEqual, zeroAddress } from "viem";
import { formatUnits, intSetting, loadNetworks, parseAmount, stableStringify } from "./domain";
import type { ApiEnv, IntentRow, NetworkConfig } from "./types";

type SwapStatus =
  | "awaiting_input"
  | "input_confirming"
  | "input_confirmed"
  | "awaiting_signature"
  | "output_submitted"
  | "complete"
  | "expired"
  | "refund_required"
  | "refund_awaiting_signature"
  | "refund_submitted"
  | "refunded"
  | "reorged";

type SwapRow = {
  id: string;
  idempotency_key: string;
  request_hash: string;
  external_id: string;
  deposit_intent: string;
  withdrawal_intent: string | null;
  refund_withdrawal: string | null;
  output_chain: string;
  output_chain_id: number;
  output_asset: string;
  output_token_address: Address | "";
  output_decimals: number;
  output_source_address: Address;
  output_confirmations: number;
  output_max_gas_price_wei: string;
  output_amount: string;
  output_units: string;
  destination_address: Address;
  refund_address: Address;
  refund_source_address: Address;
  refund_confirmations: number;
  refund_max_gas_price_wei: string;
  quote_expires_at: number;
  status: SwapStatus;
  last_error: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type ReconcileRow = SwapRow & {
  input_chain: string;
  input_chain_id: number;
  input_asset: string;
  input_token_address: Address;
  input_decimals: number;
  deposit_status: IntentRow["status"];
  expected_units: string;
  received_units: string;
  confirmed_units: string;
  sweep_status: string | null;
  observed_units: string | null;
  collected_units: string | null;
  withdrawal_status: string | null;
  refund_status: string | null;
  refund_units: string | null;
  late_transfers: number;
};

export async function routeSwap(
  request: Request,
  url: URL,
  env: ApiEnv,
  apiRoot: string,
): Promise<Response | null> {
  const collection = `${apiRoot}/swaps`;
  const match = url.pathname.match(new RegExp(`^${collection}/([A-Za-z0-9_-]+)$`));
  if (request.method !== "POST" && !(request.method === "GET" && match)) return null;
  try {
    if (request.method === "POST" && url.pathname === collection)
      return await createSwap(request, env);
    if (request.method === "GET" && match) return await getSwap(match[1], env);
    return null;
  } catch (error) {
    if (error instanceof SwapHttpError) return json({ error: error.message }, error.status);
    throw error;
  }
}

async function createSwap(request: Request, env: ApiEnv): Promise<Response> {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new SwapHttpError(400, "Idempotency-Key is required and must be at most 200 characters");
  const body = await readObject(request, [
    "depositIntentId",
    "outputChain",
    "outputAsset",
    "outputAmount",
    "destinationAddress",
    "refundAddress",
  ]);
  const depositIntentId = requiredString(body, "depositIntentId").trim();
  const outputChain = requiredString(body, "outputChain").trim();
  const outputAsset = requiredString(body, "outputAsset").trim().toUpperCase();
  const rawOutputAmount = requiredString(body, "outputAmount");
  const destination = checkedAddress(requiredString(body, "destinationAddress"));
  const refundAddress = checkedAddress(requiredString(body, "refundAddress"), "refundAddress");
  if (!/^pi_[A-Za-z0-9_-]+$/.test(depositIntentId))
    throw new SwapHttpError(400, "invalid depositIntentId");
  if (rawOutputAmount.trim().length > 100)
    throw new SwapHttpError(400, "outputAmount must be at most 100 characters");
  const existing = await env.DB.prepare("SELECT * FROM swaps WHERE idempotency_key = ?")
    .bind(idempotencyKey)
    .first<SwapRow>();
  if (existing) {
    let replayAmount = "";
    try {
      replayAmount = parseAmount(rawOutputAmount, existing.output_decimals).amount;
    } catch {
      throw new SwapHttpError(409, "idempotency key was already used with a different request");
    }
    const replayHash = await sha256(
      stableStringify({
        depositIntentId,
        outputChain,
        outputAsset,
        outputAmount: replayAmount,
        destinationAddress: destination,
        refundAddress,
        quoteExpiresAt: existing.quote_expires_at,
      }),
    );
    if (existing.request_hash !== replayHash)
      throw new SwapHttpError(409, "idempotency key was already used with a different request");
    return json(await swapResponse(env.DB, existing));
  }

  const deposit = await env.DB.prepare("SELECT * FROM deposit_intents WHERE id = ?")
    .bind(depositIntentId)
    .first<IntentRow>();
  if (!deposit) throw new SwapHttpError(404, "deposit intent not found");
  if (deposit.purpose !== "swap")
    throw new SwapHttpError(400, "deposit intent purpose must be swap");
  if (BigInt(deposit.received_units) > 0n || BigInt(deposit.confirmed_units) > 0n)
    throw new SwapHttpError(409, "deposit intent already received funds");
  if (deposit.status !== "pending")
    throw new SwapHttpError(409, "deposit intent is not open for swap terms");
  if (!deposit.token_address)
    throw new SwapHttpError(
      400,
      "native swap inputs require trace-capable monitoring and are not supported",
    );

  const networks = loadNetworks(env.NETWORKS_JSON);
  const network = networks.get(outputChain);
  if (!network) throw new SwapHttpError(400, "unsupported output chain");
  const refundNetwork = networks.get(deposit.chain);
  const refundToken = refundNetwork?.tokens[deposit.asset];
  if (
    !refundNetwork ||
    refundNetwork.chainId !== deposit.chain_id ||
    !refundToken ||
    !isAddressEqual(refundToken.address, deposit.token_address)
  ) {
    throw new SwapHttpError(409, "input network configuration changed");
  }
  const token = outputAsset === network.nativeAsset ? undefined : network.tokens[outputAsset];
  if (outputAsset !== network.nativeAsset && !token)
    throw new SwapHttpError(400, "unsupported output asset for chain");
  if (deposit.chain === outputChain && deposit.asset === outputAsset)
    throw new SwapHttpError(400, "swap input and output must differ");
  await validateDestination(env.DB, network, token?.address ?? "", destination, "output");
  await validateDestination(env.DB, refundNetwork, deposit.token_address, refundAddress, "refund");
  let output: ReturnType<typeof parseAmount>;
  try {
    output = parseAmount(rawOutputAmount, token?.decimals ?? 18);
  } catch (error) {
    throw new SwapHttpError(400, error instanceof Error ? error.message : String(error));
  }
  if (deposit.expires_at <= unixNow()) throw new SwapHttpError(409, "deposit intent has expired");

  const normalized = {
    depositIntentId,
    outputChain,
    outputAsset,
    outputAmount: output.amount,
    destinationAddress: destination,
    refundAddress,
    quoteExpiresAt: deposit.expires_at,
  };
  const requestHash = await sha256(stableStringify(normalized));

  const now = unixNow();
  const row: SwapRow = {
    id: randomId("swp"),
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    external_id: deposit.external_id,
    deposit_intent: deposit.id,
    withdrawal_intent: null,
    refund_withdrawal: null,
    output_chain: network.name,
    output_chain_id: network.chainId,
    output_asset: outputAsset,
    output_token_address: token?.address ?? "",
    output_decimals: token?.decimals ?? 18,
    output_source_address: network.withdrawalSourceAddress,
    output_confirmations: network.confirmations,
    output_max_gas_price_wei: network.maxGasPriceWei.toString(),
    output_amount: output.amount,
    output_units: output.units.toString(),
    destination_address: destination,
    refund_address: refundAddress,
    refund_source_address: refundNetwork.withdrawalSourceAddress,
    refund_confirmations: refundNetwork.confirmations,
    refund_max_gas_price_wei: refundNetwork.maxGasPriceWei.toString(),
    quote_expires_at: deposit.expires_at,
    status: "awaiting_input",
    last_error: "",
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  try {
    const inserted = await env.DB.prepare(`INSERT INTO swaps
      (id,idempotency_key,request_hash,external_id,deposit_intent,output_chain,output_chain_id,
       output_asset,output_token_address,output_decimals,output_source_address,output_confirmations,
       output_max_gas_price_wei,output_amount,output_units,destination_address,refund_address,
       refund_source_address,refund_confirmations,refund_max_gas_price_wei,quote_expires_at,status,
       created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_input',?,?
      FROM deposit_intents WHERE id = ? AND status = 'pending'
        AND received_units = '0' AND confirmed_units = '0' AND expires_at > ?`)
      .bind(
        row.id,
        row.idempotency_key,
        row.request_hash,
        row.external_id,
        row.deposit_intent,
        row.output_chain,
        row.output_chain_id,
        row.output_asset,
        row.output_token_address,
        row.output_decimals,
        row.output_source_address,
        row.output_confirmations,
        row.output_max_gas_price_wei,
        row.output_amount,
        row.output_units,
        row.destination_address,
        row.refund_address,
        row.refund_source_address,
        row.refund_confirmations,
        row.refund_max_gas_price_wei,
        row.quote_expires_at,
        row.created_at,
        row.updated_at,
        row.deposit_intent,
        now,
      )
      .run();
    if (!(inserted.meta.changes ?? 0))
      throw new SwapHttpError(409, "deposit intent already received funds");
  } catch (error) {
    const winner = await env.DB.prepare("SELECT * FROM swaps WHERE idempotency_key = ?")
      .bind(idempotencyKey)
      .first<SwapRow>();
    if (winner) {
      if (winner.request_hash !== requestHash)
        throw new SwapHttpError(409, "idempotency key was already used with a different request");
      return json(await swapResponse(env.DB, winner));
    }
    if (
      await env.DB.prepare("SELECT 1 FROM swaps WHERE deposit_intent = ?").bind(deposit.id).first()
    )
      throw new SwapHttpError(409, "deposit intent already belongs to another swap");
    throw error;
  }
  return json(await swapResponse(env.DB, row), 201);
}

async function getSwap(id: string, env: ApiEnv): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM swaps WHERE id = ?").bind(id).first<SwapRow>();
  if (!row) throw new SwapHttpError(404, "swap not found");
  return json(await swapResponse(env.DB, row));
}

export async function reconcileSwaps(env: ApiEnv): Promise<void> {
  const now = unixNow();
  const rows = await all<ReconcileRow>(
    env.DB,
    `SELECT s.*, d.chain AS input_chain, d.chain_id AS input_chain_id, d.asset AS input_asset,
       d.token_address AS input_token_address, d.decimals AS input_decimals,
       d.status AS deposit_status, d.expected_units, d.received_units, d.confirmed_units,
       j.status AS sweep_status, j.observed_units, j.collected_units,
       w.status AS withdrawal_status, r.status AS refund_status, r.amount_units AS refund_units,
       (SELECT COUNT(*) FROM deposit_transfers t
         WHERE t.deposit_intent = d.id AND t.canonical = 1
           AND t.block_timestamp > s.quote_expires_at) AS late_transfers
     FROM swaps s
     JOIN deposit_intents d ON d.id = s.deposit_intent
     LEFT JOIN sweep_jobs j ON j.deposit_intent = d.id
     LEFT JOIN withdrawal_intents w ON w.id = s.withdrawal_intent
     LEFT JOIN withdrawal_intents r ON r.id = s.refund_withdrawal
     WHERE s.status != 'reorged'
       AND (s.status NOT IN ('complete', 'refunded') OR s.completed_at >= ?)
     ORDER BY CASE WHEN s.status IN ('complete', 'expired', 'refunded') THEN 1 ELSE 0 END, s.updated_at
     LIMIT 100`,
    now - 7 * 24 * 60 * 60,
  );
  for (const row of rows) {
    try {
      await reconcileSwap(env, row, now);
    } catch (error) {
      await setStatus(env.DB, row.id, row.status, safeErrorText(error), row.completed_at);
    }
  }
}

async function reconcileSwap(env: ApiEnv, row: ReconcileRow, now: number): Promise<void> {
  if (row.deposit_status === "reorged") {
    await setStatus(env.DB, row.id, "reorged", "input deposit was reorganized");
    return;
  }
  const expected = BigInt(row.expected_units);
  const received = BigInt(row.received_units);
  const confirmed = BigInt(row.confirmed_units);
  const observed = BigInt(row.observed_units ?? "0");
  const collected = BigInt(row.collected_units ?? "0");
  const exactTimelyInput =
    row.deposit_status === "paid" && confirmed === expected && row.late_transfers === 0;
  const outputInputIntact =
    exactTimelyInput && received === expected && observed === expected && collected === expected;
  if (
    row.refund_withdrawal &&
    row.refund_units !== null &&
    (BigInt(row.refund_units) !== observed || collected !== observed)
  ) {
    if (row.refund_status === "awaiting_signature") {
      await env.DB.prepare(
        "UPDATE withdrawal_intents SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_signature'",
      )
        .bind(now, row.refund_withdrawal)
        .run();
    }
    await setStatus(env.DB, row.id, "reorged", "input changed after refund creation");
    return;
  }
  if (
    row.refund_withdrawal &&
    row.withdrawal_intent &&
    !["failed", "expired"].includes(row.withdrawal_status ?? "")
  ) {
    if (row.refund_status === "awaiting_signature") {
      await env.DB.prepare(
        "UPDATE withdrawal_intents SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_signature'",
      )
        .bind(now, row.refund_withdrawal)
        .run();
    }
    await setStatus(env.DB, row.id, "reorged", "output revived after refund creation");
    return;
  }
  if (row.refund_withdrawal) {
    if (row.refund_status === "complete") {
      await setStatus(env.DB, row.id, "refunded", "", row.completed_at ?? now);
      return;
    }
    if (row.refund_status === "failed" || row.refund_status === "expired") {
      if (!(await reopenRefundWithdrawal(env, row, now)))
        await setStatus(
          env.DB,
          row.id,
          "refund_required",
          `refund ${row.refund_status}; a previous transaction may still execute`,
        );
      return;
    }
    await setStatus(
      env.DB,
      row.id,
      row.refund_status === "awaiting_signature" ? "refund_awaiting_signature" : "refund_submitted",
      "",
    );
    return;
  }
  if (row.withdrawal_intent) {
    if (!outputInputIntact) {
      if (row.withdrawal_status === "awaiting_signature") {
        await env.DB.prepare(
          "UPDATE withdrawal_intents SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_signature'",
        )
          .bind(now, row.withdrawal_intent)
          .run();
        await createRefundWithdrawal(env, row, "input changed after output creation", now, true);
      } else if (row.withdrawal_status === "failed" || row.withdrawal_status === "expired") {
        await createRefundWithdrawal(env, row, "input changed after output creation", now, true);
      } else {
        await setStatus(env.DB, row.id, "reorged", "input changed after output creation");
      }
      return;
    }
    if (row.withdrawal_status === "complete") {
      await setStatus(env.DB, row.id, "complete", "", row.completed_at ?? now);
      return;
    }
    if (row.withdrawal_status === "failed" || row.withdrawal_status === "expired") {
      await createRefundWithdrawal(env, row, `output ${row.withdrawal_status}`, now, true);
      return;
    }
    await setStatus(
      env.DB,
      row.id,
      row.withdrawal_status === "awaiting_signature" ? "awaiting_signature" : "output_submitted",
      "",
    );
    return;
  }

  if (received > expected || confirmed > expected || observed > expected || collected > expected) {
    await createRefundWithdrawal(env, row, "input amount does not exactly match quote", now);
    return;
  }
  if (now > row.quote_expires_at && !exactTimelyInput) {
    if (received > 0n || observed > 0n)
      await createRefundWithdrawal(env, row, "quote expired after receiving input", now);
    else await setStatus(env.DB, row.id, "expired", "quote expired");
    return;
  }
  if (exactTimelyInput) {
    if (["complete", "external"].includes(row.sweep_status ?? "") && collected === expected) {
      await createOutputWithdrawal(env, row, now);
    } else {
      await setStatus(env.DB, row.id, "input_confirmed", "");
    }
    return;
  }
  await setStatus(
    env.DB,
    row.id,
    row.deposit_status === "confirming" ? "input_confirming" : "awaiting_input",
    "",
  );
}

async function createRefundWithdrawal(
  env: ApiEnv,
  row: ReconcileRow,
  reason: string,
  now: number,
  failedOutput = false,
): Promise<void> {
  const claimed = await env.DB.prepare(`UPDATE swaps SET status = 'refund_required',
    last_error = ?, completed_at = NULL, updated_at = ?
    WHERE id = ? AND refund_withdrawal IS NULL AND status NOT IN ('complete','refunded','reorged')
      AND ((? = 0 AND withdrawal_intent IS NULL) OR (? = 1 AND EXISTS (
        SELECT 1 FROM withdrawal_intents w
        WHERE w.id = swaps.withdrawal_intent AND w.status IN ('failed','expired'))))
    RETURNING id`)
    .bind(reason, now, row.id, failedOutput ? 1 : 0, failedOutput ? 1 : 0)
    .first<{ id: string }>();
  if (!claimed) return;

  const refundable = BigInt(row.observed_units ?? "0");
  const collected = BigInt(row.collected_units ?? "0");
  if (refundable <= 0n) {
    await setStatus(
      env.DB,
      row.id,
      "refund_required",
      `${reason}: waiting for input confirmations`,
    );
    return;
  }
  if (!["complete", "external"].includes(row.sweep_status ?? "") || collected !== refundable) {
    await setStatus(env.DB, row.id, "refund_required", `${reason}: waiting for exact collection`);
    return;
  }

  const network = loadNetworks(env.NETWORKS_JSON).get(row.input_chain);
  const configuredToken = network?.tokens[row.input_asset]?.address;
  if (
    !network ||
    network.chainId !== row.input_chain_id ||
    !configuredToken ||
    !isAddressEqual(configuredToken, row.input_token_address) ||
    !isAddressEqual(network.withdrawalSourceAddress, row.refund_source_address) ||
    network.confirmations !== row.refund_confirmations ||
    network.maxGasPriceWei.toString() !== row.refund_max_gas_price_wei
  ) {
    await setStatus(env.DB, row.id, "refund_required", "refund network configuration changed");
    return;
  }

  const withdrawalId = randomId("wd");
  const idempotencyKey = `swap:${row.id}:refund`;
  const amount = formatUnits(refundable, row.input_decimals);
  const requestHash = await sha256(
    stableStringify({
      swapId: row.id,
      externalId: row.external_id,
      chain: row.input_chain,
      asset: row.input_asset,
      amount,
      destinationAddress: row.refund_address,
    }),
  );
  const expiry =
    now + intSetting(env.DEFAULT_EXPIRY_SECONDS, "DEFAULT_EXPIRY_SECONDS", 300, 86_400);
  const [insert] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO withdrawal_intents
      (id,idempotency_key,request_hash,purpose,external_id,chain,chain_id,asset,token_address,decimals,
       source_address,destination_address,amount,amount_units,confirmations,max_gas_price_wei,status,
       expires_at,created_at,updated_at)
      SELECT ?,?,?,'refund',?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_signature',?,?,?
      FROM swaps s JOIN deposit_intents d ON d.id = s.deposit_intent
      JOIN sweep_jobs j ON j.deposit_intent = d.id
      WHERE s.id = ? AND s.refund_withdrawal IS NULL AND s.status = 'refund_required'
        AND j.observed_units = ? AND j.collected_units = ?
        AND j.status IN ('complete','external')`).bind(
      withdrawalId,
      idempotencyKey,
      requestHash,
      row.external_id,
      row.input_chain,
      row.input_chain_id,
      row.input_asset,
      row.input_token_address,
      row.input_decimals,
      row.refund_source_address,
      row.refund_address,
      amount,
      collected.toString(),
      row.refund_confirmations,
      row.refund_max_gas_price_wei,
      expiry,
      now,
      now,
      row.id,
      refundable.toString(),
      refundable.toString(),
    ),
    env.DB.prepare(`UPDATE swaps SET refund_withdrawal = ?, status = 'refund_awaiting_signature',
      last_error = ?, updated_at = ? WHERE id = ? AND refund_withdrawal IS NULL
      AND EXISTS (SELECT 1 FROM withdrawal_intents WHERE id = ?)`).bind(
      withdrawalId,
      reason,
      now,
      row.id,
      withdrawalId,
    ),
  ]);
  if (!(insert.meta.changes ?? 0)) {
    const winner = await env.DB.prepare("SELECT refund_withdrawal FROM swaps WHERE id = ?")
      .bind(row.id)
      .first<{ refund_withdrawal: string | null }>();
    if (!winner?.refund_withdrawal) return;
  }
}

async function reopenRefundWithdrawal(
  env: ApiEnv,
  row: ReconcileRow,
  now: number,
): Promise<boolean> {
  if (!row.refund_withdrawal) return false;
  const expiry =
    now + intSetting(env.DEFAULT_EXPIRY_SECONDS, "DEFAULT_EXPIRY_SECONDS", 300, 86_400);
  const [reopened] = await env.DB.batch([
    env.DB.prepare(`UPDATE withdrawal_intents
      SET status = 'awaiting_signature', expires_at = ?, last_error = '', completed_at = NULL,
        updated_at = ?
      WHERE id = ? AND status IN ('failed','expired')
        AND NOT EXISTS (SELECT 1 FROM withdrawal_transactions
          WHERE withdrawal = ? AND (status != 'failed' OR block_number IS NULL
            OR last_error != 'transaction reverted'))`).bind(
      expiry,
      now,
      row.refund_withdrawal,
      row.refund_withdrawal,
    ),
    env.DB.prepare(`DELETE FROM withdrawal_nonce_reservations WHERE withdrawal = ?
      AND EXISTS (SELECT 1 FROM withdrawal_intents
        WHERE id = ? AND status = 'awaiting_signature')`).bind(
      row.refund_withdrawal,
      row.refund_withdrawal,
    ),
    env.DB.prepare(`UPDATE swaps SET status = 'refund_awaiting_signature', last_error = '',
      completed_at = NULL, updated_at = ? WHERE id = ? AND refund_withdrawal = ?
      AND EXISTS (SELECT 1 FROM withdrawal_intents
        WHERE id = ? AND status = 'awaiting_signature')`).bind(
      now,
      row.id,
      row.refund_withdrawal,
      row.refund_withdrawal,
    ),
  ]);
  if ((reopened.meta.changes ?? 0) === 1) return true;
  return Boolean(
    await env.DB.prepare(
      "SELECT 1 FROM withdrawal_intents WHERE id = ? AND status = 'awaiting_signature'",
    )
      .bind(row.refund_withdrawal)
      .first(),
  );
}

async function createOutputWithdrawal(env: ApiEnv, row: ReconcileRow, now: number): Promise<void> {
  const network = loadNetworks(env.NETWORKS_JSON).get(row.output_chain);
  const configuredToken = network?.tokens[row.output_asset]?.address ?? "";
  if (
    !network ||
    network.chainId !== row.output_chain_id ||
    !isAddressEqual(network.withdrawalSourceAddress, row.output_source_address) ||
    network.confirmations !== row.output_confirmations ||
    network.maxGasPriceWei.toString() !== row.output_max_gas_price_wei ||
    configuredToken.toLowerCase() !== row.output_token_address.toLowerCase()
  ) {
    await createRefundWithdrawal(env, row, "output network configuration changed", now);
    return;
  }
  const withdrawalId = randomId("wd");
  const idempotencyKey = `swap:${row.id}:output`;
  const requestHash = await sha256(
    stableStringify({
      swapId: row.id,
      externalId: row.external_id,
      chain: row.output_chain,
      asset: row.output_asset,
      amount: row.output_amount,
      destinationAddress: row.destination_address,
    }),
  );
  const expiry =
    now + intSetting(env.DEFAULT_EXPIRY_SECONDS, "DEFAULT_EXPIRY_SECONDS", 300, 86_400);
  const [insert] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO withdrawal_intents
      (id,idempotency_key,request_hash,purpose,external_id,chain,chain_id,asset,token_address,decimals,
       source_address,destination_address,amount,amount_units,confirmations,max_gas_price_wei,status,
       expires_at,created_at,updated_at)
      SELECT ?,?,?,'swap',?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_signature',?,?,?
      FROM swaps s JOIN deposit_intents d ON d.id = s.deposit_intent
      JOIN sweep_jobs j ON j.deposit_intent = d.id
      WHERE s.id = ? AND s.withdrawal_intent IS NULL
        AND s.status IN ('awaiting_input','input_confirming','input_confirmed')
        AND d.status = 'paid' AND d.received_units = d.expected_units
        AND d.confirmed_units = d.expected_units
        AND j.observed_units = d.expected_units AND j.collected_units = d.expected_units
        AND j.status IN ('complete','external')
        AND NOT EXISTS (SELECT 1 FROM deposit_transfers t
          WHERE t.deposit_intent = d.id AND t.canonical = 1
            AND t.block_timestamp > s.quote_expires_at)`).bind(
      withdrawalId,
      idempotencyKey,
      requestHash,
      row.external_id,
      row.output_chain,
      row.output_chain_id,
      row.output_asset,
      row.output_token_address,
      row.output_decimals,
      row.output_source_address,
      row.destination_address,
      row.output_amount,
      row.output_units,
      row.output_confirmations,
      row.output_max_gas_price_wei,
      expiry,
      now,
      now,
      row.id,
    ),
    env.DB.prepare(`UPDATE swaps SET withdrawal_intent = ?, status = 'awaiting_signature',
      last_error = '', updated_at = ? WHERE id = ? AND withdrawal_intent IS NULL
      AND EXISTS (SELECT 1 FROM withdrawal_intents WHERE id = ?)`).bind(
      withdrawalId,
      now,
      row.id,
      withdrawalId,
    ),
  ]);
  if (!(insert.meta.changes ?? 0)) {
    const winner = await env.DB.prepare("SELECT withdrawal_intent FROM swaps WHERE id = ?")
      .bind(row.id)
      .first<{ withdrawal_intent: string | null }>();
    if (!winner?.withdrawal_intent) return;
  }
}

async function setStatus(
  db: D1Database,
  id: string,
  status: SwapStatus,
  error: string,
  completedAt: number | null = null,
): Promise<void> {
  await db
    .prepare(
      "UPDATE swaps SET status = ?, last_error = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    )
    .bind(status, error.slice(0, 1_000), completedAt, unixNow(), id)
    .run();
}

async function swapResponse(db: D1Database, row: SwapRow): Promise<Record<string, unknown>> {
  const deposit = await db
    .prepare(`SELECT d.chain, d.chain_id, d.asset, d.expected_amount, d.expected_units,
       d.received_units, d.confirmed_units, d.deposit_address, d.status,
       j.status AS collection_status, j.collected_units
      FROM deposit_intents d LEFT JOIN sweep_jobs j ON j.deposit_intent = d.id
      WHERE d.id = ?`)
    .bind(row.deposit_intent)
    .first<{
      chain: string;
      chain_id: number;
      asset: string;
      expected_amount: string;
      expected_units: string;
      received_units: string;
      confirmed_units: string;
      deposit_address: Address;
      status: string;
      collection_status: string | null;
      collected_units: string | null;
    }>();
  const withdrawal = row.withdrawal_intent
    ? await db
        .prepare("SELECT status FROM withdrawal_intents WHERE id = ?")
        .bind(row.withdrawal_intent)
        .first<{ status: string }>()
    : null;
  const refund = row.refund_withdrawal
    ? await db
        .prepare("SELECT status FROM withdrawal_intents WHERE id = ?")
        .bind(row.refund_withdrawal)
        .first<{ status: string }>()
    : null;
  return {
    id: row.id,
    externalId: row.external_id,
    depositIntentId: row.deposit_intent,
    withdrawalIntentId: row.withdrawal_intent,
    input: deposit
      ? {
          chain: deposit.chain,
          chainId: deposit.chain_id,
          asset: deposit.asset,
          expectedAmount: deposit.expected_amount,
          expectedUnits: deposit.expected_units,
          receivedUnits: deposit.received_units,
          confirmedUnits: deposit.confirmed_units,
          depositAddress: deposit.deposit_address,
          depositStatus: deposit.status,
          collectionStatus: deposit.collection_status,
          collectedUnits: deposit.collected_units ?? "0",
        }
      : null,
    output: {
      chain: row.output_chain,
      chainId: row.output_chain_id,
      asset: row.output_asset,
      amount: row.output_amount,
      amountUnits: row.output_units,
      sourceAddress: row.output_source_address,
      destinationAddress: row.destination_address,
      withdrawalStatus: withdrawal?.status ?? null,
    },
    refund: {
      address: row.refund_address,
      sourceAddress: row.refund_source_address,
      withdrawalIntentId: row.refund_withdrawal,
      withdrawalStatus: refund?.status ?? null,
    },
    status: row.status,
    quoteExpiresAt: new Date(row.quote_expires_at * 1_000).toISOString(),
    lastError: row.last_error,
    completedAt: row.completed_at ? new Date(row.completed_at * 1_000).toISOString() : null,
    createdAt: new Date(row.created_at * 1_000).toISOString(),
    updatedAt: new Date(row.updated_at * 1_000).toISOString(),
  };
}

async function validateDestination(
  db: D1Database,
  network: NetworkConfig,
  token: Address | "",
  destination: Address,
  kind: "output" | "refund",
): Promise<void> {
  if (
    [
      network.treasuryAddress,
      network.withdrawalSourceAddress,
      network.factoryAddress,
      network.relayerAddress,
      token,
    ]
      .filter(Boolean)
      .some((address) => isAddressEqual(destination, address as Address)) ||
    (await db
      .prepare("SELECT 1 FROM deposit_intents WHERE chain = ? AND deposit_address = ?")
      .bind(network.name, destination)
      .first())
  ) {
    throw new SwapHttpError(400, `invalid ${kind} destination`);
  }
}

async function readObject(request: Request, allowed: string[]): Promise<Record<string, unknown>> {
  if (
    request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new SwapHttpError(415, "Content-Type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 65_536)
    throw new SwapHttpError(413, "request body is too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SwapHttpError(400, "invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SwapHttpError(400, "invalid JSON body");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key)))
    throw new SwapHttpError(400, "invalid JSON body");
  return object;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string") throw new SwapHttpError(400, `${key} is required`);
  return value[key];
}

function checkedAddress(value: string, field = "destinationAddress"): Address {
  if (!isAddress(value) || getAddress(value) === zeroAddress)
    throw new SwapHttpError(400, `invalid ${field}`);
  return getAddress(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

class SwapHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function all<T>(db: D1Database, query: string, ...bindings: unknown[]): Promise<T[]> {
  return (
    await db
      .prepare(query)
      .bind(...bindings)
      .all<T>()
  ).results;
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}

function safeErrorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/[0-9a-f]{64,}/gi, "[redacted]")
    .slice(0, 1_000);
}
