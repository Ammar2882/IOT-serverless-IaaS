import {
    DynamoDBClient,
  } from "@aws-sdk/client-dynamodb";
  
  import {
    DynamoDBDocumentClient,
    PutCommand,
  } from "@aws-sdk/lib-dynamodb";
  
  import { config } from "./config";
  import { TelemetryPayload } from "../shared/validation";
  
  const rawClient = new DynamoDBClient({
    region: config.AWS_REGION,
    maxAttempts: 3,
  });
  
  export const ddb = DynamoDBDocumentClient.from(rawClient);
  
  export async function saveTelemetry(
    payload: TelemetryPayload
  ): Promise<"stored" | "duplicate"> {
    const eventId =
      payload.eventId ??
      `${payload.deviceId}#${payload.timestamp}`;
  
    try {
      await ddb.send(
        new PutCommand({
          TableName: config.TABLE_NAME,
  
          Item: {
            eventId,
  
            deviceId: payload.deviceId,
  
            timestamp: payload.timestamp,
  
            temperature: payload.telemetry.temperature,
  
            humidity: payload.telemetry.humidity,
  
            batteryLevel: payload.telemetry.batteryLevel,
  
            status: payload.telemetry.status,
  
            processedAt: new Date().toISOString(),
  
            processedBy: "iot-sqs-worker",
          },
  
          ConditionExpression:
            "attribute_not_exists(eventId)",
        })
      );
  
      return "stored";
    } catch (error: any) {
      if (error?.name === "ConditionalCheckFailedException") {
        return "duplicate";
      }
  
      throw error;
    }
  }