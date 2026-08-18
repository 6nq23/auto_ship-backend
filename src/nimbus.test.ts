import { afterEach, describe, expect, it, vi } from "vitest";
import { COURIER_PRIORITY, NimbusClient } from "./nimbus.js";
import type { NimbusProgressEvent } from "./types.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const makeClient = () => new NimbusClient(
  { apiUrl: "https://nimbus.test", apiKey: "key", apiSecret: "secret", maxPages: 2, mockMode: false },
  { getOrderId: async () => undefined, cacheOrder: async () => undefined },
);

afterEach(() => vi.unstubAllGlobals());

describe("Nimbus courier priority", () => {
  it("uses the requested air-first courier order", () => {
    expect(COURIER_PRIORITY.map((courier) => courier.name)).toEqual([
      "Delhivery Air",
      "Bluedart Brand Air",
      "Bluedart Brand",
      "Delhivery Surface DT_Stressed",
      "Xpressbees Surface",
      "Xpressbees Surface_Stressed",
      "Delhivery Surface DT",
    ]);
  });

  it("normalizes spaced and prefix-free customer order numbers before lookup", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested.push(url.searchParams.get("order_number") || "");
      return json({ success: true, data: [{ order_id: "ORD-5001", order_number: "#RBD5001", order_status: "created" }] });
    }));

    await expect(makeClient().lookupOrder("5 0 0 1")).resolves.toMatchObject({ order_id: "ORD-5001" });
    expect(requested[0]).toBe("#RBD5001");
  });

  it("finds Nimbus orders by a customer phone across paginated order data", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("page") === "1") return json({ success: true, data: Array.from({ length: 100 }, (_, index) => ({ order_id: `ORD-${index}`, order_number: `#RBD${index}`, shipping_address: { phone: "9000000000" } })), meta: { pagination: { totalPages: 2 } } });
      return json({ success: true, data: [{ order_id: "ORD-TARGET", order_number: "#RBD5001", shipping_address: { phone: "+91 98765 43210" } }], meta: { pagination: { totalPages: 2 } } });
    }));

    await expect(makeClient().getOrdersByPhone("0091 98765 43210")).resolves.toMatchObject([{ order_number: "#RBD5001" }]);
  });

  it("pins each courier_id in order and stops after the first success", async () => {
    const bookingBodies: Array<Record<string, string>> = []; const events: NimbusProgressEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v2/orders?")) return json({ success: true, data: [{ order_id: "ORD-24", order_number: "#RBD4024", order_status: "pending" }] });
      if (url.endsWith("/v2/shipments/book")) {
        const body = JSON.parse(String(init?.body)) as Record<string, string>; bookingBodies.push(body);
        if (bookingBodies.length === 1) return json({ error: { code: "NO_SERVICEABLE_COURIER", detail: "Not serviceable" } }, 400);
        return json({ success: true, data: { awb: "AWB-24", courier_name: "Bluedart Brand", price: { total: 92 } } });
      }
      if (url.endsWith("/v2/shipments/labels")) return json({ success: true, data: { url: "https://labels.test/24.pdf" } });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await makeClient().shipMany(["#RBD4024"], 1, async (event) => { events.push(event); });
    expect(bookingBodies).toEqual([
      { order_id: "ORD-24", courier_id: COURIER_PRIORITY[0].courierId },
      { order_id: "ORD-24", courier_id: COURIER_PRIORITY[1].courierId },
    ]);
    expect(bookingBodies.every((body) => !("role_id" in body))).toBe(true);
    expect(result.shipped[0].courier).toBe("Bluedart Brand");
    expect(events.filter((event) => event.type === "courier_attempt")).toHaveLength(2);
    expect(events.some((event) => event.type === "courier_rejected" && event.priority === 1)).toBe(true);
  });

  it("tries each configured courier once and then returns a bounded failure", async () => {
    const bookingIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v2/orders?")) return json({ success: true, data: [{ order_id: "ORD-35", order_number: "#RBD4035", order_status: "pending" }] });
      if (url.endsWith("/v2/shipments/book")) { const body = JSON.parse(String(init?.body)) as { courier_id: string }; bookingIds.push(body.courier_id); return json({ error: { code: "NO_SERVICEABLE_COURIER", detail: "Not serviceable" } }, 400); }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await makeClient().shipMany(["#RBD4035"], 1);
    expect(bookingIds).toEqual(COURIER_PRIORITY.map((courier) => courier.courierId));
    expect(new Set(bookingIds).size).toBe(COURIER_PRIORITY.length);
    expect(result.failed).toEqual([{ orderNumber: "#RBD4035", code: "COURIER_PRIORITY_EXHAUSTED", error: expect.stringContaining(`All ${COURIER_PRIORITY.length} priority couriers rejected`) }]);
  });

  it("recovers pickup_scheduled as successful, preserves the booking error, and generates its label", async () => {
    const bookingIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/orders" && url.search) return json({ success: true, data: [{ order_id: "ORD-77", order_number: "#RBD4077", order_status: "created" }] });
      if (url.pathname === "/v2/shipments/book") {
        const body = JSON.parse(String(init?.body)) as { courier_id: string }; bookingIds.push(body.courier_id);
        return json({ error: { code: "VALIDATION_FAILED", detail: 'Order cannot be booked - current status is "pickup_scheduled". Only orders in "created" status can be booked.' } }, 400);
      }
      if (url.pathname === "/v2/orders/ORD-77") return json({ success: true, data: { order_id: "ORD-77", order_number: "#RBD4077", order_status: "pickup_scheduled", shipment: { awb: "AWB-77", courier_name: "Bluedart Brand Air", amount: 96 } } });
      if (url.pathname === "/v2/shipments/labels") return json({ success: true, data: { url: "https://labels.test/77.pdf" } });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await makeClient().shipMany(["#RBD4077"], 1);
    expect(bookingIds).toEqual(COURIER_PRIORITY.map((courier) => courier.courierId));
    expect(result.failed).toEqual([]);
    expect(result.shipped).toEqual([expect.objectContaining({ orderNumber: "#RBD4077", orderId: "ORD-77", awb: "AWB-77", courier: "Bluedart Brand Air", cost: 96, alreadyBooked: true, warningCode: "PICKUP_ALREADY_SCHEDULED", warning: expect.stringContaining(`All ${COURIER_PRIORITY.length} priority couriers rejected this shipment`) })]);
    expect(result.labelUrl).toBe("https://labels.test/77.pdf");
    expect(result.pickupScheduledLabelUrl).toBe("https://labels.test/77.pdf");
  });

  it("recovers pickup_pending as successful and includes it in the separate pickup labels", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/orders" && url.search) return json({ success: true, data: [{ order_id: "ORD-78", order_number: "#RBD4078", order_status: "created" }] });
      if (url.pathname === "/v2/shipments/book") return json({ error: { code: "VALIDATION_FAILED", detail: 'Order cannot be booked - current status is "pickup_pending". Only orders in "created" status can be booked.' } }, 400);
      if (url.pathname === "/v2/orders/ORD-78") return json({ success: true, data: { order_id: "ORD-78", order_number: "#RBD4078", order_status: "pickup_pending", shipment: { awb: "AWB-78", courier_name: "Bluedart Brand", amount: 88 } } });
      if (url.pathname === "/v2/shipments/labels") return json({ success: true, data: { url: "https://labels.test/78.pdf" } });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await makeClient().shipMany(["#RBD4078"], 1);
    expect(result.failed).toEqual([]);
    expect(result.shipped).toEqual([expect.objectContaining({ orderNumber: "#RBD4078", warningCode: "PICKUP_ALREADY_PENDING", alreadyBooked: true })]);
    expect(result.labelUrl).toBe("https://labels.test/78.pdf");
    expect(result.pickupScheduledLabelUrl).toBe("https://labels.test/78.pdf");
  });

  it("processes a bulk batch with at most five orders concurrently", async () => {
    let activeBookings = 0; let maximumActiveBookings = 0; let labelIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/orders") { const orderNumber = url.searchParams.get("order_number")!; return json({ success: true, data: [{ order_id: `ORD-${orderNumber.slice(4)}`, order_number: orderNumber, order_status: "pending" }] }); }
      if (url.pathname === "/v2/shipments/book") { const suffix = Number(JSON.parse(String(init?.body)).order_id.replace(/\D/g, "")); activeBookings++; maximumActiveBookings = Math.max(maximumActiveBookings, activeBookings); await new Promise((resolve) => setTimeout(resolve, (507 - suffix) * 5)); activeBookings--; return json({ success: true, data: { awb: "AWB", courier_name: "Delhivery Surface DT", price: { total: 75 } } }); }
      if (url.pathname === "/v2/shipments/labels") { labelIds = JSON.parse(String(init?.body)).ids; return json({ success: true, data: { url: "https://labels.test/bulk.pdf" } }); }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const orders = Array.from({ length: 7 }, (_, index) => `#RBD50${index}`);
    const result = await makeClient().shipMany(orders, 5);
    expect(result.shipped).toHaveLength(7);
    expect(result.shipped.map((item) => item.orderNumber)).toEqual(orders);
    expect(labelIds).toEqual(orders.map((order) => `ORD-${order.slice(4)}`));
    expect(maximumActiveBookings).toBe(5);
  });

  it("uses the ordered ids label contract and falls back to order_ids when required", async () => {
    const labelBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v2/orders?")) return json({ success: true, data: [{ order_id: "ORD-51", order_number: "#RBD51", order_status: "booked", shipment: { awb: "AWB-51", courier_name: "Delhivery" } }] });
      if (url.endsWith("/v2/shipments/labels")) { const body = JSON.parse(String(init?.body)); labelBodies.push(body); if (labelBodies.length === 1) return json({ error: { code: "VALIDATION_FAILED", detail: "order_ids: expected array" } }, 400); return json({ success: true, data: { url: "https://labels.test/51.pdf" } }); }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const result = await makeClient().shipMany(["#RBD51"], 1);
    expect(labelBodies).toEqual([{ ids: ["ORD-51"] }, { order_ids: ["ORD-51"] }]);
    expect(result.labelUrl).toBe("https://labels.test/51.pdf");
  });

  it("paginates NDR records until it finds the requested AWB", async () => {
    const pages: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input)); pages.push(url.searchParams.get("page") || "");
      if (url.searchParams.get("page") === "1") return json({ success: true, data: Array.from({ length: 100 }, (_, index) => ({ awb: `AWB-${index}` })), meta: { pagination: { totalPages: 2 } } });
      return json({ success: true, data: [{ awb: "AWB-TARGET", available_actions: ["rto"] }], meta: { pagination: { totalPages: 2 } } });
    }));

    await expect(makeClient().getNdr("AWB-TARGET")).resolves.toMatchObject({ awb: "AWB-TARGET", available_actions: ["rto"] });
    expect(pages).toEqual(["1", "2"]);
  });

  it("restores the original Nimbus order when address replacement creation fails", async () => {
    const createBodies: Array<Record<string, unknown>> = [];
    let cachedOrderId = "";
    const client = new NimbusClient(
      { apiUrl: "https://nimbus.test", apiKey: "key", apiSecret: "secret", maxPages: 2, mockMode: false },
      { getOrderId: async () => undefined, cacheOrder: async (_order, id) => { cachedOrderId = id; } },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/orders" && url.search) return json({ success: true, data: [{ order_id: "ORD-OLD", order_number: "#RBD5001", order_status: "created" }] });
      if (url.pathname === "/v2/orders/ORD-OLD" && !url.pathname.endsWith("/cancel")) return json({ success: true, data: { order_number: "#RBD5001", order_type: "forward", payment_mode: "prepaid", warehouse_id: "WH-1", shipping_address: { name: "Asha", address: "Old Road", pincode: 560001, city: "Bengaluru", state: "Karnataka", country: "India", phone: 9876543210 }, items: [{ name: "Rakhi", qty: 1 }], package: { weight: 0.5 } } });
      if (url.pathname.endsWith("/cancel")) return json({ success: true, data: {} });
      if (url.pathname === "/v2/orders" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>; createBodies.push(body);
        if (createBodies.length === 1) return json({ error: { code: "VALIDATION_FAILED", detail: "New address rejected" } }, 422);
        return json({ success: true, data: { order_id: "ORD-RESTORED", order_number: "#RBD5001", order_status: "created" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(client.replacePendingOrderAddress("#RBD5001", { address1: "New Road", city: "Kolkata", province: "West Bengal", zip: "700016", country: "India", phone: "9123456789" })).rejects.toThrow("restored the original order");
    expect((createBodies[0].shipping_address as Record<string, unknown>).address).toBe("New Road");
    expect((createBodies[1].shipping_address as Record<string, unknown>).address).toBe("Old Road");
    expect(cachedOrderId).toBe("ORD-RESTORED");
  });

  it("does not create a compensating order when only local cache bookkeeping fails", async () => {
    let createCount = 0;
    let cacheWrites = 0;
    const client = new NimbusClient(
      { apiUrl: "https://nimbus.test", apiKey: "key", apiSecret: "secret", maxPages: 2, mockMode: false },
      { getOrderId: async () => undefined, cacheOrder: async () => { cacheWrites++; if (cacheWrites > 1) throw new Error("cache unavailable"); } },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/orders" && url.search) return json({ success: true, data: [{ order_id: "ORD-OLD", order_number: "#RBD5001", order_status: "created" }] });
      if (url.pathname === "/v2/orders/ORD-OLD") return json({ success: true, data: { order_number: "#RBD5001", order_type: "forward", payment_mode: "prepaid", warehouse_id: "WH-1", shipping_address: { name: "Asha", address: "Old Road", pincode: 560001, city: "Bengaluru", state: "Karnataka", country: "India", phone: 9876543210 }, items: [{ name: "Rakhi", qty: 1 }], package: { weight: 0.5 } } });
      if (url.pathname.endsWith("/cancel")) return json({ success: true, data: {} });
      if (url.pathname === "/v2/orders" && init?.method === "POST") { createCount++; return json({ success: true, data: { order_id: "ORD-NEW", order_number: "#RBD5001", order_status: "created" } }); }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(client.replacePendingOrderAddress("#RBD5001", { address1: "New Road", city: "Kolkata", province: "West Bengal", zip: "700016", country: "India", phone: "9123456789" })).resolves.toBeUndefined();
    expect(createCount).toBe(1);
  });

  it("does not create a second order after an ambiguous replacement timeout", async () => {
    let createCount = 0;
    const client = new NimbusClient(
      { apiUrl: "https://nimbus.test", apiKey: "key", apiSecret: "secret", maxPages: 2, mockMode: false },
      { getOrderId: async () => undefined, cacheOrder: async () => undefined },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v2/orders" && url.search) return json({ success: true, data: [{ order_id: "ORD-OLD", order_number: "#RBD5001", order_status: "created" }] });
      if (url.pathname === "/v2/orders/ORD-OLD") return json({ success: true, data: { order_number: "#RBD5001", order_type: "forward", payment_mode: "prepaid", warehouse_id: "WH-1", shipping_address: { name: "Asha", address: "Old Road", pincode: 560001, city: "Bengaluru", state: "Karnataka", country: "India", phone: 9876543210 }, items: [{ name: "Rakhi", qty: 1 }], package: { weight: 0.5 } } });
      if (url.pathname.endsWith("/cancel")) return json({ success: true, data: {} });
      if (url.pathname === "/v2/orders" && init?.method === "POST") { createCount++; throw new TypeError("socket closed after upload"); }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(client.replacePendingOrderAddress("#RBD5001", { address1: "New Road", city: "Kolkata", province: "West Bengal", zip: "700016", country: "India", phone: "9123456789" })).rejects.toThrow("did not confirm whether the replacement order was created");
    expect(createCount).toBe(1);
  });
});
