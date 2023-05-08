import * as path from 'path';
import * as integ from '@aws-cdk/integ-tests-alpha';
import { App, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AppStagingSynthesizer } from '../lib';

const app = new App();

const stack = new Stack(app, 'synth-test', {
  synthesizer: AppStagingSynthesizer.defaultResources({
    appId: 'szynthassets',
  }),
  env: {
    account: '489318732371',
    region: 'us-east-1',
  },
});

new lambda.Function(stack, 'lambda-s3', {
  code: lambda.AssetCode.fromAsset(path.join(__dirname, 'assets')),
  handler: 'index.handler',
  runtime: lambda.Runtime.PYTHON_3_10,
});

for (let i = 0; i< 10; i++) {
  new lambda.Function(stack, 'lambda-ecr'+i, {
    code: lambda.EcrImageCode.fromAssetImage(path.join(__dirname, 'assets'), {
      assetName: 'ecr-assets'+i,
    }),
    handler: lambda.Handler.FROM_IMAGE,
    runtime: lambda.Runtime.FROM_IMAGE,
  });
}

new integ.IntegTest(app, 'integ-tests', {
  testCases: [stack],
});

app.synth();
