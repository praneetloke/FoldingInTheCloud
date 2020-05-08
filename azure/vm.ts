import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure";
import { LinuxVirtualMachine } from "@pulumi/azure/compute";
import { ResourceGroup } from "@pulumi/azure/core";

import { AzureSecurity } from "./security";
import { getUserData } from "../utils";

export interface AzureSpotVmArgs {
    publicKey: string;
    maxSpotPrice: number;
    resourceGroupName: string;

    securityGroupRules: pulumi.Input<azure.types.input.network.NetworkSecurityGroupSecurityRule>[];
}

export class AzureSpotVm extends pulumi.ComponentResource {
    private args: AzureSpotVmArgs;

    public resourceGroup: ResourceGroup;
    public spotInstance: LinuxVirtualMachine | undefined;
    public vmSecurity: AzureSecurity;

    constructor(name: string, args: AzureSpotVmArgs, opts?: pulumi.ComponentResourceOptions) {
        super("spotInstance:azure", name, undefined, opts);
        this.args = args;

        this.resourceGroup = new ResourceGroup(this.args.resourceGroupName, {
            name: this.args.resourceGroupName,
        }, { parent: this });
        this.vmSecurity = new AzureSecurity(`${name}-sec`,
            {
                resourceGroup: this.resourceGroup,
                securityGroupRules: this.args.securityGroupRules,
            },
            { parent: this });

        this.createInstance();

        this.registerOutputs({
            resourceGroup: this.resourceGroup,
            spotInstance: this.spotInstance,
        });
    }

    private createInstance() {
        if (!this.vmSecurity.publicNic) {
            return;
        }

        this.spotInstance = new LinuxVirtualMachine("spot-vm", {
            resourceGroupName: this.resourceGroup.name,
            sourceImageReference: {
                offer: "UbuntuServer",
                publisher: "Canonical",
                sku: "18.04-LTS",
                version: "Latest",
            },
            size: "Standard_NC6",
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
                    publicKey: this.args.publicKey
                }
            ],
            disablePasswordAuthentication: true,
            priority: "Spot",
            allowExtensionOperations: true,
            maxBidPrice: this.args.maxSpotPrice,
        }, { parent: this });
    }
}
