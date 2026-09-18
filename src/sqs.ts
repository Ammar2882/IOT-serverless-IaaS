import {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageBatchCommand,
    Message,
  } from "@aws-sdk/client-sqs";
  
  import { config } from "./config.js";
  
  export const sqs = new SQSClient({
    region: config.AWS_REGION,
    maxAttempts: 3,
  });
  
  export async function receiveMessages(): Promise<Message[]> {
    const response = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: config.QUEUE_URL,
  
        MaxNumberOfMessages: config.MAX_MESSAGES,
  
        WaitTimeSeconds: 20,
  
        VisibilityTimeout: config.VISIBILITY_TIMEOUT_SECONDS,
  
        AttributeNames: ["All"],
      })
    );
  
    return response.Messages ?? [];
  }
  
  export async function deleteMessages(
    entries: {
      Id: string;
      ReceiptHandle: string;
    }[]
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
  
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: config.QUEUE_URL,
  
        Entries: entries,
      })
    );
  }