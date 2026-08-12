import type { FailedOrder, NimbusProgressEvent, OrderMatch, ShippedOrder } from "./types.js";

type NimbusConfig = { apiUrl: string; apiKey: string; apiSecret: string; maxPages: number; mockMode: boolean };
type Envelope<T> = { success: true; data: T; meta?: { pagination?: { totalPages?: number } } };
type NimbusErrorBody = { error?: { code?: string; detail?: string } };

export const COURIER_PRIORITY = [
  { roleId: "6a61a64916956018f71a27d3", courierId: "6a0d96ef27ad772d357b22cc", name: "Delhivery Surface DT" },
  { roleId: "6a61a64916956018f71a27d7", courierId: "6a06d0daea73ccc9fd278986", name: "Bluedart Brand" },
  { roleId: "6a61a64916956018f71a27d5", courierId: "6a0d96ef27ad772d357b230a", name: "Delhivery Surface DT_Stressed" },
  { roleId: "6a61a64916956018f71a27d9", courierId: "6a0d96ef27ad772d357b22b7", name: "Xpressbees Surface" },
  { roleId: "6a61a64916956018f71a27db", courierId: "6a0d96ef27ad772d357b2308", name: "Xpressbees Surface_Stressed" },
  { roleId: "6a61a64916956018f71a27d1", courierId: "6a0d96ef27ad772d357b22b4", name: "Delhivery Air" },
  { roleId: "6a61a64916956018f71a27cf", courierId: "6a06d0daea73ccc9fd278979", name: "Bluedart Brand Air" },
] as const;

export class NimbusClient {
  constructor(private readonly config: NimbusConfig, private readonly cache: { getOrderId: (order: string) => Promise<string | undefined>; cacheOrder: (order: string, id: string) => Promise<void> }) {}

  async shipMany(orderNumbers: string[], concurrency = 5, onProgress?: (event: NimbusProgressEvent) => Promise<void>) {
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
    let labelUrl: string | null = null;
    if (shipped.length) {
      await onProgress?.({ type: "labels_started", count: shipped.length });
      try { labelUrl = await this.labels(shipped.map((item) => item.orderId)); await onProgress?.({ type: "labels_ready", labelUrl }); }
      catch (error) { const parsed = this.describeError(error); await onProgress?.({ type: "labels_failed", error: parsed.error }); }
    }
    return { shipped, failed, labelUrl };
  }

  private async shipOne(orderNumber: string, signal: AbortSignal, onProgress?: (event: NimbusProgressEvent) => Promise<void>): Promise<ShippedOrder> {
    if (this.config.mockMode) return this.mockShip(orderNumber, onProgress);
    const order = await this.resolveOrder(orderNumber, signal);
    if (order.order_status === "cancelled") throw new AppError("ORDER_CANCELLED", "Order was cancelled");
    if (order.order_status === "booked" && order.shipment?.awb) return { orderNumber, orderId: order.order_id, awb: order.shipment.awb, courier: order.shipment.courier_name || "Allocated courier", cost: order.shipment.price?.total || 0, alreadyBooked: true };
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
    throw new AppError("COURIER_PRIORITY_EXHAUSTED", `All ${COURIER_PRIORITY.length} priority couriers rejected this shipment. ${rejected.at(-1) || "No courier was serviceable."}`);
  }

  private async resolveOrder(orderNumber: string, signal: AbortSignal): Promise<OrderMatch> {
    const canonical = (value: string) => `#${value.trim().replace(/^#/, "").toUpperCase()}`;
    const cached = await this.cache.getOrderId(orderNumber);
    if (cached) return this.getOrder(cached, signal);
    const exact = await this.listOrders({ order_number: orderNumber, limit: "100", page: "1" }, signal);
    let match = exact.data.find((order) => order.order_number && canonical(order.order_number) === orderNumber);
    if (!match) {
      const pages = Math.min(exact.meta?.pagination?.totalPages || this.config.maxPages, this.config.maxPages);
      for (let page = 1; page <= pages && !match; page++) {
        const response = page === 1 ? exact : await this.listOrders({ limit: "100", page: String(page) }, signal);
        match = response.data.find((order) => order.order_number && canonical(order.order_number) === orderNumber);
      }
    }
    if (!match) throw new AppError("NOT_FOUND", `Order ${orderNumber} was not found in NimbusPost`);
    await this.cache.cacheOrder(orderNumber, match.order_id); return match;
  }

  private listOrders(query: Record<string, string>, signal: AbortSignal) { return this.request<Envelope<OrderMatch[]>>(`/v2/orders?${new URLSearchParams(query)}`, {}, 0, signal); }
  private async getOrder(orderId: string, signal: AbortSignal) { return (await this.request<Envelope<OrderMatch>>(`/v2/orders/${encodeURIComponent(orderId)}`, {}, 0, signal)).data; }
  private async labels(ids: string[]) {
    if (this.config.mockMode) return `/demo-labels?ids=${encodeURIComponent(ids.join(","))}`;
    try {
      const response = await this.request<Envelope<{ url: string }>>("/v2/shipments/labels", { method: "POST", body: JSON.stringify({ order_ids: ids }) }); return response.data.url;
    } catch (error) {
      if (!(error instanceof AppError) || !/\bids\b/i.test(error.message)) throw error;
      const response = await this.request<Envelope<{ url: string }>>("/v2/shipments/labels", { method: "POST", body: JSON.stringify({ ids }) }); return response.data.url;
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
}

class AppError extends Error { constructor(public readonly code: string, message: string) { super(message); } }
