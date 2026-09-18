import { z } from "zod";

export const telemetrySchema = z.object({
  eventId: z.string().min(1),

  deviceId: z.string().min(1),

  timestamp: z.string().datetime(),

  telemetry: z.object({
    temperature: z.number().optional(),
    humidity: z.number().optional(),
    batteryLevel: z.number().optional(),
    status: z.string().optional(),
  }),
});

export type TelemetryPayload = z.infer<typeof telemetrySchema>;