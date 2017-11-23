import configure from './aws';
import upload from './upload';
import {
  archiveApp,
  injectFiles
} from './prepare-bundle';
import {
  coloredStatusText,
  ensureInstanceProfileExists,
  ensureRoleExists,
  ensureRoleAdded,
  ensurePoliciesAttached,
  getLogs,
  logStep,
  names,
  tmpBuildPath,
  shouldRebuild
} from './utils';
import {
  largestVersion,
  ebVersions,
  oldVersions
} from './versions';

import {
  createDesiredConfig,
  diffConfig,
  scalingConfig,
  scalingConfigChanged
} from './eb-config';

import {
  waitForEnvReady,
  waitForHealth
} from './env-ready';

export async function setup(api) {
  const config = api.getConfig();
  const appConfig = config.app;
  const {
    s3,
    beanstalk
  } = configure(appConfig);

  const {
    bucket: bucketName,
    app: appName,
    instanceProfile,
    serviceRole
  } = names(config);

  logStep('=> Setting up');

  // Create bucket if needed
  const {
    Buckets
  } = await s3.listBuckets().promise();

  if (!Buckets.find(bucket => bucket.Name === bucketName)) {
    await s3.createBucket({
      Bucket: bucketName
    }).promise();
    console.log('  Created Bucket');
  }

  logStep('=> Ensuring IAM Roles and Instance Profiles are setup');

  // Create role and instance profile
  await ensureRoleExists(config, instanceProfile, '{ "Version": "2008-10-17", "Statement": [ { "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" } ] }');
  await ensureInstanceProfileExists(config, instanceProfile);
  await ensurePoliciesAttached(config, instanceProfile, [
    'arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier',
    'arn:aws:iam::aws:policy/AWSElasticBeanstalkMulticontainerDocker',
    'arn:aws:iam::aws:policy/AWSElasticBeanstalkWorkerTier'
  ]);
  await ensureRoleAdded(config, instanceProfile, instanceProfile);

  // Create role used by enhanced health
  await ensureRoleExists(config, serviceRole, '{ "Version": "2012-10-17", "Statement": [ { "Effect": "Allow", "Principal": { "Service": "elasticbeanstalk.amazonaws.com" }, "Action": "sts:AssumeRole", "Condition": { "StringEquals": { "sts:ExternalId": "elasticbeanstalk" } } } ] }');
  await ensurePoliciesAttached(config, serviceRole, [
    'arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth',
    'arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkService'
  ]);

  // Create beanstalk application if needed
  const {
    Applications
  } = await beanstalk.describeApplications().promise();

  if (!Applications.find(app => app.ApplicationName === appName)) {
    const params = {
      ApplicationName: appName,
      Description: `App "${appConfig.name}" managed by Meteor Up`
    };

    await beanstalk.createApplication(params).promise();
    console.log('  Created Beanstalk application');
  }
}

export async function deploy(api) {
  await api.runCommand('beanstalk.setup');

  const config = api.getConfig();
  const {
    app,
    bucket,
    bundlePrefix,
    environment
  } = names(config);
  const {
    beanstalk
  } = configure(config.app);

  const version = await largestVersion(api);
  const nextVersion = version + 1;

  // Mutates the config, so the meteor.build command will have the correct build location
  config.app.buildOptions.buildLocation = config.app.buildOptions.buildLocation ||
    tmpBuildPath(config.app.path, api);

  const bundlePath = api.resolvePath(config.app.buildOptions.buildLocation, 'bundle.zip');
  const willBuild = shouldRebuild(bundlePath, api.getOptions()['cached-build']);

  if (willBuild) {
    await api.runCommand('meteor.build');
    injectFiles(api, app, nextVersion, config.app.yumPackages || {}, config.app.buildOptions.buildLocation);
    await archiveApp(config.app.buildOptions.buildLocation, api);
  }

  logStep('=> Uploading bundle');

  const key = `${bundlePrefix}${nextVersion}`;
  await upload(config.app, bucket, `${bundlePrefix}${nextVersion}`, bundlePath);

  logStep('=> Creating Version');

  await beanstalk.createApplicationVersion({
    ApplicationName: app,
    VersionLabel: nextVersion.toString(),
    Description: `Deployed by Mup on ${new Date().toUTCString()}`,
    SourceBundle: {
      S3Bucket: bucket,
      S3Key: key
    }
  }).promise();

  await api.runCommand('beanstalk.reconfig');

  logStep('=> Deploying new version');

  await beanstalk.updateEnvironment({
    EnvironmentName: environment,
    VersionLabel: nextVersion.toString()
  }).promise();

  await waitForEnvReady(config, true);
  await api.runCommand('beanstalk.clean');
}

