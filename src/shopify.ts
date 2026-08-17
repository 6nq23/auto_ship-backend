import type { ShopifyAddress, ShopifyOrder } from "./types.js";
import { extractOrderSuffix, normalizeOrderNumber, normalizePhoneNumber } from "./identifiers.js";

type ShopifyConfig = {
  storeDomain: string;
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  apiVersion?: string;
  mockMode: boolean;
};

type GraphQlOrder = {
  id: string;
  name: string;
  phone?: string;
  createdAt: string;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  shippingAddress?: ShopifyAddress;
  billingAddress?: { phone?: string };
  customer?: { defaultPhoneNumber?: { phoneNumber?: string } };
  lineItems: { nodes: Array<{ title: string; quantity: number; sku?: string }> };
  fulfillments: Array<{ trackingInfo: Array<{ number?: string; url?: string; company?: string }> }>;
};

const SUPPORT_ORDERS_QUERY = `#graphql
  query SupportOrders($query: String!, $first: Int!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        phone
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        shippingAddress { name firstName lastName phone address1 address2 city province provinceCode zip country countryCodeV2 }
        billingAddress { phone }
        customer { defaultPhoneNumber { phoneNumber } }
        lineItems(first: 20) { nodes { title quantity sku } }
        fulfillments { trackingInfo { number url company } }
      }
    }
  }
`;

const CUSTOMER_ORDERS_BY_PHONE_QUERY = `#graphql
  query SupportCustomerOrders($identifier: CustomerIdentifierInput!, $first: Int!, $after: String) {
    customerByIdentifier(identifier: $identifier) {
      id
      defaultPhoneNumber { phoneNumber }
      orders(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          phone
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          shippingAddress { name firstName lastName phone address1 address2 city province provinceCode zip country countryCodeV2 }
          billingAddress { phone }
          customer { defaultPhoneNumber { phoneNumber } }
          lineItems(first: 20) { nodes { title quantity sku } }
          fulfillments { trackingInfo { number url company } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const CUSTOMERS_BY_PHONE_SEARCH_QUERY = `#graphql
  query SupportCustomersByPhone($query: String!, $customerFirst: Int!, $orderFirst: Int!) {
    customers(first: $customerFirst, query: $query) {
      nodes {
        id
        defaultPhoneNumber { phoneNumber }
        orders(first: $orderFirst, sortKey: CREATED_AT, reverse: true) {
          nodes {
            id
            name
            phone
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            currentTotalPriceSet { shopMoney { amount currencyCode } }
            shippingAddress { name firstName lastName phone address1 address2 city province provinceCode zip country countryCodeV2 }
            billingAddress { phone }
            customer { defaultPhoneNumber { phoneNumber } }
            lineItems(first: 20) { nodes { title quantity sku } }
            fulfillments { trackingInfo { number url company } }
          }
        }
      }
    }
  }
`;

const UPDATE_ADDRESS_MUTATION = `#graphql
  mutation SupportOrderAddressUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id name shippingAddress { address1 address2 city province zip country phone } }
      userErrors { field message }
    }
  }
