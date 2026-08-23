import {
  type Address,
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  isAddress,
  isAddressEqual,
  keccak256,
  parseAbiItem,
  parseTransaction,
  recoverTransactionAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type TransactionSerialized,
  zeroAddress,
} from "viem";
import { formatUnits, intSetting, loadNetworks, parseAmount, stableStringify } from "./domain";
import { rpcTransport } from "./rpc";
import type { ApiEnv, NetworkConfig } from "./types";

const MAX_WITHDRAWAL_GAS = 500_000n;
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

type WithdrawalRow = {
  id: string;
  idempotency_key: string;
  request_hash: string;
  purpose: "withdrawal" | "swap" | "refund";
  external_id: string;
  chain: string;
  chain_id: number;
  asset: string;
  token_address: Address | "";
  decimals: number;
  source_address: Address;
  destination_address: Address;
  amount: string;
  amount_units: string;
  confirmations: number;
  max_gas_price_wei: string;
  status: "awaiting_signature" | "submitted" | "confirming" | "complete" | "failed" | "expired";
  expires_at: number;
  last_error: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

type WithdrawalTransactionRow = {
  id: string;
  withdrawal: string;
  replacement_of: string | null;
  chain: string;
  tx_hash: Hex;
  raw_tx: Hex;
  from_address: Address;
  to_address: Address;
  nonce: number;
  fee_wei: string;
  status: "prepared" | "submitted" | "confirmed" | "failed" | "replaced";
  block_number: number | null;
  block_hash: Hex | null;
  last_error: string;
  created_at: number;
  updated_at: number;
};

export async function routeWithdrawal(
  request: Request,
  url: URL,
  env: ApiEnv,
  apiRoot: string,
): Promise<Response | null> {
  const collection = `${apiRoot}/withdrawals`;
  const match = url.pathname.match(
    new RegExp(`^${collection}/([A-Za-z0-9_-]+)(?:/(proposal|transaction))?$`),
  );
  if (request.method === "POST" && url.pathname === collection)
    return handle(() => createWithdrawal(request, env));
  if (!match) return null;
  if (request.method === "GET" && !match[2])
    return handle(() => getWithdrawal(match[1], env, false));
  if (request.method === "GET" && match[2] === "proposal")
    return handle(() => getWithdrawal(match[1], env, true));
  if (request.method === "POST" && match[2] === "transaction")
    return handle(() => submitTransaction(match[1], request, env));
  return null;
}

async function createWithdrawal(request: Request, env: ApiEnv): Promise<Response> {
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 200)
    throw new WithdrawalHttpError(
      400,
      "Idempotency-Key is required and must be at most 200 characters",
    );
  const body = await readObject(request, [
    "purpose",
    "externalId",
    "chain",
    "asset",
    "amount",
    "destinationAddress",
    "expiresInSeconds",
  ]);
  const purpose = requiredString(body, "purpose").trim();
  const externalId = requiredString(body, "externalId").trim();
  const chainName = requiredString(body, "chain").trim();
  const asset = requiredString(body, "asset").trim().toUpperCase();
  const rawAmount = requiredString(body, "amount");
  const destination = checkedAddress(requiredString(body, "destinationAddress"));
  if (purpose !== "withdrawal")
    throw new WithdrawalHttpError(
      400,
      "purpose must be withdrawal (swap outputs and refunds are coordinator-created)",
    );
  if (!externalId || externalId.length > 200)
    throw new WithdrawalHttpError(400, "externalId is required and must be at most 200 characters");
  if (rawAmount.trim().length > 100)
    throw new WithdrawalHttpError(400, "amount must be at most 100 characters");

  const network = loadNetworks(env.NETWORKS_JSON).get(chainName);
  if (!network) throw new WithdrawalHttpError(400, "unsupported chain");
  const token = asset === network.nativeAsset ? undefined : network.tokens[asset];
  if (asset !== network.nativeAsset && !token)
    throw new WithdrawalHttpError(400, "unsupported asset for chain");
  if (
    [
      network.treasuryAddress,
      network.withdrawalSourceAddress,
      network.factoryAddress,
      network.relayerAddress,
      token?.address,
    ]
      .filter(Boolean)
      .some((address) => isAddressEqual(destination, address as Address)) ||
    (await env.DB.prepare("SELECT 1 FROM deposit_intents WHERE chain = ? AND deposit_address = ?")
      .bind(network.name, destination)
      .first())
  ) {
    throw new WithdrawalHttpError(400, "invalid withdrawal destination");
  }
  let amount: ReturnType<typeof parseAmount>;
  try {
    amount = parseAmount(rawAmount, token?.decimals ?? 18);
  } catch (error) {
    throw new WithdrawalHttpError(400, errorText(error));
  }
  const defaultExpiry = intSetting(
    env.DEFAULT_EXPIRY_SECONDS,
    "DEFAULT_EXPIRY_SECONDS",
    300,
    86_400,
  );
  const maxExpiry = intSetting(
    env.MAX_EXPIRY_SECONDS,
    "MAX_EXPIRY_SECONDS",
    defaultExpiry,
    604_800,
  );
  const expiresIn = body.expiresInSeconds === undefined ? defaultExpiry : body.expiresInSeconds;
  if (
    !Number.isInteger(expiresIn) ||
    (expiresIn as number) < 300 ||
    (expiresIn as number) > maxExpiry
  ) {
    throw new WithdrawalHttpError(400, `expiresInSeconds must be between 300 and ${maxExpiry}`);
  }
  const normalized = {
    purpose,
    externalId,
    chain: chainName,
    asset,
    amount: amount.amount,
    destinationAddress: destination,
    expiresInSeconds: expiresIn,
  };
  const requestHash = await sha256(stableStringify(normalized));
  const existing = await env.DB.prepare(
    "SELECT * FROM withdrawal_intents WHERE idempotency_key = ?",
  )
    .bind(idempotencyKey)
    .first<WithdrawalRow>();
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new WithdrawalHttpError(
        409,
        "idempotency key was already used with a different request",
      );
    return json(await withdrawalResponse(env, existing, network, false));
  }

  const now = unixNow();
  const row: WithdrawalRow = {
    id: randomId("wd"),
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    purpose,
    external_id: externalId,
    chain: network.name,
    chain_id: network.chainId,
    asset,
    token_address: token?.address ?? "",
    decimals: token?.decimals ?? 18,
    source_address: network.withdrawalSourceAddress,
    destination_address: destination,
    amount: amount.amount,
    amount_units: amount.units.toString(),
    confirmations: network.confirmations,
    max_gas_price_wei: network.maxGasPriceWei.toString(),
    status: "awaiting_signature",
    expires_at: now + (expiresIn as number),
    last_error: "",
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await env.DB.prepare(`INSERT INTO withdrawal_intents
      (id,idempotency_key,request_hash,purpose,external_id,chain,chain_id,asset,token_address,decimals,source_address,
       destination_address,amount,amount_units,confirmations,max_gas_price_wei,status,expires_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'awaiting_signature',?,?,?)`)
      .bind(
        row.id,
        row.idempotency_key,
        row.request_hash,
        row.purpose,
        row.external_id,
        row.chain,
        row.chain_id,
        row.asset,
        row.token_address,
        row.decimals,
        row.source_address,
        row.destination_address,
        row.amount,
        row.amount_units,
        row.confirmations,
        row.max_gas_price_wei,
        row.expires_at,
        row.created_at,
        row.updated_at,
      )
      .run();
  } catch (error) {
    const winner = await env.DB.prepare(
      "SELECT * FROM withdrawal_intents WHERE idempotency_key = ?",
    )
      .bind(idempotencyKey)
      .first<WithdrawalRow>();
    if (!winner) throw error;
    if (winner.request_hash !== requestHash)
      throw new WithdrawalHttpError(
        409,
        "idempotency key was already used with a different request",
      );
    return json(await withdrawalResponse(env, winner, network, false));
  }
  return json(await withdrawalResponse(env, row, network, false), 201);
}