export async function logs(api) {
  const logsContent = await getLogs(api);

  logsContent.forEach(({
    data
  }) => {
    // console.log(data);
    data = data.split('-------------------------------------\n/var/log/');
    process.stdout.write(data[1]);
  });
}

export async function logsNginx(api) {

}

export async function logsEb(api) {
  const logsContent = await getLogs(api);

  logsContent.forEach(({
    data
  }) => {
    data = data.split('\n\n\n-------------------------------------\n/var/log/');
    console.log(data.length);
    process.stdout.write(data[2]);
  });
}

export async function start(api) {
  const config = api.getConfig();
  const {
    beanstalk,
    autoScaling
  } = await configure(config.app);
  const {
    environment
  } = names(config);

  logStep('=> Starting App');

  const {
    EnvironmentResources
  } = await beanstalk.describeEnvironmentResources({
    EnvironmentName: environment
  }).promise();

  const autoScalingGroup = EnvironmentResources.AutoScalingGroups[0].Name;

  const {
    minInstances,
    maxInstances
  } = config.app;

  await autoScaling.updateAutoScalingGroup({
    AutoScalingGroupName: autoScalingGroup,
    MaxSize: maxInstances,
    MinSize: minInstances,
    DesiredCapacity: minInstances
  }).promise();

  await waitForHealth(config);
}

export async function stop(api) {
  const config = api.getConfig();
  const {
    beanstalk,
    autoScaling
  } = await configure(config.app);
  const {
    environment
  } = names(config);

  logStep('=> Stopping App');

  const {
    EnvironmentResources
  } = await beanstalk.describeEnvironmentResources({
    EnvironmentName: environment
  }).promise();

  const autoScalingGroup = EnvironmentResources.AutoScalingGroups[0].Name;

  await autoScaling.updateAutoScalingGroup({
    AutoScalingGroupName: autoScalingGroup,
    MaxSize: 0,
    MinSize: 0,
    DesiredCapacity: 0
  }).promise();

  await waitForHealth(config, 'Grey');
}

export async function restart(api) {
  const config = api.getConfig();
  const {
    beanstalk
  } = await configure(config.app);
  const {
    environment
  } = names(config);

  logStep('=> Restarting App');

  await beanstalk.restartAppServer({
    EnvironmentName: environment
  }).promise();

  await waitForEnvReady(config, false);
}

export async function clean(api) {
  const config = api.getConfig();
  const {
    app
  } = names(config);
  const {
    beanstalk
  } = configure(config.app);

  logStep('=> Finding old versions');
  const {
    versions
  } = await oldVersions(api);

  logStep('=> Removing old versions');

  const promises = [];
  for (let i = 0; i < versions.length; i++) {
    promises.push(beanstalk.deleteApplicationVersion({
      ApplicationName: app,
      VersionLabel: versions[i].toString(),
      DeleteSourceBundle: true
    }).promise());
  }

  // TODO: remove bundles

  await Promise.all(promises);
}

