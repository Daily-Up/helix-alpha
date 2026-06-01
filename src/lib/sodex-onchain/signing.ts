/**
 * EIP-712 signing for SoDEX REST actions.
 *
 * The signing protocol (from the SoDEX trading-api docs):
 *
 *   1. Build action object:  { "type": "<name>", "params": {...} }
 *   2. Marshal to compact JSON (no whitespace, key order matching the
 *      Go struct field order)
 *   3. payloadHash = keccak256(json)
 *   4. EIP-712-sign the typed-data:
 *        domain = { name: "spot"|"futures", version: "1",
 *                   chainId, verifyingContract: 0x0 }
 *        primaryType = "ExchangeAction"
 *        types.ExchangeAction = [{name:"payloadHash",type:"bytes32"},
 *                                {name:"nonce",type:"uint64"}]
 *        message = { payloadHash, nonce }
 *   5. Returns a 65-byte signature; prepend 0x01 to produce X-API-Sign.
 *
 * Headers sent on every signed action:
 *   X-API-Sign:  the 0x01-prefixed signature
 *   X-API-Nonce: the unix-millis nonce used in the signature
 *   X-API-Key:   the API key name (OMITTED when signing with the
 *                master wallet directly, e.g. addAPIKey/revokeAPIKey)
 */

import {
  keccak256,
  toBytes,
  toHex,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SodexAction } from "./types";

/**
 * Minimal EIP-1193 provider surface. We accept anything that
 * implements `request(...)` so callers can pass `window.ethereum`,
 * a wagmi connector's provider, or a WalletConnect session — none
 * of which run viem's chainId-match validation on signing.
 */
export interface Eip1193Provider {
  request(args: {
    method: string;
    params?: unknown[] | object;
  }): Promise<unknown>;
}

export type SodexDomainName = "spot" | "futures";

