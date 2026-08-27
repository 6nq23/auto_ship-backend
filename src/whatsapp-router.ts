import fs from "node:fs/promises";
import type { Store } from "./store.js";
import type { NimbusClient } from "./nimbus.js";
import type { ShopifyClient } from "./shopify.js";
import type { IncomingWhatsAppMessage, WhatsAppClient } from "./whatsapp.js";
import type { AiProviderName, AiToolCall, ChatMessage, CustomerMemory, OrderMatch, ShopifyAddress, ShopifyOrder, SupportConversation, SupportIntent, SupportTicket, WhatsAppMessage } from "./types.js";
import { extractOrderSuffix, extractPhoneNumber, normalizeOrderNumber, normalizePhoneNumber } from "./identifiers.js";
import type { AiOrchestrator } from "./ai-providers.js";

const INTENTS: Record<string, SupportIntent> = {
  "1": "confirm_order",
  "2": "change_address",
  "3": "order_status",
  "4": "not_dispatched",
  "5": "order_failed",
  "6": "refund_return",
};

const KEYWORDS: Array<[SupportIntent, RegExp]> = [
  ["order_status", /\b(?:still\s+)?(?:have\s+)?not\s+receiv(?:e|ed)\b.*\b(?:my\s+)?order\b|\b(?:my\s+)?order\b.*\b(?:still\s+)?not\s+receiv(?:e|ed)\b/i],
  ["refund_return", /\b(refund|return|exchange|replace(?:ment)?|missing|wrong item|galat item|paisa wapas|badalna|nahi aaya|rakhi nahi)\b/i],
  ["order_failed", /\b(fail(?:ed)?|delivery fail|deliver nahi|nahi mila|attempt|undelivered|return ho gaya|ndr)\b/i],
  ["not_dispatched", /\b(not dispatch|dispatch nahi|not ship|ship nahi|kab bhejoge|nahi bheja|why not shipped)\b/i],
  ["change_address", /\b(address|phone|number)\b.*\b(change|update|badlo|galat|wrong)\b|\b(change|update|badlo|galat|wrong)\b.*\b(address|phone|number)\b/i],
  ["order_status", /\b(status|tracking|track|kaha hai|where|kab aayega|kab milega|kidhar)\b/i],
  ["confirm_order", /\b(confirm|pakka|order confirm|mera order aaya|placed|order hua|payment|paid|prepaid|cod)\b/i],
];

export const classifyIntent = (text: string): SupportIntent | undefined => {
  const menu = INTENTS[text.trim()];
  return menu || KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0];
};
export const extractOrderNumber = normalizeOrderNumber;
export { extractPhoneNumber };

type RouterDependencies = {
  store: Store;
  shopify: ShopifyClient;
  nimbus: NimbusClient;
  whatsapp: WhatsAppClient;
  supportPhone: string;
  ai?: AiOrchestrator;
  aiMaxTurns?: number;
  aiContextMaxChars?: number;
  brainFilePath?: string;
  escalationPhone?: string;
  maxConcurrentChats?: number;
};

/** Caps how many customer conversations the bot answers at the same time; extra messages queue and wait their turn. */
class ConversationSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => this.queue.push(() => resolve(() => this.release())));
  }

  private release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) { this.active += 1; next(); }
  }
}

export class WhatsAppRouter {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly concurrency: ConversationSemaphore;

  constructor(private readonly dependencies: RouterDependencies) {
    this.concurrency = new ConversationSemaphore(Math.max(1, Math.trunc(dependencies.maxConcurrentChats || 1)));
  }

