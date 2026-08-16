import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrisma } from "./db.js";
import type { Batch, BotPause, Role, ShippingJob, SupportConversation, SupportIntent, SupportOverview, SupportTicket, SupportTicketStatus, UserRecord, WhatsAppMessage } from "./types.js";

export interface Store {
  init(): Promise<void>;
  findUser(username: string): Promise<UserRecord | undefined>;
  createUser(username: string, passwordHash: string, role: Role): Promise<UserRecord | undefined>;
  getOrderId(orderNumber: string): Promise<string | undefined>;
  cacheOrder(orderNumber: string, orderId: string): Promise<void>;
  addBatch(batch: Batch): Promise<void>;
  getHistory(): Promise<Batch[]>;
  createShippingJob(job: ShippingJob): Promise<boolean>;
  claimShippingJob(jobId: string): Promise<ShippingJob | undefined>;
  updateShippingJob(job: ShippingJob): Promise<void>;
  getShippingJob(jobId: string): Promise<ShippingJob | undefined>;
  getActiveShippingJob(username: string): Promise<ShippingJob | undefined>;
  getPendingShippingJobs(): Promise<ShippingJob[]>;
  withConversationLock<T>(phone: string, task: () => Promise<T>): Promise<T>;
  addWhatsAppMessage(message: Omit<WhatsAppMessage, "id" | "createdAt">): Promise<boolean>;
  getConversation(phone: string): Promise<SupportConversation | undefined>;
  saveConversation(conversation: Omit<SupportConversation, "updatedAt" | "expiresAt">): Promise<void>;
  clearConversation(phone: string): Promise<void>;
  isBotPaused(phone: string): Promise<boolean>;
  setBotPaused(phone: string, paused: boolean, reason?: BotPause["reason"]): Promise<void>;
  isRecentBotMessage(phone: string, text: string): Promise<boolean>;
  createSupportTicket(ticket: SupportTicket): Promise<void>;
  updateSupportTicket(ticketId: string, status: SupportTicketStatus): Promise<boolean>;
  getSupportOverview(): Promise<SupportOverview>;
}

const asJson = (value: Batch | ShippingJob) => value as unknown as Prisma.InputJsonValue;
const isUniqueConstraintError = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");

export class PrismaStore implements Store {
  private readonly prisma: PrismaClient;

  constructor(databaseUrl: string, ssl: boolean, private readonly demoMode: boolean, private readonly initialPassword?: string) {
    this.prisma = getPrisma(databaseUrl, ssl);
  }

