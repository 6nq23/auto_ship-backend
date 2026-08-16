import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppClient } from "./whatsapp.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WhatsApp webhook authentication", () => {
  it("requires the configured custom callback token for Whapi.Cloud", () => {
    const client = new WhatsAppClient({
      provider: "whapi",
      accessToken: "provider-access-token",
      verifyToken: "separate-webhook-token",
      mockMode: false,
    });

    expect(client.verifySignature(Buffer.from("{}"), undefined, undefined)).toBe(false);
    expect(client.verifySignature(Buffer.from("{}"), undefined, "wrong-token")).toBe(false);
    expect(client.verifySignature(Buffer.from("{}"), undefined, "separate-webhook-token")).toBe(true);
  });

  it("validates Meta's raw-body HMAC signature", () => {
    const body = Buffer.from('{"object":"whatsapp_business_account"}');
    const secret = "meta-app-secret";
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
    const client = new WhatsAppClient({
      provider: "meta",
      accessToken: "meta-access-token",
      phoneNumberId: "123",
      verifyToken: "verify-token",
      appSecret: secret,
      mockMode: false,
    });

    expect(client.verifySignature(body, signature)).toBe(true);
    expect(client.verifySignature(Buffer.from("tampered"), signature)).toBe(false);
  });

  it("requires AutoShip's callback token for Getgabs webhooks", () => {
    const client = new WhatsAppClient({
      provider: "getgabs",
      accessToken: "getgabs-api-key",
      verifyToken: "getgabs-callback-token",
      mockMode: false,
    });

    expect(client.verifySignature(Buffer.from("{}"), undefined, "wrong-token")).toBe(false);
    expect(client.verifySignature(Buffer.from("{}"), undefined, "getgabs-callback-token")).toBe(true);
  });
});

describe("Getgabs WhatsApp integration", () => {
  it("extracts normal text and quick-reply button webhooks", () => {
    const client = new WhatsAppClient({ provider: "getgabs", accessToken: "key", mockMode: false });

    expect(client.extractMessages({
      message_id: "wamid.text",
      message_from: "91 98765 43210",
      message_text: "3",
      message_type: "text",
      direction: "inbound",
    })).toEqual([{ id: "wamid.text", phone: "919876543210", text: "3" }]);

    expect(client.extractMessages({
      message_id: "wamid.button",
      message_from: "919876543210",
      message_text: JSON.stringify({ type: "button", button: { payload: "5", text: "Delivery failed" } }),
      message_type: "button",
      direction: "inbound",
    })).toEqual([{ id: "wamid.button", phone: "919876543210", text: "5" }]);
  });

  it("separates manual outbound agent messages from customer messages", () => {
    const client = new WhatsAppClient({ provider: "getgabs", accessToken: "key", mockMode: false });
    const payload = { message_id: "wamid.agent", message_to: "919876543210", message_text: "I am checking this for you.", direction: "outbound" };

    expect(client.extractMessages(payload)).toEqual([]);
    expect(client.extractManualMessages(payload)).toEqual([{ id: "wamid.agent", phone: "919876543210", text: "I am checking this for you." }]);
  });

  it("sends dynamic replies through the service-message endpoint without an Authorization header", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.sent" }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WhatsAppClient({
      provider: "getgabs",
      accessToken: "getgabs-api-key",
      apiUrl: "https://app.getgabs.com/whatsappbusiness/send-templated-message",
      mockMode: false,
    });

    await client.sendText("+91 98765 43210", "Your order is confirmed.");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.getgabs.com/sendservicemessages/sendmessages");
    expect(request.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(request.body))).toEqual({
      to: "919876543210",
      text: { body: "Your order is confirmed.", preview_url: false },
      type: "text",
      recipient_type: "individual",
      messaging_product: "whatsapp",
      api_key: "getgabs-api-key",
    });
  });

  it("uses the configured template endpoint and campaign metadata", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WhatsAppClient({
      provider: "getgabs",
      accessToken: "getgabs-api-key",
      apiUrl: "https://app.getgabs.com/whatsappbusiness/send-templated-message",
      sender: "918849658998",
      campaignId: "24366",
      templateName: "order_update",
      templateLanguage: "en_US",
      mockMode: false,
    });

    await client.sendTemplate("919876543210", ["#RBD5001"]);

    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.getgabs.com/whatsappbusiness/send-templated-message");
    expect(JSON.parse(String(request.body))).toMatchObject({
      api_key: "getgabs-api-key",
      sender: "918849658998",
      campaign_id: "24366",
      to: "919876543210",
      template: {
        name: "order_update",
        language: { code: "en_US" },
        components: [{ type: "BODY", parameters: [{ type: "text", text: "#RBD5001" }] }],
      },
    });
  });
});
