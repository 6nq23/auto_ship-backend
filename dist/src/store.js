import bcrypt from "bcryptjs";
import { getPrisma } from "./db.js";
const asJson = (value) => value;
const isUniqueConstraintError = (error) => Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
export class PrismaStore {
    demoMode;
    initialPassword;
    prisma;
    constructor(databaseUrl, ssl, demoMode, initialPassword) {
        this.demoMode = demoMode;
        this.initialPassword = initialPassword;
        this.prisma = getPrisma(databaseUrl, ssl);
    }
    async init() {
        if (await this.prisma.user.count() > 0)
            return;
        const password = this.initialPassword || (this.demoMode ? "admin123" : "");
        if (!password)
            throw new Error("INITIAL_ADMIN_PASSWORD is required for first production startup");
        await this.prisma.user.upsert({
            where: { usernameNormalized: "admin" },
            update: {},
            create: { username: "admin", usernameNormalized: "admin", passwordHash: await bcrypt.hash(password, 12), role: "admin" },
        });
    }
    async findUser(username) {
        const user = await this.prisma.user.findUnique({ where: { usernameNormalized: username.toLowerCase() } });
        return user ? { id: user.id, username: user.username, passwordHash: user.passwordHash, role: user.role } : undefined;
    }
    async createUser(username, passwordHash, role) {
        try {
            const user = await this.prisma.user.create({ data: { username, usernameNormalized: username.toLowerCase(), passwordHash, role } });
            return { id: user.id, username: user.username, passwordHash: user.passwordHash, role: user.role };
        }
        catch (error) {
            if (isUniqueConstraintError(error))
                return undefined;
            throw error;
        }
    }
    async getOrderId(orderNumber) {
        return (await this.prisma.orderCache.findUnique({ where: { orderNumber }, select: { orderId: true } }))?.orderId;
    }
    async cacheOrder(orderNumber, orderId) {
        await this.prisma.orderCache.upsert({ where: { orderNumber }, update: { orderId }, create: { orderNumber, orderId } });
    }
    async addBatch(batch) {
        await this.prisma.shippingBatch.upsert({
            where: { batchId: batch.batchId },
            update: {},
            create: { batchId: batch.batchId, createdAt: new Date(batch.createdAt), shippedBy: batch.shippedBy, payload: asJson(batch) },
        });
    }
    async getHistory() {
        const rows = await this.prisma.shippingBatch.findMany({ orderBy: { createdAt: "desc" }, select: { payload: true } });
        return rows.map(({ payload }) => payload);
    }
    async createShippingJob(job) {
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
        }
        catch (error) {
            if (isUniqueConstraintError(error))
                return false;
            throw error;
        }
    }
    async updateShippingJob(job) {
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
    async claimShippingJob(jobId) {
        const now = new Date();
        const claimed = await this.prisma.shippingJob.updateMany({
            where: {
                jobId,
                status: { in: ["queued", "processing"] },
                OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
            },
            data: { leaseUntil: new Date(now.getTime() + 6 * 60_000) },
        });
        if (claimed.count !== 1)
            return undefined;
        return this.getShippingJob(jobId);
    }
    async getShippingJob(jobId) {
        const row = await this.prisma.shippingJob.findUnique({ where: { jobId }, select: { payload: true } });
        return row?.payload;
    }
    async getActiveShippingJob(username) {
        const row = await this.prisma.shippingJob.findUnique({ where: { activeOwnerKey: username.toLowerCase() }, select: { payload: true } });
        return row?.payload;
    }
    async getPendingShippingJobs() {
        const rows = await this.prisma.shippingJob.findMany({
            where: { status: { in: ["queued", "processing"] } },
            orderBy: { createdAt: "asc" },
            select: { payload: true },
        });
        return rows.map(({ payload }) => payload);
    }
}
