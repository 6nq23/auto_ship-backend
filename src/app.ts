import path from "node:path";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { waitUntil } from "@vercel/functions";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import {
  contentSecurityPolicy,
  crossOriginOpenerPolicy,
  originAgentCluster,
  referrerPolicy,
  strictTransportSecurity,
  xContentTypeOptions,
  xDnsPrefetchControl,
  xDownloadOptions,
  xFrameOptions,
  xPermittedCrossDomainPolicies,
  xXssProtection,
} from "helmet";
import { rateLimit } from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { PrismaStore, type Store } from "./store.js";
import { loadConfig } from "./config.js";
import { NimbusClient } from "./nimbus.js";
import type { Batch, NimbusProgressEvent, Role, ShippingJob, ShippingLog } from "./types.js";

type AuthRequest = Request & { auth?: { username: string; role: Role } };
export type AppConfig = { jwtSecret: string; clientOrigin: string; databaseUrl: string; databaseSsl: boolean; mockMode: boolean; initialAdminPassword?: string; nimbusApiUrl: string; nimbusApiKey: string; nimbusApiSecret: string; maxLookupPages: number };

type BackgroundScheduler = (task: Promise<void>) => void;

export async function createApp(config: AppConfig, storeOverride?: Store, scheduleBackground?: BackgroundScheduler) {
  const store = storeOverride || new PrismaStore(config.databaseUrl, config.databaseSsl, config.mockMode, config.initialAdminPassword); await store.init();
  const runInBackground: BackgroundScheduler = scheduleBackground || ((task) => { void task.catch((error) => console.error("Background task failed", error)); });
  const nimbus = new NimbusClient({ apiUrl: config.nimbusApiUrl, apiKey: config.nimbusApiKey, apiSecret: config.nimbusApiSecret, maxPages: config.maxLookupPages, mockMode: config.mockMode }, { getOrderId: (order) => store.getOrderId(order), cacheOrder: (order, id) => store.cacheOrder(order, id) });
  const allowedOrigins = new Set([
    "http://localhost:5173",
    "https://auto-ship-client.vercel.app",
    ...config.clientOrigin.split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean),
  ]);
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    contentSecurityPolicy(),
    crossOriginOpenerPolicy(),
    originAgentCluster(),
    referrerPolicy(),
    strictTransportSecurity(),
    xContentTypeOptions(),
    xDnsPrefetchControl(),
    xDownloadOptions(),
    xFrameOptions(),
    xPermittedCrossDomainPolicies(),
    xXssProtection(),
  );
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
      return callback(null, false);
    },
    credentials: false,
  }));
  app.use(express.json({ limit: "32kb" }));
  const authenticate = (request: AuthRequest, response: Response, next: NextFunction) => { const token = request.headers.authorization?.replace(/^Bearer\s+/i, ""); if (!token) return response.status(401).json({ error: "Please sign in to continue." }); try { request.auth = jwt.verify(token, config.jwtSecret) as { username: string; role: Role }; next(); } catch { response.status(401).json({ error: "Your session has expired. Please sign in again." }); } };
  const adminOnly = (request: AuthRequest, response: Response, next: NextFunction) => request.auth?.role === "admin" ? next() : response.status(403).json({ error: "Admin access is required." });
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });
  const sessionFor = (username: string, role: Role) => { const user = { username, role }; return { token: jwt.sign(user, config.jwtSecret, { expiresIn: "7d", issuer: "autoship" }), user, demoMode: config.mockMode }; };
  const orderNumbersFrom = (body: unknown) => {
    const values = (body as { orderNumbers?: unknown })?.orderNumbers;
    if (!Array.isArray(values)) return undefined;
    return [...new Set(values.map((value) => { const normalized = typeof value === "string" ? value.trim().replace(/^#/, "").toUpperCase() : ""; return /^RBD\d+$/.test(normalized) ? `#${normalized}` : normalized; }))];
  };
  const runningJobs = new Set<string>();
  const appendLog = (job: ShippingJob, level: ShippingLog["level"], message: string, orderNumber?: string) => {
    const at = new Date().toISOString(); job.updatedAt = at; job.logs.push({ at, level, message, ...(orderNumber ? { orderNumber } : {}) });
    const prefix = `[shipping:${job.jobId}]${orderNumber ? ` [${orderNumber}]` : ""}`; (level === "error" ? console.error : console.info)(`${prefix} ${message}`);
  };
  const processJob = async (jobId: string) => {
    if (runningJobs.has(jobId)) return; runningJobs.add(jobId);
    let job: ShippingJob | undefined;
    try {
      job = await store.claimShippingJob(jobId); if (!job || job.status === "completed" || job.status === "failed") return;
      if (job.status === "processing" && job.processed > 0) { job.processed = 0; job.shipped = []; job.failed = []; job.labelUrl = null; appendLog(job, "info", "Server restarted; safely rechecking every order before continuing."); }
      job.status = "processing"; appendLog(job, "info", `Shipment started for ${job.total} order${job.total === 1 ? "" : "s"}.`); await store.updateShippingJob(job);
      let persistence = Promise.resolve();
      const recordProgress = async (event: NimbusProgressEvent) => {
        if (!job) return;
        if (event.type === "started") appendLog(job, "info", "Checking the order and contacting NimbusPost.", event.orderNumber);
        if (event.type === "courier_attempt") appendLog(job, "info", `Priority ${event.priority}/${event.total}: trying ${event.courierName} (courier ${event.courierId}, role ${event.roleId}).`, event.orderNumber);
        if (event.type === "courier_rejected") appendLog(job, "error", `Priority ${event.priority} ${event.courierName} rejected: [${event.code}] ${event.error}`, event.orderNumber);
        if (event.type === "shipped") { job.shipped.push(event.item); job.processed = job.shipped.length + job.failed.length; appendLog(job, "success", `${event.item.alreadyBooked ? "Already booked" : "Booked"} with ${event.item.courier}; AWB ${event.item.awb}.`, event.orderNumber); }
        if (event.type === "failed") { job.failed.push(event.item); job.processed = job.shipped.length + job.failed.length; appendLog(job, "error", `[${event.item.code}] ${event.item.error}`, event.orderNumber); }
        if (event.type === "labels_started") appendLog(job, "info", `Generating labels for ${event.count} shipped order${event.count === 1 ? "" : "s"}.`);
        if (event.type === "labels_ready") { job.labelUrl = event.labelUrl; appendLog(job, "success", "Merged shipping labels are ready to download."); }
        if (event.type === "labels_failed") appendLog(job, "error", `Shipments were booked, but label generation failed: ${event.error}`);
        persistence = persistence.then(() => store.updateShippingJob(job!)); await persistence;
      };
      const outcome = await nimbus.shipMany(job.orderNumbers, 5, recordProgress); await persistence; job.labelUrl = outcome.labelUrl;
      job.status = "completed"; job.processed = job.total; appendLog(job, job.failed.length ? "error" : "success", `Shipment finished: ${job.shipped.length} shipped, ${job.failed.length} failed.`);
      const batch: Batch = { batchId: job.jobId, createdAt: job.createdAt, shippedBy: job.createdBy, shipped: job.shipped, failed: job.failed, labelUrl: job.labelUrl, totalShipped: job.shipped.length, totalFailed: job.failed.length, demoMode: config.mockMode, logs: [...job.logs] };
      job.result = batch; await store.addBatch(batch); await store.updateShippingJob(job);
    } catch (error) {
      if (job) { job.status = "failed"; job.error = error instanceof Error ? error.message : "Unexpected shipping error"; appendLog(job, "error", `Shipment stopped because of a server error: ${job.error}`); await store.updateShippingJob(job).catch(console.error); }
      console.error(`[shipping:${jobId}] worker failed`, error);
    } finally { runningJobs.delete(jobId); }
  };

  app.get("/api/health", (_request, response) => response.json({ status: "ok", demoMode: config.mockMode }));
  app.post("/api/auth/register", authLimiter, async (request, response, next) => {
    try {
      const username = typeof request.body?.username === "string" ? request.body.username.trim() : "";
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return response.status(400).json({ error: "Use 3–32 letters, numbers, dots, dashes, or underscores for the username." });
      if (password.length < 15 || Buffer.byteLength(password, "utf8") > 72) return response.status(400).json({ error: "Use a password between 15 and 72 characters." });
      const user = await store.createUser(username, await bcrypt.hash(password, 12), "packer");
      if (!user) return response.status(400).json({ error: "Account could not be created. Try a different username." });
      response.status(201).json(sessionFor(user.username, user.role));
    } catch (error) { next(error); }
  });
  app.post("/api/auth/login", authLimiter, async (request, response) => {
    const username = typeof request.body?.username === "string" ? request.body.username.trim() : ""; const password = typeof request.body?.password === "string" ? request.body.password : "";
    const user = await store.findUser(username); if (!user || !(await bcrypt.compare(password, user.passwordHash))) return response.status(401).json({ error: "Incorrect username or password." });
    response.json(sessionFor(user.username, user.role));
  });
  app.get("/api/auth/me", authenticate, (request: AuthRequest, response) => response.json({ user: request.auth, demoMode: config.mockMode }));
  app.post("/api/shipping-jobs", authenticate, async (request: AuthRequest, response, next) => {
    try {
      const orderNumbers = orderNumbersFrom(request.body);
      if (!orderNumbers || !orderNumbers.length || orderNumbers.length > 100 || orderNumbers.some((value) => !/^#RBD\d+$/.test(value))) return response.status(400).json({ error: "Send 1–100 unique order numbers in the #RBD1234 format." });
      const active = await store.getActiveShippingJob(request.auth!.username); if (active) return response.status(409).json({ error: "A shipment is already running for this account.", job: active });
      const now = new Date().toISOString(); const job: ShippingJob = { jobId: crypto.randomUUID(), createdAt: now, updatedAt: now, createdBy: request.auth!.username, status: "queued", orderNumbers, processed: 0, total: orderNumbers.length, shipped: [], failed: [], labelUrl: null, logs: [{ at: now, level: "info", message: `Shipment job created for ${orderNumbers.length} order${orderNumbers.length === 1 ? "" : "s"}.` }] };
      if (!(await store.createShippingJob(job))) { const existing = await store.getActiveShippingJob(request.auth!.username); return response.status(409).json({ error: "A shipment is already running for this account.", job: existing }); }
      response.status(202).json({ job }); runInBackground(processJob(job.jobId));
    } catch (error) { next(error); }
  });
  app.get("/api/shipping-jobs/active", authenticate, async (request: AuthRequest, response, next) => { try { response.json({ job: await store.getActiveShippingJob(request.auth!.username) || null }); } catch (error) { next(error); } });
  app.get("/api/shipping-jobs/:jobId", authenticate, async (request: AuthRequest, response, next) => {
    try { const job = await store.getShippingJob(String(request.params.jobId)); if (!job) return response.status(404).json({ error: "Shipment job was not found." }); if (request.auth!.role !== "admin" && job.createdBy.toLowerCase() !== request.auth!.username.toLowerCase()) return response.status(403).json({ error: "You cannot view this shipment job." }); response.json({ job }); }
    catch (error) { next(error); }
  });
  app.post("/api/ship-bulk", authenticate, async (request: AuthRequest, response, next) => {
    try {
      const orderNumbers = orderNumbersFrom(request.body); if (!orderNumbers || !orderNumbers.length || orderNumbers.length > 100 || orderNumbers.some((value) => !/^#RBD\d+$/.test(value))) return response.status(400).json({ error: "Send 1–100 unique order numbers in the #RBD1234 format." });
      const result = await nimbus.shipMany(orderNumbers); const batch: Batch = { ...result, batchId: crypto.randomUUID(), createdAt: new Date().toISOString(), shippedBy: request.auth!.username, totalShipped: result.shipped.length, totalFailed: result.failed.length, demoMode: config.mockMode };
      await store.addBatch(batch); response.json(batch);
    } catch (error) { next(error); }
  });
  app.get("/api/history", authenticate, async (_request, response, next) => { try { response.json({ batches: await store.getHistory() }); } catch (error) { next(error); } });
  app.get("/api/settings/status", authenticate, adminOnly, (_request, response) => response.json({ connected: !config.mockMode && Boolean(config.nimbusApiKey && config.nimbusApiSecret), demoMode: config.mockMode, apiUrl: config.nimbusApiUrl, database: "PostgreSQL" }));
  app.get("/demo-labels", (_request, response) => response.type("html").send("<title>AutoShip demo labels</title><style>body{font-family:system-ui;padding:40px}code{font-size:18px}</style><h1>Demo label bundle</h1><p>Live mode returns NimbusPost’s merged PDF here.</p>"));

  const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
  if (fs.existsSync(path.join(clientDist, "index.html"))) {
    app.use(express.static(clientDist));
    app.get("*", (request, response, next) => request.path.startsWith("/api/") ? next() : response.sendFile(path.join(clientDist, "index.html")));
  } else {
    app.get("/", (_request, response) => response.json({ message: "AutoShip API", health: "/api/health" }));
  }
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => { console.error(error); response.status(500).json({ error: "The request could not be completed. Please try again." }); });
  for (const pendingJob of await store.getPendingShippingJobs()) runInBackground(processJob(pendingJob.jobId));
  return app;
}

let serverlessAppPromise: ReturnType<typeof createApp> | undefined;

/**
 * Vercel's Express auto-detection treats src/app.ts as a function entrypoint.
 * Keep initialization lazy so importing this module during the build does not
 * connect to PostgreSQL, and reuse the Express app across warm invocations.
 */
export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (!serverlessAppPromise) {
    serverlessAppPromise = createApp(loadConfig(), undefined, (task) => waitUntil(task)).catch((error) => {
      serverlessAppPromise = undefined;
      throw error;
    });
  }

  const app = await serverlessAppPromise;
  return app(request, response);
}
