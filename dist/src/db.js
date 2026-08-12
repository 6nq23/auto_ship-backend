import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";
const { Pool } = pg;
const globalState = globalThis;
export function getPrisma(databaseUrl, ssl) {
    const existing = globalState.__autoshipPrisma;
    if (existing?.client && existing.databaseUrl === databaseUrl)
        return existing.client;
    const pool = new Pool({
        connectionString: databaseUrl,
        ssl: ssl ? { rejectUnauthorized: false } : false,
        max: process.env.VERCEL ? 1 : 10,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (error) => console.error("PostgreSQL pool error", error.message));
    const client = new PrismaClient({ adapter: new PrismaPg(pool) });
    globalState.__autoshipPrisma = { databaseUrl, pool, client };
    return client;
}
