import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TeeError } from '../common/tee-error';
import { invalidBodyMessage } from '../common/invalid-body';
import { CurrentSession, CurrentTokenTenant, WorkspaceGuard } from '../auth/workspace.guard';
import { RequireScopes, ScopesGuard } from '../auth/scopes.guard';
import { SLUG_RE, type Tenant } from '../config/schemas';
import { assertValidAccountSlug } from './account-slug';
import { AccountsService } from './accounts.service';
import { SessionRegistry, type Session } from './session.registry';
import { WalletTagsService } from './wallet-tags.service';
import { parseWalletId } from './wallet-id';
import {
  accountView,
  addressView,
  walletView,
  type AccountView,
  type AddressView,
  type WalletView,
} from './views';

const CreateAccount = z.object({
  // Core-compatible normalization/bounds run in AccountsService so direct
  // service callers cannot bypass them and known failures precede quota work.
  displayName: z.string(),
  kind: z.enum(['HD', 'PK']).default('HD'),
  /** Mnemonic for HD (generated when absent), private key for PK. */
  secret: z.string().min(1).optional(),
  // Same grammar as the ?network= selector; it flows straight into core.
  defaultNetwork: z.string().regex(SLUG_RE).optional(),
  /** DESIGN §3's Cold Vault tier: the account locks separately from the session. */
  hasOwnPassword: z.boolean().optional(),
  /** Required when hasOwnPassword is set; otherwise the flag grants nothing. */
  accountPassword: z.string().min(1).max(256).optional(),
}).strict();

const DeriveWallets = z.object({ count: z.number().int().positive().max(500) }).strict();
const ImportKey = z.object({ privateKey: z.string().min(1) }).strict();
const SetTags = z.object({ tags: z.array(z.string()).max(32) }).strict();

@Controller('accounts')
@UseGuards(WorkspaceGuard, ScopesGuard)
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly sessions: SessionRegistry,
    private readonly walletTags: WalletTagsService,
  ) {}

  @Post()
  @HttpCode(201)
  @RequireScopes('write')
  async create(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Body() body: unknown,
  ): Promise<{ account: AccountView; generatedSecret: boolean }> {
    const parsed = CreateAccount.safeParse(body);
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage(
          'body must be { displayName, kind?, secret?, defaultNetwork?, hasOwnPassword?, accountPassword? }',
          parsed.error,
          body,
        ),
      );
    }

    const account = await this.accounts.create(session, tenant, parsed.data);
    return {
      account: accountView(account),
      // The mnemonic is NOT returned. A generated secret leaves only through
      // the sealed export path, never in a plain response body.
      generatedSecret: parsed.data.secret === undefined,
    };
  }

  @Delete(':slug')
  @HttpCode(204)
  @RequireScopes('write')
  async drop(@CurrentSession() session: Session, @Param('slug') slug: string): Promise<void> {
    await this.accounts.drop(session, assertValidAccountSlug(slug));
  }

  @Post(':slug/wallets')
  @HttpCode(201)
  @RequireScopes('write')
  async derive(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<{ before: number; after: number }> {
    const parsed = DeriveWallets.safeParse(body);
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage('body must be { count }', parsed.error, body),
      );
    }
    return this.accounts.deriveWallets(
      session,
      tenant,
      assertValidAccountSlug(slug),
      parsed.data.count,
    );
  }

  @Post(':slug/wallets/import')
  @HttpCode(201)
  @RequireScopes('write')
  async importKey(
    @CurrentSession() session: Session,
    @CurrentTokenTenant() tenant: Tenant,
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<{ wallet: WalletView }> {
    const parsed = ImportKey.safeParse(body);
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage('body must be { privateKey }', parsed.error, body),
      );
    }
    const wallet = await this.accounts.importPrivateKey(
      session,
      tenant,
      assertValidAccountSlug(slug),
      parsed.data.privateKey,
    );
    return { wallet: walletView(wallet) };
  }

  @Get(':slug/wallets')
  @RequireScopes('read')
  async wallets(
    @CurrentSession() session: Session,
    @Param('slug') slug: string,
  ): Promise<{ wallets: WalletView[] }> {
    const account = await this.sessions.requireAccount(session, assertValidAccountSlug(slug));
    return { wallets: account.wallets.map(walletView) };
  }

  @Get(':slug/wallets/:id/addresses')
  @RequireScopes('read')
  async addresses(
    @CurrentSession() session: Session,
    @Param('slug') slug: string,
    @Param('id') id: string,
  ): Promise<{ addresses: AddressView[] }> {
    const walletId = parseWalletId(id);
    const account = await this.sessions.requireAccount(session, assertValidAccountSlug(slug));
    const wallet = account.wallets.byId(walletId);
    if (!wallet) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `wallet ${id} not found`);
    return { addresses: wallet.addresses.map(addressView) };
  }

  @Put(':slug/wallets/:id/tags')
  @RequireScopes('write')
  async setTags(
    @CurrentSession() session: Session,
    @Param('slug') slug: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ wallet: WalletView }> {
    const parsed = SetTags.safeParse(body);
    if (!parsed.success) {
      throw new TeeError(
        'TEE_INVALID_BODY',
        invalidBodyMessage('body must be { tags }', parsed.error, body),
      );
    }
    const walletId = parseWalletId(id);

    const account = await this.sessions.requireAccount(session, assertValidAccountSlug(slug));
    const wallet = account.wallets.byId(walletId);
    if (!wallet) throw new TeeError('TEE_ACCOUNT_NOT_FOUND', `wallet ${id} not found`);

    await this.walletTags.replace(session, wallet, parsed.data.tags);
    return { wallet: walletView(wallet) };
  }
}