`;

export class ShopifyClient {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly config: ShopifyConfig) {}

  get connected() { return this.config.mockMode || Boolean(this.config.storeDomain && (this.config.accessToken || (this.config.clientId && this.config.clientSecret))); }

  async getOrderByName(name: string) {
    const normalized = this.normalizeShopifyOrderName(name);
    if (!normalized) return null;
    if (this.config.mockMode) return this.mockOrder(normalized);
    const exactOrders = await this.findOrders(`name:${this.escapeSearch(normalized)}`, 5);
    const exact = exactOrders.find((order) => this.normalizeShopifyOrderName(order.name) === normalized);
    if (exact) return exact;

    // Some storefronts expose an RBD reference to customers while Shopify's
    // configured order name uses another prefix (for example #DR3053). Shopify
    // can search the numeric name suffix, so match it exactly as a safe alias.
    const suffix = extractOrderSuffix(name) || extractOrderSuffix(normalized);
    if (!suffix) return null;
    const suffixOrders = await this.findOrders(`name:${suffix}`, 25);
    return suffixOrders.find((order) => extractOrderSuffix(order.name) === suffix) || null;
  }

  async getOrdersByPhone(phone: string) {
    const normalized = normalizePhoneNumber(phone);
    if (!normalized) return [];
    if (this.config.mockMode) return [this.mockOrder("#RBD5001"), this.mockOrder("#RBD4998")].filter((order): order is ShopifyOrder => Boolean(order));

    try {
      const orders: GraphQlOrder[] = [];
      let after: string | null = null;
      let customerFound = false;
      do {
        const data: { customerByIdentifier: { id: string; defaultPhoneNumber?: { phoneNumber?: string }; orders: { nodes: GraphQlOrder[]; pageInfo?: { hasNextPage: boolean; endCursor?: string | null } } } | null } = await this.graphql(CUSTOMER_ORDERS_BY_PHONE_QUERY, {
          identifier: { phoneNumber: `+91${normalized}` },
          first: 100,
          after,
        });
        if (!data.customerByIdentifier) break;
        customerFound = true;
        orders.push(...data.customerByIdentifier.orders.nodes);
        const pageInfo: { hasNextPage: boolean; endCursor?: string | null } | undefined = data.customerByIdentifier.orders.pageInfo;
        after = pageInfo?.hasNextPage && pageInfo.endCursor ? pageInfo.endCursor : null;
      } while (after);
      if (customerFound) return this.mapOrders(orders);
    } catch (error) {
      console.warn("[shopify] Direct customer phone lookup failed; trying Shopify customer search instead.", error);
    }

    const variants = [`+91${normalized}`, `91${normalized}`, normalized];
    for (const candidate of variants) {
      const result = await this.graphql<{ customers: { nodes: Array<{ id: string; defaultPhoneNumber?: { phoneNumber?: string }; orders: { nodes: GraphQlOrder[] } }> } }>(CUSTOMERS_BY_PHONE_SEARCH_QUERY, {
        query: `phone:${this.escapeSearch(candidate)}`,
        customerFirst: 10,
        orderFirst: 250,
      });
      const customers = result.customers.nodes.filter((customer) => !customer.defaultPhoneNumber?.phoneNumber || normalizePhoneNumber(customer.defaultPhoneNumber.phoneNumber) === normalized);
      if (customers.length) return this.mapOrders(customers.flatMap((customer) => customer.orders.nodes));
    }
    return [];
  }

  async updateOrderAddress(orderId: string, address: ShopifyAddress) {
    if (this.config.mockMode) return;
    const shippingAddress = {
      address1: address.address1,
      ...(address.address2 ? { address2: address.address2 } : {}),
      city: address.city,
      ...(address.province ? { province: address.province } : {}),
      zip: address.zip,
      ...(address.country ? { country: address.country } : {}),
      ...(address.phone ? { phone: address.phone } : {}),
      ...(address.firstName ? { firstName: address.firstName } : {}),
      ...(address.lastName ? { lastName: address.lastName } : {}),
    };
    const data = await this.graphql<{ orderUpdate: { userErrors: Array<{ field?: string[]; message: string }> } }>(UPDATE_ADDRESS_MUTATION, { input: { id: orderId, shippingAddress } });
    if (data.orderUpdate.userErrors.length) throw new Error(data.orderUpdate.userErrors.map((error) => error.message).join("; "));
  }

  private async findOrders(query: string, first: number) {
    const data = await this.graphql<{ orders: { nodes: GraphQlOrder[] } }>(SUPPORT_ORDERS_QUERY, { query, first });
    return this.mapOrders(data.orders.nodes);
  }

  private mapOrders(orders: GraphQlOrder[]): ShopifyOrder[] {
    return orders.map((order) => ({
      id: order.id,
      name: order.name,
      createdAt: order.createdAt,
      displayFinancialStatus: order.displayFinancialStatus,
      displayFulfillmentStatus: order.displayFulfillmentStatus,
      totalAmount: order.currentTotalPriceSet.shopMoney.amount,
      currencyCode: order.currentTotalPriceSet.shopMoney.currencyCode,
      ...(order.shippingAddress ? { shippingAddress: { ...order.shippingAddress, countryCode: order.shippingAddress.countryCode || (order.shippingAddress as ShopifyAddress & { countryCodeV2?: string }).countryCodeV2 } } : {}),
      customerPhones: [order.phone, order.shippingAddress?.phone, order.billingAddress?.phone, order.customer?.defaultPhoneNumber?.phoneNumber].filter((phone): phone is string => Boolean(phone)),
      lineItems: order.lineItems.nodes,
      trackingInfo: (order.fulfillments || []).flatMap((fulfillment) => fulfillment.trackingInfo || []),
    }));
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://${this.config.storeDomain}/admin/api/${this.config.apiVersion || "2026-07"}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await this.getAccessToken() },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({})) as { data?: T; errors?: Array<{ message: string }> };
    if (!response.ok || body.errors?.length || !body.data) throw new Error(body.errors?.map((error) => error.message).join("; ") || `Shopify request failed with HTTP ${response.status}`);
    return body.data;
  }

  private async getAccessToken() {
    if (this.config.accessToken) return this.config.accessToken;
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await fetch(`https://${this.config.storeDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.config.clientId, client_secret: this.config.clientSecret }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !body.access_token) throw new Error(body.error_description || `Shopify authentication failed with HTTP ${response.status}`);
    this.token = { value: body.access_token, expiresAt: Date.now() + Math.max(60, body.expires_in || 86_400) * 1000 };
    return this.token.value;
  }

  private escapeSearch(value: string) { return `"${value.replace(/["\\]/g, "\\$&")}"`; }

  private normalizeShopifyOrderName(value: string) {
    const rbd = normalizeOrderNumber(value);
    if (rbd) return rbd;
    const compact = value.trim().toUpperCase().replace(/[\s-]+/g, "").replace(/^#/, "");
    return /^[A-Z]{1,8}\d+$/.test(compact) ? `#${compact}` : undefined;
  }

  private mockOrder(name: string): ShopifyOrder | null {
    if (!/^#RBD\d+$/.test(name) || name.endsWith("0000")) return null;
    return { id: `gid://shopify/Order/${name.replace(/\D/g, "")}`, name, createdAt: new Date().toISOString(), displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", totalAmount: "499.00", currencyCode: "INR", shippingAddress: { name: "Demo Customer", firstName: "Demo", lastName: "Customer", phone: "9876543210", address1: "12 MG Road", city: "Bengaluru", province: "Karnataka", zip: "560001", country: "India" }, customerPhones: ["9876543210"], lineItems: [{ title: "Rakhi Set", quantity: 2, sku: "RAKHI-SET" }] };
  }
}

export { CUSTOMERS_BY_PHONE_SEARCH_QUERY, CUSTOMER_ORDERS_BY_PHONE_QUERY, SUPPORT_ORDERS_QUERY, UPDATE_ADDRESS_MUTATION };