async function getWithdrawal(id: string, env: ApiEnv, proposal: boolean): Promise<Response> {
  let row = await env.DB.prepare("SELECT * FROM withdrawal_intents WHERE id = ?")
    .bind(id)
    .first<WithdrawalRow>();
  if (!row) throw new WithdrawalHttpError(404, "withdrawal not found");
  if (row.status === "awaiting_signature" && row.expires_at < unixNow()) {
    await env.DB.prepare(
      "UPDATE withdrawal_intents SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_signature'",
    )
      .bind(unixNow(), id)
      .run();
    row = { ...row, status: "expired", updated_at: unixNow() };
  }
  const network = loadNetworks(env.NETWORKS_JSON).get(row.chain);
  if (!network) throw new Error(`network ${row.chain} is no longer configured`);
  return json(await withdrawalResponse(env, row, network, proposal));
}

async function submitTransaction(id: string, request: Request, env: ApiEnv): Promise<Response> {
  const body = await readObject(request, ["rawTransaction"]);
  const raw = requiredString(body, "rawTransaction") as Hex;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(raw) || raw.length > 262_146)
    throw new WithdrawalHttpError(400, "invalid raw transaction");
  const withdrawal = await env.DB.prepare("SELECT * FROM withdrawal_intents WHERE id = ?")
    .bind(id)
    .first<WithdrawalRow>();
  if (!withdrawal) throw new WithdrawalHttpError(404, "withdrawal not found");
  if (withdrawal.status === "awaiting_signature" && withdrawal.expires_at < unixNow()) {
    await env.DB.prepare(
      "UPDATE withdrawal_intents SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_signature'",
    )
      .bind(unixNow(), id)
      .run();
    throw new WithdrawalHttpError(409, "withdrawal proposal has expired");
  }
  const network = loadNetworks(env.NETWORKS_JSON).get(withdrawal.chain);
  if (!network) throw new Error(`network ${withdrawal.chain} is no longer configured`);
  let transaction: ReturnType<typeof parseTransaction>;
  try {
    transaction = parseTransaction(raw);
  } catch {
    throw new WithdrawalHttpError(400, "invalid raw transaction");
  }
  const fee = transaction.gasPrice ?? transaction.maxFeePerGas;
  if (
    !transaction.type ||
    !["legacy", "eip2930", "eip1559"].includes(transaction.type) ||
    transaction.chainId !== withdrawal.chain_id ||
    !transaction.to ||
    transaction.nonce === undefined ||
    !Number.isSafeInteger(transaction.nonce) ||
    transaction.gas === undefined ||
    transaction.gas < 21_000n ||
    transaction.gas > MAX_WITHDRAWAL_GAS ||
    fee === undefined ||
    fee <= 0n ||
    fee > BigInt(withdrawal.max_gas_price_wei) ||
    (transaction.maxPriorityFeePerGas !== undefined &&
      transaction.maxFeePerGas !== undefined &&
      transaction.maxPriorityFeePerGas > transaction.maxFeePerGas)
  ) {
    throw new WithdrawalHttpError(400, "invalid withdrawal transaction envelope");
  }
  let from: Address;
  try {
    from = await recoverTransactionAddress({
      serializedTransaction: raw as TransactionSerialized,
    });
  } catch {
    throw new WithdrawalHttpError(400, "invalid raw transaction signature");
  }
  const expected = transactionFields(withdrawal);
  if (
    !isAddressEqual(from, withdrawal.source_address) ||
    !isAddressEqual(transaction.to, expected.to) ||
    (transaction.value ?? 0n) !== BigInt(expected.value) ||
    (transaction.data ?? "0x").toLowerCase() !== expected.data.toLowerCase()
  ) {
    throw new WithdrawalHttpError(400, "signed transaction does not match withdrawal proposal");
  }
  const hash = keccak256(raw);
  const replay = await env.DB.prepare(
    "SELECT 1 FROM withdrawal_transactions WHERE withdrawal = ? AND tx_hash = ?",
  )
    .bind(id, hash)
    .first();
  if (replay) return json(await withdrawalResponse(env, withdrawal, network, false), 202);

  const existing = await env.DB.prepare(
    `SELECT * FROM withdrawal_transactions WHERE withdrawal = ? AND status IN ('prepared', 'submitted')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(id)
    .first<WithdrawalTransactionRow>();
  if (!existing && withdrawal.status !== "awaiting_signature")
    throw new WithdrawalHttpError(409, "withdrawal is not awaiting a signature");
  if (existing) {
    if (withdrawal.status !== "submitted" && withdrawal.status !== "confirming")
      throw new WithdrawalHttpError(409, "withdrawal transaction cannot be replaced");
    const previous = parseTransaction(existing.raw_tx);
    const previousFee = transactionFeeCap(previous);
    const previousPriority = previous.maxPriorityFeePerGas ?? 0n;
    const nextPriority = transaction.maxPriorityFeePerGas ?? 0n;
    if (
      transaction.nonce !== existing.nonce ||
      previousFee === undefined ||
      fee <= previousFee ||
      nextPriority < previousPriority
    ) {
      throw new WithdrawalHttpError(
        409,
        "replacement must use the same nonce and increase the fee without reducing priority",
      );
    }
  }
  const nonceOwner = await env.DB.prepare(
    "SELECT withdrawal FROM withdrawal_nonce_reservations WHERE chain = ? AND from_address = ? AND nonce = ?",
  )
    .bind(withdrawal.chain, from, transaction.nonce)
    .first<{ withdrawal: string }>();
  if (nonceOwner && nonceOwner.withdrawal !== id)
    throw new WithdrawalHttpError(409, "treasury nonce already belongs to another withdrawal");

  const now = unixNow();
  const txId = randomId("wtx");
  let registered = false;
  try {
    const statements = existing
      ? [
          env.DB.prepare(`INSERT INTO withdrawal_transactions
            (id,withdrawal,replacement_of,chain,tx_hash,raw_tx,from_address,to_address,nonce,status,created_at,updated_at)
            SELECT ?,?,?,?,?,?,?,?,?,'prepared',?,? FROM withdrawal_transactions
            WHERE id = ? AND withdrawal = ? AND status IN ('prepared', 'submitted')`).bind(
            txId,
            id,
            existing.id,
            withdrawal.chain,
            hash,
            raw,
            from,
            getAddress(transaction.to),
            transaction.nonce,
            now,
            now,
            existing.id,
            id,
          ),
          env.DB.prepare(
            `UPDATE withdrawal_transactions SET status = 'replaced', updated_at = ?
             WHERE id = ? AND status IN ('prepared', 'submitted')
               AND EXISTS (SELECT 1 FROM withdrawal_transactions WHERE id = ?)`,
          ).bind(now, existing.id, txId),
          env.DB.prepare(
            `UPDATE withdrawal_intents SET status = 'submitted', last_error = '', updated_at = ?
             WHERE id = ? AND status IN ('submitted', 'confirming')
               AND EXISTS (SELECT 1 FROM withdrawal_transactions WHERE id = ?)`,
          ).bind(now, id, txId),
        ]
      : [
          env.DB.prepare(`INSERT INTO withdrawal_nonce_reservations
            (chain,from_address,nonce,withdrawal,created_at)
            SELECT ?,?,?,?,? FROM withdrawal_intents
            WHERE id = ? AND status = 'awaiting_signature' AND expires_at >= ?
            ON CONFLICT(chain,from_address,nonce) DO NOTHING`).bind(
            withdrawal.chain,
            from,
            transaction.nonce,
            id,
            now,
            id,
            now,
          ),
          env.DB.prepare(`INSERT INTO withdrawal_transactions
            (id,withdrawal,replacement_of,chain,tx_hash,raw_tx,from_address,to_address,nonce,status,created_at,updated_at)
            SELECT ?,?,NULL,?,?,?,?,?,?,'prepared',?,? FROM withdrawal_intents
            WHERE id = ? AND status = 'awaiting_signature' AND expires_at >= ?
              AND EXISTS (SELECT 1 FROM withdrawal_nonce_reservations
                WHERE chain = ? AND from_address = ? AND nonce = ? AND withdrawal = ?)`).bind(
            txId,
            id,
            withdrawal.chain,
            hash,
            raw,
            from,
            getAddress(transaction.to),
            transaction.nonce,
            now,
            now,
            id,
            now,
            withdrawal.chain,
            from,
            transaction.nonce,
            id,
          ),
          env.DB.prepare(
            `UPDATE withdrawal_intents SET status = 'submitted', last_error = '', updated_at = ?
             WHERE id = ? AND status = 'awaiting_signature' AND expires_at >= ?
               AND EXISTS (SELECT 1 FROM withdrawal_transactions WHERE id = ?)`,
          ).bind(now, id, now, txId),
        ];
    const results = await env.DB.batch(statements);
    const insert = results[existing ? 0 : 1];
    registered = (insert.meta.changes ?? 0) === 1;
  } catch (error) {
    const winner = await env.DB.prepare(
      "SELECT * FROM withdrawal_transactions WHERE withdrawal = ? AND tx_hash = ?",
    )
      .bind(id, hash)
      .first<WithdrawalTransactionRow>();
    if (winner) registered = true;
    else if (
      await env.DB.prepare(
        `SELECT 1 FROM withdrawal_nonce_reservations
         WHERE chain = ? AND from_address = ? AND nonce = ? AND withdrawal != ?`,
      )
        .bind(withdrawal.chain, from, transaction.nonce, id)
        .first()
    ) {
      throw new WithdrawalHttpError(409, "treasury nonce already belongs to another withdrawal");
    } else {
      throw error;
    }
  }
  if (!registered) {
    const current = await env.DB.prepare("SELECT status FROM withdrawal_intents WHERE id = ?")
      .bind(id)
      .first<{ status: WithdrawalRow["status"] }>();
    throw new WithdrawalHttpError(
      409,
      current?.status === "expired"
        ? "withdrawal proposal has expired"
        : "withdrawal is not awaiting a signature",
    );
  }

  try {
    await broadcast(raw, hash, network);
    await env.DB.prepare(
      "UPDATE withdrawal_transactions SET status = 'submitted', last_error = '', updated_at = ? WHERE id = ?",
    )
      .bind(unixNow(), txId)
      .run();
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE withdrawal_transactions SET last_error = ?, updated_at = ? WHERE id = ?",
      ).bind(safeError(error), unixNow(), txId),
      env.DB.prepare(
        "UPDATE withdrawal_intents SET last_error = ?, updated_at = ? WHERE id = ?",
      ).bind(safeError(error), unixNow(), id),
    ]);
  }
  const stored = await env.DB.prepare("SELECT * FROM withdrawal_intents WHERE id = ?")
    .bind(id)
    .first<WithdrawalRow>();
  if (!stored) throw new Error("registered withdrawal is missing");
  return json(await withdrawalResponse(env, stored, network, false), 202);
}

export async function reconcileWithdrawals(env: ApiEnv): Promise<void> {
  const now = unixNow();
  await env.DB.prepare(
    "UPDATE withdrawal_intents SET status = 'expired', updated_at = ? WHERE status = 'awaiting_signature' AND expires_at < ?",
  )
    .bind(now, now)
    .run();
  // ponytail: keep seven days of terminal transactions under reorg watch; use a chain indexer if deeper reorg monitoring is required.
  const rows = await all<WithdrawalTransactionRow & WithdrawalRow>(
    env.DB,
    `SELECT t.*, w.id AS withdrawal_id, w.purpose, w.external_id, w.chain_id, w.asset, w.token_address, w.decimals,
      w.source_address, w.destination_address, w.amount, w.amount_units, w.confirmations, w.max_gas_price_wei,
      w.expires_at, w.completed_at, w.status AS withdrawal_status
     FROM withdrawal_transactions t JOIN withdrawal_intents w ON w.id = t.withdrawal
     WHERE (w.status IN ('submitted', 'confirming') AND t.status IN ('prepared', 'submitted', 'replaced'))
        OR (w.status = 'complete' AND t.status = 'confirmed' AND w.completed_at >= ?)
        OR (w.status = 'failed' AND w.updated_at >= ?)
     ORDER BY CASE
       WHEN w.status IN ('submitted', 'confirming') AND t.status != 'replaced' THEN 0
       WHEN w.status IN ('submitted', 'confirming') THEN 1
       ELSE 2 END,
       t.updated_at
     LIMIT 100`,
    now - 7 * 24 * 60 * 60,
    now - 7 * 24 * 60 * 60,
  );
  const networks = loadNetworks(env.NETWORKS_JSON);
  const clients = new Map<string, ReturnType<typeof createPublicClient>>();
  const verifiedChains = new Set<string>();
  for (const joined of rows as Array<
    WithdrawalTransactionRow &
      Omit<WithdrawalRow, "id" | "status"> & {
        withdrawal_id: string;
        withdrawal_status: WithdrawalRow["status"];
      }
  >) {
    const liveWithdrawal = await env.DB.prepare(
      "SELECT status FROM withdrawal_intents WHERE id = ?",
    )
      .bind(joined.withdrawal_id)
      .first<{ status: WithdrawalRow["status"] }>();
    if (liveWithdrawal?.status === "complete" && joined.status !== "confirmed") continue;
    const network = networks.get(joined.chain);
    if (!network) {
      const error = `network ${joined.chain} is no longer configured`;
      const now = unixNow();
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE withdrawal_transactions SET last_error = ?, updated_at = ? WHERE id = ?",
        ).bind(error, now, joined.id),
        env.DB.prepare(
          "UPDATE withdrawal_intents SET last_error = ?, updated_at = ? WHERE id = ?",
        ).bind(error, now, joined.withdrawal_id),
      ]);
      continue;
    }
    let client = clients.get(joined.chain);
    if (!client) {
      client = createPublicClient({
        transport: rpcTransport(network.rpcUrls, { timeout: 30_000 }),
      });
      clients.set(joined.chain, client);
    }
    const withdrawal: WithdrawalRow = {
      ...joined,
      id: joined.withdrawal_id,
      status: joined.withdrawal_status,
      idempotency_key: "",
      request_hash: "",
      created_at: joined.created_at,
      updated_at: joined.updated_at,
      last_error: joined.last_error,
    };
    try {
      if (!verifiedChains.has(joined.chain)) {
        if ((await client.getChainId()) !== network.chainId)
          throw new Error(`RPC chain ID mismatch for ${network.name}`);
        verifiedChains.add(joined.chain);
      }
      if (joined.status === "prepared") {
        await broadcast(joined.raw_tx, joined.tx_hash, network, client);
        await env.DB.prepare(
          "UPDATE withdrawal_transactions SET status = 'submitted', last_error = '', updated_at = ? WHERE id = ?",
        )
          .bind(unixNow(), joined.id)
          .run();
      }
      if (joined.status === "replaced") {
        await reconcileReplacedTransaction(env.DB, withdrawal, joined, network, client);
        continue;
      }
      await reconcileTransaction(env.DB, withdrawal, joined, network, client);
    } catch (error) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE withdrawal_transactions SET last_error = ?, updated_at = ? WHERE id = ?",
        ).bind(safeError(error), unixNow(), joined.id),
        env.DB.prepare(
          "UPDATE withdrawal_intents SET last_error = ?, updated_at = ? WHERE id = ?",
        ).bind(safeError(error), unixNow(), withdrawal.id),
      ]);
    }
  }
}

async function reconcileTransaction(
  db: D1Database,
  withdrawal: WithdrawalRow,
  transaction: WithdrawalTransactionRow,
  network: NetworkConfig,
  client: ReturnType<typeof createPublicClient>,
): Promise<void> {
  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: transaction.tx_hash });
  } catch (error) {
    if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
    try {
      await client.getTransaction({ hash: transaction.tx_hash });
    } catch (transactionError) {
      if (!(transactionError instanceof TransactionNotFoundError)) throw transactionError;
      await markSubmitted(db, withdrawal.id, transaction.id, "transaction and receipt not found");
      await broadcast(transaction.raw_tx, transaction.tx_hash, network, client);
      return;
    }
    await markSubmitted(db, withdrawal.id, transaction.id);
    return;
  }
  const fee = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
  const expected = transactionFields(withdrawal);
  if (
    receipt.transactionHash.toLowerCase() !== transaction.tx_hash.toLowerCase() ||
    !isAddressEqual(receipt.from, withdrawal.source_address) ||
    !receipt.to ||
    !isAddressEqual(receipt.to, expected.to)
  ) {
    throw new Error("withdrawal receipt does not match signed transaction");
  }
  const [head, canonicalBlock] = await Promise.all([
    client.getBlockNumber(),
    client.request({
      method: "eth_getBlockByNumber",
      params: [`0x${receipt.blockNumber.toString(16)}`, false],
    }),
  ]);
  if (!canonicalBlock || canonicalBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    if (transaction.status === "replaced") {
      await db
        .prepare("UPDATE withdrawal_transactions SET last_error = ?, updated_at = ? WHERE id = ?")
        .bind("receipt block is not canonical", unixNow(), transaction.id)
        .run();
    } else {
      await markSubmitted(db, withdrawal.id, transaction.id, "receipt block is not canonical");
    }
    return;
  }
  await db
    .prepare(`UPDATE withdrawal_transactions SET status = 'replaced', updated_at = ?
      WHERE withdrawal = ? AND id != ? AND status IN ('prepared', 'submitted')`)
    .bind(unixNow(), withdrawal.id, transaction.id)
    .run();
  const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
  const now = unixNow();
  if (confirmations < BigInt(withdrawal.confirmations)) {
    await db.batch([
      db
        .prepare(`UPDATE withdrawal_transactions SET status = 'submitted', block_number = ?, block_hash = ?,
          fee_wei = ?, last_error = '', updated_at = ? WHERE id = ?`)
        .bind(Number(receipt.blockNumber), receipt.blockHash, fee, now, transaction.id),
      db
        .prepare(`UPDATE withdrawal_intents SET status = 'confirming', completed_at = NULL,
          last_error = '', updated_at = ? WHERE id = ?`)
        .bind(now, withdrawal.id),
    ]);
    return;
  }
  if (receipt.status !== "success") {
    await db.batch([
      db
        .prepare(`UPDATE withdrawal_transactions SET status = 'failed', block_number = ?, block_hash = ?,
          fee_wei = ?, last_error = 'transaction reverted', updated_at = ? WHERE id = ?`)
        .bind(Number(receipt.blockNumber), receipt.blockHash, fee, now, transaction.id),
      db
        .prepare(`UPDATE withdrawal_intents SET status = 'failed', last_error = 'transaction reverted',
          updated_at = ? WHERE id = ?`)
        .bind(now, withdrawal.id),
    ]);
    return;
  }
  if (withdrawal.token_address && !hasExpectedTransfer(receipt.logs, withdrawal)) {
    await db.batch([
      db
        .prepare(`UPDATE withdrawal_transactions SET status = 'failed', block_number = ?, block_hash = ?,
          fee_wei = ?, last_error = 'token transfer event mismatch', updated_at = ? WHERE id = ?`)
        .bind(Number(receipt.blockNumber), receipt.blockHash, fee, now, transaction.id),
      db
        .prepare(`UPDATE withdrawal_intents SET status = 'failed', last_error = 'token transfer event mismatch',
          updated_at = ? WHERE id = ?`)
        .bind(now, withdrawal.id),
    ]);
    return;
  }
  await db.batch([
    db
      .prepare(`UPDATE withdrawal_transactions SET status = 'confirmed', block_number = ?, block_hash = ?,
        fee_wei = ?, last_error = '', updated_at = ? WHERE id = ?`)
      .bind(Number(receipt.blockNumber), receipt.blockHash, fee, now, transaction.id),
    db
      .prepare(`UPDATE withdrawal_intents SET status = 'complete', last_error = '',
        completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE id = ?`)
      .bind(now, now, withdrawal.id),
  ]);
}

async function reconcileReplacedTransaction(
  db: D1Database,
  withdrawal: WithdrawalRow,
  transaction: WithdrawalTransactionRow,
  network: NetworkConfig,
  client: ReturnType<typeof createPublicClient>,
): Promise<void> {
  try {
    await client.getTransactionReceipt({ hash: transaction.tx_hash });
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return;
    throw error;
  }
  await reconcileTransaction(db, withdrawal, transaction, network, client);
}

async function markSubmitted(
  db: D1Database,
  withdrawalId: string,
  transactionId: string,
  error = "",
): Promise<void> {
  const now = unixNow();
  await db.batch([
    db
      .prepare(`UPDATE withdrawal_transactions SET status = 'submitted', block_number = NULL,
        block_hash = NULL, fee_wei = '0', last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(error, now, transactionId),
    db
      .prepare(`UPDATE withdrawal_intents SET status = 'submitted', completed_at = NULL,
        last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(error, now, withdrawalId),
  ]);
}

export async function rewindWithdrawals(
  db: D1Database,
  chain: string,
  fromBlock: number,
): Promise<void> {
  const now = unixNow();
  await db.batch([
    db
      .prepare(`UPDATE withdrawal_intents SET status = 'submitted', completed_at = NULL, updated_at = ?
        WHERE id IN (SELECT withdrawal FROM withdrawal_transactions
          WHERE chain = ? AND block_number >= ? AND status IN ('submitted', 'confirmed', 'failed'))`)
      .bind(now, chain, fromBlock),
    db
      .prepare(`UPDATE withdrawal_transactions SET status = 'submitted', block_number = NULL,
        block_hash = NULL, fee_wei = '0', updated_at = ?
        WHERE chain = ? AND block_number >= ? AND status IN ('submitted', 'confirmed', 'failed')`)
      .bind(now, chain, fromBlock),
  ]);
}

function hasExpectedTransfer(
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[],
  withdrawal: WithdrawalRow,
): boolean {
  return logs.some((log) => {
    if (!withdrawal.token_address || !isAddressEqual(log.address, withdrawal.token_address))
      return false;
    try {
      const decoded = decodeEventLog({
        abi: [transferEvent],
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      return (
        isAddressEqual(decoded.args.from, withdrawal.source_address) &&
        isAddressEqual(decoded.args.to, withdrawal.destination_address) &&
        decoded.args.value === BigInt(withdrawal.amount_units)
      );
    } catch {
      return false;
    }
  });
}

async function withdrawalResponse(
  env: ApiEnv,
  row: WithdrawalRow,
  network: NetworkConfig,
  includeProposal: boolean,
): Promise<Record<string, unknown>> {
  const [transaction, swap] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM withdrawal_transactions WHERE withdrawal = ?
       ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'replaced' THEN 2 ELSE 1 END,
                created_at DESC, id DESC LIMIT 1`,
    )
      .bind(row.id)
      .first<WithdrawalTransactionRow>(),
    row.purpose !== "withdrawal"
      ? env.DB.prepare(
          "SELECT id, deposit_intent FROM swaps WHERE withdrawal_intent = ? OR refund_withdrawal = ?",
        )
          .bind(row.id, row.id)
          .first<{ id: string; deposit_intent: string }>()
      : Promise.resolve(null),
  ]);
  return {
    id: row.id,
    purpose: row.purpose,
    externalId: row.external_id,
    chain: row.chain,
    chainId: row.chain_id,
    asset: row.asset,
    amount: row.amount,
    amountUnits: row.amount_units,
    sourceAddress: row.source_address,
    destinationAddress: row.destination_address,
    requiredConfirmations: row.confirmations,
    status: row.status,
    expiresAt: new Date(row.expires_at * 1_000).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at * 1_000).toISOString() : null,
    lastError: row.last_error,
    ...(swap ? { swapId: swap.id, depositIntentId: swap.deposit_intent } : {}),
    ...(includeProposal
      ? {
          proposal: {
            ...transactionFields(row),
            amount: formatUnits(BigInt(row.amount_units), row.decimals),
            asset: row.asset,
            maxGas: MAX_WITHDRAWAL_GAS.toString(),
            maxGasPriceWei: row.max_gas_price_wei,
          },
        }
      : {}),
    transaction: transaction
      ? {
          hash: transaction.tx_hash,
          from: transaction.from_address,
          to: transaction.to_address,
          nonce: transaction.nonce,
          feeWei: transaction.fee_wei,
          status: transaction.status,
          blockNumber: transaction.block_number,
          lastError: transaction.last_error,
          ...(network.explorerUrl
            ? { explorerUrl: `${network.explorerUrl}/tx/${transaction.tx_hash}` }
            : {}),
        }
      : null,
    createdAt: new Date(row.created_at * 1_000).toISOString(),
    updatedAt: new Date(row.updated_at * 1_000).toISOString(),
  };
}

