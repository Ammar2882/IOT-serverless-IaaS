#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { IotPipelineCdkStack } from '../lib/aws-iot-stack';

const app = new cdk.App();

// Pass -c stage=staging (or prod) to deploy a separate, independently-named
// copy of the stack in the same account. Defaults to "dev".
const stage: string = app.node.tryGetContext('stage') ?? 'dev';

new IotPipelineCdkStack(app, `AwsIotStack-${stage}`, {
  stage,
  // Uses the account/region implied by the current AWS CLI configuration
  // (`aws configure`/`AWS_PROFILE`), so account/region-dependent context
  // lookups and stage-scoped resource naming work as expected.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
