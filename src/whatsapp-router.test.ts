import { describe, expect, it, vi } from "vitest";
import type { NimbusClient } from "./nimbus.js";
import type { ShopifyClient } from "./shopify.js";
import type { Store } from "./store.js";
import type { WhatsAppClient } from "./whatsapp.js";
import { AiOrchestrator } from "./ai-providers.js";
import type { CustomerMemory, SupportConversation, WhatsAppMessage } from "./types.js";
import { WhatsAppRouter, buildAiContext, classifyIntent, extractOrderNumber, extractPhoneNumber, parseAddress, refundCategory } from "./whatsapp-router.js";

describe("WhatsApp support parsing", () => {
  it("passes the complete chronological transcript to AI while it fits", () => {
    const memory: CustomerMemory = { phone: "919876543210", customerName: "Asha", summary: "Asked about delivery", knownOrderNumbers: ["#RBD5001"], issueHistory: [], profile: {}, updatedAt: new Date().toISOString() };
    const history: WhatsAppMessage[] = Array.from({ length: 30 }, (_, index) => ({ id: String(index + 1), phone: memory.phone, direction: index % 2 ? "outbound" : "inbound", text: `message-${index + 1}`, createdAt: new Date(index * 1_000).toISOString() }));
    const result = buildAiContext(memory, history, 120_000);
    expect(result.messages).toHaveLength(31); expect(result.messages[0].content).toContain("CUSTOMER_CONTEXT_JSON"); expect(result.messages.slice(1).map((message) => message.content)).toEqual(history.map((message) => message.text)); expect(result.archiveSummary).toBeUndefined();
  });
  it("archives only the oldest transcript section when the Gemini budget is exceeded", () => {
    const memory: CustomerMemory = { phone: "919876543210", summary: "Long-running support chat", knownOrderNumbers: [], issueHistory: [], profile: {}, updatedAt: new Date().toISOString() };
    const history: WhatsAppMessage[] = Array.from({ length: 80 }, (_, index) => ({ id: String(index + 1), phone: memory.phone, direction: index % 2 ? "outbound" : "inbound", text: `${index + 1}-${"x".repeat(300)}`, createdAt: new Date(index * 1_000).toISOString() }));
    const result = buildAiContext(memory, history, 10_000); expect(result.archiveSummary).toContain("inbound"); expect(Number(result.archivedThroughMessageId)).toBeGreaterThan(0); expect(result.messages[1].content).toContain("ARCHIVED_CHAT_HISTORY"); expect(result.messages.at(-1)?.content).toBe(history.at(-1)?.text);
  });

  it("classifies clear English and Hinglish messages without an LLM", () => {
    expect(classifyIntent("mera order kaha hai RBD5001")).toBe("order_status");
    expect(classifyIntent("address galat hai change karna hai")).toBe("change_address");
    expect(classifyIntent("wrong item, paisa wapas chahiye")).toBe("refund_return");
    expect(classifyIntent("5")).toBe("order_failed");
    expect(classifyIntent("hello ji")).toBeUndefined();
  });

  it("extracts only valid order and phone identifiers", () => {
    expect(extractOrderNumber("track #rbd-5001 please")).toBe("#RBD5001");
    expect(extractOrderNumber("#RBD 5001")).toBe("#RBD5001");
    expect(extractOrderNumber("R B D 5 0 0 1")).toBe("#RBD5001");
    expect(extractOrderNumber("5 0 0 1")).toBe("#RBD5001");
    expect(extractOrderNumber("5001")).toBe("#RBD5001");
    expect(extractPhoneNumber("my number is +91 98765 43210")).toBe("9876543210");
    expect(extractPhoneNumber("98765 43210")).toBe("9876543210");
    expect(extractPhoneNumber("9876543210")).toBe("9876543210");
    expect(extractPhoneNumber("+919876543210")).toBe("9876543210");
    expect(extractPhoneNumber("+91 9876543210")).toBe("9876543210");
    expect(extractPhoneNumber("0091-98765-43210")).toBe("9876543210");
    expect(extractPhoneNumber("91 98765 43210")).toBe("9876543210");
    expect(extractPhoneNumber("RBD5001")).toBeUndefined();
    expect(extractPhoneNumber("5 0 0 1")).toBeUndefined();
  });

  it("requires a structured, complete Indian address", () => {
    expect(parseAddress("14 Park Street, Kolkata, West Bengal, 700016")).toEqual({ address1: "14 Park Street", city: "Kolkata", province: "West Bengal", zip: "700016", country: "India" });
    expect(parseAddress("somewhere in Kolkata")).toBeNull();
    expect(parseAddress("14 Park Street, Kolkata, West Bengal, 7000")).toBeNull();
  });

  it("preserves refund, return, and missing-item ticket categories", () => {
    expect(refundCategory("missing item nahi aaya")).toBe("missing");
    expect(refundCategory("paisa wapas refund chahiye")).toBe("refund");
    expect(refundCategory("wrong item return karna hai")).toBe("return");
  });

  it("answers general COD availability with the website and complete-collection guidance", async () => {
    const sendText = vi.fn(async () => undefined);
    const clearConversation = vi.fn(async () => undefined);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true), getConversation: vi.fn(async () => undefined), clearConversation,
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: {} as unknown as ShopifyClient,
      nimbus: {} as unknown as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "9999999999",
    });

    await router.handleIncomingMessage({ id: "cod-available-1", phone: "919876543210", text: "COD is available?" });

    expect(clearConversation).toHaveBeenCalledWith("919876543210");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[1]).toContain("Cash on Delivery (COD) is available");
    expect(sendText.mock.calls[0]?.[1]).toContain("https://rakhibydiorin.com/");
    expect(sendText.mock.calls[0]?.[1]).toContain("Only the products shown on the website are currently available");
    expect(sendText.mock.calls[0]?.[1]).toContain("do not have additional designs outside the website");
  });

  it("returns an order without requiring the WhatsApp sender phone to match", async () => {
    const sendText = vi.fn(async () => undefined);
    const clearConversation = vi.fn(async () => undefined);
    const nimbusLookup = vi.fn(async () => null);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true),
        getConversation: vi.fn(async () => undefined),
        clearConversation,
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: {
        getOrderByName: vi.fn(async () => ({
          id: "gid://shopify/Order/5001",
          name: "#RBD5001",
          createdAt: new Date().toISOString(),
          totalAmount: "499.00",
          currencyCode: "INR",
          customerPhones: ["9876543210"],
          lineItems: [{ title: "Rakhi Set", quantity: 1 }],
        })),
      } as unknown as ShopifyClient,
      nimbus: { lookupOrder: nimbusLookup } as unknown as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "9999999999",
    });

    await router.handleIncomingMessage({ id: "wa-unauthorized-1", phone: "911111111111", text: "track RBD5001" });

    expect(nimbusLookup).toHaveBeenCalledWith("#RBD5001");
    expect(clearConversation).toHaveBeenCalledWith("911111111111");
    expect(sendText.mock.calls[0]?.[1]).toContain("#RBD5001");
    expect(sendText.mock.calls[0]?.[1]).not.toContain("couldn't verify");
  });

  it("answers at most maxConcurrentChats customers at a time and queues the rest", async () => {
    let active = 0;
    let peak = 0;
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const sendText = vi.fn(async () => undefined);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true),
        clearConversation: vi.fn(async () => undefined),
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
        getConversation: vi.fn(async () => {
          active += 1; peak = Math.max(peak, active);
          await gate;
          active -= 1;
          return undefined;
        }),
      } as unknown as Store,
      shopify: {} as unknown as ShopifyClient,
      nimbus: {} as unknown as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "9999999999",
      maxConcurrentChats: 2,
    });

    const pending = ["919000000001", "919000000002", "919000000003", "919000000004"].map((phone) => router.handleIncomingMessage({ id: `wa-${phone}`, phone, text: "hello ji" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(peak).toBe(2);

    openGate();
    await Promise.all(pending);
    expect(sendText).toHaveBeenCalledTimes(4);
  });

  it("does not offer NDR actions when Nimbus explicitly returns none", async () => {
    const sendText = vi.fn(async () => undefined);
    const saveConversation = vi.fn(async () => undefined);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true), getConversation: vi.fn(async () => undefined), clearConversation: vi.fn(async () => undefined), saveConversation,
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: { getOrderByName: vi.fn(async () => ({ id: "gid://shopify/Order/5001", name: "#RBD5001", createdAt: new Date().toISOString(), totalAmount: "499", currencyCode: "INR", customerPhones: ["9876543210"], lineItems: [] })) } as unknown as ShopifyClient,
      nimbus: { lookupOrder: vi.fn(async () => ({ order_id: "ORD-1", order_number: "#RBD5001", order_status: "ndr", shipment: { awb: "AWB-1" } })), getNdr: vi.fn(async () => ({ awb: "AWB-1", available_actions: [] })) } as unknown as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "9999999999",
    });

    await router.handleIncomingMessage({ id: "wa-no-actions", phone: "919876543210", text: "delivery failed RBD5001" });

    expect(saveConversation).not.toHaveBeenCalled();
    expect(sendText.mock.calls[0]?.[1]).toContain("not provided an available recovery action");
  });

  it("answers an RBD status lookup from Nimbus when the configured Shopify store uses different order names", async () => {
    const sendText = vi.fn(async () => undefined);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true), getConversation: vi.fn(async () => undefined), clearConversation: vi.fn(async () => undefined),
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: { getOrderByName: vi.fn(async () => null) } as unknown as ShopifyClient,
      nimbus: {
        lookupOrder: vi.fn(async () => ({ order_id: "NIMBUS-1", order_number: "#RBD5001", order_status: "booked", shipping_address: { phone: "+91 98765 43210" }, shipment: { awb: "AWB-5001", courier_name: "Courier" } })),
        track: vi.fn(async () => ({ orderStatus: "in_transit", shipment: { awb: "AWB-5001", courierName: "Courier", edd: "2026-08-20T00:00:00Z" }, latest: { shipStatus: "in transit" } })),
      } as unknown as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "9999999999",
    });

    await router.handleIncomingMessage({ id: "wa-nimbus-status", phone: "919876543210", text: "track #RBD 5001" });

    expect(sendText.mock.calls[0]?.[1]).toContain("AWB-5001");
    expect(sendText.mock.calls[0]?.[1]).toContain("In Transit");
  });

  it("prioritizes an undelivered order after its expected delivery date without duplicating tickets", async () => {
    const sendText = vi.fn(async () => undefined);
    const createSupportTicket = vi.fn(async () => undefined);
    let existingTicket: any;
    const findOpenSupportTicket = vi.fn(async () => existingTicket);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true), getConversation: vi.fn(async () => undefined), clearConversation: vi.fn(async () => undefined),
        findOpenSupportTicket, createSupportTicket: vi.fn(async (ticket) => { existingTicket = ticket; await createSupportTicket(ticket); }),
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: { getOrderByName: vi.fn(async () => null) } as unknown as ShopifyClient,
      nimbus: {
        lookupOrder: vi.fn(async () => ({ order_id: "N-4544", order_number: "#RBD4544", order_status: "shipped", shipment: { awb: "23645498210334", courier_name: "Delhivery Surface DT" } })),
        track: vi.fn(async () => ({ orderStatus: "in_transit", shipment: { awb: "23645498210334", courierName: "Delhivery Surface DT", edd: "2020-08-17T00:00:00Z" }, latest: { shipStatus: "in transit", location: "BangaloreHoskoteGW" } })),
      } as unknown as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "919999999999", escalationPhone: "919999999999",
    });

    await router.handleIncomingMessage({ id: "overdue-1", phone: "919184434105", text: "track RBD4544" });
    await router.handleIncomingMessage({ id: "overdue-2", phone: "919184434105", text: "I still have not received my order RBD4544" });

    expect(createSupportTicket).toHaveBeenCalledTimes(1);
    expect(createSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ orderNumber: "#RBD4544", category: "other", status: "open", metadata: expect.objectContaining({ reason: "overdue_delivery" }) }));
    expect(sendText.mock.calls.some(([, message]) => message.includes("Overdue delivery needs courier follow-up"))).toBe(true);
    const customerReplies = sendText.mock.calls.filter(([recipient]) => recipient === "919184434105").map(([, message]) => message);
    expect(customerReplies.at(-1)).toContain("passed its expected delivery date");
    expect(customerReplies.at(-1)).toContain("marked your order as priority");
    expect(customerReplies.at(-1)).toContain("follow up with the courier");
  });

  it("explains naturally that an in-transit Nimbus order cannot change address", async () => {
    const sendText = vi.fn(async () => undefined); const createSupportTicket = vi.fn(async () => undefined);
    const router = new WhatsAppRouter({ store: { addWhatsAppMessage: vi.fn(async () => true), getConversation: vi.fn(async () => undefined), clearConversation: vi.fn(async () => undefined), findOpenSupportTicket: vi.fn(async () => undefined), createSupportTicket, withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task() } as unknown as Store, shopify: { getOrderByName: vi.fn(async () => null) } as unknown as ShopifyClient, nimbus: { lookupOrder: vi.fn(async () => ({ order_id: "N-11298", order_number: "#RBD11298", order_status: "shipped", shipment: { awb: "AWB-11298", courier_name: "Courier" } })), track: vi.fn(async () => ({ orderStatus: "in_transit", latest: { shipStatus: "in transit" } })) } as unknown as NimbusClient, whatsapp: { sendText } as unknown as WhatsAppClient, supportPhone: "9999999999" });
    await router.handleIncomingMessage({ id: "wa-address-transit", phone: "919876543210", text: "change address RBD11298" });
    expect(sendText.mock.calls[0]?.[1]).toContain("already moving through the courier network"); expect(sendText.mock.calls[0]?.[1]).not.toContain("configured Shopify"); expect(sendText.mock.calls[0]?.[1]).not.toContain("safely"); expect(createSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ category: "address_change", orderNumber: "#RBD11298" }));
  });

  it("updates an eligible Nimbus-only address and records the change in AutoShip", async () => {
    const sendText = vi.fn(async () => undefined); const replacePendingOrderAddress = vi.fn(async () => undefined); const createSupportTicket = vi.fn(async () => undefined); const updateSupportTicket = vi.fn(async () => true); let conversation: SupportConversation | undefined;
    const saveConversation = vi.fn(async (value: Omit<SupportConversation, "updatedAt" | "expiresAt">) => { conversation = { ...value, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }; });
    const router = new WhatsAppRouter({ store: { addWhatsAppMessage: vi.fn(async () => true), getConversation: vi.fn(async () => conversation), saveConversation, clearConversation: vi.fn(async () => { conversation = undefined; }), createSupportTicket, updateSupportTicket, withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task() } as unknown as Store, shopify: { getOrderByName: vi.fn(async () => null) } as unknown as ShopifyClient, nimbus: { lookupOrder: vi.fn(async () => ({ order_id: "N-11298", order_number: "#RBD11298", order_status: "created", shipping_address: { name: "Customer", phone: "9876543210" } })), replacePendingOrderAddress } as unknown as NimbusClient, whatsapp: { sendText } as unknown as WhatsAppClient, supportPhone: "9999999999" });
    await router.handleIncomingMessage({ id: "address-1", phone: "919876543210", text: "change address RBD11298" }); await router.handleIncomingMessage({ id: "address-2", phone: "919876543210", text: "14 Park Street, Kolkata, West Bengal, 700016" }); await router.handleIncomingMessage({ id: "address-3", phone: "919876543210", text: "SAME" }); await router.handleIncomingMessage({ id: "address-4", phone: "919876543210", text: "YES" });
    expect(replacePendingOrderAddress).toHaveBeenCalledWith("#RBD11298", expect.objectContaining({ address1: "14 Park Street", city: "Kolkata", phone: "9876543210" })); expect(createSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ category: "address_change", description: expect.stringContaining("14 Park Street"), metadata: expect.objectContaining({ branch: "nimbus_pending" }) })); expect(sendText.mock.calls.at(-1)?.[1]).toContain("recorded the change in AutoShip");
  });

  it("answers a masked Nimbus order directly when its visible phone suffix matches the sender", async () => {
    const sendText = vi.fn(async () => undefined);
    const lookupOrder = vi.fn(async () => ({
      order_id: "NIMBUS-MASKED", order_number: "#RBD9588", order_status: "booked",
      shipping_address: { phone: "XXXXXXXX21", pincode: 560001 },
      shipment: { awb: "AWB-9588", courier_name: "Courier" },
    }));
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true),
        getConversation: vi.fn(async () => undefined),
        clearConversation: vi.fn(async () => undefined),
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: { getOrderByName: vi.fn(async () => null) } as unknown as ShopifyClient,
      nimbus: {
        lookupOrder,
        track: vi.fn(async () => ({ orderStatus: "in_transit", shipment: { awb: "AWB-9588", courierName: "Courier" }, latest: { shipStatus: "in transit" } })),
      } as unknown as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "9999999999",
    });

    await router.handleIncomingMessage({ id: "wa-masked-order", phone: "917093689721", text: "track #RBD 9588" });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]?.[1]).toContain("AWB-9588");
    expect(sendText.mock.calls[0]?.[1]).not.toContain("PIN code");
  });

  it("returns every Shopify order for a normalized phone lookup", async () => {
    const sendText = vi.fn(async () => undefined);
    const saveConversation = vi.fn(async () => undefined);
    const getOrdersByPhone = vi.fn(async () => [
      { id: "gid://shopify/Order/1", name: "#DR5002", createdAt: "2026-08-16T10:00:00Z", totalAmount: "799", currencyCode: "INR", displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", shippingAddress: { address1: "12 MG Road", city: "Bengaluru", province: "Karnataka", zip: "560001" }, lineItems: [{ title: "Premium Rakhi", quantity: 1 }] },
      { id: "gid://shopify/Order/2", name: "#DR5001", createdAt: "2026-08-15T10:00:00Z", totalAmount: "499", currencyCode: "INR", displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", shippingAddress: { address1: "12 MG Road", city: "Bengaluru", province: "Karnataka", zip: "560001" }, lineItems: [{ title: "Rakhi Set", quantity: 2 }] },
    ]);
    const router = new WhatsAppRouter({
      store: { addWhatsAppMessage: vi.fn(async () => true), getConversation: vi.fn(async () => undefined), saveConversation, withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task() } as unknown as Store,
      shopify: { getOrdersByPhone } as unknown as ShopifyClient,
      nimbus: { getOrdersByPhone: vi.fn(async () => []) } as unknown as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "919999999999",
    });

    await router.handleIncomingMessage({ id: "wa-phone-orders", phone: "911111111111", text: "track orders for +91 98765 43210" });
    expect(getOrdersByPhone).toHaveBeenCalledWith("9876543210");
    expect(sendText.mock.calls[0]?.[1]).toContain("#DR5002");
    expect(sendText.mock.calls[0]?.[1]).toContain("#DR5001");
    expect(sendText.mock.calls[0]?.[1]).toContain("Premium Rakhi");
    expect(sendText.mock.calls[0]?.[1]).toContain("12 MG Road");
    expect(saveConversation).toHaveBeenCalledWith(expect.objectContaining({ step: "waiting_pick" }));
  });

  it("uses an AI tool call to route natural language into the existing tracking handler", async () => {
    const sent: string[] = [];
    const messages: WhatsAppMessage[] = [];
    const ai = new AiOrchestrator([{ name: "gemini", chat: vi.fn(async () => ({ text: "", toolCalls: [{ name: "track_order", arguments: { identifier: "RBD5001" } }] })) }]);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async (message) => { messages.push({ ...message, id: String(messages.length + 1), createdAt: new Date().toISOString() }); return true; }),
        getConversation: vi.fn(async () => undefined),
        getConversationHistory: vi.fn(async () => messages),
        incrementAiTurnCount: vi.fn(async () => 1),
        clearConversation: vi.fn(async () => undefined),
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: { getOrderByName: vi.fn(async () => null) } as unknown as ShopifyClient,
      nimbus: {
        lookupOrder: vi.fn(async () => ({ order_id: "N-1", order_number: "#RBD5001", order_status: "booked", shipping_address: { phone: "+91 98765 43210" }, shipment: { awb: "AWB-5001", courier_name: "Courier" } })),
        track: vi.fn(async () => ({ shipment: { awb: "AWB-5001", courierName: "Courier" }, latest: { shipStatus: "in transit" } })),
      } as unknown as NimbusClient,
      whatsapp: { sendText: vi.fn(async (_phone, text) => { sent.push(text); }) } as unknown as WhatsAppClient,
      supportPhone: "919999999999",
      ai,
    });

    await router.handleIncomingMessage({ id: "wa-ai-track", phone: "919876543210", text: "bhai mera parcel kidhar hai 5001" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("AWB-5001");
    expect(sent[0]).toContain("In Transit");
  });

  it("records the provider for a direct AI reply", async () => {
    const added: Array<Omit<WhatsAppMessage, "id" | "createdAt">> = [];
    const ai = new AiOrchestrator([{ name: "openai", chat: vi.fn(async () => ({ text: "Namaste! How can I help?", resolved: true })) }]);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async (message) => { added.push(message); return true; }),
        getConversation: vi.fn(async () => undefined),
        getConversationHistory: vi.fn(async () => [{ id: "1", phone: "919876543210", direction: "inbound", source: "customer", text: "hello", createdAt: new Date().toISOString() }]),
        incrementAiTurnCount: vi.fn(async () => 1),
        clearConversation: vi.fn(async () => undefined),
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: {} as ShopifyClient,
      nimbus: {} as NimbusClient,
      whatsapp: { sendText: vi.fn(async () => undefined) } as unknown as WhatsAppClient,
      supportPhone: "919999999999",
      ai,
    });

    await router.handleIncomingMessage({ id: "wa-ai-greeting", phone: "919876543210", text: "hello" });
    expect(added.at(-1)).toEqual(expect.objectContaining({ direction: "outbound", text: "Namaste! How can I help?", aiProvider: "openai" }));
  });

  it("creates a ticket and notifies the human destination at the unresolved turn limit", async () => {
    const sendText = vi.fn(async () => undefined);
    const createSupportTicket = vi.fn(async () => undefined);
    const ai = new AiOrchestrator([{ name: "gemini", chat: vi.fn(async () => ({ text: "Please tell me more", resolved: false })) }]);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true),
        getConversation: vi.fn(async () => ({ phone: "919876543210", step: "ai_active", context: { aiTurnCount: 2 }, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() })),
        getConversationHistory: vi.fn(async () => []),
        incrementAiTurnCount: vi.fn(async () => 3),
        clearConversation: vi.fn(async () => undefined),
        createSupportTicket,
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: {} as ShopifyClient,
      nimbus: {} as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "919999999999",
      escalationPhone: "919924863749",
      aiMaxTurns: 3,
      ai,
    });

    await router.handleIncomingMessage({ id: "wa-ai-limit", phone: "919876543210", text: "still not solved" });
    expect(createSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ phone: "919876543210", category: "other", status: "open" }));
    expect(sendText.mock.calls[0]?.[0]).toBe("919924863749");
    expect(sendText.mock.calls[1]?.[0]).toBe("919876543210");
  });

  it("reads policy guidance from brain.md and escalates exchange requests", async () => {
    const sendText = vi.fn(async () => undefined);
    const createSupportTicket = vi.fn(async () => undefined);
    let conversation: SupportConversation | undefined;
    const ai = new AiOrchestrator([{ name: "gemini", chat: vi.fn(async () => ({ text: "", toolCalls: [{ name: "create_ticket", arguments: { reason: "Customer received the wrong item and wants an exchange", order_number: "RBD5001", category: "exchange" } }] })) }]);
    const router = new WhatsAppRouter({
      store: {
        addWhatsAppMessage: vi.fn(async () => true), getConversation: vi.fn(async () => conversation), getConversationHistory: vi.fn(async () => []), incrementAiTurnCount: vi.fn(async () => 1), saveConversation: vi.fn(async (next: Omit<SupportConversation, "updatedAt" | "expiresAt">) => { const now = new Date(); conversation = { ...next, updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60_000).toISOString() }; }), clearConversation: vi.fn(async () => { conversation = undefined; }), createSupportTicket,
        withConversationLock: async (_phone: string, task: () => Promise<unknown>) => task(),
      } as unknown as Store,
      shopify: {} as ShopifyClient,
      nimbus: {} as NimbusClient,
      whatsapp: { sendText } as unknown as WhatsAppClient,
      supportPhone: "919999999999",
      escalationPhone: "919924863749",
      brainFilePath: "data/brain.md",
      ai,
    });

    await router.handleIncomingMessage({ id: "wa-ai-exchange", phone: "919876543210", text: "I received the wrong rakhi and want an exchange" });
    expect(createSupportTicket).not.toHaveBeenCalled();
    expect(conversation).toEqual(expect.objectContaining({ step: "waiting_escalation_issue", context: expect.objectContaining({ category: "return", orderNumber: "#RBD5001" }) }));
    expect(sendText.mock.calls[0]?.[0]).toBe("919876543210");
    expect(sendText.mock.calls[0]?.[1]).toContain("keep the item");
    expect(sendText.mock.calls[0]?.[1]).toContain("one clear line");

    await router.handleIncomingMessage({ id: "wa-ai-exchange-detail", phone: "919876543210", text: "I received the wrong blue rakhi in order RBD5001." });
    expect(createSupportTicket).toHaveBeenCalledWith(expect.objectContaining({ category: "return", orderNumber: "#RBD5001" }));
    expect(sendText.mock.calls[1]?.[0]).toBe("919924863749");
    expect(sendText.mock.calls[2]?.[0]).toBe("919876543210");
    expect(sendText.mock.calls[2]?.[1]).toContain("exact issue");
  });
});
