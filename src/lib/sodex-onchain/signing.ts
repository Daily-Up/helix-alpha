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
  type WalletClient,
  type Account,
  type TypedDataDomain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SodexAction } from "./types";

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
 * Sign a SoDEX action via the master wallet (MetaMask / wagmi). Used
 * for addAPIKey and revokeAPIKey.
 *
 * Returns the X-API-Sign value (already 0x01-prefixed) plus the
 * nonce used.
 */
export async function signWithMasterWallet(opts: {
  walletClient: WalletClient;
  account: Account | `0x${string}`;
  domainName: SodexDomainName;
  chainId: number;
  action: SodexAction;
  nonce?: bigint;
}): Promise<{ apiSign: Hex; nonce: bigint }> {
  const nonce = opts.nonce ?? BigInt(Date.now());
  const payloadHash = hashAction(opts.action);

  const signature = await opts.walletClient.signTypedData({
    account: opts.account,
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

  // X-API-Sign = 0x01 || rawSig
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
