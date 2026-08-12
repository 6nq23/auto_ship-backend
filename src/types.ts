export type Role = "admin" | "packer";
export type UserRecord = { id: number; username: string; passwordHash: string; role: Role };
export type ShippedOrder = { orderNumber: string; orderId: string; awb: string; courier: string; cost: number; alreadyBooked?: boolean };
export type FailedOrder = { orderNumber: string; error: string; code: string };
export type ShippingLog = { at: string; level: "info" | "success" | "error"; message: string; orderNumber?: string };
export type Batch = { batchId: string; createdAt: string; shippedBy: string; shipped: ShippedOrder[]; failed: FailedOrder[]; labelUrl: string | null; totalShipped: number; totalFailed: number; demoMode: boolean; logs?: ShippingLog[] };
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
  | { type: "labels_failed"; error: string };
export type OrderMatch = { order_id: string; order_number: string; order_status?: string; shipment?: { awb?: string; courier_name?: string; price?: { total?: number }; label_url?: string } };
