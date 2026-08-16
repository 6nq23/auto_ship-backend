import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "./shopify.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const makeClient = () => new ShopifyClient({ storeDomain: "store.myshopify.com", clientId: "client", clientSecret: "secret", apiVersion: "2026-07", mockMode: false });

afterEach(() => vi.unstubAllGlobals());

describe("ShopifyClient", () => {
  it("uses the client-credential grant, caches the token, and maps orders", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      if (url.endsWith("/admin/oauth/access_token")) { expect(String(init?.body)).toContain("grant_type=client_credentials"); return json({ access_token: "access-token", expires_in: 3600 }); }
      expect(new Headers(init?.headers).get("X-Shopify-Access-Token")).toBe("access-token");
      return json({ data: { orders: { nodes: [{ id: "gid://shopify/Order/5001", name: "#RBD5001", createdAt: "2026-08-15T10:00:00Z", displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", currentTotalPriceSet: { shopMoney: { amount: "499.00", currencyCode: "INR" } }, shippingAddress: { name: "Asha", phone: "+919876543210", address1: "12 MG Road", city: "Bengaluru", province: "Karnataka", zip: "560001", country: "India" }, lineItems: { nodes: [{ title: "Rakhi Set", quantity: 2, sku: "RS-1" }] }, fulfillments: [{ trackingInfo: [{ number: "AWB-1", url: "https://track.test/AWB-1", company: "Courier" }] }] }] } } });
    }));
    const first = await makeClient().getOrderByName("RBD5001");
    expect(first?.name).toBe("#RBD5001"); expect(first?.lineItems[0]).toEqual({ title: "Rakhi Set", quantity: 2, sku: "RS-1" }); expect(first?.customerPhones).toContain("+919876543210");
    expect(first?.trackingInfo).toEqual([{ number: "AWB-1", url: "https://track.test/AWB-1", company: "Courier" }]);

    const client = makeClient();
    await client.getOrderByName("RBD5001"); await client.getOrderByName("RBD5001");
    expect(calls.filter((url) => url.endsWith("/admin/oauth/access_token"))).toHaveLength(2);
  });

  it("finds a customer's orders through customerByIdentifier using an E.164 phone", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/admin/oauth/access_token")) return json({ access_token: "access-token", expires_in: 3600 });
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { identifier: { phoneNumber: string } } };
      expect(body.query).toContain("customerByIdentifier");
      expect(body.variables.identifier.phoneNumber).toBe("+919876543210");
      return json({ data: { customerByIdentifier: { orders: { nodes: [{ id: "gid://shopify/Order/5001", name: "#RBD5001", createdAt: "2026-08-15T10:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "499.00", currencyCode: "INR" } }, shippingAddress: { phone: "+91 98765 43210", address1: "12 MG Road", city: "Bengaluru", zip: "560001" }, lineItems: { nodes: [] }, fulfillments: [] }] } } } });
    }));

    await expect(makeClient().getOrdersByPhone("0091 98765 43210")).resolves.toMatchObject([{ name: "#RBD5001" }]);
  });

  it("returns every order belonging to the matched customer even when an old order has a different delivery phone", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/admin/oauth/access_token")) return json({ access_token: "access-token", expires_in: 3600 });
      return json({ data: { customerByIdentifier: { id: "gid://shopify/Customer/1", defaultPhoneNumber: { phoneNumber: "+919876543210" }, orders: { nodes: [
        { id: "gid://shopify/Order/1", name: "#DR1001", createdAt: "2026-08-01T10:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "499", currencyCode: "INR" } }, shippingAddress: { phone: "+919876543210", address1: "Current", city: "Delhi", zip: "110001" }, lineItems: { nodes: [] }, fulfillments: [] },
        { id: "gid://shopify/Order/2", name: "#DR900", createdAt: "2026-07-01T10:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "299", currencyCode: "INR" } }, shippingAddress: { phone: "+919000000000", address1: "Old", city: "Delhi", zip: "110001" }, lineItems: { nodes: [] }, fulfillments: [] },
      ] } } } });
    }));

    await expect(makeClient().getOrdersByPhone("9876543210")).resolves.toMatchObject([{ name: "#DR1001" }, { name: "#DR900" }]);
  });

  it("sends validated orderUpdate input and surfaces Shopify user errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/admin/oauth/access_token")) return json({ access_token: "access-token", expires_in: 3600 });
      const body = JSON.parse(String(init?.body)) as { variables: { input: { shippingAddress: { zip: string; city: string } } } };
      expect(body.variables.input.shippingAddress).toMatchObject({ city: "Kolkata", zip: "700016" });
      return json({ data: { orderUpdate: { order: null, userErrors: [{ field: ["input", "shippingAddress"], message: "Address is invalid" }] } } });
    }));
    await expect(makeClient().updateOrderAddress("gid://shopify/Order/5001", { address1: "14 Park Street", city: "Kolkata", province: "West Bengal", zip: "700016", country: "India", phone: "9876543210" })).rejects.toThrow("Address is invalid");
  });
});
