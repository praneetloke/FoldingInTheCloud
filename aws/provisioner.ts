import * as aws from "@pulumi/aws";
import { Context } from "@pulumi/aws/lambda";
import {
    DescribeInstancesResult,
    DescribeSpotInstanceRequestsResult,
    Instance,
} from "aws-sdk/clients/ec2";
import * as unzipper from "unzipper";

import {
    ConnectionArgs,
    INSTANCE_USER,
    LINUX_USER_SCRIPTS_DIR,
    copyFile,
    runCommand,
} from "../sshUtils";

const AWS_REGION = aws.config.region;

/**
 * The path where the Lambda will download/extract the scripts zip file.
 */
const LOCAL_SCRIPTS_PATH = "/tmp/scripts";

/**
 * The name of the scheduled event that is created when copying a file to
 * the EC2 instance fails after several retries. The scheduled event
 * will be removed once an instance is successfully provisioned.
 */
const SCHEDULED_EVENT_NAME_PREFIX = "ScheduledEC2Provisioner";
/**
 * The StatementId of the Lambda Permission granting the temporary scheduled event
 * permission to invoke the Lambda.
 */
const LAMBDA_PERMISSION_SID = "sched-event";

/**
 * Downloads an object from an S3 bucket and extract it to a temporary
 * path accessible to AWS Lamda service.
 * @param bucketName
 * @param zipFilename
 */
export async function downloadS3Object(bucketName: string, zipFilename: string): Promise<void> {
    const s3 = new aws.sdk.S3({
        region: AWS_REGION,
    });

    const s3Stream = s3
        .getObject({
            Bucket: bucketName,
            Key: zipFilename,
        })
        .createReadStream();

    return new Promise((resolve, reject) => {
        // Listen for errors returned by the service
        s3Stream.on("error", function (err) {
            // NoSuchKey: The specified key does not exist
            reject(err);
        });

        s3Stream
            .pipe(unzipper.Extract({ path: LOCAL_SCRIPTS_PATH }))
            .on("error", (err) => {
                reject(`File Stream error: ${err}`);
            })
            .on("close", () => {
                console.log(`Downloaded s3 object ${zipFilename} to local path.`);
                resolve();
            });
    });
}

export async function getSpotInstance(spotRequestId: string): Promise<Instance> {
    const ec2 = new aws.sdk.EC2({
        region: AWS_REGION,
    });

    console.log("Verifying if spot instance request is fulfilled...");
    await ec2
        .waitFor("spotInstanceRequestFulfilled", {
            $waiter: {
                maxAttempts: 20,
                delay: 10,
            },
            SpotInstanceRequestIds: [spotRequestId],
        })
        .promise();

    console.log("Getting fulfilled spot instance request info...");
    const latestSpotRequest = await ec2
        .describeSpotInstanceRequests({
            SpotInstanceRequestIds: [spotRequestId],
        })
        .promise();

    const fulfilledInstanceRequest =
        latestSpotRequest.$response.data as DescribeSpotInstanceRequestsResult;
    if (!fulfilledInstanceRequest.SpotInstanceRequests) {
        throw new Error("Spot instance request could not be fetched.");
    }
    const instanceId = fulfilledInstanceRequest.SpotInstanceRequests[0].InstanceId;
    if (!instanceId) {
        throw new Error(
            "InstanceId is undefined. Spot instance request has not been fulfilled yet.");
    }

    console.log("Waiting for instance state to be in running state...");
    await ec2
        .waitFor("instanceRunning", {
            $waiter: {
                maxAttempts: 20,
                delay: 10,
            },
            InstanceIds: [instanceId],
        })
        .promise();

    return await getInstanceInfo(instanceId);
}

export async function getInstanceInfo(instanceId: string): Promise<Instance> {
    console.log("Getting instance info...");
    const ec2 = new aws.sdk.EC2({
        region: AWS_REGION,
    });
    const describeInstanceResponse = await ec2
        .describeInstances({
            InstanceIds: [instanceId],
        })
        .promise();

    const describeInstanceResult =
        describeInstanceResponse.$response.data as DescribeInstancesResult;
    if (!describeInstanceResult.Reservations || !describeInstanceResult.Reservations[0].Instances) {
        throw new Error(`Could not find instance ${instanceId}`);
    }

    return describeInstanceResult.Reservations[0].Instances[0];
}

/**
 * Sends the SSH public key to an EC2 instance to facilitate connecting to that instance
 * via SSH later using the private key counterpart.
 * @param instance The EC2 instance object to which the SSH public key needs to be sent.
 * @param publicKey
 */
export async function sendSSHPublicKeyToInstance(
    instance: Instance, publicKey: string): Promise<void> {
    console.log("Sending SSH public key to the EC2 instance...");
    const ec2 = new aws.sdk.EC2InstanceConnect({
        region: AWS_REGION,
    });

    const result = await ec2
        .sendSSHPublicKey({
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            AvailabilityZone: instance.Placement!.AvailabilityZone!,
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            InstanceId: instance.InstanceId!,
            SSHPublicKey: publicKey,
            InstanceOSUser: INSTANCE_USER,
        })
        .promise();

    if (!result.Success) {
        throw new Error(
            `Sending the SSH public key to the instance failed: ${result.$response.error}`);
    }
    console.log("SSH public key sent.");
}

/**
 * Returns a formatted name for the scheduled event to be created. Use this to find
 * corresponding scheduled events for spot instance requests.
 * @param spotInstanceRequestId
 */
