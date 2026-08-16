import bcrypt from "bcryptjs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Store } from "./store.js";
import type { Batch, BotPause, ShippingJob, SupportConversation, SupportOverview, SupportTicket, SupportTicketStatus, UserRecord, WhatsAppMessage } from "./types.js";

class MemoryStore implements Store {
  private users: UserRecord[] = [];
  private history: Batch[] = [];
  private cache = new Map<string, string>();
  private jobs = new Map<string, ShippingJob>();
  private messages: WhatsAppMessage[] = [];
  private conversations = new Map<string, SupportConversation>();
  private tickets = new Map<string, SupportTicket>();
  private botPauses = new Map<string, BotPause>();
  async init() { this.users = [{ id: 1, username: "admin", passwordHash: await bcrypt.hash("admin123", 4), role: "admin" }]; }
  async findUser(username: string) { return this.users.find((user) => user.username.toLowerCase() === username.toLowerCase()); }
  async createUser(username: string, passwordHash: string, role: UserRecord["role"]) {
    if (await this.findUser(username)) return undefined;
    const user = { id: this.users.length + 1, username, passwordHash, role }; this.users.push(user); return user;
  }
  async getOrderId(orderNumber: string) { return this.cache.get(orderNumber); }
  async cacheOrder(orderNumber: string, orderId: string) { this.cache.set(orderNumber, orderId); }
  async addBatch(batch: Batch) { this.history.unshift(batch); }
  async getHistory() { return this.history; }
  async createShippingJob(job: ShippingJob) { if ([...this.jobs.values()].some((item) => item.createdBy.toLowerCase() === job.createdBy.toLowerCase() && ["queued", "processing"].includes(item.status))) return false; this.jobs.set(job.jobId, structuredClone(job)); return true; }
  async claimShippingJob(jobId: string) { const job = this.jobs.get(jobId); return job && ["queued", "processing"].includes(job.status) ? structuredClone(job) : undefined; }
  async updateShippingJob(job: ShippingJob) { this.jobs.set(job.jobId, structuredClone(job)); }
  async getShippingJob(jobId: string) { const job = this.jobs.get(jobId); return job ? structuredClone(job) : undefined; }
  async getActiveShippingJob(username: string) { const job = [...this.jobs.values()].find((item) => item.createdBy.toLowerCase() === username.toLowerCase() && ["queued", "processing"].includes(item.status)); return job ? structuredClone(job) : undefined; }
  async getPendingShippingJobs() { return [...this.jobs.values()].filter((job) => ["queued", "processing"].includes(job.status)).map((job) => structuredClone(job)); }
  async withConversationLock<T>(_phone: string, task: () => Promise<T>) { return task(); }
  async addWhatsAppMessage(message: Omit<WhatsAppMessage, "id" | "createdAt">) { if (message.providerMessageId && this.messages.some((item) => item.providerMessageId === message.providerMessageId)) return false; this.messages.unshift({ ...message, id: String(this.messages.length + 1), createdAt: new Date().toISOString() }); return true; }
  async getConversation(phone: string) { const conversation = this.conversations.get(phone); return conversation ? structuredClone(conversation) : undefined; }
  async saveConversation(conversation: Omit<SupportConversation, "updatedAt" | "expiresAt">) { const now = new Date(); this.conversations.set(conversation.phone, { ...structuredClone(conversation), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString() }); }
  async clearConversation(phone: string) { this.conversations.delete(phone); }
  async isBotPaused(phone: string) { return this.botPauses.has(phone); }
  async setBotPaused(phone: string, paused: boolean, reason: BotPause["reason"] = "manual") { if (!paused) { this.botPauses.delete(phone); return; } const now = new Date(); this.botPauses.set(phone, { phone, reason, pausedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString() }); this.conversations.delete(phone); }
  async isRecentBotMessage(phone: string, text: string) { return this.messages.some((message) => message.phone === phone && message.direction === "outbound" && message.source !== "agent" && message.text === text); }
  async createSupportTicket(ticket: SupportTicket) { this.tickets.set(ticket.ticketId, structuredClone(ticket)); }
  async updateSupportTicket(ticketId: string, status: SupportTicketStatus) { const ticket = this.tickets.get(ticketId); if (!ticket) return false; ticket.status = status; ticket.resolvedAt = status === "resolved" ? new Date().toISOString() : undefined; return true; }
  async getSupportOverview(): Promise<SupportOverview> { return { messages: structuredClone(this.messages), tickets: structuredClone([...this.tickets.values()]), conversations: structuredClone([...this.conversations.values()]), botPauses: structuredClone([...this.botPauses.values()]), stats: { inboundToday: this.messages.filter((message) => message.direction === "inbound").length, outboundToday: this.messages.filter((message) => message.direction === "outbound").length, activeConversations: this.conversations.size, openTickets: [...this.tickets.values()].filter((ticket) => ticket.status === "open").length } }; }
}

