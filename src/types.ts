export type Role = "admin" | "packer";
export type UserRecord = { id: number; username: string; passwordHash: string; role: Role };
export type ShippedOrder = { orderNumber: string; orderId: string; awb: string; courier: string; cost: number; alreadyBooked?: boolean; warningCode?: string; warning?: string };
export type FailedOrder = { orderNumber: string; error: string; code: string };
export type ShippingLog = { at: string; level: "info" | "success" | "error"; message: string; orderNumber?: string };
export type Batch = { batchId: string; createdAt: string; shippedBy: string; shipped: ShippedOrder[]; failed: FailedOrder[]; labelUrl: string | null; pickupScheduledLabelUrl?: string | null; totalShipped: number; totalFailed: number; demoMode: boolean; logs?: ShippingLog[] };
export type ShippingJobStatus = "queued" | "processing" | "completed" | "failed";
export type ShippingJob = {
  jobId: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  status: ShippingJobStatus;
  orderNumbers: string[];
  processed: number;
  total: number;
  shipped: ShippedOrder[];
  failed: FailedOrder[];
  labelUrl: string | null;
  pickupScheduledLabelUrl?: string | null;
  logs: ShippingLog[];
  error?: string;
  result?: Batch;
};
export type NimbusProgressEvent =
  | { type: "started"; orderNumber: string }
  | { type: "courier_attempt"; orderNumber: string; priority: number; total: number; courierId: string; courierName: string; roleId: string }
  | { type: "courier_rejected"; orderNumber: string; priority: number; courierName: string; code: string; error: string }
  | { type: "shipped"; orderNumber: string; item: ShippedOrder }
  | { type: "failed"; orderNumber: string; item: FailedOrder }
  | { type: "labels_started"; count: number }
  | { type: "labels_ready"; labelUrl: string }
  | { type: "labels_failed"; error: string }
  | { type: "pickup_labels_started"; count: number }
  | { type: "pickup_labels_ready"; labelUrl: string }
  | { type: "pickup_labels_failed"; error: string };
export type OrderMatch = {
  order_id: string;
  order_number: string;
  order_status?: string;
  total_amount?: number;
  shipping_address?: { name?: string; phone?: string | number; address?: string; city?: string; state?: string; pincode?: string | number };
  billing_address?: { phone?: string | number };
  items?: Array<{ name?: string; qty?: number }>;
  shipment?: { awb?: string; courier_name?: string; price?: { total?: number }; amount?: number; label_url?: string };
};

export type SupportIntent = "confirm_order" | "change_address" | "order_status" | "not_dispatched" | "order_failed" | "refund_return";
export type ConversationStep = "ai_active" | "waiting_menu" | "waiting_issue" | "waiting_order" | "waiting_pick" | "waiting_address" | "waiting_phone" | "waiting_confirm" | "waiting_ndr_choice" | "waiting_escalation_issue";
export type SupportConversation = {
  phone: string;
  intent?: SupportIntent;
  step: ConversationStep;
  context: Record<string, unknown>;
  updatedAt: string;
  expiresAt: string;
};
export type WhatsAppMessage = {
  id: string;
  phone: string;
  direction: "inbound" | "outbound";
  text: string;
  intent?: SupportIntent;
  orderNumber?: string;
  providerMessageId?: string;
  aiProvider?: AiProviderName;
  source?: "customer" | "bot" | "agent";
  createdAt: string;
};
export type BotPause = { phone: string; pausedAt: string; expiresAt: string; reason: "manual" | "agent_message" };
export type SupportTicketStatus = "open" | "resolved";
export type SupportTicket = {
  ticketId: string;
  phone: string;
  orderNumber?: string;
  category: "refund" | "return" | "missing" | "other";
  description?: string;
  status: SupportTicketStatus;
  createdAt: string;
  resolvedAt?: string;
};
export type SupportOverview = {
  messages: WhatsAppMessage[];
  tickets: SupportTicket[];
  conversations: SupportConversation[];
  botPauses: BotPause[];
  stats: { inboundToday: number; outboundToday: number; activeConversations: number; openTickets: number };
};

export type AiProviderName = "gemini" | "claude" | "openai";
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type AiToolCall = { name: string; arguments: Record<string, unknown> };
export type AiResponse = {
  text: string;
  toolCalls?: AiToolCall[];
  resolved?: boolean;
  escalate?: boolean;
  provider?: AiProviderName;
};

export type ShopifyAddress = {
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  provinceCode?: string;
  zip: string;
  country?: string;
  countryCode?: string;
};
export type ShopifyOrder = {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
  totalAmount: string;
  currencyCode: string;
  shippingAddress?: ShopifyAddress;
  customerPhones?: string[];
  lineItems: Array<{ title: string; quantity: number; sku?: string }>;
  trackingInfo?: Array<{ number?: string; url?: string; company?: string }>;
};
export type NimbusTracking = {
  orderId?: string;
  orderNumber?: string;
  orderStatus?: string;
  shipment?: { awb?: string; courierName?: string; edd?: string; pickedAt?: string };
  latest?: { shipStatus?: string; eventTime?: string; location?: string; message?: string };
};
export type NimbusNdr = {
  awb: string;
  attempt_count?: number;
  last_attempt_date?: string;
  remarks?: string;
  available_actions?: string[];
};
