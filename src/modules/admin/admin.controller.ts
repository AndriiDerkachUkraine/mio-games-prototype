import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { DomainError } from '../../common/domain-error';
import { CurrencyCode, Uuid } from '../../common/schemas';
import { validate } from '../../common/validation';
import { REDEMPTION_STATUSES } from '../../db/schema';
import { ManualReviewService } from '../redemption/manual-review.service';
import { RulesRepository } from '../rules/rules.repository';
import { RewardDescriptorSchema } from '../store/reward-descriptor';
import { StoreItemsRepository } from '../store/store-items.repository';
import { RewardSegmentsSchema } from '../wheel/reward-segments';
import { RewardTablesRepository } from '../wheel/reward-tables.repository';
import { AdminAuthGuard, AdminTenant } from './admin-auth.guard';

const PublishRewardTable = z.object({ segments: RewardSegmentsSchema });

const CreateStoreItem = z.object({
  sku: z.string().regex(/^[a-z0-9-]{1,64}$/, 'lowercase letters, digits and dashes'),
  name: z.string().min(1).max(128),
  priceCoins: z.number().int().positive(),
  reward: RewardDescriptorSchema,
});

const ToggleStoreItem = z.object({ active: z.boolean() });

const UpdateRule = z
  .object({
    currency: CurrencyCode.nullable(),
    minAmountMinor: z.number().int().nonnegative(),
    spinsGranted: z.number().int().min(1).max(100),
    active: z.boolean(),
  })
  .partial()
  .refine((changes) => Object.keys(changes).length > 0, 'nothing to change');

const ResolveReview = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ISSUED'),
    externalReference: z.string().min(1).max(128),
    note: z.string().min(1).max(500),
  }),
  z.object({ outcome: z.literal('REFUNDED'), note: z.string().min(1).max(500) }),
]);

const RedemptionStatusFilter = z.enum(REDEMPTION_STATUSES).default('MANUAL_REVIEW');

const notFound = (code: 'ITEM_NOT_FOUND' | 'RULE_NOT_FOUND') =>
  new DomainError(HttpStatus.NOT_FOUND, code, code === 'ITEM_NOT_FOUND' ? 'store item not found' : 'rule not found');

/** Operator configuration and back-office actions, always scoped to the tenant of the admin key. */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
export class AdminController {
  constructor(
    private readonly rewardTables: RewardTablesRepository,
    private readonly storeItems: StoreItemsRepository,
    private readonly rules: RulesRepository,
    private readonly reviews: ManualReviewService,
  ) {}

  @Get('reward-tables')
  async listRewardTables(@AdminTenant() tenantId: string) {
    return { versions: await this.rewardTables.list(tenantId) };
  }

  @Post('reward-tables')
  publishRewardTable(@AdminTenant() tenantId: string, @Body() body: unknown) {
    const { segments } = validate(PublishRewardTable, body);
    return this.rewardTables.publish(tenantId, segments, 'tenant-admin');
  }

  @Get('store-items')
  async listStoreItems(@AdminTenant() tenantId: string) {
    return { items: await this.storeItems.listAll(tenantId) };
  }

  @Post('store-items')
  createStoreItem(@AdminTenant() tenantId: string, @Body() body: unknown) {
    return this.storeItems.create(tenantId, validate(CreateStoreItem, body));
  }

  @Patch('store-items/:itemId')
  async toggleStoreItem(@AdminTenant() tenantId: string, @Param('itemId') itemId: string, @Body() body: unknown) {
    const { active } = validate(ToggleStoreItem, body);
    const item = Uuid.safeParse(itemId).success ? await this.storeItems.setActive(tenantId, itemId, active) : undefined;
    if (!item) throw notFound('ITEM_NOT_FOUND');
    return item;
  }

  @Get('rules')
  async listRules(@AdminTenant() tenantId: string) {
    return { rules: await this.rules.list(tenantId) };
  }

  @Patch('rules/:ruleId')
  async updateRule(@AdminTenant() tenantId: string, @Param('ruleId') ruleId: string, @Body() body: unknown) {
    const changes = validate(UpdateRule, body);
    const rule = Uuid.safeParse(ruleId).success ? await this.rules.update(tenantId, ruleId, changes) : undefined;
    if (!rule) throw notFound('RULE_NOT_FOUND');
    return rule;
  }

  @Get('redemptions')
  async listRedemptions(@AdminTenant() tenantId: string, @Query('status') status: unknown) {
    return { redemptions: await this.reviews.list(tenantId, validate(RedemptionStatusFilter, status)) };
  }

  @Post('redemptions/:redemptionId/resolve')
  @HttpCode(HttpStatus.OK)
  resolveReview(@AdminTenant() tenantId: string, @Param('redemptionId') redemptionId: string, @Body() body: unknown) {
    return this.reviews.resolve(tenantId, redemptionId, validate(ResolveReview, body));
  }
}