  async handleIncomingMessage(message: IncomingWhatsAppMessage) {
    const normalizedMessage = { ...message, phone: canonicalCustomerPhone(message.phone) };
    const previous = this.locks.get(normalizedMessage.phone) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.dependencies.store.withConversationLock(normalizedMessage.phone, () => this.process(normalizedMessage)));
    this.locks.set(normalizedMessage.phone, current);
    try { await current; } finally { if (this.locks.get(normalizedMessage.phone) === current) this.locks.delete(normalizedMessage.phone); }
  }

  async handleManualAgentMessage(message: IncomingWhatsAppMessage) {
    message = { ...message, phone: canonicalCustomerPhone(message.phone) };
    const text = message.text.trim().slice(0, 2_000);
    if (!text || await this.dependencies.store.isRecentBotMessage?.(message.phone, text)) return;
    const inserted = await this.dependencies.store.addWhatsAppMessage({ phone: message.phone, direction: "outbound", source: "agent", text, providerMessageId: message.id });
    if (!inserted) return;
    await this.dependencies.store.setBotPaused?.(message.phone, true, "agent_message");
  }

  private async process(message: IncomingWhatsAppMessage) {
    const text = message.text.trim().slice(0, 2_000);
    if (!text) return;
    const inserted = await this.dependencies.store.addWhatsAppMessage({ phone: message.phone, direction: "inbound", source: "customer", text, messageType: message.messageType || "text", providerMessageId: message.id });
    if (!inserted) return;
    if (message.customerName) await this.rememberCustomerName(message.phone, message.customerName);
    if (await this.dependencies.store.isBotPaused?.(message.phone)) return;
    const release = await this.concurrency.acquire();
    try { return await this.reply(message.phone, text, message.messageType || "text"); }
    finally { release(); }
  }

  private async reply(phone: string, text: string, messageType: "text" | "image") {
    const conversation = await this.dependencies.store.getConversation(phone);
    if (conversation && conversation.step !== "ai_active") return this.resume(conversation, text);
    if (await this.handleCommonScenario(phone, text, messageType)) return;
    const correctedOrder = extractLikelyOrderTypo(text);
    if (correctedOrder && /\b(order|status|track|details?|where|kaha|confirm|dispatch)\b/i.test(text)) return this.resolveIdentifier(phone, classifyIntent(text) || "order_status", correctedOrder);
    if (this.dependencies.ai?.enabled) {
      try { return await this.processWithAi(phone, text); }
      catch (error) {
        console.error(`[support:${phone}] AI routing failed; using deterministic fallback`, error);
        await this.dependencies.store.clearConversation(phone).catch(() => undefined);
      }
    }
    return this.processDeterministic(phone, text);
  }

  private async processDeterministic(phone: string, text: string) {
    const intent = classifyIntent(text);
    if (!intent) return this.send(phone, "Of course—please tell me what you need help with, and I’ll check it for you.");
    const context = intent === "refund_return" ? { ticketCategory: refundCategory(text) } : {};
    if (intent === "refund_return" && context.ticketCategory === "other") return this.askRefundIssue(phone);
    const orderNumber = extractOrderNumber(text);
    const phoneNumber = extractPhoneNumber(text);
    if (orderNumber || phoneNumber) return this.resolveIdentifier(phone, intent, orderNumber || phoneNumber!, context);
    await this.askForOrder(phone, intent, context);
  }

  private async processWithAi(phone: string, text: string) {
    const ai = this.dependencies.ai!;
    const turnCount = await this.dependencies.store.incrementAiTurnCount(phone);
    await this.refreshShopifyIdentity(phone);
    const history = typeof this.dependencies.store.getCompleteConversationHistory === "function" ? await this.dependencies.store.getCompleteConversationHistory(phone) : await this.dependencies.store.getConversationHistory(phone, 50);
    const memory = typeof this.dependencies.store.getCustomerMemory === "function" ? await this.dependencies.store.getCustomerMemory(phone) : undefined;
    const context = buildAiContext(memory || newCustomerMemory(phone), history, this.dependencies.aiContextMaxChars || 120_000);
    const messages = context.messages;
    if (typeof this.dependencies.store.saveCustomerMemory === "function" && context.archiveSummary && (context.archiveSummary !== memory?.archiveSummary || context.archivedThroughMessageId !== memory?.archivedThroughMessageId)) await this.dependencies.store.saveCustomerMemory({ ...(memory || newCustomerMemory(phone)), archiveSummary: context.archiveSummary, archivedThroughMessageId: context.archivedThroughMessageId });
    const response = await ai.chat(messages, await this.loadBrain());
    const toolCall = response.toolCalls?.[0];
    if (toolCall) return this.executeAiTool(phone, toolCall, response.text);
    const directIdentifier = extractOrderNumber(text) || extractLikelyOrderTypo(text) || extractPhoneNumber(text);
    if (directIdentifier && !response.resolved) return this.resolveIdentifier(phone, inferIntent(messages) || "order_status", directIdentifier);
    if (response.escalate) {
      const customerText = messages.filter((item) => item.role === "user").map((item) => item.content).join("\n");
      const category = refundCategory(customerText);
      const reason = response.text || "Customer requested senior support";
      return category === "other"
        ? this.escalateToHuman(phone, reason, category, extractOrderNumber(customerText), response.text)
        : this.beginEscalation(phone, reason, category, extractOrderNumber(customerText), response.text);
    }
    if (!response.text) throw new Error("AI returned neither a reply nor a tool call");
    await this.remember(phone, response.summary || summarizeConversation(history, response.text), response.intent || inferIntent(messages));
    if (!response.resolved && turnCount >= Math.max(1, this.dependencies.aiMaxTurns || 3)) return this.escalateToHuman(phone, "The automated conversation could not be resolved within the configured turn limit", "other");
    if (response.resolved) await this.dependencies.store.clearConversation(phone);
    await this.send(phone, response.text, undefined, undefined, response.provider);
  }

  private async handleCommonScenario(phone: string, text: string, messageType: "text" | "image") {
    const category = refundCategory(text);
    if (category === "refund" || category === "missing") { await this.createEmailTicket(phone, category, text, extractOrderNumber(text), messageType); return true; }
    if (/\b(customer\s*(?:care|support)\s*(?:number|phone)|customer\s*care\s*no)\b/i.test(text)) { await this.save({ phone, intent: "contact_request", step: "waiting_contact_issue", context: {} }); await this.send(phone, "I’ll arrange the right support for you. Please describe your main issue in one clear line so our senior team can help quickly.", "contact_request"); return true; }
    if (/\b(real|actual|original)\b.*\b(photo|photos|picture|pictures|image|images)\b/i.test(text)) { await this.dependencies.store.clearConversation(phone); await this.send(phone, "You can book a video call from our website to see the Rakhis live before ordering: https://rakhibydiorin.com/", "real_picture_request"); return true; }
    if (/\b(add|buy|order)\b.*\b(another|more|extra|one more)\b.*\brakhi\b|\bfor the same address\b/i.test(text)) { await this.dependencies.store.clearConversation(phone); await this.send(phone, "Yes, you can place another Rakhi order directly on our website and use the same delivery address: https://rakhibydiorin.com/", "additional_purchase"); return true; }
    if (!extractOrderNumber(text) && /\b(?:cod|cash[ -]?on[ -]?delivery)\b/i.test(text) && /\b(?:available|availability|option|possible|accept|have|do you|is there|mil(?:e|ta)|hai)\b|^\s*(?:cod|cash[ -]?on[ -]?delivery)\s*[?.!]*\s*$/i.test(text)) { await this.dependencies.store.clearConversation(phone); await this.send(phone, "Yes, Cash on Delivery (COD) is available. You can view and order from our complete currently available collection here: https://rakhibydiorin.com/\n\nOnly the products shown on the website are currently available; we do not have additional designs outside the website.", "product_inquiry"); return true; }
    if (/rakhibydiorin\.com\/products\/|\b(rakhi|product|colour|color|design)\b.*\b(available|availability|price|details?|info|stock)\b|\bis (?:red|blue|green|yellow|pink|gold|silver|white|black) colou?r available\b/i.test(text)) { await this.dependencies.store.clearConversation(phone); await this.send(phone, "Please view our complete currently available collection here: https://rakhibydiorin.com/\n\nOnly the products shown on the website are currently available; we do not have additional designs outside the website. The latest designs, colours, prices, and stock are shown there.", "product_inquiry"); return true; }
    if (/\bquestion about rakhi by diorin\b/i.test(text)) { await this.send(phone, "Sure—what would you like to know about Rakhi by Diorin?", "product_inquiry"); return true; }
    if (messageType === "image") { await this.send(phone, "Thank you for sharing the image. Please also tell me whether this is about a refund, a missing item, or something else, along with your order ID."); return true; }
    if (/^(ok|okay|thanks|thank you|got it|fine|haan|thik hai)[.! ]*$/i.test(text)) { const memory = await this.dependencies.store.getCustomerMemory?.(phone); await this.send(phone, memory?.lastIntent === "order_status" ? "You’re welcome. If you want, send the same order ID anytime and I’ll check the latest status again." : "You’re welcome. Message me whenever you need help.", memory?.lastIntent); return true; }
    return false;
  }

  private async createEmailTicket(phone: string, category: "refund" | "missing", issue: string, orderNumber?: string, messageType: "text" | "image" = "text") {
    const shopifyOrders = orderNumber ? [await this.dependencies.shopify.getOrderByName(orderNumber).catch(() => null)].filter((order): order is ShopifyOrder => Boolean(order)) : await this.dependencies.shopify.getOrdersByPhone(normalizePhoneNumber(phone) || phone).catch(() => []);
    const customerName = shopifyOrders.map((order) => order.shippingAddress?.name || [order.shippingAddress?.firstName, order.shippingAddress?.lastName].filter(Boolean).join(" ")).find(Boolean);
    const existing = await this.dependencies.store.findOpenSupportTicket(phone, category, orderNumber); const now = new Date().toISOString();
    const metadata = { emailInstructionsSentAt: now, imageReceived: messageType === "image", latestIssue: issue.slice(0, 1_000), ...(customerName ? { customerName } : {}) }; let ticketId = existing?.ticketId;
    if (existing) await this.dependencies.store.updateSupportTicketDetails(existing.ticketId, { orderNumber, description: issue.slice(0, 2_000), metadata, status: "awaiting_email" });
    else { ticketId = crypto.randomUUID(); await this.dependencies.store.createSupportTicket({ ticketId, phone, ...(orderNumber ? { orderNumber } : {}), category, description: issue.slice(0, 2_000), status: "awaiting_email", metadata, createdAt: now, updatedAt: now }); }
    await this.dependencies.store.clearConversation(phone); await this.remember(phone, `${category === "missing" ? "Missing-item" : "Refund"} request is awaiting the customer's email.`, "refund_return", orderNumber, ticketId);
    const instructions = category === "missing" ? "First, please email clear photos of the package and every product you received to support@diorin.com. In the same email, include your order ID, registered phone number, and the exact Rakhi/product name and quantity that is missing. Please also attach an unboxing video if available. Once we receive your email, our senior team can verify the issue and continue the process." : "First, please email clear photos of the order you received to support@diorin.com. In the same email, include your order ID, registered phone number, the product received, and your refund reason. Please also attach an unboxing video if available. Once we receive your email, our senior team can review your refund request and continue the process.";
    await this.send(phone, `I’m sorry you’re facing this. ${instructions}\n\nWe’ve also recorded your ${category === "missing" ? "missing-item" : "refund"} request for senior review. Ticket ${ticketId!.slice(0, 8)} is awaiting your email.`, "refund_return", orderNumber);
  }

  private async remember(phone: string, summary: string, lastIntent?: SupportIntent, lastOrderNumber?: string, activeTicketId?: string) {
    if (typeof this.dependencies.store.saveCustomerMemory !== "function") return;
    const current = (typeof this.dependencies.store.getCustomerMemory === "function" ? await this.dependencies.store.getCustomerMemory(phone) : undefined) || newCustomerMemory(phone); const intent = lastIntent || current.lastIntent; const order = lastOrderNumber || current.lastOrderNumber; const issue = summary.slice(0, 2_000);
    const issueHistory = intent ? [...current.issueHistory, { ...(intent ? { intent } : {}), ...(order ? { orderNumber: order } : {}), summary: issue, status: "active" as const, updatedAt: new Date().toISOString() }].slice(-100) : current.issueHistory;
    await this.dependencies.store.saveCustomerMemory({ ...current, summary: issue, currentIssue: issue, knownOrderNumbers: [...new Set([...current.knownOrderNumbers, ...(order ? [order] : [])])], issueHistory, lastIntent: intent, lastOrderNumber: order, activeTicketId: activeTicketId || current.activeTicketId });
  }

  private async refreshShopifyIdentity(phone: string, knownOrders?: ShopifyOrder[]) {
    if (typeof this.dependencies.store.saveCustomerMemory !== "function") return;
    const current = (typeof this.dependencies.store.getCustomerMemory === "function" ? await this.dependencies.store.getCustomerMemory(phone) : undefined) || newCustomerMemory(phone);
    const lastLookup = typeof current.profile.shopifyIdentityCheckedAt === "string" ? Date.parse(current.profile.shopifyIdentityCheckedAt) : 0;
    if (!knownOrders && Date.now() - lastLookup < 24 * 60 * 60_000) return;
    const lookup = (this.dependencies.shopify as ShopifyClient & { getOrdersByPhone?: ShopifyClient["getOrdersByPhone"] }).getOrdersByPhone;
    const orders = knownOrders || (typeof lookup === "function" ? await lookup.call(this.dependencies.shopify, normalizePhoneNumber(phone) || phone).catch((error) => { console.error(`[support:${phone}] Shopify identity lookup failed`, error); return []; }) : []);
    const namedOrder = orders.find((order) => order.customerName || order.shippingAddress?.name || order.shippingAddress?.firstName);
    const customerName = namedOrder?.customerName || namedOrder?.shippingAddress?.name || [namedOrder?.shippingAddress?.firstName, namedOrder?.shippingAddress?.lastName].filter(Boolean).join(" ") || current.customerName;
    await this.dependencies.store.saveCustomerMemory({ ...current, ...(customerName ? { customerName, nameSource: "shopify" as const } : {}), shopifyCustomerId: orders.find((order) => order.shopifyCustomerId)?.shopifyCustomerId || current.shopifyCustomerId, knownOrderNumbers: [...new Set([...current.knownOrderNumbers, ...orders.map((order) => order.name)])], profile: { ...current.profile, shopifyIdentityCheckedAt: new Date().toISOString(), shopifyOrderCount: orders.length } });
  }

  private async rememberCustomerName(phone: string, customerName: string) {
    if (typeof this.dependencies.store.saveCustomerMemory !== "function") return;
    const current = (typeof this.dependencies.store.getCustomerMemory === "function" ? await this.dependencies.store.getCustomerMemory(phone) : undefined) || newCustomerMemory(phone);
    if (current.nameSource === "shopify") return;
    await this.dependencies.store.saveCustomerMemory({ ...current, customerName: customerName.trim().slice(0, 120), nameSource: "whatsapp" });
  }

  private async executeAiTool(phone: string, toolCall: AiToolCall, customerMessage?: string) {
    const args = toolCall.arguments;
    const rawIdentifier = String(args.identifier || args.order_number || args.order_id || args.orderId || args.phone || phone);
    const identifier = extractOrderNumber(rawIdentifier) || extractLikelyOrderTypo(rawIdentifier) || extractPhoneNumber(rawIdentifier) || rawIdentifier;
    if (toolCall.name === "lookup_order") return this.resolveIdentifier(phone, "confirm_order", identifier);
    if (toolCall.name === "track_order") return this.resolveIdentifier(phone, "order_status", identifier);
    if (toolCall.name === "check_dispatch") return this.resolveIdentifier(phone, "not_dispatched", identifier);
    if (toolCall.name === "update_address") return this.resolveIdentifier(phone, "change_address", identifier);
    if (toolCall.name === "failed_delivery") return this.resolveIdentifier(phone, "order_failed", identifier);
    if (toolCall.name === "lookup_by_phone") {
      const intent = isSupportIntent(args.intent) ? args.intent : "order_status";
      return this.resolveIdentifier(phone, intent, String(args.phone || phone));
    }
    if (toolCall.name === "create_ticket") {
      const reason = String(args.reason || customerMessage || "Customer requested human support");
      const inferredCategory = refundCategory(`${String(args.category || "")} ${reason} ${customerMessage || ""}`);
      const category = isTicketCategory(args.category) && args.category !== "other" ? args.category : inferredCategory;
      const rawOrderNumber = String(args.order_number || args.order_id || args.orderId || "");
      const orderNumber = extractOrderNumber(rawOrderNumber);
      if (category === "refund" || category === "missing") return this.createEmailTicket(phone, category, reason, orderNumber);
      return category === "other"
        ? this.escalateToHuman(phone, reason, category, orderNumber, customerMessage)
        : this.beginEscalation(phone, reason, category, orderNumber, customerMessage);
    }
    throw new Error(`Unsupported AI tool: ${toolCall.name}`);
  }

  private async loadBrain() {
    const filePath = this.dependencies.brainFilePath;
    if (!filePath) return DEFAULT_BRAIN;
    try { return await fs.readFile(filePath, "utf8"); }
    catch (error) { console.error(`[support] Could not load brain file at ${filePath}; using built-in rules`, error); return DEFAULT_BRAIN; }
  }

  private async loadSupportPolicy() {
    const brain = await this.loadBrain();
    const heading = /^##\s+Refund, return, exchange, and missing-item policy\s*$/im;
    const start = heading.exec(brain);
    if (!start) return DEFAULT_POLICY_GUIDANCE;
    const remainder = brain.slice(start.index + start[0].length);
    const content = remainder.split(/\n##\s+/)[0]
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^\s*[-*]\s+/gm, "• ")
      .trim();
    return content || DEFAULT_POLICY_GUIDANCE;
  }

  private async beginEscalation(phone: string, reason: string, category: SupportTicket["category"], orderNumber?: string, customerMessage?: string) {
    const policy = await this.loadSupportPolicy();
    await this.save({ phone, intent: "refund_return", step: "waiting_escalation_issue", context: { reason: reason.slice(0, 1_500), category, ...(orderNumber ? { orderNumber } : {}) } });
    const empathy = escalationEmpathy(category);
    const prompt = "I’m sending this to our senior support team so the right person can help you. Before I forward it, please reply with your main issue in one clear line—for example: ‘One rakhi is missing from order RBD1234.’ This will help the team act faster.";
    await this.send(phone, [empathy, policy, prompt].filter(Boolean).join("\n\n"), "refund_return", orderNumber);
  }

  private async escalateToHuman(phone: string, reason: string, category: SupportTicket["category"], orderNumber?: string, customerMessage?: string) {
    const ticket: SupportTicket = { ticketId: crypto.randomUUID(), phone, ...(orderNumber ? { orderNumber } : {}), category, description: reason.slice(0, 2_000), status: "open", createdAt: new Date().toISOString() };
    await this.dependencies.store.createSupportTicket(ticket);
    await this.dependencies.store.clearConversation(phone);
    const escalationPhone = String(this.dependencies.escalationPhone || this.dependencies.supportPhone || "").replace(/\D/g, "");
    if (escalationPhone && escalationPhone !== phone) await this.dependencies.whatsapp.sendText(escalationPhone, `🚨 Customer ${phone} needs human help.${orderNumber ? `\nOrder: ${orderNumber}` : ""}\nReason: ${reason}\nTicket: ${ticket.ticketId.slice(0, 8)}`).catch((error) => console.error(`[support:${phone}] escalation notification failed`, error));
    const policy = category === "other" ? "" : await this.loadSupportPolicy();
    const guidance = customerMessage?.trim() || policy;
    const acknowledgement = `Your request has been forwarded to our senior support team. Ticket ${ticket.ticketId.slice(0, 8)} has been created. Please wait for their WhatsApp update—we will review it and help you as soon as possible. 🙏`;
    await this.send(phone, [guidance, acknowledgement].filter(Boolean).join("\n\n"), "refund_return", orderNumber);
  }

  private async resume(conversation: SupportConversation, text: string) {
    const { phone, step, intent, context } = conversation;
    if (step === "waiting_contact_issue" && intent === "contact_request") {
      const issue = text.trim().replace(/\s+/g, " ").slice(0, 1_000); if (issue.length < 5) return this.send(phone, "Please describe your issue in one short line so I can send it to the right person.", intent);
      const existing = await this.dependencies.store.findOpenSupportTicket(phone, "contact_request"); const ticketId = existing?.ticketId || crypto.randomUUID();
      if (existing) await this.dependencies.store.updateSupportTicketDetails(ticketId, { description: issue, status: "open" }); else await this.dependencies.store.createSupportTicket({ ticketId, phone, category: "contact_request", description: issue, status: "open", createdAt: new Date().toISOString() });
      await this.dependencies.store.clearConversation(phone); await this.remember(phone, `Customer requested contact about: ${issue}`, intent, undefined, ticketId);
      return this.send(phone, `Thank you. I’ve sent your issue to our senior support team under ticket ${ticketId.slice(0, 8)}. They’ll review it and contact you.`, intent);
    }
    if (step === "waiting_menu") {
      const nextIntent = classifyIntent(text);
      if (!nextIntent) return this.showMenu(phone, "Please reply with a number from 1 to 6.");
      return nextIntent === "refund_return" ? this.askRefundIssue(phone) : this.askForOrder(phone, nextIntent);
    }
    if (step === "waiting_issue" && intent === "refund_return") {
      const ticketCategory = refundCategory(text) !== "other" ? refundCategory(text) : text.trim() === "1" ? "refund" : text.trim() === "2" ? "return" : text.trim() === "3" ? "missing" : undefined;
      if (!ticketCategory) return this.send(phone, "Reply 1 for refund, 2 for return/wrong item, or 3 for a missing item.", intent);
      return this.askForOrder(phone, intent, { ticketCategory });
    }
    if (step === "waiting_escalation_issue" && intent === "refund_return") {
      const issue = text.trim().replace(/\s+/g, " ").slice(0, 1_000);
      if (issue.length < 5) return this.send(phone, "Please describe the main issue in one short, clear line so I can send the right details to the senior team.", intent, String(context.orderNumber || "") || undefined);
      const category = isTicketCategory(context.category) ? context.category : refundCategory(issue);
      const orderNumber = typeof context.orderNumber === "string" ? context.orderNumber : extractOrderNumber(issue);
      const originalReason = String(context.reason || "Customer requested senior support");
      return this.escalateToHuman(phone, `${originalReason}\nCustomer's one-line issue: ${issue}`, category, orderNumber, "Thank you—that explains it clearly. I’ve added your exact issue to the request.");
    }
    if (step === "waiting_order" && intent) {
      const identifier = extractOrderNumber(text) || extractLikelyOrderTypo(text) || extractPhoneNumber(text);
      if (identifier) return this.resolveIdentifier(phone, intent, identifier, context);
      const retries = Number(context.retries || 0) + 1;
      if (retries >= 3) { await this.dependencies.store.clearConversation(phone); return this.send(phone, "I still couldn’t identify the order. Please send only the 4–5 digits from your RBD order number, or the 10-digit phone used at checkout.", intent); }
      await this.save({ phone, intent, step, context: { ...context, retries } });
      return this.send(phone, "Sorry, I didn't understand. Please send an order number like RBD5001 or a 10-digit phone number.", intent);
    }
    if (step === "waiting_pick" && intent) {
      const options = Array.isArray(context.orders) ? context.orders as Array<{ name: string; source?: "shopify" | "nimbus" }> : [];
      const selectedByPosition = options[Number(text.trim()) - 1];
      const selectedSuffix = extractOrderSuffix(text);
      const selected = selectedByPosition || options.find((option) => selectedSuffix && extractOrderSuffix(option.name) === selectedSuffix);
      if (!selected) return this.send(phone, `Reply with a number from 1 to ${options.length}, or send one of the order IDs shown above.`, intent);
      return this.dispatch(phone, intent, selected.name, context);
    }
    if (step === "waiting_address" && intent === "change_address") {
      const parsed = parseAddress(text);
      if (!parsed) return this.send(phone, "Please use this format: House/street, City, State, 6-digit PIN. Example: 14 Park Street, Kolkata, West Bengal, 700016", intent, String(context.orderNumber || ""));
      await this.save({ phone, intent, step: "waiting_phone", context: { ...context, newAddress: parsed } });
      return this.send(phone, "Send the new 10-digit phone number, or reply SAME to keep the current number.", intent, String(context.orderNumber || ""));
    }
    if (step === "waiting_phone" && intent === "change_address") {
      const currentPhone = String((context.existingAddress as ShopifyAddress | undefined)?.phone || "").replace(/\D/g, "").slice(-10);
      const nextPhone = /^same$/i.test(text) ? currentPhone : extractPhoneNumber(text);
      if (!/^\d{10}$/.test(nextPhone || "")) return this.send(phone, "Please send a valid 10-digit phone number, or reply SAME.", intent, String(context.orderNumber || ""));
      const address = { ...(context.newAddress as ShopifyAddress), phone: nextPhone };
      await this.save({ phone, intent, step: "waiting_confirm", context: { ...context, newAddress: address } });
      return this.send(phone, `Please confirm the update:\n📍 ${formatAddress(address)}\n📱 ${nextPhone}\n\nReply YES to update or NO to cancel.`, intent, String(context.orderNumber || ""));
    }
    if (step === "waiting_confirm" && intent === "change_address") {
      if (/^(no|n)$/i.test(text)) { await this.dependencies.store.clearConversation(phone); return this.send(phone, "Address update cancelled.", intent, String(context.orderNumber || "")); }
      if (!/^(yes|y|haan|ha)$/i.test(text)) return this.send(phone, "Please reply YES to update or NO to cancel.", intent, String(context.orderNumber || ""));
      return this.applyAddressUpdate(phone, context);
    }
    if (step === "waiting_ndr_choice" && intent === "order_failed") return this.handleNdrChoice(phone, text, context);
    await this.dependencies.store.clearConversation(phone); return this.send(phone, "Please tell me what you need help with, and I’ll continue from there.");
  }

  private async showMenu(phone: string, preface?: string) {
    await this.dependencies.store.clearConversation(phone);
    if (preface) await this.send(phone, preface);
    await this.dependencies.whatsapp.sendMenu(phone);
    await this.dependencies.store.addWhatsAppMessage({ phone, direction: "outbound", source: "bot", text: "Support menu: 1 Confirm, 2 Address, 3 Status, 4 Not dispatched, 5 Delivery failed, 6 Refund/return/missing" });
    await this.save({ phone, step: "waiting_menu", context: {} });
  }

  private async askForOrder(phone: string, intent: SupportIntent, context: Record<string, unknown> = {}) {
    await this.save({ phone, intent, step: "waiting_order", context: { ...context, retries: 0 } });
    await this.send(phone, "Please share your order number (for example RBD5001). If you don't have it, send your 10-digit phone number.", intent);
  }

  private async askRefundIssue(phone: string) {
    await this.save({ phone, intent: "refund_return", step: "waiting_issue", context: {} });
    await this.send(phone, "What do you need help with?\n1️⃣ Refund\n2️⃣ Return, exchange, or wrong item\n3️⃣ Missing item", "refund_return");
  }

  private async resolveIdentifier(phone: string, intent: SupportIntent, identifier: string, context: Record<string, unknown> = {}) {
    const orderNumber = extractOrderNumber(identifier);
    if (orderNumber) return this.dispatch(phone, intent, orderNumber, context);
    const customerPhone = normalizePhoneNumber(identifier);
    if (!customerPhone) return this.askForOrder(phone, intent, context);
    const shopifyOrders = await this.dependencies.shopify.getOrdersByPhone(customerPhone).catch((error) => { console.error(`[support:${phone}] Shopify phone lookup failed`, error); return []; });
    if (shopifyOrders.length) await this.refreshShopifyIdentity(phone, shopifyOrders);
    const nimbusOrders = shopifyOrders.length ? [] : await this.dependencies.nimbus.getOrdersByPhone(customerPhone).catch((error) => { console.error(`[support:${phone}] Nimbus phone lookup failed`, error); return []; });
    const orders = [
      ...shopifyOrders.map((order) => ({ name: order.name, source: "shopify" as const, summary: formatShopifyOrderSummary(order) })),
      ...nimbusOrders.map((order) => ({ name: order.order_number, source: "nimbus" as const, summary: `${order.items?.map((item) => `${item.name || "Item"} ×${item.qty || 1}`).join(", ") || "Order"}${order.order_status ? ` · ${humanStatus(order.order_status)}` : ""}` })),
    ].filter((order, index, all) => all.findIndex((candidate) => candidate.name.toUpperCase() === order.name.toUpperCase()) === index);
    if (!orders.length) {
      await this.save({ phone, intent, step: "waiting_order", context: { ...context, retries: 1 } });
      return this.send(phone, "We couldn't find an order for that phone number. Check the number or send your RBD order number.", intent);
    }
    if (orders.length === 1) return this.dispatch(phone, intent, orders[0].name, context);
    await this.save({ phone, intent, step: "waiting_pick", context: { ...context, orders: orders.map((order) => ({ name: order.name, source: order.source })) } });
    await this.sendOrderChoices(phone, intent, orders);
  }

  private async dispatch(phone: string, intent: SupportIntent, orderNumber: string, context: Record<string, unknown> = {}) {
    try {
      const shopifyOrder = await this.dependencies.shopify.getOrderByName(orderNumber).catch((error) => { console.error(`[support:${phone}] Shopify order lookup failed`, error); return null; });
      const nimbusOrder = shopifyOrder ? null : await this.dependencies.nimbus.lookupOrder(orderNumber).catch((error) => { console.error(`[support:${phone}] Nimbus order lookup failed`, error); return null; });
      if (!shopifyOrder && !nimbusOrder) throw new Error(`Order ${orderNumber} was not found in Shopify or NimbusPost`);
      const resolvedOrderNumber = shopifyOrder?.name || nimbusOrder?.order_number || orderNumber;
      if (shopifyOrder) await this.refreshShopifyIdentity(phone, [shopifyOrder]);
      else await this.remember(phone, `Order ${resolvedOrderNumber} was identified for the customer.`, intent, resolvedOrderNumber);
      if (intent === "confirm_order") return shopifyOrder ? await this.confirmOrder(phone, shopifyOrder) : await this.confirmNimbusOrder(phone, nimbusOrder!);
      if (intent === "order_status") return await this.orderStatus(phone, resolvedOrderNumber, shopifyOrder || undefined, nimbusOrder || undefined);
      if (intent === "not_dispatched") return await this.notDispatched(phone, resolvedOrderNumber, shopifyOrder || undefined, nimbusOrder || undefined);
      if (intent === "refund_return") return shopifyOrder ? await this.refundReturn(phone, shopifyOrder, context.ticketCategory as SupportTicket["category"] | undefined) : await this.refundNimbusOrder(phone, nimbusOrder!, context.ticketCategory as SupportTicket["category"] | undefined);
      if (intent === "change_address") {
        if (shopifyOrder) return await this.beginAddressChange(phone, shopifyOrder);
        return await this.beginNimbusAddressChange(phone, nimbusOrder!);
      }
      return await this.orderFailed(phone, resolvedOrderNumber, nimbusOrder || undefined);
    } catch (error) {
      console.error(`[support:${phone}] ${intent} failed`, error);
      await this.save({ phone, intent, step: "waiting_order", context: { retries: 0 } });
      await this.send(phone, `We couldn't complete that lookup right now. Please try again, or contact ${this.dependencies.supportPhone || "our support team"}.`, intent, orderNumber);
    }
  }

  private async confirmOrder(phone: string, order: ShopifyOrder) {
    const nimbus = await this.dependencies.nimbus.lookupOrder(order.name).catch(() => null);
    const items = order.lineItems.map((item) => `${item.title} ×${item.quantity}`).join(", ");
    const shipping = order.shippingAddress ? formatAddress(order.shippingAddress) : "Address unavailable";
    const courier = nimbus?.shipment?.courier_name ? `\n🚚 Courier: ${nimbus.shipment.courier_name}` : "";
    await this.dependencies.store.clearConversation(phone);
    await this.send(phone, `✅ Order ${order.name} is confirmed!\n📦 Items: ${items}\n💰 Total: ${formatMoney(order)} (${order.displayFinancialStatus || "payment status unavailable"})\n📍 Shipping to: ${shipping}${courier}`, "confirm_order", order.name);
  }

  private async confirmNimbusOrder(phone: string, order: OrderMatch) {
    const items = order.items?.map((item) => `${item.name || "Item"} ×${item.qty || 1}`).join(", ") || "Order items available in NimbusPost";
    const courier = order.shipment?.courier_name ? `\n🚚 Courier: ${order.shipment.courier_name}` : "";
    await this.dependencies.store.clearConversation(phone);
    await this.send(phone, `✅ Order ${order.order_number} is confirmed!\n📦 Items: ${items}\n📍 Status: ${humanStatus(order.order_status || "created")}${courier}`, "confirm_order", order.order_number);
  }

  private async orderStatus(phone: string, orderNumber: string, shopifyOrder?: ShopifyOrder, resolvedNimbusOrder?: OrderMatch) {
    const order = resolvedNimbusOrder || await this.dependencies.nimbus.lookupOrder(orderNumber).catch((error) => { console.error(`[support:${phone}] Nimbus order lookup failed; using Shopify status`, error); return null; });
    const shopifyTracking = shopifyOrder?.trackingInfo?.find((item) => item.number || item.url);
    const awb = order?.shipment?.awb || shopifyTracking?.number;
    if (!awb) {
      const status = order?.order_status || shopifyOrder?.displayFulfillmentStatus || "being processed";
      await this.dependencies.store.clearConversation(phone);
      return this.send(phone, `I understand it’s frustrating to wait without a clear update. I checked ${orderNumber} for you—it is currently ${humanStatus(status)} and has not been handed to the courier yet. Tracking will appear as soon as the courier booking is completed. 📦`, "order_status", orderNumber);
    }
    const tracking = await this.dependencies.nimbus.track(awb).catch((error) => { console.error(`[support:${phone}] Nimbus tracking lookup failed; using available shipment data`, error); return null; });
    const status = tracking?.latest?.shipStatus || tracking?.orderStatus || order?.order_status || shopifyOrder?.displayFulfillmentStatus || "processing";
    const location = tracking?.latest?.location ? `\n📍 Current location: ${tracking.latest.location}` : "";
    const eta = tracking?.shipment?.edd ? `\n📅 Expected delivery: ${formatDate(tracking.shipment.edd)}` : "";
    const trackingLink = shopifyTracking?.url ? `\n🔗 Track shipment: ${shopifyTracking.url}` : "";
    await this.dependencies.store.clearConversation(phone);
    if (tracking?.shipment?.edd && isPastDeliveryDate(tracking.shipment.edd) && !isDeliveredStatus(status)) {
      const existingTicket = await this.dependencies.store.findOpenSupportTicket(phone, "other", orderNumber);
      const ticketId = existingTicket?.ticketId || crypto.randomUUID();
      if (!existingTicket) {
        const reason = `Priority courier follow-up: ${orderNumber} is still ${humanStatus(status)} after its expected delivery date of ${formatDate(tracking.shipment.edd)}. Courier: ${tracking.shipment.courierName || order?.shipment?.courier_name || shopifyTracking?.company || "unknown"}; AWB: ${awb}.`;
        await this.dependencies.store.createSupportTicket({ ticketId, phone, orderNumber, category: "other", description: reason, metadata: { reason: "overdue_delivery", expectedDelivery: tracking.shipment.edd, shipmentStatus: status, awb }, status: "open", createdAt: new Date().toISOString() });
        const escalationPhone = String(this.dependencies.escalationPhone || this.dependencies.supportPhone || "").replace(/\D/g, "");
        if (escalationPhone && escalationPhone !== phone) await this.dependencies.whatsapp.sendText(escalationPhone, `🚨 Overdue delivery needs courier follow-up.\nCustomer: ${phone}\nOrder: ${orderNumber}\nExpected: ${formatDate(tracking.shipment.edd)}\nStatus: ${humanStatus(status)}\nAWB: ${awb}\nTicket: ${ticketId.slice(0, 8)}`).catch((error) => console.error(`[support:${phone}] overdue-delivery notification failed`, error));
      }
      return this.send(phone, `I’m sorry—${orderNumber} has passed its expected delivery date and is still ${humanStatus(status)}.${location}${eta}\n🚚 ${tracking.shipment.courierName || order?.shipment?.courier_name || shopifyTracking?.company || "Courier"}\n🔎 AWB: ${awb}${trackingLink}\n\nWe’ve marked your order as priority and alerted our support team to follow up with the courier. Your reference is ${ticketId.slice(0, 8)}. We’ll update you on WhatsApp as soon as we receive the courier’s response. 🙏`, "order_status", orderNumber);
    }
    await this.send(phone, `I checked ${orderNumber} for you. Here’s the latest update:\n\n${statusEmoji(status)} ${humanStatus(status)}${location}${eta}\n🚚 ${tracking?.shipment?.courierName || order?.shipment?.courier_name || shopifyTracking?.company || "Courier"}\n🔎 AWB: ${awb}${trackingLink}`, "order_status", orderNumber);
  }

  private async notDispatched(phone: string, orderNumber: string, shopifyOrder?: ShopifyOrder, resolvedNimbusOrder?: OrderMatch) {
    const order = resolvedNimbusOrder || await this.dependencies.nimbus.lookupOrder(orderNumber).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "NOT_FOUND") return null;
      throw error;
    });
    await this.dependencies.store.clearConversation(phone);
    if (!order) return this.send(phone, `I’m sorry this is taking longer than expected. I checked ${orderNumber}; it is still being prepared and has not been dispatched yet. During peak Rakhi season we receive a high volume of orders, and each Rakhi is handmade, so preparation can take a little extra time. We’ll share tracking as soon as it is handed to the courier. 📦`, "not_dispatched", orderNumber);
    const status = (order.order_status || "created").toLowerCase();
    if (order.shipment?.awb || shopifyOrder?.trackingInfo?.some((item) => item.number) || /shipped|transit|picked/.test(status)) return this.orderStatus(phone, orderNumber, shopifyOrder, order);
    const response = status === "booked" ? `I understand the delay is frustrating. ${orderNumber} is booked with ${order.shipment?.courier_name || "the courier"}, and pickup is scheduled.` : status === "created" ? `I’m sorry you’ve had to wait. ${orderNumber} is ready and queued for courier pickup. We’ll send the tracking details as soon as it is collected. 🚛` : `I checked ${orderNumber}; it is currently ${humanStatus(status)}. I know you’re waiting, and we’ll share tracking as soon as it is dispatched.`;
    await this.send(phone, response, "not_dispatched", orderNumber);
  }

  private async refundReturn(phone: string, order: ShopifyOrder, category: SupportTicket["category"] = "other") {
    const details = `We found ${order.name}: ${order.lineItems.map((item) => `${item.title} ×${item.quantity}`).join(", ")} · ${formatMoney(order)}.`;
    if (category === "refund" || category === "missing") return this.createEmailTicket(phone, category, details, order.name);
    await this.beginEscalation(phone, `Refund, return, exchange, or wrong-item request received on WhatsApp. ${details}`, category, order.name);
  }

  private async refundNimbusOrder(phone: string, order: OrderMatch, category: SupportTicket["category"] = "other") {
    if (category === "refund" || category === "missing") return this.createEmailTicket(phone, category, "Request received on WhatsApp for a NimbusPost order", order.order_number);
    await this.beginEscalation(phone, "Return, exchange, or wrong-item request received on WhatsApp for a NimbusPost order", category, order.order_number);
  }

  private async beginAddressChange(phone: string, shopifyOrder: ShopifyOrder) {
    const orderNumber = shopifyOrder.name;
    const nimbusOrder = await this.dependencies.nimbus.lookupOrder(orderNumber);
    const status = (nimbusOrder.order_status || "").toLowerCase();
    if (/delivered/.test(status)) { await this.dependencies.store.clearConversation(phone); return this.send(phone, `Order ${orderNumber} was already delivered, so its address can no longer be changed.`, "change_address", orderNumber); }
    const awb = nimbusOrder.shipment?.awb;
    if (awb) {
      const tracking = await this.dependencies.nimbus.track(awb);
      const ndr = await this.dependencies.nimbus.getNdr(awb);
      if (!ndr && /picked|transit|out for delivery|shipped/i.test(tracking.latest?.shipStatus || status)) {
        const reason = `Address or phone change requested after shipment reached ${tracking.latest?.shipStatus || status}.`; const existing = await this.dependencies.store.findOpenSupportTicket(phone, "address_change", orderNumber); const ticketId = existing?.ticketId || crypto.randomUUID();
        if (existing) await this.dependencies.store.updateSupportTicketDetails(ticketId, { description: reason, status: "open" }); else await this.dependencies.store.createSupportTicket({ ticketId, phone, orderNumber, category: "address_change", description: reason, status: "open", createdAt: new Date().toISOString() });
        await this.dependencies.store.clearConversation(phone); return this.send(phone, `I checked ${orderNumber}. Your order is already in transit with ${tracking.shipment?.courierName || nimbusOrder.shipment?.courier_name || "the courier"}, so the delivery address cannot be changed now. It should reach you in the next few days; please follow the tracking updates for the latest delivery progress.`, "change_address", orderNumber);
      }
      if (ndr) return this.askForAddress(phone, shopifyOrder, { branch: "ndr", awb });
    }
    return this.askForAddress(phone, shopifyOrder, { branch: "pending" });
  }

  private async beginNimbusAddressChange(phone: string, order: OrderMatch) {
    const orderNumber = order.order_number; const tracking = order.shipment?.awb ? await this.dependencies.nimbus.track(order.shipment.awb).catch(() => null) : null; const liveStatus = tracking?.latest?.shipStatus || tracking?.orderStatus || order.order_status || "created";
    if (/picked|in[ -]?transit|transit|out for delivery|shipped|delivered|rto/i.test(liveStatus)) {
      const reason = `Address change requested after shipment reached ${liveStatus}.`; const existingTicket = await this.dependencies.store.findOpenSupportTicket(phone, "address_change", orderNumber); const ticketId = existingTicket?.ticketId || crypto.randomUUID();
      if (existingTicket) await this.dependencies.store.updateSupportTicketDetails(ticketId, { description: reason, status: "open" }); else await this.dependencies.store.createSupportTicket({ ticketId, phone, orderNumber, category: "address_change", description: reason, status: "open", metadata: { shipmentStatus: liveStatus, changeAllowed: false }, createdAt: new Date().toISOString() });
      await this.dependencies.store.clearConversation(phone); return this.send(phone, `I checked ${orderNumber}. Your order is currently ${humanStatus(liveStatus)} and is already moving through the courier network, so the delivery address cannot be changed now. It should reach you in the next few days; please follow the tracking updates for the latest delivery progress.`, "change_address", orderNumber);
    }
    const currentAddress = order.shipping_address;
    await this.save({ phone, intent: "change_address", step: "waiting_address", context: { orderNumber, branch: "nimbus_pending", existingAddress: { name: currentAddress?.name, phone: String(currentAddress?.phone || phone).replace(/\D/g, "").slice(-10), address1: currentAddress?.address || "", city: currentAddress?.city || "", province: currentAddress?.state || "", zip: String(currentAddress?.pincode || ""), country: "India" } } });
    await this.send(phone, `I checked ${orderNumber}. It has not entered transit yet, so an address change can still be requested. Please send the complete new address in this format:\nHouse/street, City, State, 6-digit PIN\nExample: 14 Park Street, Kolkata, West Bengal, 700016`, "change_address", orderNumber);
  }

  private async askForAddress(phone: string, order: ShopifyOrder, extra: Record<string, unknown>) {
    await this.save({ phone, intent: "change_address", step: "waiting_address", context: { orderNumber: order.name, orderId: order.id, existingAddress: order.shippingAddress || {}, ...extra } });
    await this.send(phone, "Send the complete new address in this format:\nHouse/street, City, State, 6-digit PIN\nExample: 14 Park Street, Kolkata, West Bengal, 700016", "change_address", order.name);
  }

  private async applyAddressUpdate(phone: string, context: Record<string, unknown>) {
    const orderNumber = String(context.orderNumber || ""); const address = context.newAddress as ShopifyAddress;
    const requestedAddress = `${formatAddress(address)} · Phone ${address.phone || "not provided"}`;
    const recoveryTicket: SupportTicket = { ticketId: crypto.randomUUID(), phone, orderNumber, category: "address_change", description: `Address change requested: ${requestedAddress}`, status: "open", metadata: { requestedAddress: address, branch: String(context.branch || "pending") }, createdAt: new Date().toISOString() };
    await this.dependencies.store.createSupportTicket(recoveryTicket);
    let businessError: unknown;
    try {
      if (context.branch === "ndr") {
        await this.dependencies.nimbus.submitNdrAction(String(context.awb), { action: "reattempt", updated_address: { address: address.address1, city: address.city, state: address.province || "", pincode: address.zip }, updated_phone: address.phone });
        await this.dependencies.shopify.updateOrderAddress(String(context.orderId), address);
      } else if (context.branch === "nimbus_pending") {
        await this.dependencies.nimbus.replacePendingOrderAddress(orderNumber, address);
      } else {
        await this.dependencies.shopify.updateOrderAddress(String(context.orderId), address);
        await this.dependencies.nimbus.replacePendingOrderAddress(orderNumber, address);
      }
    } catch (error) {
      businessError = error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (context.branch === "pending" && code === "REPLACEMENT_FAILED_RESTORED" && context.existingAddress) await this.dependencies.shopify.updateOrderAddress(String(context.orderId), context.existingAddress as ShopifyAddress).catch(() => undefined);
    }
    if (businessError) {
      await this.dependencies.store.clearConversation(phone).catch(() => undefined);
      return this.send(phone, `I couldn’t complete the address change automatically, but I recorded the complete new address in AutoShip under ticket ${recoveryTicket.ticketId.slice(0, 8)} for our team to update before dispatch.`, "change_address", orderNumber);
    }
    await this.dependencies.store.updateSupportTicket(recoveryTicket.ticketId, "resolved").catch((error) => console.error(`[support:${phone}] could not resolve recovery ticket`, error));
    await this.dependencies.store.clearConversation(phone).catch((error) => console.error(`[support:${phone}] could not clear completed address flow`, error));
    await this.send(phone, context.branch === "ndr" ? "✅ Your address has been updated and re-delivery has been requested." : "✅ Your delivery address has been updated. I’ve also recorded the change in AutoShip for our team.", "change_address", orderNumber);
  }

  private async orderFailed(phone: string, orderNumber: string, resolvedNimbusOrder?: OrderMatch) {
    const order = resolvedNimbusOrder || await this.dependencies.nimbus.lookupOrder(orderNumber);
    const awb = order.shipment?.awb;
    if (!awb) { await this.dependencies.store.clearConversation(phone); return this.send(phone, `Order ${orderNumber} has no courier shipment yet, so there is no failed delivery to action.`, "order_failed", orderNumber); }
    const ndr = await this.dependencies.nimbus.getNdr(awb);
    if (!ndr) { const tracking = await this.dependencies.nimbus.track(awb); await this.dependencies.store.clearConversation(phone); return this.send(phone, `The courier status is ${tracking.latest?.shipStatus || "unavailable"}${tracking.latest?.message ? `: ${tracking.latest.message}` : ""}. Please contact ${this.dependencies.supportPhone || "support"} for the next step.`, "order_failed", orderNumber); }
    const availableActions = ndr.available_actions === undefined ? ["reattempt", "rto"] : ndr.available_actions;
    const choices = [availableActions.includes("reattempt") ? "1️⃣ Re-attempt delivery\n2️⃣ Update address/phone" : "", availableActions.includes("rto") ? "3️⃣ Return to sender" : ""].filter(Boolean).join("\n");
    if (!choices) { await this.dependencies.store.clearConversation(phone); return this.send(phone, `The courier has not provided an available recovery action. Please contact ${this.dependencies.supportPhone || "support"}.`, "order_failed", orderNumber); }
    await this.save({ phone, intent: "order_failed", step: "waiting_ndr_choice", context: { orderNumber, awb, availableActions } });
    await this.send(phone, `⚠️ Delivery was attempted${ndr.last_attempt_date ? ` on ${formatDate(ndr.last_attempt_date)}` : ""}.\nReason: ${ndr.remarks || "Courier exception"}\nAttempt #${ndr.attempt_count || 1}\n\n${choices}`, "order_failed", orderNumber);
  }

  private async handleNdrChoice(phone: string, text: string, context: Record<string, unknown>) {
    const orderNumber = String(context.orderNumber || ""); const awb = String(context.awb || "");
    const availableActions = Array.isArray(context.availableActions) ? context.availableActions.map(String) : ["reattempt", "rto"];
    if (text.trim() === "1" && availableActions.includes("reattempt")) { await this.dependencies.nimbus.submitNdrAction(awb, { action: "reattempt" }); await this.dependencies.store.clearConversation(phone); return this.send(phone, "✅ Re-delivery has been requested. The courier will attempt again soon.", "order_failed", orderNumber); }
    if (text.trim() === "3" && availableActions.includes("rto")) { await this.dependencies.nimbus.submitNdrAction(awb, { action: "rto" }); await this.dependencies.store.clearConversation(phone); return this.send(phone, `↩️ Return to sender has been requested. Contact ${this.dependencies.supportPhone || "support"} for refund questions.`, "order_failed", orderNumber); }
    if (text.trim() === "2" && availableActions.includes("reattempt")) {
      const order = await this.requireShopifyOrder(orderNumber);
      return this.askForAddress(phone, order, { branch: "ndr", awb });
    }
    await this.send(phone, "That action is not currently available from the courier. Choose one of the options shown above.", "order_failed", orderNumber);
  }

  private async requireShopifyOrder(orderNumber: string) {
    const order = await this.dependencies.shopify.getOrderByName(orderNumber);
    if (!order) throw new Error(`Order ${orderNumber} was not found in Shopify`);
    return order;
  }

  private async sendOrderChoices(phone: string, intent: SupportIntent, orders: Array<{ name: string; source?: "shopify" | "nimbus"; summary: string }>) {
    const lines = orders.map((order, index) => `${index + 1}. ${order.name} — ${order.summary}`);
    const chunks: string[] = [];
    let chunk = orders.every((order) => order.source === "shopify") ? "We found these Shopify orders for your customer account:" : "We found these orders for your phone number:";
    for (const line of lines) {
      if (`${chunk}\n${line}`.length > 3_500) { chunks.push(chunk); chunk = line; }
      else chunk += `\n${line}`;
    }
    chunks.push(`${chunk}\n\nReply with the list number or any order ID above for live tracking or another action.`);
    for (const message of chunks) await this.send(phone, message, intent);
  }

  private async send(phone: string, text: string, intent?: SupportIntent, orderNumber?: string, aiProvider?: AiProviderName) {
    const safeText = looksLikeInternalJson(text) ? "I’m sorry, I couldn’t format that reply correctly. Please send your question once more and I’ll help you." : text;
    await this.dependencies.whatsapp.sendText(phone, safeText);
    await this.dependencies.store.addWhatsAppMessage({ phone, direction: "outbound", source: "bot", text: safeText, ...(intent ? { intent } : {}), ...(orderNumber ? { orderNumber } : {}), ...(aiProvider ? { aiProvider } : {}) });
    if (intent || orderNumber) await this.remember(phone, safeText, intent, orderNumber).catch((error) => console.error(`[support:${phone}] customer memory update failed`, error));
  }

  private save(conversation: Omit<SupportConversation, "updatedAt" | "expiresAt">) { return this.dependencies.store.saveConversation(conversation); }
}

