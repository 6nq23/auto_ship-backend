import type { Store } from "./store.js";
import type { NimbusClient } from "./nimbus.js";
import type { ShopifyClient } from "./shopify.js";
import type { IncomingWhatsAppMessage, WhatsAppClient } from "./whatsapp.js";
import type { OrderMatch, ShopifyAddress, ShopifyOrder, SupportConversation, SupportIntent, SupportTicket } from "./types.js";
import { extractPhoneNumber, normalizeOrderNumber, normalizePhoneNumber } from "./identifiers.js";

const INTENTS: Record<string, SupportIntent> = {
  "1": "confirm_order",
  "2": "change_address",
  "3": "order_status",
  "4": "not_dispatched",
  "5": "order_failed",
  "6": "refund_return",
};

const KEYWORDS: Array<[SupportIntent, RegExp]> = [
  ["refund_return", /\b(refund|return|missing|wrong item|galat item|paisa wapas|nahi aaya|rakhi nahi)\b/i],
  ["order_failed", /\b(fail(?:ed)?|delivery fail|deliver nahi|nahi mila|attempt|undelivered|return ho gaya|ndr)\b/i],
  ["not_dispatched", /\b(not dispatch|dispatch nahi|not ship|ship nahi|kab bhejoge|nahi bheja|why not shipped)\b/i],
  ["change_address", /\b(address|phone|number)\b.*\b(change|update|badlo|galat|wrong)\b|\b(change|update|badlo|galat|wrong)\b.*\b(address|phone|number)\b/i],
  ["order_status", /\b(status|tracking|track|kaha hai|where|kab aayega|kab milega|kidhar)\b/i],
  ["confirm_order", /\b(confirm|pakka|order confirm|mera order aaya|placed|order hua)\b/i],
];

export const classifyIntent = (text: string): SupportIntent | undefined => {
  const menu = INTENTS[text.trim()];
  return menu || KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0];
};
export const extractOrderNumber = normalizeOrderNumber;
export { extractPhoneNumber };

type RouterDependencies = { store: Store; shopify: ShopifyClient; nimbus: NimbusClient; whatsapp: WhatsAppClient; supportPhone: string };