function getScheduledEventRuleName(spotInstanceRequestId: string): string {
    return `${SCHEDULED_EVENT_NAME_PREFIX}_${spotInstanceRequestId}`;
}

/**
 * Create a fixed-rate scheduled event, if it doesn't exist,
 * that will attempt to provision the spot instance
 * identified by the spot instance request ID.
 * @param ctx The Lambda context object.
 * @param spotInstanceRequestId
 */
async function checkAndCreateScheduledEvent(ctx: Context, spotInstanceRequestId: string) {
    const cw = new aws.sdk.CloudWatchEvents({
        region: AWS_REGION,
    });
    let result;
    try {
        result = await cw
            .describeRule({
                Name: getScheduledEventRuleName(spotInstanceRequestId),
            })
            .promise();
        if (result.$response.httpResponse.statusCode === 200) {
            console.log(
                `Scheduled event ${SCHEDULED_EVENT_NAME_PREFIX} already exists. Won't re-create it.`);
            return;
        }
    } catch (err) {
        /**
         * If the error is anything else other than a `ResourceNotFoundException`, re-throw it.
         * We expect to _not_ find it, so we can actually create it.
         */
        if (err.code !== "ResourceNotFoundException") {
            throw err;
        }
    }

    const ruleName = `${SCHEDULED_EVENT_NAME_PREFIX}_${spotInstanceRequestId}`;
    const rule = await cw
        .putRule({
            Name: ruleName,
            Description:
                "Scheduled Event to provision an EC2 spot instance until it succeeds. " +
                "This is a temporary event and will be deleted.",
            ScheduleExpression: "rate(15 minutes)",
        })
        .promise();

    const lambda = new aws.sdk.Lambda({
        region: AWS_REGION,
    });
    await lambda
        .addPermission({
            Action: "lambda:InvokeFunction",
            FunctionName: ctx.functionName,
            Principal: "events.amazonaws.com",
            SourceArn: rule.RuleArn,
            StatementId: LAMBDA_PERMISSION_SID,
        })
        .promise();

    await cw
        .putTargets({
            Rule: ruleName,
            Targets: [
                {
                    Arn: ctx.invokedFunctionArn,
                    Id: ctx.functionName,
                },
            ],
        })
        .promise();
}

/**
 * Deletes the scheduled event, if found. Also removes the associated Lambda permission
 * resource.
 * @param ctx The Lambda context object.
 * @param spotInstanceRequestId
 */
async function deleteScheduledEvent(ctx: Context, spotInstanceRequestId: string) {
    const cw = new aws.sdk.CloudWatchEvents({
        region: AWS_REGION,
    });
    const ruleName = getScheduledEventRuleName(spotInstanceRequestId);
    try {
        await cw
            .removeTargets({
                Rule: ruleName,
                Ids: [ctx.functionName],
            })
            .promise();
    } catch (err) {
        // If the error is anything but a 404, re-throw it. Otherwise, ignore it.
        if (err.code !== "ResourceNotFoundException") {
            throw err;
        }
    }

    try {
        await cw
            .deleteRule({
                Name: ruleName,
            })
            .promise();
    } catch (err) {
        // If the error is anything but a 404, re-throw it. Otherwise, ignore it.
        if (err.code !== "ResourceNotFoundException") {
            throw err;
        }
    }

    try {
        const lambda = new aws.sdk.Lambda({
            region: AWS_REGION,
        });
        await lambda
            .removePermission({
                FunctionName: ctx.functionName,
                StatementId: LAMBDA_PERMISSION_SID,
            })
            .promise();
    } catch (err) {
        // If the error is anything but a 404, re-throw it. Otherwise, ignore it.
        if (err.code !== "ResourceNotFoundException") {
            throw err;
        }
    }
}

export async function provisionInstance(
    ctx: Context,
    spotInstanceRequestId: string,
    instancePrivateOrPublicIp: string,
    sshPrivateKey: string,
): Promise<void> {
    const conn: ConnectionArgs = {
        type: "ssh",
        host: instancePrivateOrPublicIp,
        username: INSTANCE_USER,
        privateKey: sshPrivateKey,
    };

    try {
        await checkAndCreateScheduledEvent(ctx, spotInstanceRequestId);
        console.log(`Copying files to the instance ${instancePrivateOrPublicIp}...`);
        // Copy the files to the EC2 instance.
        await copyFile(conn, LOCAL_SCRIPTS_PATH, LINUX_USER_SCRIPTS_DIR);
    } catch (err) {
        console.error("Could not copy files to the instance at this time.", err);
        return;
    }

    const commands = [`chmod 755 ${LINUX_USER_SCRIPTS_DIR}*.sh`, `. ${LINUX_USER_SCRIPTS_DIR}install.sh`];

    console.log("Executing commands on the instance...");
    for (const cmd of commands) {
        await runCommand(conn, cmd);
    }
    await deleteScheduledEvent(ctx, spotInstanceRequestId);
}

export async function runShutdownScript(
    ctx: Context,
    spotInstanceRequestId: string,
    instancePrivateOrPublicIp: string,
    sshPrivateKey: string,
): Promise<void> {
    const conn: ConnectionArgs = {
        type: "ssh",
        host: instancePrivateOrPublicIp,
        username: INSTANCE_USER,
        privateKey: sshPrivateKey,
    };

    console.log("Removing any previously created scheduled events...");
    await deleteScheduledEvent(ctx, spotInstanceRequestId);
    console.log("Running shutdown script on the instance...");
    await runCommand(conn, `. ${LINUX_USER_SCRIPTS_DIR}shutdown.sh`);
}
