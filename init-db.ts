import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { PrismaStore } from "./src/store.js";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(serverDirectory, "..", ".env") });
dotenv.config({ path: path.join(serverDirectory, ".env") });

async function initDb() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set in .env");

  const store = new PrismaStore(
    databaseUrl,
    process.env.DATABASE_SSL === "true",
    false,
    process.env.INITIAL_ADMIN_PASSWORD || "admin123",
  );

  try {
    console.info("Connecting to PostgreSQL and initializing AutoShip...");
    await store.init();
    console.info("Database initialization completed successfully.");
  } finally {
    await store.close();
  }
}

initDb().catch((error) => {
  console.error("Failed to initialize the database:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