export async function reconfig(api) {
  const config = api.getConfig();
  const {
    beanstalk
  } = configure(config.app);

  const {
    app,
    environment
  } = names(config);

  logStep('=> Configuring Beanstalk Environment');

  // check if env exists
  const {
    Environments
  } = await beanstalk.describeEnvironments({
    ApplicationName: app,
    EnvironmentNames: [environment]
  }).promise();

  const desiredEbConfig = createDesiredConfig(api.getConfig(), '', api);

  if (!Environments.find(env => env.Status !== 'Terminated')) {
    const [version] = await ebVersions(api);
    await beanstalk.createEnvironment({
      ApplicationName: app,
      EnvironmentName: environment,
      CNAMEPrefix: config.app.name,
      Description: `Environment for ${config.app.name}, managed by Meteor Up`,
      VersionLabel: version.toString(),
      SolutionStackName: '64bit Amazon Linux 2017.03 v4.3.0 running Node.js',
      OptionSettings: desiredEbConfig.OptionSettings
    }).promise();

    console.log(' Created Environment');
  } else {
    await waitForEnvReady(config, false);
    const {
      ConfigurationSettings
    } = await beanstalk.describeConfigurationSettings({
      EnvironmentName: environment,
      ApplicationName: app
    }).promise();
    const {
      toRemove
    } = diffConfig(
      ConfigurationSettings[0].OptionSettings,
      desiredEbConfig.OptionSettings
    );

    // TODO: only update diff, and remove extra items
    await beanstalk.updateEnvironment({
      EnvironmentName: environment,
      OptionSettings: desiredEbConfig.OptionSettings,
      OptionsToRemove: toRemove
    }).promise();

    console.log('  Updated Environment');

    if (scalingConfigChanged(ConfigurationSettings[0].OptionSettings, config)) {
  await waitForEnvReady(config, true);

      logStep('=> Configuring scaling');
      await beanstalk.updateEnvironment({
        EnvironmentName: environment,
        OptionSettings: scalingConfig(config.app).OptionSettings
      }).promise()
}
  }
  await waitForEnvReady(config, true);
}

export async function events(api) {
  const {
    beanstalk
  } = configure(api.getConfig().app);
  const {
    environment
  } = names(api.getConfig());

  const {
    Events: envEvents
  } = await beanstalk.describeEvents({
    EnvironmentName: environment
  }).promise();

  console.log(envEvents.map(ev => `${ev.EventDate}: ${ev.Message}`).join('\n'));
}

export async function status(api) {
  const {
    beanstalk
  } = configure(api.getConfig().app);
  const {
    environment
  } = names(api.getConfig());

  const result = await beanstalk.describeEnvironmentHealth({
    AttributeNames: [
      'All'
    ],
    EnvironmentName: environment
  }).promise();
  const {
    InstanceHealthList
  } = await beanstalk.describeInstancesHealth({
    AttributeNames: [
      'All'
    ],
    EnvironmentName: environment
  }).promise();

  const {
    RequestCount,
    Duration,
    StatusCodes,
    Latency
  } = result.ApplicationMetrics;

  console.log(`Environment Status: ${result.Status}`);
  console.log(`Health Status: ${coloredStatusText(result.Color, result.HealthStatus)}`);
  if (result.Causes.length > 0) {
    console.log('Causes: ');
    result.Causes.forEach(cause => console.log(`  ${cause}`));
  }
  console.log('');
  console.log(`=== Metrics For Last ${Duration || 'Unknown'} Minutes ===`);
  console.log(`  Requests: ${RequestCount}`);
  if (StatusCodes) {
    console.log('  Status Codes');
    console.log(`    2xx: ${StatusCodes.Status2xx}`);
    console.log(`    3xx: ${StatusCodes.Status3xx}`);
    console.log(`    4xx: ${StatusCodes.Status4xx}`);
    console.log(`    5xx: ${StatusCodes.Status5xx}`);
  }
  if (Latency) {
    console.log('  Latency');
    console.log(`    99.9%: ${Latency.P999}`);
    console.log(`    99%  : ${Latency.P99}`);
    console.log(`    95%  : ${Latency.P95}`);
    console.log(`    90%  : ${Latency.P90}`);
    console.log(`    85%  : ${Latency.P85}`);
    console.log(`    75%  : ${Latency.P75}`);
    console.log(`    50%  : ${Latency.P50}`);
    console.log(`    10%  : ${Latency.P10}`);
  }
  console.log('');
  console.log('=== Instances ===');
  InstanceHealthList.forEach((instance) => {
    console.log(`  ${instance.InstanceId}: ${coloredStatusText(instance.Color, instance.HealthStatus)}`);
  });
  if (InstanceHealthList.length === 0) {
    console.log('  0 Instances');
  }
}
