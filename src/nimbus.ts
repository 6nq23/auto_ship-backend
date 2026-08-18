import type { FailedOrder, NimbusNdr, NimbusProgressEvent, NimbusTracking, OrderMatch, ShippedOrder, ShopifyAddress } from "./types.js";
import { normalizeOrderNumber, normalizePhoneNumber } from "./identifiers.js";

type NimbusConfig = { apiUrl: string; apiKey: string; apiSecret: string; maxPages: number; mockMode: boolean };
type Envelope<T> = { success: true; data: T; meta?: { pagination?: { totalPages?: number } } };
type NimbusErrorBody = { error?: { code?: string; detail?: string } };
const isPickupRecoveryStatus = (status?: string) => ["pickup_scheduled", "pickup_pending"].includes(status?.toLowerCase() || "");
const isPickupRecoveryWarning = (item: ShippedOrder) => ["PICKUP_ALREADY_SCHEDULED", "PICKUP_ALREADY_PENDING"].includes(item.warningCode || "");

export const COURIER_PRIORITY = [
  { roleId: "6a61a64916956018f71a27d1", courierId: "6a0d96ef27ad772d357b22b4", name: "Delhivery Air" },
  { roleId: "6a61a64916956018f71a27cf", courierId: "6a06d0daea73ccc9fd278979", name: "Bluedart Brand Air" },
  { roleId: "6a61a64916956018f71a27d7", courierId: "6a06d0daea73ccc9fd278986", name: "Bluedart Brand" },
  { roleId: "6a61a64916956018f71a27d5", courierId: "6a0d96ef27ad772d357b230a", name: "Delhivery Surface DT_Stressed" },
  { roleId: "6a61a64916956018f71a27d3", courierId: "6a0d96ef27ad772d357b22cc", name: "Delhivery Surface DT" },
] as const;

export class NimbusClient {
  constructor(private readonly config: NimbusConfig, private readonly cache: { getOrderId: (order: string) => Promise<string | undefined>; cacheOrder: (order: string, id: string) => Promise<void> }) {}

