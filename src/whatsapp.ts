import crypto from "node:crypto";

export type WhatsAppProvider = "disabled" | "meta" | "whapi" | "getgabs";
export type IncomingWhatsAppMessage = { id: string; phone: string; text: string };
type WhatsAppConfig = {
  provider: WhatsAppProvider;
  accessToken: string;
  phoneNumberId?: string;
  verifyToken?: string;
  appSecret?: string;
  apiUrl?: string;
  serviceApiUrl?: string;
  sender?: string;
  campaignId?: string;
  templateName?: string;
  templateLanguage?: string;
  mockMode: boolean;
};

const GETGABS_TEMPLATE_URL = "https://app.getgabs.com/whatsappbusiness/send-templated-message";
const GETGABS_SERVICE_PATH = "/sendservicemessages/sendmessages";

const MENU_TEXT = `Namaste! 🙏 How can we help you?
Reply with the number:
1️⃣ Confirm my order
2️⃣ Change address or phone number
3️⃣ Check order status / tracking
4️⃣ Why is my order not dispatched?
5️⃣ My delivery failed
6️⃣ Refund / Return / Missing item`;

export class WhatsAppClient {
  constructor(private readonly config: WhatsAppConfig) {}

  get connected() {
    if (this.config.mockMode) return true;
    if (this.config.provider === "meta") return Boolean(this.config.accessToken && this.config.phoneNumberId && this.config.verifyToken && this.config.appSecret);
    return (this.config.provider === "whapi" || this.config.provider === "getgabs") && Boolean(this.config.accessToken);
  }

  verifyChallenge(query: Record<string, unknown>) {
    const mode = String(query["hub.mode"] || "");
    const token = String(query["hub.verify_token"] || "");
    const challenge = String(query["hub.challenge"] || "");
    return mode === "subscribe" && Boolean(this.config.verifyToken) && token === this.config.verifyToken ? challenge : null;
  }

  verifySignature(rawBody: Buffer, signature?: string, webhookToken?: string) {
    if (this.config.provider === "disabled" || this.config.mockMode) return true;
    if (this.config.provider === "whapi" || this.config.provider === "getgabs") {
      const expected = this.config.verifyToken || this.config.accessToken;
      if (!expected || !webhookToken) return false;
      const actual = Buffer.from(webhookToken);
      const target = Buffer.from(expected);
      return actual.length === target.length && crypto.timingSafeEqual(actual, target);
    }
    if (!this.config.appSecret) return false;
    if (!signature?.startsWith("sha256=")) return false;
    const expected = `sha256=${crypto.createHmac("sha256", this.config.appSecret).update(rawBody).digest("hex")}`;
    const actual = Buffer.from(signature);
    const target = Buffer.from(expected);
    return actual.length === target.length && crypto.timingSafeEqual(actual, target);
  }

  extractMessages(body: unknown): IncomingWhatsAppMessage[] {
    const payload = body as Record<string, unknown>;
    if (payload.object === "whatsapp_business_account") return this.extractMetaMessages(payload);
    const candidates = Array.isArray(payload.messages) ? payload.messages : [payload];
    return candidates.flatMap((candidate) => {
      const message = candidate as Record<string, unknown>;
      if (message.from_me === true || message.fromMe === true || message.direction === "outbound") return [];
      const textObject = message.text as Record<string, unknown> | string | undefined;
      const getgabsText = this.extractGetgabsText(message.message_text);
      const text = typeof textObject === "string" ? textObject : String(textObject?.body || getgabsText || message.body || message.message || "");
      const phone = String(message.from || message.message_from || message.chat_id || message.chatId || "").split("@")[0].replace(/\D/g, "");
      const id = String(message.id || message.message_id || message.messageId || "");
      return phone && text ? [{ id: id || crypto.randomUUID(), phone, text: text.trim() }] : [];
    });
  }

  extractManualMessages(body: unknown): IncomingWhatsAppMessage[] {
    const payload = body as Record<string, unknown>;
    if (payload.object === "whatsapp_business_account") return [];
    const candidates = Array.isArray(payload.messages) ? payload.messages : [payload];
    return candidates.flatMap((candidate) => {
      const message = candidate as Record<string, unknown>;
      const outbound = message.from_me === true || message.fromMe === true || String(message.direction || "").toLowerCase() === "outbound";
      if (!outbound) return [];
      const textObject = message.text as Record<string, unknown> | string | undefined;
      const getgabsText = this.extractGetgabsText(message.message_text);
      const text = typeof textObject === "string" ? textObject : String(textObject?.body || getgabsText || message.body || message.message || "");
      const phone = String(message.to || message.message_to || message.recipient || message.chat_id || message.chatId || message.message_from || "").split("@")[0].replace(/\D/g, "");
      const id = String(message.id || message.message_id || message.messageId || "");
      return phone && text ? [{ id: id || crypto.randomUUID(), phone, text: text.trim() }] : [];
    });
  }