  async init() {
    // Older AutoShip installations created these columns as TEXT before the
    // project moved to Prisma enums. Align that schema in place without
    // deleting existing users, jobs, or shipment history.
    await this.prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        CREATE TYPE public."Role" AS ENUM ('admin', 'packer');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      DO $$ BEGIN
        CREATE TYPE public."ShippingJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
      ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE public.shipping_jobs DROP CONSTRAINT IF EXISTS shipping_jobs_status_check;
      DROP INDEX IF EXISTS public.shipping_jobs_active_idx;
      DROP INDEX IF EXISTS public.shipping_jobs_one_active_per_user_idx;
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'role' AND data_type = 'text'
        ) THEN
          ALTER TABLE public.users
          ALTER COLUMN role TYPE public."Role" USING role::text::public."Role";
        END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'shipping_jobs' AND column_name = 'status' AND data_type = 'text'
        ) THEN
          ALTER TABLE public.shipping_jobs
          ALTER COLUMN status TYPE public."ShippingJobStatus" USING status::text::public."ShippingJobStatus";
        END IF;
      END $$;
      ALTER TABLE public.shipping_jobs ADD COLUMN IF NOT EXISTS active_owner_key TEXT;
      ALTER TABLE public.shipping_jobs ADD COLUMN IF NOT EXISTS lease_until TIMESTAMP(3);
      CREATE UNIQUE INDEX IF NOT EXISTS shipping_jobs_active_owner_key_key ON public.shipping_jobs (active_owner_key);
      CREATE INDEX IF NOT EXISTS shipping_jobs_created_by_updated_at_idx ON public.shipping_jobs (created_by, updated_at DESC);
      CREATE INDEX IF NOT EXISTS shipping_jobs_status_created_at_idx ON public.shipping_jobs (status, created_at);
    `);

    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS wa_messages (
        id BIGSERIAL PRIMARY KEY,
        phone TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        message_text TEXT NOT NULL,
        intent TEXT,
        order_number TEXT,
        provider_message_id TEXT,
        sender_type TEXT NOT NULL DEFAULT 'bot',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS sender_type TEXT NOT NULL DEFAULT 'bot';
      UPDATE wa_messages SET sender_type = 'customer' WHERE direction = 'inbound' AND sender_type = 'bot';
      CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_provider_id_idx ON wa_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS wa_messages_phone_idx ON wa_messages (phone, created_at DESC);
      CREATE INDEX IF NOT EXISTS wa_messages_created_at_idx ON wa_messages (created_at DESC);
      CREATE TABLE IF NOT EXISTS wa_conversations (
        phone TEXT PRIMARY KEY,
        intent TEXT,
        step TEXT NOT NULL,
        context JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wa_conversations_expires_idx ON wa_conversations (expires_at);
      CREATE TABLE IF NOT EXISTS wa_bot_pauses (
        phone TEXT PRIMARY KEY,
        reason TEXT NOT NULL CHECK (reason IN ('manual', 'agent_message')),
        paused_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wa_bot_pauses_expires_idx ON wa_bot_pauses (expires_at);
      CREATE TABLE IF NOT EXISTS support_tickets (
        ticket_id UUID PRIMARY KEY,
        phone TEXT NOT NULL,
        order_number TEXT,
        category TEXT NOT NULL CHECK (category IN ('refund', 'return', 'missing', 'other')),
        description TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS support_tickets_status_created_idx ON support_tickets (status, created_at DESC);
      UPDATE wa_conversations
      SET expires_at = updated_at + INTERVAL '24 hours'
      WHERE expires_at < updated_at + INTERVAL '24 hours';
    `);

    if (await this.prisma.user.count() > 0) return;

    const password = this.initialPassword || (this.demoMode ? "admin123" : "");
    if (!password) throw new Error("INITIAL_ADMIN_PASSWORD is required for first production startup");
    await this.prisma.user.upsert({
      where: { usernameNormalized: "admin" },
      update: {},
      create: { username: "admin", usernameNormalized: "admin", passwordHash: await bcrypt.hash(password, 12), role: "admin" },
    });
  }

  async findUser(username: string) {
    const user = await this.prisma.user.findUnique({ where: { usernameNormalized: username.toLowerCase() } });
    return user ? { id: user.id, username: user.username, passwordHash: user.passwordHash, role: user.role } : undefined;
  }

  async createUser(username: string, passwordHash: string, role: Role) {
    try {
      const user = await this.prisma.user.create({ data: { username, usernameNormalized: username.toLowerCase(), passwordHash, role } });
      return { id: user.id, username: user.username, passwordHash: user.passwordHash, role: user.role };
    } catch (error) {
      if (isUniqueConstraintError(error)) return undefined;
      throw error;
    }
  }

  async getOrderId(orderNumber: string) {
    return (await this.prisma.orderCache.findUnique({ where: { orderNumber }, select: { orderId: true } }))?.orderId;
  }

  async cacheOrder(orderNumber: string, orderId: string) {
    await this.prisma.orderCache.upsert({ where: { orderNumber }, update: { orderId }, create: { orderNumber, orderId } });
  }

  async addBatch(batch: Batch) {
    await this.prisma.shippingBatch.upsert({
      where: { batchId: batch.batchId },
      update: {},
      create: { batchId: batch.batchId, createdAt: new Date(batch.createdAt), shippedBy: batch.shippedBy, payload: asJson(batch) },
    });
  }

  async getHistory() {
    const rows = await this.prisma.shippingBatch.findMany({ orderBy: { createdAt: "desc" }, select: { payload: true } });
    return rows.map(({ payload }) => payload as unknown as Batch);
  }

  async createShippingJob(job: ShippingJob) {
    try {
      await this.prisma.shippingJob.create({
        data: {
          jobId: job.jobId,
          createdAt: new Date(job.createdAt),
          updatedAt: new Date(job.updatedAt),
          createdBy: job.createdBy,
          status: job.status,
          activeOwnerKey: job.createdBy.toLowerCase(),
          payload: asJson(job),
        },
      });
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  async updateShippingJob(job: ShippingJob) {
    await this.prisma.shippingJob.update({
      where: { jobId: job.jobId },
      data: {
        updatedAt: new Date(job.updatedAt),
        status: job.status,
        activeOwnerKey: job.status === "queued" || job.status === "processing" ? job.createdBy.toLowerCase() : null,
        payload: asJson(job),
      },
    });
  }

  async claimShippingJob(jobId: string) {
    const now = new Date();
    const claimed = await this.prisma.shippingJob.updateMany({
      where: {
        jobId,
        status: { in: ["queued", "processing"] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      data: { leaseUntil: new Date(now.getTime() + 6 * 60_000) },
    });
    if (claimed.count !== 1) return undefined;
    return this.getShippingJob(jobId);
  }

  async getShippingJob(jobId: string) {
    const row = await this.prisma.shippingJob.findUnique({ where: { jobId }, select: { payload: true } });
    return row?.payload as unknown as ShippingJob | undefined;
  }

  async getActiveShippingJob(username: string) {
    const row = await this.prisma.shippingJob.findUnique({ where: { activeOwnerKey: username.toLowerCase() }, select: { payload: true } });
    return row?.payload as unknown as ShippingJob | undefined;
  }

  async getPendingShippingJobs() {
    const rows = await this.prisma.shippingJob.findMany({
      where: { status: { in: ["queued", "processing"] } },
      orderBy: { createdAt: "asc" },
      select: { payload: true },
    });
    return rows.map(({ payload }: { payload: any }) => payload as unknown as ShippingJob);
  }
  async withConversationLock<T>(phone: string, task: () => Promise<T>) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", phone);
      return await task();
    });
  }

  async addWhatsAppMessage(message: Omit<WhatsAppMessage, "id" | "createdAt">) {
    const rowCount = await this.prisma.$executeRawUnsafe(
      `INSERT INTO wa_messages (phone, direction, message_text, intent, order_number, provider_message_id, sender_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING`,
      message.phone, message.direction, message.text, message.intent || null, message.orderNumber || null, message.providerMessageId || null, message.source || (message.direction === "inbound" ? "customer" : "bot"),
    );
    return rowCount === 1;
  }

  async getConversation(phone: string) {
    const rows = await this.prisma.$queryRawUnsafe<{ phone: string; intent: SupportIntent | null; step: SupportConversation["step"]; context: any; updated_at: Date; expires_at: Date }[]>(
      "SELECT phone, intent, step, context, updated_at, expires_at FROM wa_conversations WHERE phone = $1 AND expires_at > NOW()",
      phone,
    );
    const row = rows[0];
    return row ? { phone: row.phone, ...(row.intent ? { intent: row.intent } : {}), step: row.step, context: typeof row.context === "string" ? JSON.parse(row.context) : row.context, updatedAt: row.updated_at.toISOString(), expiresAt: row.expires_at.toISOString() } : undefined;
  }

  async saveConversation(conversation: Omit<SupportConversation, "updatedAt" | "expiresAt">) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO wa_conversations (phone, intent, step, context, updated_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW() + INTERVAL '24 hours')
       ON CONFLICT (phone) DO UPDATE SET intent = EXCLUDED.intent, step = EXCLUDED.step, context = EXCLUDED.context, updated_at = NOW(), expires_at = NOW() + INTERVAL '24 hours'`,
      conversation.phone, conversation.intent || null, conversation.step, JSON.stringify(conversation.context),
    );
  }

  async clearConversation(phone: string) {
    await this.prisma.$executeRawUnsafe("DELETE FROM wa_conversations WHERE phone = $1", phone);
  }

  async isBotPaused(phone: string) {
    const rows = await this.prisma.$queryRawUnsafe<{ paused: boolean }[]>(
      "SELECT EXISTS (SELECT 1 FROM wa_bot_pauses WHERE phone = $1 AND expires_at > NOW()) AS paused",
      phone,
    );
    return Boolean(rows[0]?.paused);
  }

  async setBotPaused(phone: string, paused: boolean, reason: BotPause["reason"] = "manual") {
    if (!paused) {
      await this.prisma.$executeRawUnsafe("DELETE FROM wa_bot_pauses WHERE phone = $1", phone);
      return;
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO wa_bot_pauses (phone, reason, paused_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + INTERVAL '24 hours')
       ON CONFLICT (phone) DO UPDATE SET reason = EXCLUDED.reason, paused_at = NOW(), expires_at = NOW() + INTERVAL '24 hours'`,
      phone, reason,
    );
    await this.clearConversation(phone);
  }

  async isRecentBotMessage(phone: string, text: string) {
    const rows = await this.prisma.$queryRawUnsafe<{ found: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM wa_messages
         WHERE phone = $1 AND direction = 'outbound' AND sender_type = 'bot'
           AND message_text = $2 AND created_at > NOW() - INTERVAL '5 minutes'
       ) AS found`,
      phone, text,
    );
    return Boolean(rows[0]?.found);
  }

  async createSupportTicket(ticket: SupportTicket) {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO support_tickets (ticket_id, phone, order_number, category, description, status, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (ticket_id) DO NOTHING`,
      ticket.ticketId, ticket.phone, ticket.orderNumber || null, ticket.category, ticket.description || null, ticket.status, ticket.createdAt, ticket.resolvedAt || null,
    );
  }

  async updateSupportTicket(ticketId: string, status: SupportTicketStatus) {
    const rowCount = await this.prisma.$executeRawUnsafe(
      "UPDATE support_tickets SET status = $2, resolved_at = CASE WHEN $2 = 'resolved' THEN NOW() ELSE NULL END WHERE ticket_id = $1",
      ticketId, status,
    );
    return rowCount === 1;
  }

  async getSupportOverview(): Promise<SupportOverview> {
    const [messageResult, ticketResult, conversationResult, pauseResult, statsResult] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ id: bigint; phone: string; direction: WhatsAppMessage["direction"]; message_text: string; intent: SupportIntent | null; order_number: string | null; provider_message_id: string | null; sender_type: WhatsAppMessage["source"]; created_at: Date }[]>(
        "SELECT id, phone, direction, message_text, intent, order_number, provider_message_id, sender_type, created_at FROM wa_messages ORDER BY created_at DESC LIMIT 200",
      ),
      this.prisma.$queryRawUnsafe<{ ticket_id: string; phone: string; order_number: string | null; category: SupportTicket["category"]; description: string | null; status: SupportTicketStatus; created_at: Date; resolved_at: Date | null }[]>(
        "SELECT ticket_id, phone, order_number, category, description, status, created_at, resolved_at FROM support_tickets ORDER BY created_at DESC LIMIT 100",
      ),
      this.prisma.$queryRawUnsafe<{ phone: string; intent: SupportIntent | null; step: SupportConversation["step"]; context: any; updated_at: Date; expires_at: Date }[]>(
        "SELECT phone, intent, step, context, updated_at, expires_at FROM wa_conversations WHERE expires_at > NOW() ORDER BY updated_at DESC LIMIT 100",
      ),
      this.prisma.$queryRawUnsafe<{ phone: string; reason: BotPause["reason"]; paused_at: Date; expires_at: Date }[]>(
        "SELECT phone, reason, paused_at, expires_at FROM wa_bot_pauses WHERE expires_at > NOW() ORDER BY paused_at DESC LIMIT 200",
      ),
      this.prisma.$queryRawUnsafe<{ inbound_today: number; outbound_today: number; active_conversations: number; open_tickets: number }[]>(
        `SELECT
          (SELECT COUNT(*)::int FROM wa_messages WHERE direction = 'inbound' AND created_at >= CURRENT_DATE) AS inbound_today,
          (SELECT COUNT(*)::int FROM wa_messages WHERE direction = 'outbound' AND created_at >= CURRENT_DATE) AS outbound_today,
          (SELECT COUNT(*)::int FROM wa_conversations WHERE expires_at > NOW()) AS active_conversations,
          (SELECT COUNT(*)::int FROM support_tickets WHERE status = 'open') AS open_tickets`,
      ),
    ]);
    const stats = statsResult[0];
    return {
      messages: messageResult.map((row: any) => ({ id: row.id.toString(), phone: row.phone, direction: row.direction, text: row.message_text, ...(row.intent ? { intent: row.intent } : {}), ...(row.order_number ? { orderNumber: row.order_number } : {}), ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}), ...(row.sender_type ? { source: row.sender_type } : {}), createdAt: row.created_at.toISOString() })),
      tickets: ticketResult.map((row: any) => ({ ticketId: row.ticket_id, phone: row.phone, ...(row.order_number ? { orderNumber: row.order_number } : {}), category: row.category, ...(row.description ? { description: row.description } : {}), status: row.status, createdAt: row.created_at.toISOString(), ...(row.resolved_at ? { resolvedAt: row.resolved_at.toISOString() } : {}) })),
      conversations: conversationResult.map((row: any) => ({ phone: row.phone, ...(row.intent ? { intent: row.intent } : {}), step: row.step, context: typeof row.context === "string" ? JSON.parse(row.context) : row.context, updatedAt: row.updated_at.toISOString(), expiresAt: row.expires_at.toISOString() })),
      botPauses: pauseResult.map((row) => ({ phone: row.phone, reason: row.reason, pausedAt: row.paused_at.toISOString(), expiresAt: row.expires_at.toISOString() })),
      stats: { inboundToday: stats.inbound_today, outboundToday: stats.outbound_today, activeConversations: stats.active_conversations, openTickets: stats.open_tickets },
    };
  }

  async close() { await this.prisma.$disconnect(); }

}