function transactionFeeCap(transaction: ReturnType<typeof parseTransaction>): bigint | undefined {
  return transaction.gasPrice ?? transaction.maxFeePerGas;
}

function transactionFields(withdrawal: WithdrawalRow): {
  chainId: number;
  from: Address;
  to: Address;
  value: string;
  data: Hex;
} {
  if (!withdrawal.token_address)
    return {
      chainId: withdrawal.chain_id,
      from: withdrawal.source_address,
      to: withdrawal.destination_address,
      value: withdrawal.amount_units,
      data: "0x",
    };
  return {
    chainId: withdrawal.chain_id,
    from: withdrawal.source_address,
    to: withdrawal.token_address,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [withdrawal.destination_address, BigInt(withdrawal.amount_units)],
    }),
  };
}

async function broadcast(
  raw: Hex,
  expectedHash: Hex,
  network: NetworkConfig,
  existingClient?: ReturnType<typeof createPublicClient>,
): Promise<void> {
  const client =
    existingClient ??
    createPublicClient({ transport: rpcTransport(network.rpcUrls, { timeout: 30_000 }) });
  try {
    if (!existingClient && (await client.getChainId()) !== network.chainId)
      throw new Error(`RPC chain ID mismatch for ${network.name}`);
    const hash = await client.sendRawTransaction({ serializedTransaction: raw });
    if (hash.toLowerCase() !== expectedHash.toLowerCase())
      throw new Error("RPC returned the wrong transaction hash");
  } catch (error) {
    if (!knownTransactionError(error)) throw error;
  }
}