const config = {
  jwtSecret: "test-secret-that-is-long-enough-for-tests",
  clientOrigin: "http://localhost:5173",
  databaseUrl: "postgresql://unused-in-unit-tests",
  databaseSsl: false,
  mockMode: true,
  nimbusApiUrl: "https://api-v2.nimbuspost.com",
  nimbusApiKey: "",
  nimbusApiSecret: "",
  maxLookupPages: 2,
  whatsappProvider: "disabled" as const,
  whatsappVerifyToken: "test-verify-token",
  supportPhone: "919876543210",
};
const makeApp = () => createApp(config, new MemoryStore());
async function login(app: Awaited<ReturnType<typeof makeApp>>) { const response = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" }); return response.body.token as string; }
async function waitForJob(app: Awaited<ReturnType<typeof makeApp>>, token: string, jobId: string) { for (let attempt = 0; attempt < 30; attempt++) { const response = await request(app).get(`/api/shipping-jobs/${jobId}`).set("Authorization", `Bearer ${token}`); if (["completed", "failed"].includes(response.body.job.status)) return response.body.job as ShippingJob; await new Promise((resolve) => setTimeout(resolve, 30)); } throw new Error("Job did not finish in time"); }

describe("AutoShip API", () => {
  it("authenticates the seeded demo admin", async () => { const app = await makeApp(); const response = await request(app).post("/api/auth/login").send({ username: "admin", password: "admin123" }); expect(response.status).toBe(200); expect(response.body.user.role).toBe("admin"); expect(response.body.token).toBeTruthy(); });
  it("creates only non-admin accounts and signs them in", async () => { const app = await makeApp(); const response = await request(app).post("/api/auth/register").send({ username: "new.packer", password: "a secure passphrase", role: "admin" }); expect(response.status).toBe(201); expect(response.body.user).toEqual({ username: "new.packer", role: "packer" }); expect(response.body.token).toBeTruthy(); const history = await request(app).get("/api/history").set("Authorization", `Bearer ${response.body.token}`); expect(history.status).toBe(200); const settings = await request(app).get("/api/settings/status").set("Authorization", `Bearer ${response.body.token}`); expect(settings.status).toBe(403); const loginResponse = await request(app).post("/api/auth/login").send({ username: "NEW.PACKER", password: "a secure passphrase" }); expect(loginResponse.status).toBe(200); expect(loginResponse.body.user.role).toBe("packer"); });
  it("rejects invalid and duplicate registrations", async () => { const app = await makeApp(); const weak = await request(app).post("/api/auth/register").send({ username: "ok-user", password: "too-short" }); expect(weak.status).toBe(400); const first = await request(app).post("/api/auth/register").send({ username: "ok-user", password: "a secure passphrase" }); expect(first.status).toBe(201); const duplicate = await request(app).post("/api/auth/register").send({ username: "OK-USER", password: "another secure passphrase" }); expect(duplicate.status).toBe(400); });
  it("rejects an invalid order batch", async () => { const app = await makeApp(); const token = await login(app); const response = await request(app).post("/api/ship-bulk").set("Authorization", `Bearer ${token}`).send({ orderNumbers: ["NOT-AN-ORDER"] }); expect(response.status).toBe(400); });
  it("ships a partial batch, stores its history, and regenerates labels on demand", async () => { const app = await makeApp(); const token = await login(app); const shipped = await request(app).post("/api/ship-bulk").set("Authorization", `Bearer ${token}`).send({ orderNumbers: ["RBD4023", "RBD4030", "RBD4035", "RBD4044"] }); expect(shipped.status).toBe(200); expect(shipped.body.totalShipped).toBe(2); expect(shipped.body.totalFailed).toBe(2); expect(shipped.body.shipped[1].alreadyBooked).toBe(true); expect(shipped.body.labelUrl).toContain("/demo-labels"); const history = await request(app).get("/api/history").set("Authorization", `Bearer ${token}`); expect(history.body.batches).toHaveLength(1); expect(history.body.batches[0].batchId).toBe(shipped.body.batchId); const freshLabel = await request(app).post(`/api/history/${shipped.body.batchId}/label`).set("Authorization", `Bearer ${token}`); expect(freshLabel.status).toBe(200); expect(freshLabel.body.labelUrl).toContain("/demo-labels"); });
  it("runs a persistent job with progress logs and prevents a second active job", async () => { const app = await makeApp(); const token = await login(app); const started = await request(app).post("/api/shipping-jobs").set("Authorization", `Bearer ${token}`).send({ orderNumbers: ["RBD4023", "#RBD4030", "RBD4035", "#RBD4044"] }); expect(started.status).toBe(202); expect(started.body.job.orderNumbers[0]).toBe("#RBD4023"); const duplicate = await request(app).post("/api/shipping-jobs").set("Authorization", `Bearer ${token}`).send({ orderNumbers: ["RBD4050"] }); expect(duplicate.status).toBe(409); const job = await waitForJob(app, token, started.body.job.jobId); expect(job.status).toBe("completed"); expect(job.processed).toBe(4); expect(job.shipped).toHaveLength(2); expect(job.failed).toHaveLength(2); expect(job.logs.some((log) => log.level === "success")).toBe(true); expect(job.logs.some((log) => log.level === "error" && log.orderNumber === "#RBD4030")).toBe(true); expect(job.result?.totalFailed).toBe(2); });
  it("requires authentication for shipping", async () => { const app = await makeApp(); const response = await request(app).post("/api/ship-bulk").send({ orderNumbers: ["RBD4023"] }); expect(response.status).toBe(401); });
  it("verifies the WhatsApp webhook and persists one deduplicated conversation", async () => {
    const app = await makeApp();
    const challenge = await request(app).get("/api/whatsapp/webhook").query({ "hub.mode": "subscribe", "hub.verify_token": "test-verify-token", "hub.challenge": "challenge-123" });
    expect(challenge.status).toBe(200); expect(challenge.text).toBe("challenge-123");
    const payload = { id: "message-1", from: "919876543210", text: "hello ji" };
    expect((await request(app).post("/api/whatsapp/webhook").send(payload)).status).toBe(200);
    expect((await request(app).post("/api/whatsapp/webhook").send(payload)).status).toBe(200);
    const token = await login(app);
    let overview: SupportOverview | undefined;
    for (let attempt = 0; attempt < 20; attempt++) { overview = (await request(app).get("/api/support/overview").set("Authorization", `Bearer ${token}`)).body; if (overview?.stats.outboundToday) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    expect(overview?.stats.inboundToday).toBe(1); expect(overview?.stats.outboundToday).toBe(1); expect(overview?.conversations[0].step).toBe("waiting_menu");
  });
  it("asks for a refund/return/missing subtype before collecting an order", async () => {
    const app = await makeApp(); const token = await login(app);
    expect((await request(app).post("/api/whatsapp/webhook").send({ id: "message-refund-menu", from: "919876543210", text: "6" })).status).toBe(200);
    const overview = await request(app).get("/api/support/overview").set("Authorization", `Bearer ${token}`);
    expect(overview.body.conversations).toEqual([expect.objectContaining({ phone: "919876543210", intent: "refund_return", step: "waiting_issue" })]);
  });
  it("restricts the support dashboard and ticket updates to admins", async () => {
    const app = await makeApp();
    const registration = await request(app).post("/api/auth/register").send({ username: "support-packer", password: "a secure passphrase" });
    expect((await request(app).get("/api/support/overview").set("Authorization", `Bearer ${registration.body.token}`)).status).toBe(403);
    const token = await login(app);
    const missing = await request(app).patch("/api/support/tickets/00000000-0000-0000-0000-000000000000").set("Authorization", `Bearer ${token}`).send({ status: "resolved" });
    expect(missing.status).toBe(404);
    const invalid = await request(app).patch("/api/support/tickets/invalid").set("Authorization", `Bearer ${token}`).send({ status: "closed" });
    expect(invalid.status).toBe(400);
  });
  it("lets an admin pause and resume bot replies for a customer", async () => {
    const app = await makeApp(); const token = await login(app); const phone = "919876543210";
    const paused = await request(app).patch(`/api/support/bot-pauses/${phone}`).set("Authorization", `Bearer ${token}`).send({ paused: true });
    expect(paused.status).toBe(200);
    await request(app).post("/api/whatsapp/webhook").send({ id: "paused-customer-message", from: phone, text: "hello while agent is talking" });
    const overview = await request(app).get("/api/support/overview").set("Authorization", `Bearer ${token}`);
    expect(overview.body.botPauses).toEqual([expect.objectContaining({ phone })]);
    expect(overview.body.messages.filter((message: WhatsAppMessage) => message.providerMessageId === "paused-customer-message")).toHaveLength(1);
    expect(overview.body.messages.some((message: WhatsAppMessage) => message.direction === "outbound")).toBe(false);
    const resumed = await request(app).patch(`/api/support/bot-pauses/${phone}`).set("Authorization", `Bearer ${token}`).send({ paused: false });
    expect(resumed.status).toBe(200);
  });
});