export class WhatsAppRouter {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly dependencies: RouterDependencies) {}

  async handleIncomingMessage(message: IncomingWhatsAppMessage) {
    const previous = this.locks.get(message.phone) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.dependencies.store.withConversationLock(message.phone, () => this.process(message)));
    this.locks.set(message.phone, current);
    try { await current; } finally { if (this.locks.get(message.phone) === current) this.locks.delete(message.phone); }
  }

  async handleManualAgentMessage(message: IncomingWhatsAppMessage) {
    const text = message.text.trim().slice(0, 2_000);
    if (!text || await this.dependencies.store.isRecentBotMessage?.(message.phone, text)) return;
    const inserted = await this.dependencies.store.addWhatsAppMessage({ phone: message.phone, direction: "outbound", source: "agent", text, providerMessageId: message.id });
    if (!inserted) return;
    await this.dependencies.store.setBotPaused?.(message.phone, true, "agent_message");
  }

  private async process(message: IncomingWhatsAppMessage) {
    const text = message.text.trim().slice(0, 2_000);
    if (!text) return;
    const inserted = await this.dependencies.store.addWhatsAppMessage({ phone: message.phone, direction: "inbound", source: "customer", text, providerMessageId: message.id });
    if (!inserted) return;
    if (await this.dependencies.store.isBotPaused?.(message.phone)) return;
    const conversation = await this.dependencies.store.getConversation(message.phone);
    if (conversation) return this.resume(conversation, text);
    const intent = classifyIntent(text);
    if (!intent) return this.showMenu(message.phone);
    const context = intent === "refund_return" ? { ticketCategory: refundCategory(text) } : {};
    if (intent === "refund_return" && context.ticketCategory === "other") return this.askRefundIssue(message.phone);
    const orderNumber = extractOrderNumber(text);
    const phoneNumber = extractPhoneNumber(text);
    if (orderNumber || phoneNumber) return this.resolveIdentifier(message.phone, intent, orderNumber || phoneNumber!, context);
    await this.askForOrder(message.phone, intent, context);
  }

  private async resume(conversation: SupportConversation, text: string) {
    const { phone, step, intent, context } = conversation;
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
    if (step === "waiting_order" && intent) {
      const identifier = extractOrderNumber(text) || extractPhoneNumber(text);
      if (identifier) return this.resolveIdentifier(phone, intent, identifier, context);
      const retries = Number(context.retries || 0) + 1;
      if (retries >= 3) return this.showMenu(phone, "We could not identify an order. Let's start again.");
      await this.save({ phone, intent, step, context: { ...context, retries } });
      return this.send(phone, "Sorry, I didn't understand. Please send an order number like RBD5001 or a 10-digit phone number.", intent);
    }
    if (step === "waiting_pick" && intent) {
      const options = Array.isArray(context.orders) ? context.orders as Array<{ name: string; source?: "shopify" | "nimbus" }> : [];
      const selected = options[Number(text.trim()) - 1];
      if (!selected) return this.send(phone, `Reply with a number from 1 to ${options.length}.`, intent);
      return this.dispatch(phone, intent, selected.name, { ...context, customerPhoneVerified: selected.source === "shopify" });
    }
    if (step === "waiting_nimbus_verify" && intent) {
      const pincode = text.replace(/\D/g, "");
      const orderNumber = String(context.orderNumber || "");
      if (!/^\d{6}$/.test(pincode)) return this.send(phone, "Please reply with the 6-digit delivery PIN code for this order.", intent, orderNumber);
      const order = await this.dependencies.nimbus.lookupOrder(orderNumber).catch(() => null);
      const expectedPincode = String(order?.shipping_address?.pincode || "").replace(/\D/g, "");
      if (!order || expectedPincode !== pincode) {
        const retries = Number(context.retries || 0) + 1;
        if (retries >= 3) {
          await this.dependencies.store.clearConversation(phone);
          return this.send(phone, `We couldn't verify that order. Please contact ${this.dependencies.supportPhone || "support"}.`, intent, orderNumber);
        }
        await this.save({ phone, intent, step, context: { ...context, retries } });
        return this.send(phone, "That PIN code did not match the order. Please check the 6-digit delivery PIN code and try again.", intent, orderNumber);
      }
      return this.dispatch(phone, intent, orderNumber, { ...context, nimbusVerified: true });
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
    return this.showMenu(phone, "That conversation expired or reached an unknown step. Let's start again.");
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
    await this.send(phone, "What do you need help with?\n1️⃣ Refund\n2️⃣ Return or wrong item\n3️⃣ Missing item", "refund_return");
  }

  private async resolveIdentifier(phone: string, intent: SupportIntent, identifier: string, context: Record<string, unknown> = {}) {
    if (identifier.startsWith("#RBD")) return this.dispatch(phone, intent, identifier, context);
    if (normalizePhoneNumber(identifier) !== normalizePhoneNumber(phone)) {
      await this.dependencies.store.clearConversation(phone);
      return this.send(phone, `For your security, order lookup must use the phone number connected to this WhatsApp chat. Please message us from the order phone or contact ${this.dependencies.supportPhone || "support"}.`);
    }
    const [shopifyOrders, nimbusOrders] = await Promise.all([
      this.dependencies.shopify.getOrdersByPhone(identifier).catch((error) => { console.error(`[support:${phone}] Shopify phone lookup failed`, error); return []; }),
      this.dependencies.nimbus.getOrdersByPhone(identifier).catch((error) => { console.error(`[support:${phone}] Nimbus phone lookup failed`, error); return []; }),
    ]);
    const orders = [
      ...shopifyOrders.map((order) => ({ name: order.name, source: "shopify" as const, summary: formatShopifyOrderSummary(order) })),
      ...nimbusOrders.map((order) => ({ name: order.order_number, source: "nimbus" as const, summary: `${order.items?.map((item) => `${item.name || "Item"} ×${item.qty || 1}`).join(", ") || "Order"}${order.order_status ? ` · ${humanStatus(order.order_status)}` : ""}` })),
    ].filter((order, index, all) => all.findIndex((candidate) => candidate.name.toUpperCase() === order.name.toUpperCase()) === index);
    if (!orders.length) {
      await this.save({ phone, intent, step: "waiting_order", context: { ...context, retries: 1 } });
      return this.send(phone, "We couldn't find an order for that phone number. Check the number or send your RBD order number.", intent);
    }
    if (orders.length === 1) return this.dispatch(phone, intent, orders[0].name, { ...context, customerPhoneVerified: orders[0].source === "shopify" });
    const visibleOrders = orders.slice(0, 9);
    await this.save({ phone, intent, step: "waiting_pick", context: { ...context, orders: visibleOrders.map((order) => ({ name: order.name, source: order.source })) } });
    const choices = orders.slice(0, 9).map((order, index) => `${index + 1}️⃣ ${order.name} — ${order.summary}`).join("\n");
    await this.send(phone, `We found these orders:\n${choices}\nReply with the number.`, intent);
  }

  private async dispatch(phone: string, intent: SupportIntent, orderNumber: string, context: Record<string, unknown> = {}) {
    try {
      const shopifyOrder = await this.dependencies.shopify.getOrderByName(orderNumber).catch((error) => { console.error(`[support:${phone}] Shopify order lookup failed`, error); return null; });
      const nimbusOrder = shopifyOrder ? null : await this.dependencies.nimbus.lookupOrder(orderNumber).catch((error) => { console.error(`[support:${phone}] Nimbus order lookup failed`, error); return null; });
      if (!shopifyOrder && !nimbusOrder) throw new Error(`Order ${orderNumber} was not found in Shopify or NimbusPost`);
      if (!shopifyOrder && nimbusOrder && !this.nimbusHasReadablePhone(nimbusOrder) && context.nimbusVerified !== true) {
        await this.save({ phone, intent, step: "waiting_nimbus_verify", context: { ...context, orderNumber: nimbusOrder.order_number, retries: 0 } });
        return await this.send(phone, `We found ${nimbusOrder.order_number}. To verify it securely, please reply with the 6-digit delivery PIN code.`, intent, nimbusOrder.order_number);
      }
      const belongsToSender = shopifyOrder ? context.customerPhoneVerified === true || this.orderBelongsToSender(shopifyOrder, phone) : context.nimbusVerified === true || this.nimbusOrderBelongsToSender(nimbusOrder!, phone);
      if (!belongsToSender) {
        await this.dependencies.store.clearConversation(phone);
        return await this.send(phone, `We couldn't verify that order against this WhatsApp number. Please message us from the phone used on the order or contact ${this.dependencies.supportPhone || "support"}.`);
      }
      if (intent === "confirm_order") return shopifyOrder ? await this.confirmOrder(phone, shopifyOrder) : await this.confirmNimbusOrder(phone, nimbusOrder!);
      if (intent === "order_status") return await this.orderStatus(phone, orderNumber, shopifyOrder || undefined, nimbusOrder || undefined);
      if (intent === "not_dispatched") return await this.notDispatched(phone, orderNumber, shopifyOrder || undefined, nimbusOrder || undefined);
      if (intent === "refund_return") return shopifyOrder ? await this.refundReturn(phone, shopifyOrder, context.ticketCategory as SupportTicket["category"] | undefined) : await this.refundNimbusOrder(phone, nimbusOrder!, context.ticketCategory as SupportTicket["category"] | undefined);
      if (intent === "change_address") {
        if (shopifyOrder) return await this.beginAddressChange(phone, shopifyOrder);
        await this.dependencies.store.clearConversation(phone);
        return await this.send(phone, `We found ${nimbusOrder!.order_number}, but it is not linked to the configured Shopify store, so the bot cannot safely change its address. Please contact ${this.dependencies.supportPhone || "support"}.`, intent, nimbusOrder!.order_number);
      }
      return await this.orderFailed(phone, orderNumber, nimbusOrder || undefined);
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
      return this.send(phone, `📦 ${orderNumber} is ${humanStatus(status)}. Tracking will appear after courier booking.`, "order_status", orderNumber);
    }
    const tracking = await this.dependencies.nimbus.track(awb).catch((error) => { console.error(`[support:${phone}] Nimbus tracking lookup failed; using available shipment data`, error); return null; });
    const status = tracking?.latest?.shipStatus || tracking?.orderStatus || order?.order_status || shopifyOrder?.displayFulfillmentStatus || "processing";
    const location = tracking?.latest?.location ? `\n📍 Current location: ${tracking.latest.location}` : "";
    const eta = tracking?.shipment?.edd ? `\n📅 Expected delivery: ${formatDate(tracking.shipment.edd)}` : "";
    const trackingLink = shopifyTracking?.url ? `\n🔗 Track shipment: ${shopifyTracking.url}` : "";
    await this.dependencies.store.clearConversation(phone);
    await this.send(phone, `${statusEmoji(status)} ${humanStatus(status)}${location}${eta}\n🚚 ${tracking?.shipment?.courierName || order?.shipment?.courier_name || shopifyTracking?.company || "Courier"}\n🔎 AWB: ${awb}${trackingLink}`, "order_status", orderNumber);
  }

  private async notDispatched(phone: string, orderNumber: string, shopifyOrder?: ShopifyOrder, resolvedNimbusOrder?: OrderMatch) {
    const order = resolvedNimbusOrder || await this.dependencies.nimbus.lookupOrder(orderNumber).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "NOT_FOUND") return null;
      throw error;
    });
    await this.dependencies.store.clearConversation(phone);
    if (!order) return this.send(phone, `Your order ${orderNumber} is being processed by our team and should be prepared within 24–48 hours. We'll share tracking once dispatched. 📦`, "not_dispatched", orderNumber);
    const status = (order.order_status || "created").toLowerCase();
    if (order.shipment?.awb || shopifyOrder?.trackingInfo?.some((item) => item.number) || /shipped|transit|picked/.test(status)) return this.orderStatus(phone, orderNumber, shopifyOrder, order);
    const response = status === "booked" ? `Your order is booked with ${order.shipment?.courier_name || "the courier"}. Pickup is scheduled.` : status === "created" ? "Your order is ready and queued for shipping. Courier pickup should happen today or tomorrow. 🚛" : `Your order is currently ${status}. We'll share tracking after dispatch.`;
    await this.send(phone, response, "not_dispatched", orderNumber);
  }

  private async refundReturn(phone: string, order: ShopifyOrder, category: SupportTicket["category"] = "other") {
    const ticket: SupportTicket = { ticketId: crypto.randomUUID(), phone, orderNumber: order.name, category, description: "Refund, return, missing, or wrong-item request received on WhatsApp", status: "open", createdAt: new Date().toISOString() };
    await this.dependencies.store.createSupportTicket(ticket);
    await this.dependencies.store.clearConversation(phone);
    await this.send(phone, `We found ${order.name} (${order.lineItems.map((item) => `${item.title} ×${item.quantity}`).join(", ")}, ${formatMoney(order)}).\n\nFor refund, return, or missing-item help, please WhatsApp/call ${this.dependencies.supportPhone || "our support team"} and mention order ${order.name}. Ticket ${ticket.ticketId.slice(0, 8)} has been logged. 🙏`, "refund_return", order.name);
  }

  private async refundNimbusOrder(phone: string, order: OrderMatch, category: SupportTicket["category"] = "other") {
    const ticket: SupportTicket = { ticketId: crypto.randomUUID(), phone, orderNumber: order.order_number, category, description: "Refund, return, missing, or wrong-item request received on WhatsApp for a NimbusPost order", status: "open", createdAt: new Date().toISOString() };
    await this.dependencies.store.createSupportTicket(ticket);
    await this.dependencies.store.clearConversation(phone);
    await this.send(phone, `We found ${order.order_number}. Ticket ${ticket.ticketId.slice(0, 8)} has been logged. Please WhatsApp/call ${this.dependencies.supportPhone || "our support team"} and mention the order number for refund or return help. 🙏`, "refund_return", order.order_number);
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
      if (!ndr && /picked|transit|out for delivery|shipped/i.test(tracking.latest?.shipStatus || status)) { await this.dependencies.store.clearConversation(phone); return this.send(phone, `Order ${orderNumber} is already in transit with ${tracking.shipment?.courierName || nimbusOrder.shipment?.courier_name || "the courier"}. We cannot change its address now. Please contact ${this.dependencies.supportPhone || "support"}.`, "change_address", orderNumber); }
      if (ndr) return this.askForAddress(phone, shopifyOrder, { branch: "ndr", awb });
    }
    return this.askForAddress(phone, shopifyOrder, { branch: "pending" });
  }

  private async askForAddress(phone: string, order: ShopifyOrder, extra: Record<string, unknown>) {
    await this.save({ phone, intent: "change_address", step: "waiting_address", context: { orderNumber: order.name, orderId: order.id, existingAddress: order.shippingAddress || {}, ...extra } });
    await this.send(phone, "Send the complete new address in this format:\nHouse/street, City, State, 6-digit PIN\nExample: 14 Park Street, Kolkata, West Bengal, 700016", "change_address", order.name);
  }

  private async applyAddressUpdate(phone: string, context: Record<string, unknown>) {
    const orderNumber = String(context.orderNumber || ""); const address = context.newAddress as ShopifyAddress;
    const recoveryTicket: SupportTicket = { ticketId: crypto.randomUUID(), phone, orderNumber, category: "other", description: `Address update recovery record (${context.branch === "ndr" ? "NDR" : "pre-dispatch"})`, status: "open", createdAt: new Date().toISOString() };
    await this.dependencies.store.createSupportTicket(recoveryTicket);
    let businessError: unknown;
    try {
      if (context.branch === "ndr") {
        await this.dependencies.nimbus.submitNdrAction(String(context.awb), { action: "reattempt", updated_address: { address: address.address1, city: address.city, state: address.province || "", pincode: address.zip }, updated_phone: address.phone });
        await this.dependencies.shopify.updateOrderAddress(String(context.orderId), address);
      } else {
        await this.dependencies.shopify.updateOrderAddress(String(context.orderId), address);
        await this.dependencies.nimbus.replacePendingOrderAddress(orderNumber, address);
      }
    } catch (error) {
      businessError = error;
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (context.branch !== "ndr" && code === "REPLACEMENT_FAILED_RESTORED" && context.existingAddress) await this.dependencies.shopify.updateOrderAddress(String(context.orderId), context.existingAddress as ShopifyAddress).catch(() => undefined);
    }
    if (businessError) {
      await this.dependencies.store.clearConversation(phone).catch(() => undefined);
      return this.send(phone, `We couldn't finish the address update safely. We logged ticket ${recoveryTicket.ticketId.slice(0, 8)} for manual help. Please contact ${this.dependencies.supportPhone || "support"} before dispatch.`, "change_address", orderNumber);
    }
    await this.dependencies.store.updateSupportTicket(recoveryTicket.ticketId, "resolved").catch((error) => console.error(`[support:${phone}] could not resolve recovery ticket`, error));
    await this.dependencies.store.clearConversation(phone).catch((error) => console.error(`[support:${phone}] could not clear completed address flow`, error));
    await this.send(phone, context.branch === "ndr" ? "✅ Address updated in Shopify and re-delivery has been requested." : "✅ Address updated. The replacement NimbusPost order will use the new address.", "change_address", orderNumber);
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
      if (!this.orderBelongsToSender(order, phone)) { await this.dependencies.store.clearConversation(phone); return this.send(phone, `We couldn't verify that order against this WhatsApp number. Please contact ${this.dependencies.supportPhone || "support"}.`); }
      return this.askForAddress(phone, order, { branch: "ndr", awb });
    }
    await this.send(phone, "That action is not currently available from the courier. Choose one of the options shown above.", "order_failed", orderNumber);
  }

  private async requireShopifyOrder(orderNumber: string) {
    const order = await this.dependencies.shopify.getOrderByName(orderNumber);
    if (!order) throw new Error(`Order ${orderNumber} was not found in Shopify`);
    return order;
  }

  private orderBelongsToSender(order: ShopifyOrder, phone: string) {
    const sender = normalizePhoneNumber(phone);
    const candidates = order.customerPhones?.length ? order.customerPhones : [order.shippingAddress?.phone].filter((candidate): candidate is string => Boolean(candidate));
    return Boolean(sender && candidates.some((candidate) => normalizePhoneNumber(candidate) === sender));
  }

  private nimbusOrderBelongsToSender(order: OrderMatch, phone: string) {
    const sender = normalizePhoneNumber(phone);
    const candidates = [order.shipping_address?.phone, order.billing_address?.phone].filter((candidate) => candidate !== undefined);
    return Boolean(sender && candidates.some((candidate) => normalizePhoneNumber(String(candidate)) === sender));
  }

  private nimbusHasReadablePhone(order: OrderMatch) {
    const candidates = [order.shipping_address?.phone, order.billing_address?.phone].filter((candidate) => candidate !== undefined);
    return candidates.some((candidate) => Boolean(normalizePhoneNumber(String(candidate))));
  }

  private async send(phone: string, text: string, intent?: SupportIntent, orderNumber?: string) {
    await this.dependencies.whatsapp.sendText(phone, text);
    await this.dependencies.store.addWhatsAppMessage({ phone, direction: "outbound", source: "bot", text, ...(intent ? { intent } : {}), ...(orderNumber ? { orderNumber } : {}) });
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
const refundCategory = (text: string): SupportTicket["category"] => /missing|nahi aaya|rakhi nahi/i.test(text) ? "missing" : /refund|paisa wapas/i.test(text) ? "refund" : /return|wrong item|galat item/i.test(text) ? "return" : "other";
const formatAddress = (address: ShopifyAddress) => [address.address1, address.address2, address.city, address.province, address.zip].filter(Boolean).join(", ");
const formatMoney = (order: ShopifyOrder) => new Intl.NumberFormat("en-IN", { style: "currency", currency: order.currencyCode }).format(Number(order.totalAmount));
const formatShopifyOrderSummary = (order: ShopifyOrder) => {
  const items = order.lineItems.slice(0, 3).map((item) => `${item.title} ×${item.quantity}`).join(", ") || "Order items unavailable";
  const extraItems = order.lineItems.length > 3 ? ` +${order.lineItems.length - 3} more` : "";
  const date = new Date(order.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const statuses = [order.displayFinancialStatus, order.displayFulfillmentStatus].filter(Boolean).map((status) => humanStatus(String(status))).join(" / ");
  const tracking = order.trackingInfo?.find((item) => item.number || item.url);
  return `${date} · ${items}${extraItems} · ${formatMoney(order)}${statuses ? ` · ${statuses}` : ""}${tracking?.number ? ` · AWB ${tracking.number}` : ""}`;
};
const formatDate = (value: string) => new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const statusEmoji = (status: string) => /delivered/i.test(status) ? "✅" : /out for delivery/i.test(status) ? "🎉" : /ndr|fail/i.test(status) ? "⚠️" : /rto|return/i.test(status) ? "↩️" : "🚚";
const humanStatus = (status: string) => status.replace(/\b\w/g, (letter) => letter.toUpperCase());

export { INTENTS, parseAddress, refundCategory };