  async sendText(phone: string, text: string) {
    if (this.config.mockMode || this.config.provider === "disabled") { console.info(`[whatsapp:mock] ${phone}: ${text.replace(/\s+/g, " ").slice(0, 180)}`); return; }
    if (this.config.provider === "meta") {
      await this.request(this.config.apiUrl || `https://graph.facebook.com/v23.0/${this.config.phoneNumberId}/messages`, { messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "text", text: { preview_url: false, body: text } });
      return;
    }
    if (this.config.provider === "getgabs") {
      await this.requestGetgabs(this.getgabsServiceUrl(), {
        to: phone.replace(/\D/g, ""),
        text: { body: text, preview_url: false },
        type: "text",
        recipient_type: "individual",
        messaging_product: "whatsapp",
        api_key: this.config.accessToken,
      });
      return;
    }
    await this.request(this.config.apiUrl || "https://gate.whapi.cloud/messages/text", { to: phone, body: text });
  }

  async sendTemplate(phone: string, bodyParameters: string[] = []) {
    if (this.config.mockMode || this.config.provider === "disabled") return;
    if (this.config.provider !== "getgabs") throw new Error("Template sending through this method requires the Getgabs provider");
    if (!this.config.sender || !this.config.campaignId || !this.config.templateName) {
      throw new Error("Getgabs template sending requires WHATSAPP_SENDER, WHATSAPP_CAMPAIGN_ID, and WHATSAPP_TEMPLATE_NAME");
    }
    const template: Record<string, unknown> = {
      name: this.config.templateName,
      language: { code: this.config.templateLanguage || "en_US" },
    };
    if (bodyParameters.length) {
      template.components = [{ type: "BODY", parameters: bodyParameters.map((text) => ({ type: "text", text })) }];
    }
    await this.requestGetgabs(this.config.apiUrl || GETGABS_TEMPLATE_URL, {
      api_key: this.config.accessToken,
      sender: this.config.sender.replace(/\D/g, ""),
      campaign_id: this.config.campaignId,
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone.replace(/\D/g, ""),
      type: "template",
      template,
    });
  }

  async sendMenu(phone: string) {
    if (this.config.provider !== "meta" || this.config.mockMode) return this.sendText(phone, MENU_TEXT);
    await this.request(this.config.apiUrl || `https://graph.facebook.com/v23.0/${this.config.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Namaste! 🙏 How can we help you?" },
        action: { button: "Choose an option", sections: [{ title: "Customer support", rows: [
          { id: "1", title: "Confirm my order" },
          { id: "2", title: "Change address / phone" },
          { id: "3", title: "Order status / tracking" },
          { id: "4", title: "Not dispatched" },
          { id: "5", title: "Delivery failed" },
          { id: "6", title: "Refund / return / missing" },
        ] }] },
      },
    });
  }

  private extractMetaMessages(payload: Record<string, unknown>) {
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    return entries.flatMap((entry) => {
      const changes = Array.isArray((entry as Record<string, unknown>).changes) ? (entry as Record<string, unknown>).changes as unknown[] : [];
      return changes.flatMap((change) => {
        const value = ((change as Record<string, unknown>).value || {}) as Record<string, unknown>;
        const messages = Array.isArray(value.messages) ? value.messages : [];
        return messages.flatMap((candidate) => {
          const message = candidate as Record<string, unknown>;
          const interactive = (message.interactive || {}) as Record<string, unknown>;
          const button = (interactive.button_reply || {}) as Record<string, unknown>;
          const list = (interactive.list_reply || {}) as Record<string, unknown>;
          const text = String((message.text as Record<string, unknown> | undefined)?.body || button.id || list.id || "").trim();
          const phone = String(message.from || "").replace(/\D/g, "");
          return phone && text ? [{ id: String(message.id || crypto.randomUUID()), phone, text }] : [];
        });
      });
    });
  }

  private extractGetgabsText(value: unknown) {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return trimmed;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const button = (parsed.button || {}) as Record<string, unknown>;
      const interactive = (parsed.interactive || {}) as Record<string, unknown>;
      const buttonReply = (interactive.button_reply || {}) as Record<string, unknown>;
      const listReply = (interactive.list_reply || {}) as Record<string, unknown>;
      return String(button.payload || button.text || buttonReply.id || buttonReply.title || listReply.id || listReply.title || "").trim();
    } catch {
      return trimmed;
    }
  }

  private getgabsServiceUrl() {
    if (this.config.serviceApiUrl) return this.config.serviceApiUrl;
    try {
      return new URL(GETGABS_SERVICE_PATH, new URL(this.config.apiUrl || GETGABS_TEMPLATE_URL).origin).toString();
    } catch {
      return `https://app.getgabs.com${GETGABS_SERVICE_PATH}`;
    }
  }

  private async request(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.accessToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: { message?: string }; message?: string };
      throw new Error(error.error?.message || error.message || `WhatsApp provider rejected the message with HTTP ${response.status}`);
    }
  }

  private async requestGetgabs(url: string, body: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: { message?: string } | string; message?: string };
      const nestedError = typeof error.error === "object" ? error.error?.message : error.error;
      throw new Error(nestedError || error.message || `Getgabs rejected the message with HTTP ${response.status}`);
    }
  }
}

export { MENU_TEXT };
