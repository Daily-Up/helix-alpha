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
export async function signWithMasterWallet(opts: {
  provider?: Eip1193Provider;
  account: `0x${string}`;
  domainName: SodexDomainName;
  chainId: number;
  action: SodexAction;
  nonce?: bigint;
}): Promise<{ apiSign: Hex; nonce: bigint }> {
  const nonce = opts.nonce ?? BigInt(Date.now());
  const payloadHash = hashAction(opts.action);

  // Resolve the lowest-level provider available. Priority:
  //   1. Caller-supplied provider (from wagmi connector.getProvider())
  //   2. window.ethereum (the wallet extension's own injected provider)
  // We deliberately go around viem's WalletClient AND wagmi's
  // wrappers — both add a chainId-match validator that doesn't apply
  // to plain message signing.
  type WindowEthereum = Eip1193Provider & {
    isMetaMask?: boolean;
    isRabby?: boolean;
  };
  const win = (typeof window !== "undefined"
    ? (window as unknown as { ethereum?: WindowEthereum })
    : undefined);
  const provider: Eip1193Provider | undefined =
    opts.provider ?? win?.ethereum;
  if (!provider) {
    throw new Error(
      "No wallet provider available (window.ethereum missing). Install MetaMask or Rabby.",
    );
  }

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
    message: {
      payloadHash,
      // uint64 over JSON-RPC takes a string — bigints aren't JSON.
      nonce: nonce.toString(),
    },
  };

  // SIGNING_PATH_RAW_PROVIDER_2026_06_02 — marker so we can see in
  // chunk diffs whether this exact code reached production.
  let signature: Hex;
  try {
    signature = (await provider.request({
      method: "eth_signTypedData_v4",
      params: [opts.account, JSON.stringify(typedData)],
    })) as Hex;
  } catch (err) {
    const m = (err as Error).message ?? String(err);
    throw new Error(
      `[raw-provider] eth_signTypedData_v4 failed: ${m.slice(0, 300)}`,
    );
  }

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