  async shipMany(orderNumbers: string[], concurrency = 5, onProgress?: (event: NimbusProgressEvent) => Promise<void>, generateLabels = true) {
    const shipped: ShippedOrder[] = []; const failed: FailedOrder[] = []; let cursor = 0;
    const worker = async () => { while (cursor < orderNumbers.length) {
      const orderNumber = orderNumbers[cursor++]; const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 60_000);
      await onProgress?.({ type: "started", orderNumber });
      try { const item = await this.shipOne(orderNumber, controller.signal, onProgress); shipped.push(item); await onProgress?.({ type: "shipped", orderNumber, item }); }
      catch (error) { const parsed = controller.signal.aborted ? { code: "ORDER_TIMEOUT", error: "NimbusPost did not finish this order within 60 seconds" } : this.describeError(error); const item = { orderNumber, ...parsed }; failed.push(item); await onProgress?.({ type: "failed", orderNumber, item }); }
      finally { clearTimeout(timeout); }
    } };
    await Promise.all(Array.from({ length: Math.min(concurrency, orderNumbers.length) }, worker));
    shipped.sort((a, b) => orderNumbers.indexOf(a.orderNumber) - orderNumbers.indexOf(b.orderNumber));
    failed.sort((a, b) => orderNumbers.indexOf(a.orderNumber) - orderNumbers.indexOf(b.orderNumber));
    let labelUrl: string | null = null; let pickupScheduledLabelUrl: string | null = null;
    if (generateLabels && shipped.length) {
      await onProgress?.({ type: "labels_started", count: shipped.length });
      try { labelUrl = await this.labels(shipped.map((item) => item.orderId)); await onProgress?.({ type: "labels_ready", labelUrl }); }
      catch (error) { const parsed = this.describeError(error); await onProgress?.({ type: "labels_failed", error: parsed.error }); }
    }
    const pickupScheduled = shipped.filter(isPickupRecoveryWarning);
    if (generateLabels && pickupScheduled.length) {
      await onProgress?.({ type: "pickup_labels_started", count: pickupScheduled.length });
      try { pickupScheduledLabelUrl = await this.labels(pickupScheduled.map((item) => item.orderId)); await onProgress?.({ type: "pickup_labels_ready", labelUrl: pickupScheduledLabelUrl }); }
      catch (error) { const parsed = this.describeError(error); await onProgress?.({ type: "pickup_labels_failed", error: parsed.error }); }
    }
    return { shipped, failed, labelUrl, pickupScheduledLabelUrl };
  }

  async generateLabels(orderIds: string[]) {
    if (!orderIds.length) throw new AppError("NO_LABEL_ORDERS", "This batch has no shipped orders to print");
    return this.labels(orderIds);
  }

  async lookupOrder(orderNumber: string, signal = AbortSignal.timeout(20_000)) {
    const normalized = normalizeOrderNumber(orderNumber);
    if (!normalized) throw new AppError("INVALID_ORDER_NUMBER", "Enter an order number like #RBD5001");
    return this.resolveOrder(normalized, signal);
  }

  async getOrdersByPhone(phone: string, signal = AbortSignal.timeout(20_000)) {
    const normalized = normalizePhoneNumber(phone);
    if (!normalized) return [];
    const matches: OrderMatch[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= this.config.maxPages; page++) {
      const response = await this.listOrders({ limit: "100", page: String(page) }, signal);
      let phoneFields = 0;
      let readablePhones = 0;
      for (const order of response.data) {
        const candidates = [order.shipping_address?.phone, order.billing_address?.phone].filter((candidate) => candidate !== undefined);
        phoneFields += candidates.length;
        readablePhones += candidates.filter((candidate) => Boolean(normalizePhoneNumber(String(candidate)))).length;
        if (candidates.some((candidate) => normalizePhoneNumber(String(candidate)) === normalized) && !seen.has(order.order_id)) {
          matches.push(order);
          seen.add(order.order_id);
        }
      }
      const totalPages = response.meta?.pagination?.totalPages;
      // NimbusPost currently masks list/detail phone values. Do not scan more pages when none are searchable.
      if (phoneFields > 0 && readablePhones === 0) break;
      if ((totalPages !== undefined && page >= totalPages) || response.data.length < 100) break;
    }
    return matches.slice(0, 10);
  }

  async track(awb: string) {
    if (this.config.mockMode) return { orderStatus: "booked", shipment: { awb, courierName: "Delhivery Surface", edd: new Date(Date.now() + 3 * 86_400_000).toISOString() }, latest: { shipStatus: "in transit", eventTime: new Date().toISOString(), location: "Bengaluru Hub", message: "In transit" } } satisfies NimbusTracking;
    return (await this.request<Envelope<NimbusTracking>>(`/v2/tracking/${encodeURIComponent(awb)}`)).data;
  }

  async getNdr(awb: string) {
    if (this.config.mockMode) return { awb, attempt_count: 1, last_attempt_date: new Date().toISOString(), remarks: "Customer not available", available_actions: ["reattempt", "rto"] } satisfies NimbusNdr;
    for (let page = 1; page <= this.config.maxPages; page++) {
      const response = await this.request<Envelope<NimbusNdr[]>>(`/v2/ndr?limit=100&page=${page}`);
      const match = response.data.find((item) => item.awb === awb);
      if (match) return match;
      const totalPages = response.meta?.pagination?.totalPages;
      if ((totalPages !== undefined && page >= totalPages) || response.data.length < 100) break;
    }
    return null;
  }

  async submitNdrAction(awb: string, input: { action: "reattempt" | "rto"; updated_address?: { address: string; city: string; state: string; pincode: string }; updated_phone?: string }) {
    if (this.config.mockMode) return;
    await this.request(`/v2/ndr/${encodeURIComponent(awb)}/action`, { method: "POST", body: JSON.stringify(input) });
  }

  async replacePendingOrderAddress(orderNumber: string, address: ShopifyAddress) {
    if (this.config.mockMode) return;
    const order = await this.lookupOrder(orderNumber);
    const details = await this.getOrderDetails(order.order_id);
    const originalBody = {
      order_number: details.order_number,
      order_type: details.order_type,
      payment_mode: details.payment_mode,
      ...(details.order_collectable_amount !== undefined ? { order_collectable_amount: details.order_collectable_amount } : {}),
      warehouse_id: details.warehouse_id,
      shipping_address: details.shipping_address as Record<string, unknown>,
      items: details.items,
      package: details.package,
      ...(details.channel_id ? { channel_id: details.channel_id } : {}),
    };
    const body = {
      ...originalBody,
      shipping_address: {
        ...originalBody.shipping_address,
        name: address.name || `${address.firstName || ""} ${address.lastName || ""}`.trim(),
        address: address.address1,
        address_opt: address.address2 || "",
        pincode: Number(address.zip),
        city: address.city,
        state: address.province || address.provinceCode || "",
        country: address.country || "India",
        phone: Number((address.phone || "").replace(/\D/g, "").slice(-10)),
      },
    };
    if (!body.order_number || !body.order_type || !body.payment_mode || !body.warehouse_id || !Array.isArray(body.items) || !body.items.length || !body.package || !/^\d{6}$/.test(String(body.shipping_address.pincode)) || !/^\d{10}$/.test(String(body.shipping_address.phone))) throw new AppError("RECREATE_DATA_MISSING", "NimbusPost did not return enough order data to recreate this shipment safely");
    await this.request(`/v2/orders/${encodeURIComponent(order.order_id)}/cancel`, { method: "POST", body: JSON.stringify({ reason: "Customer requested address update before dispatch" }) });
    let replacement: Envelope<OrderMatch>;
    try {
      replacement = await this.request<Envelope<OrderMatch>>("/v2/orders", { method: "POST", body: JSON.stringify(body) });
    } catch (replacementError) {
      if (!this.isDefinitiveCreateRejection(replacementError)) throw new AppError("REPLACEMENT_STATUS_UNKNOWN", `NimbusPost did not confirm whether the replacement order was created. AutoShip did not create another order; manual reconciliation is required. ${this.describeError(replacementError).error}`);
      try {
        const restored = await this.request<Envelope<OrderMatch>>("/v2/orders", { method: "POST", body: JSON.stringify(originalBody) });
        await this.cache.cacheOrder(normalizeOrderNumber(orderNumber)!, restored.data.order_id).catch((error) => console.error("NimbusPost restored-order cache update failed", error));
      } catch (restoreError) {
        throw new AppError("REPLACEMENT_AND_RESTORE_FAILED", `NimbusPost cancelled the original order, then both replacement and automatic restoration failed: ${this.describeError(replacementError).error}; restore: ${this.describeError(restoreError).error}`);
      }
      throw new AppError("REPLACEMENT_FAILED_RESTORED", `NimbusPost rejected the new address, so AutoShip restored the original order: ${this.describeError(replacementError).error}`);
    }
    await this.cache.cacheOrder(normalizeOrderNumber(orderNumber)!, replacement.data.order_id).catch((error) => console.error("NimbusPost replacement cache update failed", error));
  }

  private async shipOne(orderNumber: string, signal: AbortSignal, onProgress?: (event: NimbusProgressEvent) => Promise<void>): Promise<ShippedOrder> {
    if (this.config.mockMode) return this.mockShip(orderNumber, onProgress);
    const order = await this.resolveOrder(orderNumber, signal);
    if (order.order_status === "cancelled") throw new AppError("ORDER_CANCELLED", "Order was cancelled");
    if (order.order_status === "booked" && order.shipment?.awb) return { orderNumber, orderId: order.order_id, awb: order.shipment.awb, courier: order.shipment.courier_name || "Allocated courier", cost: order.shipment.price?.total ?? order.shipment.amount ?? 0, alreadyBooked: true };
    if (isPickupRecoveryStatus(order.order_status)) return this.pickupRecoveryShipment(orderNumber, order);
    const rejected: string[] = [];
    for (let index = 0; index < COURIER_PRIORITY.length; index++) {
      const courier = COURIER_PRIORITY[index]; await onProgress?.({ type: "courier_attempt", orderNumber, priority: index + 1, total: COURIER_PRIORITY.length, courierId: courier.courierId, courierName: courier.name, roleId: courier.roleId });
      try {
        const response = await this.request<Envelope<{ awb: string; courier_name?: string; price?: { total?: number } }>>("/v2/shipments/book", { method: "POST", body: JSON.stringify({ order_id: order.order_id, courier_id: courier.courierId }) }, 0, signal);
        return { orderNumber, orderId: order.order_id, awb: response.data.awb, courier: response.data.courier_name || courier.name, cost: response.data.price?.total || 0 };
      } catch (error) {
        if (!(error instanceof AppError)) throw new AppError("BOOKING_STATUS_UNKNOWN", `Could not confirm whether ${courier.name} booked the shipment. No further courier was attempted.`);
        const parsed = this.describeError(error); rejected.push(`${courier.name}: ${parsed.error}`); await onProgress?.({ type: "courier_rejected", orderNumber, priority: index + 1, courierName: courier.name, code: parsed.code, error: parsed.error });
        if (["UNAUTHORIZED", "FORBIDDEN", "RATE_LIMITED", "TOO_MANY_REQUESTS", "HTTP_401", "HTTP_403", "HTTP_429"].includes(parsed.code)) throw error;
      }
    }
    const exhaustedError = `All ${COURIER_PRIORITY.length} priority couriers rejected this shipment. ${rejected.at(-1) || "No courier was serviceable."}`;
    if (rejected.some((message) => /current status is\s*["']?pickup_(?:scheduled|pending)/i.test(message))) {
      const refreshed = await this.getOrder(order.order_id, signal);
      if (isPickupRecoveryStatus(refreshed.order_status)) return this.pickupRecoveryShipment(orderNumber, refreshed, exhaustedError);
    }
    throw new AppError("COURIER_PRIORITY_EXHAUSTED", exhaustedError);
  }

  private pickupRecoveryShipment(orderNumber: string, order: OrderMatch, warning?: string): ShippedOrder {
    const pending = order.order_status?.toLowerCase() === "pickup_pending";
    return {
      orderNumber,
      orderId: order.order_id,
      awb: order.shipment?.awb || "",
      courier: order.shipment?.courier_name || "Allocated courier",
      cost: order.shipment?.price?.total ?? order.shipment?.amount ?? 0,
      alreadyBooked: true,
      warningCode: pending ? "PICKUP_ALREADY_PENDING" : "PICKUP_ALREADY_SCHEDULED",
      warning: warning || `Order cannot be booked - current status is "${pending ? "pickup_pending" : "pickup_scheduled"}". Only orders in "created" status can be booked. The existing shipment was kept as successful.`,
    };
  }

  private async resolveOrder(orderNumber: string, signal: AbortSignal): Promise<OrderMatch> {
    const cached = await this.cache.getOrderId(orderNumber);
    if (cached) return this.getOrder(cached, signal);
    const exact = await this.listOrders({ order_number: orderNumber, limit: "100", page: "1" }, signal);
    let match = exact.data.find((order) => order.order_number && normalizeOrderNumber(order.order_number) === orderNumber);
    if (!match) {
      const pages = Math.min(exact.meta?.pagination?.totalPages || this.config.maxPages, this.config.maxPages);
      for (let page = 1; page <= pages && !match; page++) {
        const response = page === 1 ? exact : await this.listOrders({ limit: "100", page: String(page) }, signal);
        match = response.data.find((order) => order.order_number && normalizeOrderNumber(order.order_number) === orderNumber);
      }
    }
    if (!match) throw new AppError("NOT_FOUND", `Order ${orderNumber} was not found in NimbusPost`);
    await this.cache.cacheOrder(orderNumber, match.order_id); return match;
  }

  private listOrders(query: Record<string, string>, signal: AbortSignal) { return this.request<Envelope<OrderMatch[]>>(`/v2/orders?${new URLSearchParams(query)}`, {}, 0, signal); }
  private async getOrder(orderId: string, signal: AbortSignal) { return (await this.request<Envelope<OrderMatch>>(`/v2/orders/${encodeURIComponent(orderId)}`, {}, 0, signal)).data; }
  private async getOrderDetails(orderId: string) { return (await this.request<Envelope<Record<string, unknown>>>(`/v2/orders/${encodeURIComponent(orderId)}`)).data; }
  private async labels(ids: string[]) {
    if (this.config.mockMode) return `/demo-labels?ids=${encodeURIComponent(ids.join(","))}`;
    try {
      const response = await this.request<Envelope<{ url: string }>>("/v2/shipments/labels", { method: "POST", body: JSON.stringify({ ids }) }); return response.data.url;
    } catch (error) {
      if (!(error instanceof AppError) || !/\border_ids\b/i.test(error.message)) throw error;
      const response = await this.request<Envelope<{ url: string }>>("/v2/shipments/labels", { method: "POST", body: JSON.stringify({ order_ids: ids }) }); return response.data.url;
    }
  }
  private async request<T>(path: string, init: RequestInit = {}, attempt = 0, overallSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20_000); const abort = () => controller.abort(); overallSignal?.addEventListener("abort", abort, { once: true });
    let response: globalThis.Response;
    try { response = await fetch(`${this.config.apiUrl}${path}`, { ...init, headers: { Accept: "application/json", "Content-Type": "application/json", "x-api-key": this.config.apiKey, "x-api-secret": this.config.apiSecret, ...init.headers }, signal: controller.signal }); }
    finally { clearTimeout(timeout); overallSignal?.removeEventListener("abort", abort); }
    if (response.status === 429 && attempt < 2) { const wait = Math.min(Number(response.headers.get("retry-after") || 1) * 1000, 5000); await new Promise((resolve) => setTimeout(resolve, wait)); return this.request<T>(path, init, attempt + 1, overallSignal); }
    const body = await response.json().catch(() => ({})) as T & NimbusErrorBody;
    if (!response.ok) throw new AppError(body.error?.code || `HTTP_${response.status}`, body.error?.detail || "NimbusPost rejected the request");
    return body;
  }
  private async mockShip(orderNumber: string, onProgress?: (event: NimbusProgressEvent) => Promise<void>): Promise<ShippedOrder> {
    await new Promise((resolve) => setTimeout(resolve, 20)); const suffix = Number(orderNumber.replace(/\D/g, ""));
    if (orderNumber.endsWith("30")) throw new AppError("NOT_FOUND", `Order ${orderNumber} was not found in NimbusPost`);
    if (orderNumber.endsWith("44")) return { orderNumber, orderId: `ORD-${suffix}`, awb: `AWB${240000000 + suffix}`, courier: "Bluedart Brand", cost: 92, alreadyBooked: true };
    for (let index = 0; index < COURIER_PRIORITY.length; index++) {
      const courier = COURIER_PRIORITY[index]; await onProgress?.({ type: "courier_attempt", orderNumber, priority: index + 1, total: COURIER_PRIORITY.length, courierId: courier.courierId, courierName: courier.name, roleId: courier.roleId }); await new Promise((resolve) => setTimeout(resolve, 10));
      if (orderNumber.endsWith("35") || (orderNumber.endsWith("24") && index === 0)) { const error = "No courier service is available for the destination pincode"; await onProgress?.({ type: "courier_rejected", orderNumber, priority: index + 1, courierName: courier.name, code: "NO_SERVICEABLE_COURIER", error }); continue; }
      return { orderNumber, orderId: `ORD-${suffix}`, awb: `AWB${240000000 + suffix}`, courier: courier.name, cost: index === 0 ? 75 : 92 };
    }
    throw new AppError("COURIER_PRIORITY_EXHAUSTED", `All ${COURIER_PRIORITY.length} priority couriers rejected this shipment.`);
  }
  private describeError(error: unknown) { if (error instanceof AppError) return { code: error.code, error: error.message }; return { code: "NETWORK_ERROR", error: "NimbusPost could not be reached. Try this order again." }; }
  private isDefinitiveCreateRejection(error: unknown) { return error instanceof AppError && ["VALIDATION_FAILED", "BAD_REQUEST", "INVALID_REQUEST", "DUPLICATE_ORDER", "DUPLICATE_ORDER_NUMBER", "HTTP_400", "HTTP_409", "HTTP_422"].includes(error.code); }
}

class AppError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
