import { Message } from "@aws-sdk/client-sqs";

import { config } from "./config";
import { logger } from "../shared/logger";
import { receiveMessages, deleteMessages } from "./sqs";
import { saveTelemetry } from "./dynamodb";
import {
  telemetrySchema,
  TelemetryPayload,
} from "../shared/validation";

let shuttingDown = false; 

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableError(error: any): boolean {
  const retryableNames = new Set([
    "ThrottlingException",
    "ProvisionedThroughputExceededException",
    "RequestLimitExceeded",
    "ServiceUnavailable",
    "InternalServerError",
    "TimeoutError",
    "NetworkingError",
  ]);

  return (
    retryableNames.has(error?.name) ||
    error?.$retryable !== undefined
  );
}

async function processMessage(
  message: Message
): Promise<"success" | "failure"> {
  if (!message.Body || !message.ReceiptHandle) {
    logger.warn("invalid_sqs_message", {
      messageId: message.MessageId,
    });

    return "failure";
  }

  let payload: TelemetryPayload;

  try {
    const parsed = JSON.parse(message.Body);

    payload = telemetrySchema.parse(parsed);
  } catch (error) {
    logger.error("invalid_message_payload", {
      messageId: message.MessageId,
      error: error instanceof Error ? error.message : String(error),
    });

    /*
     * Do NOT delete this message.
     *
     * SQS will make it visible again.
     * After maxReceiveCount, the configured DLQ
     * should receive it.
     */
    return "failure";
  }

  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await saveTelemetry(payload);

      logger.info("message_processed", {
        messageId: message.MessageId,
        eventId:
          payload.eventId ??
          `${payload.deviceId}#${payload.timestamp}`,
        deviceId: payload.deviceId,
        result,
        attempt,
      });

      return "success";
    } catch (error) {
      const retryable = isRetryableError(error);

      logger.error("message_processing_failed", {
        messageId: message.MessageId,
        deviceId: payload.deviceId,
        attempt,
        retryable,
        error: error instanceof Error ? error.message : String(error),
      });

      if (!retryable || attempt === maxAttempts) {
        return "failure";
      }

      const delay = Math.min(
        1000 * 2 ** (attempt - 1),
        30000
      );

      await sleep(delay);
    }
  }

  return "failure";
}

export async function pollMessages(): Promise<void> {
  logger.info("worker_started", {
    queueUrl: config.QUEUE_URL,
  });

  while (!shuttingDown) {
    try {
      const messages = await receiveMessages();

      if (messages.length === 0) {
        continue;
      }

      logger.info("messages_received", {
        count: messages.length,
      });

      const successfulMessages: {
        Id: string;
        ReceiptHandle: string;
      }[] = [];

      for (let index = 0; index < messages.length; index++) {
        if (shuttingDown) {
          break;
        }

        const message = messages[index];

        const result = await processMessage(message);

        if (
          result === "success" &&
          message.ReceiptHandle
        ) {
          successfulMessages.push({
            Id: message.MessageId ?? index.toString(),

            ReceiptHandle: message.ReceiptHandle,
          });
        }
      }

      if (successfulMessages.length > 0) {
        await deleteMessages(successfulMessages);

        logger.info("messages_deleted", {
          count: successfulMessages.length,
        });
      }
    } catch (error) {
      logger.error("worker_loop_error", {
        error: error instanceof Error ? error.message : String(error),
      });

      await sleep(5000);
    }
  }

  logger.info("worker_stopped");
}

export function shutdown(): void {
  logger.info("shutdown_requested");

  shuttingDown = true;
}