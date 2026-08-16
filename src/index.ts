import { createApp } from "./app.js";

import path from "node:path";
import dotenv from "dotenv";

// npm workspace scripts run with server/ as cwd, while direct development
// commands often run from the repository root. Support both locations after compilation.
const workspaceDirectory = path.basename(process.cwd()).toLowerCase() === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
dotenv.config({ path: path.join(workspaceDirectory, ".env") });
dotenv.config({ path: path.join(workspaceDirectory, "server", ".env") });
const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const mockMode = process.env.MOCK_MODE === "true" || (!production && (!process.env.NIMBUS_API_KEY || !process.env.NIMBUS_API_SECRET));
const getgabsConfigured = process.env.WHATSAPP_API_URL?.includes("getgabs.com") || Boolean(process.env.WHATSAPP_SENDER || process.env.WHATSAPP_CAMPAIGN_ID);
const requestedWhatsAppProvider = process.env.WHATSAPP_PROVIDER || (process.env.WHATSAPP_PHONE_NUMBER_ID ? "meta" : getgabsConfigured ? "getgabs" : process.env.WHATSAPP_API_KEY ? "whapi" : "disabled");
const whatsappProvider = (["disabled", "meta", "whapi", "getgabs"].includes(requestedWhatsAppProvider) ? requestedWhatsAppProvider : "disabled") as "disabled" | "meta" | "whapi" | "getgabs";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Copy .env.example to .env and set your PostgreSQL password.");
if (!mockMode && (!process.env.NIMBUS_API_KEY || !process.env.NIMBUS_API_SECRET)) throw new Error("NIMBUS_API_KEY and NIMBUS_API_SECRET are required outside demo mode");
if (!mockMode && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 || process.env.JWT_SECRET === "replace-with-a-long-random-secret")) throw new Error("JWT_SECRET must be a unique random value of at least 32 characters in production");
const app = await createApp({
  jwtSecret: process.env.JWT_SECRET || "local-demo-secret-not-for-production-use",
  clientOrigin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL === "true",
  mockMode,
  initialAdminPassword: process.env.INITIAL_ADMIN_PASSWORD,
  nimbusApiUrl: process.env.NIMBUS_API_URL || "https://api-v2.nimbuspost.com",
  nimbusApiKey: process.env.NIMBUS_API_KEY || "",
  nimbusApiSecret: process.env.NIMBUS_API_SECRET || "",
  maxLookupPages: Number(process.env.NIMBUS_LOOKUP_MAX_PAGES || 20),
  shopifyStoreDomain: process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_STORE_URL,
  shopifyClientId: process.env.SHOPIFY_CLIENT_ID,
  shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  shopifyAccessToken: process.env.SHOPIFY_ACCESS_TOKEN,
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION || "2026-07",
  whatsappProvider,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || process.env.WHATSAPP_API_KEY,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,
  whatsappApiUrl: process.env.WHATSAPP_API_URL,
  whatsappServiceApiUrl: process.env.WHATSAPP_SERVICE_API_URL,
  whatsappSender: process.env.WHATSAPP_SENDER,
  whatsappCampaignId: process.env.WHATSAPP_CAMPAIGN_ID,
  whatsappTemplateName: process.env.WHATSAPP_TEMPLATE_NAME,
  whatsappTemplateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en_US",
  supportPhone: process.env.SUPPORT_PHONE_NUMBER || process.env.Phonenumber,
});
const port = Number(process.env.PORT || 8787);
app.listen(port, () => console.log(`AutoShip API listening on http://localhost:${port}`));
