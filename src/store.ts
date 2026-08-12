import bcrypt from "bcryptjs";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getPrisma } from "./db.js";
import type { Batch, Role, ShippingJob, UserRecord } from "./types.js";

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
}

const asJson = (value: Batch | ShippingJob) => value as unknown as Prisma.InputJsonValue;
const isUniqueConstraintError = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");

export class PrismaStore implements Store {
  private readonly prisma: PrismaClient;

  constructor(databaseUrl: string, ssl: boolean, private readonly demoMode: boolean, private readonly initialPassword?: string) {
    this.prisma = getPrisma(databaseUrl, ssl);
  }

  async init() {
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
    return rows.map(({ payload }) => payload as unknown as ShippingJob);
  }
}
