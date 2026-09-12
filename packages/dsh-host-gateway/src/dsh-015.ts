import { LockedDsh015CoreExtension, type Dsh015CoreHost } from "@linmu/dsh-core-extension";
import { DshHostGateway, type DshHostGatewayOptions } from "./gateway.js";
export interface Dsh015GatewayHostBinding {readonly instanceId:string;readonly host:Dsh015CoreHost;readonly expectedContractFingerprint:string;}
/** Explicit V3 binding retains the established authenticated scope and request protocol. */
export function createDsh015HostGateway(bindings:readonly Dsh015GatewayHostBinding[],options:Omit<DshHostGatewayOptions,"extensions">):DshHostGateway {
 if(new Set(bindings.map(b=>b.instanceId)).size!==bindings.length)throw new TypeError("Duplicate V3 Core gateway instance binding");
 return new DshHostGateway({...options,extensions:new Map(bindings.map(b=>[b.instanceId,new LockedDsh015CoreExtension(b.host,b.expectedContractFingerprint)]))});
}
