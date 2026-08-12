import dotenv from "dotenv";
import { PrismaStore } from "./src/store.js";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function initDb() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set in .env");
    process.exit(1);
  }

  const ssl = process.env.DATABASE_SSL === "true";
  const initialPassword = process.env.INITIAL_ADMIN_PASSWORD || "admin123";

  console.log("Connecting to database...");
  const store = new PrismaStore(dbUrl, ssl, false, initialPassword);

  try {
    console.log("Seeding the initial admin account...");
    await store.init();
    console.log("Database seed completed successfully!");
  } catch (error) {
    console.error("Failed to initialize database:", error);
  }
}

initDb();
