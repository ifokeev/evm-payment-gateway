import type { Address, Hex } from "viem";

export type TokenConfig = { address: Address; decimals: number };

export type NetworkConfig = {
  name: string;
  chainId: number;
  rpcUrl: string;
  treasuryAddress: Address;
  confirmations: number;
  maxGasPriceWei: bigint;
  nativeAsset: string;
  explorerUrl: string;
  tokens: Record<string, TokenConfig>;
  gasPrivateKey?: Hex;
};

export interface TurnkeyEnv {
  TURNKEY_ORGANIZATION_ID: string;
  TURNKEY_API_PUBLIC_KEY: string;
  TURNKEY_API_PRIVATE_KEY: string;
}

export interface TurnkeyAddressEnv extends TurnkeyEnv {
  TURNKEY_WALLET_ID: string;
}

export interface ApiEnv extends TurnkeyAddressEnv {
  DB: D1Database;
  SWEEP_QUEUE: Queue<SweepMessage>;
  PAYMENT_API_KEY: string;
  PAYMENT_WEBHOOK_URL: string;
  PAYMENT_WEBHOOK_SECRET: string;
  NETWORKS_JSON: string;
  DEFAULT_EXPIRY_SECONDS: string;
  MAX_EXPIRY_SECONDS: string;
  PAYMENT_GRACE_SECONDS: string;
  REORG_HISTORY_BLOCKS: string;
  SWEEPER_MAX_GAS_FUNDING_WEI: string;
  SWEEPER_MIN_TOKEN_PAYMENT_BPS: string;
}

export interface SweeperEnv extends TurnkeyEnv {
  GATEWAY: SweepCoordinatorService;
  SWEEP_QUEUE: Queue<SweepMessage>;
  SWEEPER_NETWORKS_JSON: string;
  SWEEPER_GAS_BUFFER_BPS: string;
  SWEEPER_MAX_GAS_FUNDING_WEI: string;
  SWEEPER_RETRY_SECONDS: string;
}

export type SweepMessage = { jobId: string };

export type IntentRow = {
  id: string;
  idempotency_key: string;
  request_hash: string;
  kind: "payment" | "invoice";
  external_id: string;
  chain: string;
  chain_id: number;
  asset: string;
  token_address: Address | "";
  decimals: number;
  expected_amount: string;
  expected_units: string;
  received_units: string;
  confirmed_units: string;
  deposit_address: Address;
  derivation_index: number;
  start_block: number;
  confirmations: number;
  status: PaymentStatus;
  expires_at: number;
  metadata: string;
  created_at: number;
  updated_at: number;
};

export type PaymentTransactionRow = {
  id: string;
  payment_intent: string;
  chain: string;
  tx_hash: Hex;
  event_index: number;
  asset: string;
  from_address: Address;
  to_address: Address;
  amount_units: string;
  block_number: number;
  block_hash: Hex;
  block_timestamp: number;
  canonical: number;
  created_at: number;
  updated_at: number;
};

export type PaymentStatus = "pending" | "underpaid" | "confirming" | "paid" | "expired" | "reorged";

export type SweepTransaction = {
  id: string;
  kind: "gas" | "sweep";
  hash: Hex;
  rawTransaction: Hex;
  from: Address;
  to: Address;
  amountUnits: string;
  nonce: number;
  status: "prepared" | "submitted" | "confirmed" | "failed";
  blockNumber?: number;
  lastError?: string;
  explorerUrl?: string;
  createdAt: string;
};

export type SweepJob = {
  id: string;
  chain: string;
  chainId: number;
  asset: string;
  tokenAddress: Address | "";
  depositAddress: Address;
  derivationIndex: number;
  treasuryAddress: Address;
  confirmations: number;
  maxGasPriceWei: string;
  observedUnits: string;
  status: string;
  attempts: number;
  transactions: SweepTransaction[];
};

export interface SweepCoordinatorService extends Fetcher {
  claimSweep(jobId: string, owner: string): Promise<SweepJob | null>;
  registerSweepTransaction(
    jobId: string,
    owner: string,
    kind: "gas" | "sweep",
    rawTransaction: Hex,
  ): Promise<SweepTransaction>;
  reportSweepTransaction(
    id: string,
    owner: string,
    status: "submitted" | "confirmed" | "failed",
    blockNumber: number,
    error: string,
  ): Promise<void>;
  releaseSweep(
    jobId: string,
    owner: string,
    outcome: SweepOutcome,
  ): Promise<{ delaySeconds: number }>;
}

export type SweepOutcome = {
  status: "queued" | "complete" | "external";
  remainingUnits: string;
  delaySeconds: number;
  error: string;
};