function checkedAddress(value: string): Address {
  if (!isAddress(value) || getAddress(value) === zeroAddress)
    throw new WithdrawalHttpError(400, "invalid destinationAddress");
  return getAddress(value);
}

async function readObject(
  request: Request,
  allowedKeys: string[],
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json")
    throw new WithdrawalHttpError(415, "Content-Type must be application/json");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 65_536)
    throw new WithdrawalHttpError(413, "request body is too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WithdrawalHttpError(400, "invalid JSON body");
  }
  if (!isObject(value) || Object.keys(value).some((key) => !allowedKeys.includes(key)))
    throw new WithdrawalHttpError(400, "invalid JSON body");
  return value;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  if (typeof object[key] !== "string") throw new WithdrawalHttpError(400, `${key} is required`);
  return object[key];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handle(action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WithdrawalHttpError) return json({ error: error.message }, error.status);
    throw error;
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function all<T>(db: D1Database, sql: string, ...bindings: unknown[]): Promise<T[]> {
  return (
    await db
      .prepare(sql)
      .bind(...bindings)
      .all<T>()
  ).results;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function knownTransactionError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("already known") || /\bknown transaction\b/.test(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeError(error: unknown): string {
  return errorText(error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]")
    .replace(/0x[0-9a-f]{128,}/gi, "[redacted-hex]")
    .slice(0, 1_000);
}

class WithdrawalHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
