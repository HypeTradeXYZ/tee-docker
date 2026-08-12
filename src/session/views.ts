import type { Account, Address, Wallet } from 'wative-core';

/**
 * Response shapes.
 *
 * Domain objects are never serialized directly — they carry `_ciphertext`,
 * `_dumpPrivateKey` and other internals that must never reach a response body.
 * Every field a client sees is listed here explicitly.
 */

export interface AddressView {
  publicKey: string;
  vm: string;
  network: string;
  chainId: number;
}

export interface WalletView {
  id: number;
  tags: readonly string[];
  addresses: AddressView[];
}

export interface AccountView {
  slug: string;
  displayName: string;
  kind: string;
  hasOwnPassword: boolean;
  locked: boolean;
  defaultNetwork: string;
  wallets: number;
}

export const addressView = (a: Address): AddressView => ({
  publicKey: String(a.publicKey),
  vm: a.vm,
  network: String(a.network.slug),
  chainId: Number(a.network.chainId),
});

export const walletView = (w: Wallet): WalletView => ({
  id: w.id,
  tags: w.tags,
  addresses: w.addresses.map(addressView),
});

export const accountView = (a: Account): AccountView => ({
  slug: String(a.slug),
  displayName: a.displayName,
  kind: a.organizationType,
  hasOwnPassword: a.hasOwnPassword,
  locked: a.locked,
  defaultNetwork: String(a.defaultNetwork),
  wallets: a.wallets.length,
});