/** EIP-712 domain for SoDEX exchange actions. */
export function buildExchangeDomain(
  name: SodexDomainName,
  chainId: number,
): TypedDataDomain {
  return {
    name,
    version: "1",
    chainId,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
}

/** Compact-serialize an action object and hash it with keccak256. */
export function hashAction(action: SodexAction): Hex {
  // JSON.stringify gives us no-whitespace output, which matches the Go
  // compact-marshaling the docs describe. Key order is preserved from
  // the object's literal-declaration order, so callers must build the
  // params object with fields in the documented order.
  const json = JSON.stringify(action);
  return keccak256(toBytes(json));
}

/**
 * Sign a SoDEX action via the master wallet (MetaMask / Rabby / etc).
 * Used for addAPIKey and revokeAPIKey.
 *
 * IMPORTANT: we deliberately bypass viem ENTIRELY and call
 * `eth_signTypedData_v4` straight on the EIP-1193 provider. Reasons:
 *
 *   1. viem's `signTypedData` action refuses if the typed-data
 *      domain's chainId doesn't match the wallet's connected chain
 *      ("chainId should be same as current chainId"). EIP-712 has
 *      no such restriction — the chainId is just a field in the
 *      signed payload, not a transport-level requirement.
 *
 *   2. Even calling `walletClient.request` from viem appears to run
 *      the same validation on known JSON-RPC methods. The only way
 *      around is to grab the underlying provider (via the wagmi
 *      connector's `getProvider()`) and call `.request` on it.
 *
 * SoDEX's gateway then verifies the signature against the chainId
 * inside the payload, completely independent of which network the
 * user's wallet was on at signing time.
 */
/**
 * Resolve the rawest possible EIP-1193 provider — prefer
 * window.ethereum because wagmi's connector may return a viem-
 * wrapped provider whose `.request` still goes through chainId
 * validation middleware.
 */
function resolveProvider(opts: {
  provider?: Eip1193Provider;
}): Eip1193Provider {
  type WindowEthereum = Eip1193Provider & { isMetaMask?: boolean };
  const win =
    typeof window !== "undefined"
      ? (window as unknown as { ethereum?: WindowEthereum })
      : undefined;
  const provider = win?.ethereum ?? opts.provider;
  if (!provider) {
    throw new Error(
      "No wallet provider available (window.ethereum missing). Install MetaMask, Rabby, or another EIP-1193 wallet.",
    );
  }
  return provider;
}

/**
 * Sign a SoDEX `addAPIKey` request.
 *
 * IMPORTANT — this is a different scheme than the order/cancel
 * signing path (`signMasterExchangeAction` below). SoDEX models
 * `addAPIKey` as a "UserSignedAddAPIKeyAction" inside the
 * `universal` EIP-712 domain (what their docs call EIP712_UNIVERSAL).
 *
 * Critically: the domain chainId is the WALLET'S currently-connected
 * chain, NOT SoDEX's chainId. The SoDEX chainID lives as a separate
 * field inside the signed message. This is the trick that lets
 * Rabby/Phantom/etc. sign without a "chainId mismatch" refusal —
 * the typed data's domain matches the wallet exactly.
 *
 * Schema reverse-engineered from testnet.sodex.com's bundle:
 *   primaryType: "UserSignedAddAPIKeyAction"
 *   types.UserSignedAddAPIKeyAction = [
 *     {name:"chainID",   type:"uint64"},
 *     {name:"nonce",     type:"uint64"},
 *     {name:"accountID", type:"uint64"},
 *     {name:"name",      type:"string"},
 *     {name:"keyType",   type:"uint8"},
 *     {name:"publicKey", type:"bytes"},
 *     {name:"expiresAt", type:"uint64"},
 *   ]
 *   domain.name = "universal"
 *   domain.chainId = wallet's current chainId
 */
export async function signAddAPIKeyAction(opts: {
  provider?: Eip1193Provider;
  account: `0x${string}`;
  /** SoDEX chain ID this key will be valid on (286623 / 138565). */
  sodexChainId: number;
  accountID: number;
  name: string;
  /** 1 for EVM. */
  keyType: number;
  /** API key's public address (it's signed as `bytes`). */
  publicKey: `0x${string}`;
  /** Unix-millis expiry; 0 means never. */
  expiresAt: number;
  nonce?: bigint;
}): Promise<{ apiSign: Hex; nonce: bigint; walletChainId: number }> {
  const provider = resolveProvider({ provider: opts.provider });
  const nonce = opts.nonce ?? BigInt(Date.now());

  // Use the wallet's CURRENT chain in the typed-data domain. Required
  // so the wallet doesn't reject with "chainId mismatch".
  const walletChainHex = (await provider.request({
    method: "eth_chainId",
    params: [],
  })) as string;
  const walletChainId = parseInt(walletChainHex, 16);

  const message = {
    chainID: opts.sodexChainId.toString(),
    nonce: nonce.toString(),
    accountID: opts.accountID.toString(),
    name: opts.name,
    keyType: opts.keyType,
    publicKey: opts.publicKey,
    expiresAt: opts.expiresAt.toString(),
  };

  const typedData = {
    domain: {
      name: "universal",
      version: "1",
      chainId: walletChainId,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      UserSignedAddAPIKeyAction: [
        { name: "chainID", type: "uint64" },
        { name: "nonce", type: "uint64" },
        { name: "accountID", type: "uint64" },
        { name: "name", type: "string" },
        { name: "keyType", type: "uint8" },
        { name: "publicKey", type: "bytes" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "UserSignedAddAPIKeyAction",
    message,
  };

  let signature: Hex;
  try {
    signature = (await provider.request({
      method: "eth_signTypedData_v4",
      params: [opts.account, JSON.stringify(typedData)],
    })) as Hex;
  } catch (err) {
    const m = (err as Error).message ?? String(err);
    throw new Error(
      `[universal] eth_signTypedData_v4 failed: ${m.slice(0, 300)}`,
    );
  }

  // The 0x01 prefix IS required for X-API-Sign (per docs + the
  // "X-API-Sign is invalid" gateway error without it). But before
  // prefixing, normalize the v byte: some wallets (Rabby/MetaMask
  // in some configs) return v ∈ {0, 1} (EIP-1559 compact form),
  // SoDEX's ecrecover wants the legacy v ∈ {27, 28}. That mismatch
  // was the "bad recovery id" we saw earlier.
  const apiSign = ("0x01" + normalizeVByte(signature).slice(2)) as Hex;
  return { apiSign, nonce, walletChainId };
}

/**
 * Normalize the v (recovery id) byte at the end of an ECDSA
 * signature. If the wallet returned v ∈ {0, 1}, add 27 to convert
 * to the legacy {27, 28} form some chains/services require.
 *
 * Input:  0x{r:64hex}{s:64hex}{v:2hex}   (130 hex chars after 0x)
 * Output: same length, only v adjusted.
 */
function normalizeVByte(sig: Hex): Hex {
  if (sig.length !== 132) return sig; // not a 65-byte sig — leave alone
  const vHex = sig.slice(130);
  const v = parseInt(vHex, 16);
  if (v === 0 || v === 1) {
    const normalized = (v + 27).toString(16).padStart(2, "0");
    return (sig.slice(0, 130) + normalized) as Hex;
  }
  return sig;
}

/**
 * (Retained for reference) — the ExchangeAction signing path used by
 * trade orders / cancels. Not called by addAPIKey anymore.
 */
export async function signWithMasterWallet(opts: {
  provider?: Eip1193Provider;
  account: `0x${string}`;
  domainName: SodexDomainName;
  chainId: number;
  action: SodexAction;
  nonce?: bigint;
}): Promise<{ apiSign: Hex; nonce: bigint }> {
  const provider = resolveProvider({ provider: opts.provider });
  const nonce = opts.nonce ?? BigInt(Date.now());
  const payloadHash = hashAction(opts.action);

  const typedData = {
    domain: buildExchangeDomain(opts.domainName, opts.chainId),
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ExchangeAction: [
        { name: "payloadHash", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "ExchangeAction",
    message: { payloadHash, nonce: nonce.toString() },
  };

  const signature = (await provider.request({
    method: "eth_signTypedData_v4",
    params: [opts.account, JSON.stringify(typedData)],
  })) as Hex;

  const apiSign = ("0x01" + signature.slice(2)) as Hex;
  return { apiSign, nonce };
}

/**
 * Sign with an API key (raw secp256k1 private key held in browser
 * localStorage). Used for all trading actions: newOrder, cancelOrder,
 * transferAsset, etc.
 */
export async function signWithApiKey(opts: {
  privateKey: Hex;
  domainName: SodexDomainName;
  chainId: number;
  action: SodexAction;
  nonce?: bigint;
}): Promise<{ apiSign: Hex; nonce: bigint }> {
  const nonce = opts.nonce ?? BigInt(Date.now());
  const account = privateKeyToAccount(opts.privateKey);
  const payloadHash = hashAction(opts.action);

  const signature = await account.signTypedData({
    domain: buildExchangeDomain(opts.domainName, opts.chainId),
    types: {
      ExchangeAction: [
        { name: "payloadHash", type: "bytes32" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "ExchangeAction",
    message: { payloadHash, nonce },
  });

  const apiSign = ("0x01" + signature.slice(2)) as Hex;
  return { apiSign, nonce };
}

/** Avoid an unused-import lint complaint for `toHex`. */
void toHex;
