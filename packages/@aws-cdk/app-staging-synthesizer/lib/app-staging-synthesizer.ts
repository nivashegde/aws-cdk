import {
  AssetManifestBuilder,
  BOOTSTRAP_QUALIFIER_CONTEXT,
  DockerImageAssetLocation,
  DockerImageAssetSource,
  FileAssetLocation,
  FileAssetSource,
  IBoundStackSynthesizer as IBoundAppStagingSynthesizer,
  IReusableStackSynthesizer,
  ISynthesisSession,
  Stack,
  StackSynthesizer,
  Token,
} from 'aws-cdk-lib';
import { StringSpecializer, translateCfnTokenToAssetToken } from 'aws-cdk-lib/core/lib/helpers-internal';
import { BootstrapRole, BootstrapRoles } from './bootstrap-roles';
import { DefaultStagingStack, DefaultStagingStackOptions } from './default-staging-stack';
import { PerEnvironmenStagingFactory } from './per-env-staging-factory';
import { AppScopedGlobal } from './private/app-global';
import { IStagingStack, IStagingStackFactory, ObtainStagingResourcesContext } from './staging-stack';

const AGNOSTIC_STACKS = new AppScopedGlobal(() => new Set<Stack>());
const ENV_AWARE_STACKS = new AppScopedGlobal(() => new Set<Stack>());

/**
 * Options that apply to all AppStagingSynthesizer variants
 */
export interface AppStagingSynthesizerOptions {
  /**
   * What roles to use to deploy applications
   *
   * These are the roles that have permissions to interact with CloudFormation
   * on your behalf. By default these are the standard bootstrapped CDK roles,
   * but you can customize them or turn them off and use the CLI credentials
   * to deploy.
   *
   * @default - The standard bootstrapped CDK roles
   */
  readonly deploymentRoles?: BootstrapRoles;

  /**
   * Qualifier to disambiguate multiple bootstrapped environments in the same account
   *
   * This qualifier is only used to reference bootstrapped resources. It will not
   * be used in the creation of app-specific staging resources: `appId` is used for that
   * instead.
   *
   * @default - Value of context key '@aws-cdk/core:bootstrapQualifier' if set, otherwise `DEFAULT_QUALIFIER`
   */
  readonly bootstrapQualifier?: string;
}

/**
 * Properties for stackPerEnv static method
 */
export interface DefaultResourcesOptions extends AppStagingSynthesizerOptions, DefaultStagingStackOptions {
}

/**
 * Properties for customFactory static method
 */
export interface CustomFactoryOptions extends AppStagingSynthesizerOptions {
  /**
   * The factory that will be used to return staging resources for each stack
   */
  readonly factory: IStagingStackFactory;

  /**
   * Reuse the answer from the factory for stacks in the same environment
   *
   * @default true
   */
  readonly oncePerEnv?: boolean;
}

/**
 * Properties for customResources static method
 */
export interface CustomResourcesOptions extends AppStagingSynthesizerOptions {
  /**
   * Use these exact staging resources for every stack that this synthesizer is used for
   */
  readonly resources: IStagingStack;
}

/**
 * Internal properties for AppStagingSynthesizer
 */
interface AppStagingSynthesizerProps extends AppStagingSynthesizerOptions {
  /**
   * A factory method that creates an IStagingStack when given the stack the
   * synthesizer is binding.
   */
  readonly factory: IStagingStackFactory;
}

/**
 * App Staging Synthesizer
 */
export class AppStagingSynthesizer extends StackSynthesizer implements IReusableStackSynthesizer {
  /**
   * Default ARN qualifier
   */
  public static readonly DEFAULT_QUALIFIER = 'hnb659fds';

  /**
   * Default CloudFormation role ARN.
   */
  public static readonly DEFAULT_CLOUDFORMATION_ROLE_ARN = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-cfn-exec-role-${AWS::AccountId}-${AWS::Region}';

  /**
   * Default deploy role ARN.
   */
  public static readonly DEFAULT_DEPLOY_ROLE_ARN = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-deploy-role-${AWS::AccountId}-${AWS::Region}';

  /**
   * Default lookup role ARN for missing values.
   */
  public static readonly DEFAULT_LOOKUP_ROLE_ARN = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-lookup-role-${AWS::AccountId}-${AWS::Region}';

