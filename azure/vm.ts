import * as azure from "@pulumi/azure";
import { LinuxVirtualMachine } from "@pulumi/azure/compute";
import { ResourceGroup } from "@pulumi/azure/core";
import * as pulumi from "@pulumi/pulumi";

import { getUserData } from "../awsUtils";

import { AzureSecurity } from "./security";

export interface AzureSpotVmArgs {
    resourceGroup: ResourceGroup;
    publicKey: string;
    maxSpotPrice: number;
    instanceType: string;

    securityGroupRules: pulumi.Input<azure.types.input.network.NetworkSecurityGroupSecurityRule>[];
}

export class AzureSpotVm extends pulumi.ComponentResource {
    private args: AzureSpotVmArgs;

    public spotInstance: LinuxVirtualMachine | undefined;
    public vmSecurity: AzureSecurity;

    constructor(name: string, args: AzureSpotVmArgs, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance:azure", name, undefined, opts);
        this.args = args;

        this.vmSecurity = new AzureSecurity(
            "security",
            {
                resourceGroup: this.args.resourceGroup,
                securityGroupRules: this.args.securityGroupRules,
            },
            { parent: this },
        );

        this.createInstance();

        this.registerOutputs({
            resourceGroup: this.args.resourceGroup,
            spotInstance: this.spotInstance,
        });
    }

    private createInstance() {
        if (!this.vmSecurity.publicNic) {
            throw new Error("Network interface is undefined.");
        }

        this.spotInstance = new LinuxVirtualMachine(
            "spotVm",
            {
                resourceGroupName: this.args.resourceGroup.name,
                sourceImageReference: {
                    offer: "UbuntuServer",
                    publisher: "Canonical",
                    sku: "18.04-LTS",
                    version: "Latest",
                },
                size: this.args.instanceType,
                osDisk: {
                    diskSizeGb: 50,
                    storageAccountType: "Standard_LRS",
                    caching: "None",
                },
                evictionPolicy: "Deallocate",
                networkInterfaceIds: [this.vmSecurity.publicNic.id],
                customData: Buffer.from(getUserData()).toString("base64"),
                adminUsername: "ubuntu",
                adminSshKeys: [
                    {
                        username: "ubuntu",
                        publicKey: this.args.publicKey,
                    },
                ],
                disablePasswordAuthentication: true,
                priority: "Spot",
                allowExtensionOperations: true,
                maxBidPrice: this.args.maxSpotPrice,
                // Enable the Azure VM Agent if you are planning to install VM extensions.
                // provisionVmAgent: true
            },
            { parent: this },
        );
    }
}
