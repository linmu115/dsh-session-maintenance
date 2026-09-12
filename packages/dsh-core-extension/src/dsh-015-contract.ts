import { sha256Canonical } from "@linmu/dsh-session-domain";
import type { JsonValue } from "@linmu/dsh-session-contracts";
import type { DshCoreProbe } from "./types.js";
export interface Dsh015CoreContractObservation {
 readonly platformVersion:string;
 readonly sessionFormatVersion:number;
 readonly packageVersions:Readonly<Record<string,string>>;
 readonly implementationHashes:Readonly<Record<string,string>>;
 readonly methods:{readonly sessionPersistence:readonly string[];readonly sessionHandle:readonly string[];readonly session:readonly string[]};
}
export function dsh015CoreContractFingerprint(observation:Dsh015CoreContractObservation):string{return `dsh-core-extension/0.1.5-rc.2/session-v3:${sha256Canonical(observation as unknown as JsonValue)}`;}
/** expectedFingerprint comes from the approved release receipt, never from the observed runtime itself. */
export function assessDsh015CoreContract(observation:Dsh015CoreContractObservation,expectedFingerprint:string):DshCoreProbe {
 const observed=dsh015CoreContractFingerprint(observation);
 const compatible=observed===expectedFingerprint&&observation.platformVersion==="0.1.5-rc.2"&&observation.sessionFormatVersion===3
 &&["@deepseek-ai/dsh-session","@deepseek-ai/dsh-session-persistence","@deepseek-ai/dsh-session-format-catalog"].every(p=>observation.packageVersions[p]==="0.1.5-rc.2")
 &&["session","sessionPersistence","jsonlPersistence"].every(p=>/^sha256:[a-f0-9]{64}$/u.test(observation.implementationHashes[p]??""))
 &&["list","stat","open","create"].every(p=>observation.methods.sessionPersistence.includes(p))
 &&["read","append","flush","close"].every(p=>observation.methods.sessionHandle.includes(p))
 &&observation.methods.session.includes("validateStoredEvents");
 return {status:compatible?"compatible":"unsupported",contractFingerprint:observed,capabilities:compatible?["create-session","append-events","update-title","update-archive","verify","restore"]:[],issues:compatible?[]:[{code:"ADAPTER_INCOMPATIBLE",message:"RC2 V3 Core host differs from the approved resolved implementation/handle contract"}]};
}
