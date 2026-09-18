import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { SQSHandler } from "aws-lambda";
import { telemetrySchema } from "../shared/validation";
import { logger } from "../shared/logger";

const rawClient = new DynamoDBClient({
  region: process.env.AWS_REGION || "eu-west-1",
  maxAttempts: 3,
});

const ddb = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

const TABLE_NAME = process.env.TABLE_NAME;
const MAX_BATCH_RETRIES = 5;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type PutRequest = {
  PutRequest: {
    Item: Record<string, unknown>;
  };
};

async function batchWriteWithRetry(
  requests: PutRequest[]
): Promise<PutRequest[]> {
  let remaining = requests;

  for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
    if (remaining.length === 0) {
      return [];
    }

    const response = await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME!]: remaining,
        },
      })
    );

    const unprocessed =
      (response.UnprocessedItems?.[TABLE_NAME!] as PutRequest[] | undefined) ?? [];

    if (unprocessed.length === 0) {
      return [];
    }

    logger.warn("dynamodb_unprocessed_items", {
      attempt,
      count: unprocessed.length,
    });

    remaining = unprocessed;

    if (attempt < MAX_BATCH_RETRIES) {
      const delay = Math.min(100 * 2 ** (attempt - 1), 3000);
      await sleep(delay);
    }
  }

  return remaining;
}

export const handler: SQSHandler = async (event) => {
  if (!TABLE_NAME) {
    throw new Error("TABLE_NAME environment variable is not set");
  }

  logger.info("sqs_batch_received", {
    recordCount: event.Records.length,
  });

  const failures: { itemIdentifier: string }[] = [];

  // Tracks every SQS messageId for a given eventId
  const eventIdToMessageIdsMap = new Map<string, string[]>();
  const validRequests: PutRequest[] = [];

  for (const record of event.Records) {
    // 1. Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.body);
    } catch (error) {
      logger.error("invalid_json", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Invalid JSON will never succeed on retry.
      // Omit from failures so SQS acknowledges and deletes it.
      continue;
    }

    // 2. Validate with Zod
    const result = telemetrySchema.safeParse(parsed);
    if (!result.success) {
      logger.error("invalid_telemetry", {
        messageId: record.messageId,
        errors: result.error.flatten(),
      });

      // Invalid schema payloads will never succeed on retry.
      // Omit from failures so SQS acknowledges and deletes it.
      continue;
    }

    const payload = result.data;
    const eventId =
      payload.eventId ?? `${payload.deviceId}#${payload.timestamp}`;

    // 3. Map ALL SQS messageIds associated with this eventId
    const existingMessageIds = eventIdToMessageIdsMap.get(eventId) || [];
    eventIdToMessageIdsMap.set(eventId, [...existingMessageIds, record.messageId]);

    // 4. Batch Deduplication: Only add 1 PutRequest per eventId
    if (existingMessageIds.length === 0) {
      validRequests.push({
        PutRequest: {
          Item: {
            eventId,
            deviceId: payload.deviceId,
            timestamp: payload.timestamp,
            temperature: payload.telemetry.temperature,
            humidity: payload.telemetry.humidity,
            batteryLevel: payload.telemetry.batteryLevel,
            status: payload.telemetry.status,
            processedAt: new Date().toISOString(),
            processedBy: "iot-lambda-processor",
          },
        },
      });
    }
  }

  if (validRequests.length === 0) {
    return { batchItemFailures: failures };
  }

  // 5. Execute DynamoDB batch write
  try {
    const unprocessed = await batchWriteWithRetry(validRequests);

    // 6. Push ALL messageIds linked to throttled/unprocessed DynamoDB items to failures
    for (const request of unprocessed) {
      const failedEventId = request.PutRequest.Item.eventId as string;
      const failedMessageIds = eventIdToMessageIdsMap.get(failedEventId) ?? [];

      for (const msgId of failedMessageIds) {
        failures.push({ itemIdentifier: msgId });
      }
    }

    logger.info("dynamodb_batch_write_completed", {
      requested: validRequests.length,
      unprocessed: unprocessed.length,
      failedMessages: failures.length,
    });
  } catch (error) {
    logger.error("dynamodb_batch_write_failed", {
      error: error instanceof Error ? error.message : String(error),
    });

    // Handle unexpected/catastrophic batch failure
    for (const record of event.Records) {
      if (
        !failures.some(
          (failure) => failure.itemIdentifier === record.messageId
        )
      ) {
        failures.push({ itemIdentifier: record.messageId });
      }
    }
  }

  return { batchItemFailures: failures };
};