  /**
   * Use the Default Staging Resources, creating a single stack per environment this app is deployed in
   */
  public static defaultResources(props: DefaultResourcesOptions) {
    return AppStagingSynthesizer.customFactory({
      factory: DefaultStagingStack.factory(props),
      deploymentRoles: props.deploymentRoles,
      oncePerEnv: true,
    });
  }

  /**
   * Use these exact staging resources for every stack that this synthesizer is used for
   */
  public static customResources(options: CustomResourcesOptions) {
    return AppStagingSynthesizer.customFactory({
      deploymentRoles: options.deploymentRoles,
      oncePerEnv: false,
      factory: {
        obtainStagingResources() {
          return options.resources;
        },
      },
    });
  }

  /**
   * Supply your own stagingStackFactory method for creating an IStagingStack when
   * a stack is bound to the synthesizer.
   *
   * By default, `oncePerEnv = true`, which means that a new instance of the IStagingStack
   * will be created in new environments. Set `oncePerEnv = false` to turn off that behavior.
   */
  public static customFactory(props: CustomFactoryOptions) {
    const oncePerEnv = props.oncePerEnv ?? true;
    const factory = oncePerEnv ? new PerEnvironmenStagingFactory(props.factory) : props.factory;

    return new AppStagingSynthesizer({
      factory,
      bootstrapQualifier: props.bootstrapQualifier,
      deploymentRoles: props.deploymentRoles,
    });
  }

  private readonly roles: Required<BootstrapRoles>;

  private constructor(private readonly props: AppStagingSynthesizerProps) {
    super();

    this.roles = {
      deploymentRole: props.deploymentRoles?.deploymentRole ??
        BootstrapRole.fromRoleArn(AppStagingSynthesizer.DEFAULT_DEPLOY_ROLE_ARN),
      cloudFormationExecutionRole: props.deploymentRoles?.cloudFormationExecutionRole ??
        BootstrapRole.fromRoleArn(AppStagingSynthesizer.DEFAULT_CLOUDFORMATION_ROLE_ARN),
      lookupRole: this.props.deploymentRoles?.lookupRole ??
        BootstrapRole.fromRoleArn(AppStagingSynthesizer.DEFAULT_LOOKUP_ROLE_ARN),
    };
  }

  /**
   * Returns a version of the synthesizer bound to a stack.
   */
  public reusableBind(stack: Stack): IBoundAppStagingSynthesizer {
    this.checkEnvironmentGnosticism(stack);
    const qualifier = this.props.bootstrapQualifier ??
      stack.node.tryGetContext(BOOTSTRAP_QUALIFIER_CONTEXT) ??
      AppStagingSynthesizer.DEFAULT_QUALIFIER;
    const spec = new StringSpecializer(stack, qualifier);

    const deployRole = this.roles.deploymentRole._specialize(spec);

    const context: ObtainStagingResourcesContext = {
      environmentString: [
        Token.isUnresolved(stack.region) ? 'REGION' : stack.region,
        Token.isUnresolved(stack.account) ? 'ACCOUNT' : stack.account,
      ].join('-'),
      deployRoleArn: deployRole._arnForCloudFormation(),
    };

    return new BoundAppStagingSynthesizer(stack, {
      stagingResources: this.props.factory.obtainStagingResources(stack, context),
      deployRole,
      cloudFormationExecutionRole: this.roles.cloudFormationExecutionRole._specialize(spec),
      lookupRole: this.roles.lookupRole._specialize(spec),
      qualifier,
    });
  }

  /**
   * Implemented for legacy purposes; this will never be called.
   */
  public bind(_stack: Stack) {
    throw new Error('This is a legacy API, call reusableBind instead');
  }

  /**
   * Implemented for legacy purposes; this will never be called.
   */
  public synthesize(_session: ISynthesisSession): void {
    throw new Error('This is a legacy API, call reusableBind instead');
  }

  /**
   * Implemented for legacy purposes; this will never be called.
   */
  public addFileAsset(_asset: FileAssetSource): FileAssetLocation {
    throw new Error('This is a legacy API, call reusableBind instead');
  }

  /**
   * Implemented for legacy purposes; this will never be called.
   */
  public addDockerImageAsset(_asset: DockerImageAssetSource): DockerImageAssetLocation {
    throw new Error('This is a legacy API, call reusableBind instead');
  }