function parseAddress(text: string): ShopifyAddress | null {
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 4) return null;
  const zip = parts.pop()!.replace(/\D/g, "");
  const province = parts.pop()!;
  const city = parts.pop()!;
  const address1 = parts.join(", ");
  return address1.length >= 5 && city.length >= 2 && province.length >= 2 && /^\d{6}$/.test(zip) ? { address1, city, province, zip, country: "India" } : null;
}
const refundCategory = (text: string): SupportTicket["category"] => /missing|nahi aaya|rakhi nahi/i.test(text) ? "missing" : /refund|paisa wapas/i.test(text) ? "refund" : /return|exchange|replace(?:ment)?|wrong item|galat item|badalna/i.test(text) ? "return" : "other";
const extractLikelyOrderTypo = (text: string) => { const match = /\b(?:RNF|RBF)\s*#?\s*(\d{4,5})\b/i.exec(text); return match ? `RBD${match[1]}` : undefined; };
const looksLikeInternalJson = (text: string) => /^\s*[\[{]/.test(text) && /["']?(?:text|toolCalls?|resolved|escalate)["']?\s*:/.test(text);
const summarizeConversation = (history: Array<{ direction: string; text: string }>, reply: string) => [...history.slice(-5).map((item) => `${item.direction}: ${item.text}`), `reply: ${reply}`].join(" | ").slice(0, 2_000);
const newCustomerMemory = (phone: string): CustomerMemory => ({ phone, summary: "", knownOrderNumbers: [], issueHistory: [], profile: {}, updatedAt: new Date(0).toISOString() });
const canonicalCustomerPhone = (phone: string) => { const local = normalizePhoneNumber(phone); return local ? `91${local}` : phone.replace(/\D/g, ""); };
export function buildAiContext(memory: CustomerMemory, history: WhatsAppMessage[], maxChars: number) {
  const safeMax = Math.max(10_000, Math.trunc(maxChars));
  const profile = JSON.stringify({ version: 1, phone: memory.phone, customerName: memory.customerName, shopifyCustomerId: memory.shopifyCustomerId, knownOrderNumbers: memory.knownOrderNumbers, currentIssue: memory.currentIssue, previousSummary: memory.summary, issueHistory: memory.issueHistory, profile: memory.profile });
  const profileMessage: ChatMessage = { role: "assistant", content: `[CUSTOMER_CONTEXT_JSON]\n${profile}\nUse this as private support context. Never expose the JSON or internal fields to the customer.` };
  const allMessages = history.map((message) => ({ role: message.direction === "inbound" ? "user" as const : "assistant" as const, content: message.text }));
  const total = profileMessage.content.length + allMessages.reduce((sum, message) => sum + message.content.length, 0);
  if (total <= safeMax) return { messages: [profileMessage, ...allMessages] as ChatMessage[] };
  const reserved = Math.min(Math.floor(safeMax * 0.35), 30_000); const recent: ChatMessage[] = []; let recentChars = 0; let splitIndex = history.length;
  for (let index = history.length - 1; index >= 0; index -= 1) { const candidate = allMessages[index]; if (recent.length && recentChars + candidate.content.length > safeMax - reserved) break; recent.unshift(candidate); recentChars += candidate.content.length; splitIndex = index; }
  const archived = history.slice(0, splitIndex); const archiveSummary = archived.map((message) => `${message.createdAt} ${message.direction}${message.intent ? `/${message.intent}` : ""}${message.orderNumber ? `/${message.orderNumber}` : ""}: ${message.text.replace(/\s+/g, " ").slice(0, 280)}`).join("\n").slice(-Math.max(1_000, reserved - profileMessage.content.length));
  const archiveMessage: ChatMessage = { role: "assistant", content: `[ARCHIVED_CHAT_HISTORY through message ${archived.at(-1)?.id || "unknown"}]\n${archiveSummary}` };
  return { messages: [profileMessage, archiveMessage, ...recent], archiveSummary, archivedThroughMessageId: archived.at(-1)?.id };
}
const formatAddress = (address: ShopifyAddress) => [address.address1, address.address2, address.city, address.province, address.zip].filter(Boolean).join(", ");
const formatMoney = (order: ShopifyOrder) => new Intl.NumberFormat("en-IN", { style: "currency", currency: order.currencyCode }).format(Number(order.totalAmount));
const formatShopifyOrderSummary = (order: ShopifyOrder) => {
  const items = order.lineItems.map((item) => `${item.title} ×${item.quantity}`).join(", ") || "Order items unavailable";
  const date = new Date(order.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const statuses = [order.displayFinancialStatus, order.displayFulfillmentStatus].filter(Boolean).map((status) => humanStatus(String(status))).join(" / ");
  const tracking = order.trackingInfo?.find((item) => item.number || item.url);
  const address = order.shippingAddress ? formatAddress(order.shippingAddress) : "Address unavailable";
  return `${date}\n   📦 ${items}\n   💰 ${formatMoney(order)}${statuses ? ` · ${statuses}` : ""}\n   📍 ${address}${tracking?.number ? `\n   🚚 AWB ${tracking.number}${tracking.company ? ` · ${tracking.company}` : ""}` : ""}`;
};
const inferIntent = (messages: ChatMessage[]): SupportIntent | undefined => {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    const intent = classifyIntent(message.content);
    if (intent) return intent;
  }
  return undefined;
};
const isSupportIntent = (value: unknown): value is SupportIntent => typeof value === "string" && ["confirm_order", "change_address", "order_status", "not_dispatched", "order_failed", "refund_return", "product_inquiry", "additional_purchase", "real_picture_request", "contact_request"].includes(value);
const isTicketCategory = (value: unknown): value is SupportTicket["category"] => typeof value === "string" && ["refund", "return", "missing", "address_change", "contact_request", "other"].includes(value);
const DEFAULT_BRAIN = "You are AutoShip support. Return JSON with text, toolCalls, resolved, and escalate. Never invent order facts; use a tool for every order question.";
const DEFAULT_POLICY_GUIDANCE = "Our team will review your refund, return, exchange, or missing-item request according to the store policy. Please keep the item and packaging safe until our senior support team confirms the next step.";
const escalationEmpathy = (category: SupportTicket["category"]) => category === "missing"
  ? "I’m really sorry an item is missing from your order. I understand how disappointing that is."
  : category === "refund"
    ? "I understand you want this refund request handled properly, and I’ll make sure the right team reviews it."
    : "I’m sorry the order wasn’t right. I’ll help you get this reviewed for a return or exchange.";
const formatDate = (value: string) => new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const deliveryDateKey = (value: string | Date) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
};
const isPastDeliveryDate = (edd: string, now = new Date()) => {
  const expected = deliveryDateKey(edd); const today = deliveryDateKey(now);
  return Boolean(expected && today && expected < today);
};
const isDeliveredStatus = (status: string) => /\bdelivered\b/i.test(status) && !/\b(?:not|un|failed|undelivered)\b/i.test(status);
const statusEmoji = (status: string) => /delivered/i.test(status) ? "✅" : /out for delivery/i.test(status) ? "🎉" : /ndr|fail/i.test(status) ? "⚠️" : /rto|return/i.test(status) ? "↩️" : "🚚";
const humanStatus = (status: string) => status.replace(/\b\w/g, (letter) => letter.toUpperCase());

export { INTENTS, parseAddress, refundCategory };
