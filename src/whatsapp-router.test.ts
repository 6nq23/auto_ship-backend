import { describe, expect, it, vi } from "vitest";
import type { NimbusClient } from "./nimbus.js";
import type { ShopifyClient } from "./shopify.js";
import type { Store } from "./store.js";
import type { WhatsAppClient } from "./whatsapp.js";
import { AiOrchestrator } from "./ai-providers.js";
import type { WhatsAppMessage } from "./types.js";
import { WhatsAppRouter, classifyIntent, extractOrderNumber, extractPhoneNumber, parseAddress, refundCategory } from "./whatsapp-router.js";

describe("WhatsApp support parsing", () => {
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

  it("does not reveal an order when the WhatsApp sender phone does not match", async () => {
    const sendText = vi.fn(async () => undefined);
    const clearConversation = vi.fn(async () => undefined);
    const nimbusLookup = vi.fn();
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

    expect(nimbusLookup).not.toHaveBeenCalled();
    expect(clearConversation).toHaveBeenCalledWith("911111111111");
    expect(sendText.mock.calls[0]?.[1]).toContain("couldn't verify");
    expect(sendText.mock.calls[0]?.[1]).not.toContain("#RBD5001");
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
});
