import { prepareLearningV3, appendLearningV3 } from "./learning.js";
import { adapter } from "./index.js";
import { scopeV3Service, type V3AdapterDialect } from "./dialect.js";
import { V3RuntimeBridge, bindV3NativeAppend, type V3RuntimeRegistrar } from "./runtime-bridge.js";
import { recoverV3RuntimeTail } from "./runtime-tail-recovery.js";
import { validateV3 } from "./official.js";
import { verifyV3NativeContextMaterials, verifyV3NativeContextRelease } from "./native-context-evidence.js";

/** Compose trusted native event extensions into a host service without global mutations. */
export function createV3DialectAdapter(dialect: V3AdapterDialect) {
  const services = scopeV3Service({ bindNativeAppend: bindV3NativeAppend, recoverRuntimeTail: recoverV3RuntimeTail,
    prepareLearningV3, appendLearningV3, validateArtifact: validateV3, verifyNativeContextMaterials: verifyV3NativeContextMaterials, verifyNativeContextRelease: verifyV3NativeContextRelease,
  }, dialect);
  return {
    adapter: scopeV3Service({ ...adapter, manifest: dialect.manifest,
      nativeSessionCodec: scopeV3Service(adapter.nativeSessionCodec, dialect),
      sessionContext: scopeV3Service(adapter.sessionContext, dialect),
      sessionGraph: scopeV3Service(adapter.sessionGraph, dialect),
    }, dialect),
    createRuntimeBridge: (registrar: V3RuntimeRegistrar) => scopeV3Service(new V3RuntimeBridge(registrar), dialect),
    ...services,
  };
}
export type { V3AdapterDialect } from "./dialect.js";
