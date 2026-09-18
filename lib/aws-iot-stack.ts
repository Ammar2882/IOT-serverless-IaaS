import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

export interface IotPipelineCdkStackProps extends cdk.StackProps {
  /** Deployment stage, e.g. "dev", "staging", "prod". Suffixes physical resource names
   * so multiple stages can coexist in the same account, and gates prod-only safety
   * behavior like DynamoDB removal policy. */
  stage: string;
}

export class IotPipelineCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IotPipelineCdkStackProps) {
    super(scope, id, props);

    const { stage } = props;
    const isProd = stage === 'prod';

    // 1a. Dead-Letter Queue for the Lambda (serverless) consumer path
    const lambdaDlq = new sqs.Queue(this, 'IotTelemetryLambdaDLQ', {
      queueName: `iot-telemetry-lambda-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // 1b. Primary queue feeding the Lambda consumer
    const lambdaQueue = new sqs.Queue(this, 'IotTelemetryLambdaQueue', {
      queueName: `iot-telemetry-lambda-queue-${stage}`,
      visibilityTimeout: cdk.Duration.seconds(300),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: lambdaDlq,
      },
    });

    // 2a. Dead-Letter Queue for the containerized worker (Docker/Kubernetes) consumer path
    const workerDlq = new sqs.Queue(this, 'IotTelemetryWorkerDLQ', {
      queueName: `iot-telemetry-worker-dlq-${stage}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    // 2b. Primary queue polled by the standalone worker
    const workerQueue = new sqs.Queue(this, 'IotTelemetryWorkerQueue', {
      queueName: `iot-telemetry-worker-queue-${stage}`,
      visibilityTimeout: cdk.Duration.seconds(300),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: workerDlq,
      },
    });

    // 3. DynamoDB Table (shared by both consumer paths)
    const telemetryTable = new dynamodb.Table(this, 'IotTelemetryTable', {
      tableName: `IotTelemetryData-${stage}`,
      partitionKey: {
        name: 'deviceId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      // Opt-in: items only expire if a caller sets this attribute; unset by default.
      timeToLiveAttribute: 'ttl',
      // Retain data in prod even if the stack is destroyed; dev/staging stay disposable.
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // 4. Node.js Lambda Processor Function (Node.js 22 LTS)
    const processorLogGroup = new logs.LogGroup(this, 'IotTelemetryProcessorLogGroup', {
      logGroupName: `/aws/lambda/iot-telemetry-processor-${stage}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const processorLambda = new lambdaNodejs.NodejsFunction(
      this,
      "IotTelemetryProcessor",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: "lambda/processor.ts",
        handler: "handler",
        timeout: cdk.Duration.seconds(30),
        tracing: lambda.Tracing.ACTIVE,
        // Caps concurrent invocations so a burst can't starve other functions/DynamoDB
        // in the same account. Tune to expected throughput.
        reservedConcurrentExecutions: 5,
        logGroup: processorLogGroup,
        environment: {
          // AWS_REGION is a reserved Lambda environment key — the runtime
          // injects it automatically, and setting it here breaks deployment.
          TABLE_NAME: telemetryTable.tableName,
        },
      }
    );

    // 5. Connect SQS as event trigger for Lambda
    processorLambda.addEventSource(
      new SqsEventSource(lambdaQueue, {
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),

        reportBatchItemFailures: true,
      })
    );

    // 6. Permissions (Least Privilege)
    telemetryTable.grantWriteData(processorLambda);

    // 7. Alarms — notify an SNS topic on DLQ activity or processor errors/throttles
    const alarmTopic = new sns.Topic(this, 'IotPipelineAlarmsTopic', {
      topicName: `iot-pipeline-alarms-${stage}`,
    });

    const alarmEmail = this.node.tryGetContext('alarmEmail');
    if (alarmEmail) {
      alarmTopic.addSubscription(new subscriptions.EmailSubscription(alarmEmail));
    }

    new cloudwatch.Alarm(this, 'LambdaDlqNotEmptyAlarm', {
      alarmDescription: 'Messages have landed in the Lambda consumer DLQ',
      metric: lambdaDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, 'WorkerDlqNotEmptyAlarm', {
      alarmDescription: 'Messages have landed in the worker consumer DLQ',
      metric: workerDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, 'ProcessorLambdaErrorsAlarm', {
      alarmDescription: 'The Lambda processor is returning errors',
      metric: processorLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    new cloudwatch.Alarm(this, 'ProcessorLambdaThrottlesAlarm', {
      alarmDescription: 'The Lambda processor is being throttled',
      metric: processorLambda.metricThrottles({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
    }).addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));

    // 8. Outputs
    new cdk.CfnOutput(this, 'LambdaQueueUrlOutput', {
      value: lambdaQueue.queueUrl,
      description: 'URL of the SQS queue consumed by the Lambda processor',
    });

    new cdk.CfnOutput(this, 'WorkerQueueUrlOutput', {
      value: workerQueue.queueUrl,
      description: 'URL of the SQS queue polled by the standalone worker (Docker/Kubernetes). Set as QUEUE_URL for that consumer.',
    });

    new cdk.CfnOutput(this, 'TableArnOutput', {
      value: telemetryTable.tableArn,
      description: 'ARN of the DynamoDB telemetry table (shared by both consumer paths)',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArnOutput', {
      value: alarmTopic.topicArn,
      description: 'SNS topic ARN for pipeline alarms — subscribe to it for DLQ/error notifications',
    });
  }
}