  /**
   * Check that we're only being used for exclusively gnostic or agnostic stacks.
   *
   * We can think about whether to loosen this requirement later.
   */
  private checkEnvironmentGnosticism(stack: Stack) {
    const isAgnostic = Token.isUnresolved(stack.account) || Token.isUnresolved(stack.region);
    const agnosticStacks = AGNOSTIC_STACKS.for(stack);
    const envAwareStacks = ENV_AWARE_STACKS.for(stack);

    (isAgnostic ? agnosticStacks : envAwareStacks).add(stack);
    if (agnosticStacks.size > 0 && envAwareStacks.size > 0) {

      const describeStacks = (xs: Set<Stack>) => Array.from(xs).map(s => s.node.path).join(', ');

      throw new Error([
        'It is not safe to use AppStagingSynthesizer for both environment-agnostic and environment-aware stacks at the same time.',
        'Please either specify environments for all stacks or no stacks in the CDK App.',
        `Stacks with environment: ${describeStacks(agnosticStacks)}.`,
        `Stacks without environment: ${describeStacks(envAwareStacks)}.`,
      ].join(' '));
    }
  }
}

/**
 * Internal properties for BoundAppStagingSynthesizer
 */
interface BoundAppStagingSynthesizerProps {
  /**
   * The bootstrap qualifier
   */
  readonly qualifier: string;

  /**
   * The resources we end up using for this synthesizer
   */
  readonly stagingResources: IStagingStack;

  /**
   * The deploy role
   */
  readonly deployRole: BootstrapRole;

  /**
   * CloudFormation Execution Role
   */
  readonly cloudFormationExecutionRole: BootstrapRole;

  /**
   * Lookup Role
   */
  readonly lookupRole: BootstrapRole;
}


class BoundAppStagingSynthesizer extends StackSynthesizer implements IBoundAppStagingSynthesizer {
  private readonly stagingStack: IStagingStack;
  private readonly assetManifest = new AssetManifestBuilder();
  private readonly lookupRoleArn?: string;
  private readonly cloudFormationExecutionRoleArn?: string;
  private readonly deploymentActionRoleArn?: string;
  private readonly qualifier: string;

  constructor(stack: Stack, props: BoundAppStagingSynthesizerProps) {
    super();
    super.bind(stack);

    this.qualifier = props.qualifier;
    this.stagingStack = props.stagingResources;
  }
  /**
   * The qualifier used to bootstrap this stack
   */
  public get bootstrapQualifier(): string | undefined {
    // Not sure why we need this.
    return this.qualifier;
  }

  public synthesize(session: ISynthesisSession): void {
    const templateAssetSource = this.synthesizeTemplate(session, this.lookupRoleArn);
    const templateAsset = this.addFileAsset(templateAssetSource);

    const assetManifestId = this.assetManifest.emitManifest(this.boundStack, session);

    this.emitArtifact(session, {
      assumeRoleArn: this.deploymentActionRoleArn,
      additionalDependencies: [assetManifestId],
      stackTemplateAssetObjectUrl: templateAsset.s3ObjectUrlWithPlaceholders,
      cloudFormationExecutionRoleArn: this.cloudFormationExecutionRoleArn,
      lookupRole: this.lookupRoleArn ? {
        arn: this.lookupRoleArn,
      }: undefined,
    });
  }

  /**
   * Add a file asset to the manifest.
   */
  public addFileAsset(asset: FileAssetSource): FileAssetLocation {
    const { bucketName, assumeRoleArn, prefix, dependencyStack } = this.stagingStack.addFile(asset);
    const location = this.assetManifest.defaultAddFileAsset(this.boundStack, asset, {
      bucketName: translateCfnTokenToAssetToken(bucketName),
      bucketPrefix: prefix,
      role: assumeRoleArn ? { assumeRoleArn } : undefined,
    });

    if (dependencyStack) {
      this.boundStack.addDependency(dependencyStack, 'stack depends on the staging stack for staging resources');
    }

    return this.cloudFormationLocationFromFileAsset(location);
  }

  /**
   * Add a docker image asset to the manifest.
   */
  public addDockerImageAsset(_asset: DockerImageAssetSource): DockerImageAssetLocation {
    // TODO: implement
    throw new Error('Support for Docker Image Assets in AppStagingSynthesizer is not yet implemented. This construct is being actively worked on.');
    // const { repoName, assumeRoleArn } = this.stagingStack.addDockerImage(asset);

    // const location = this.assetManifest.defaultAddDockerImageAsset(this.boundStack, asset, {
    //   repositoryName: repoName,
    //   role: { assumeRoleArn },
    //   // TODO: more props
    // });
    // return this.cloudFormationLocationFromDockerImageAsset(location);
  }
}
