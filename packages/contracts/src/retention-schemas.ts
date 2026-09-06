import { z } from "zod";

const id = z.string().min(1).max(256);
const relativePath = z.string().min(1).max(4096).refine((value)=>!value.startsWith("/") && !value.includes("\\") && value.split("/").every((part)=>part !== "" && part !== "." && part !== ".." && !part.includes(":")), "Expected a contained relative path");
export const retentionPolicySchema = z.strictObject({ schemaVersion:z.literal(1),history:z.literal("protect-all-version-bodies"),finishedRunHours:z.number().int().min(48),recoveredRunHours:z.number().int().min(120),automaticBackupsToKeep:z.number().int().min(3),cacheTargetBytes:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),quarantineHours:z.number().int().min(48),orphanGraceHours:z.number().int().min(48) });
export const retentionPreviewRequestSchema = z.strictObject({ policy:retentionPolicySchema.optional() });
export const retentionExecuteRequestSchema = z.strictObject({ planId:id });
export const retentionBatchRequestSchema = z.strictObject({ batchId:id });
export const retentionVerifyRequestSchema = z.strictObject({ resourceId:id });
export const retentionRootRegistrationSchema = z.strictObject({id,path:z.string().min(1).max(4096),purpose:z.enum(["state","objects","runs","caches","backups","databases"])});
export const retentionSourceRegistrationSchema = z.strictObject({ id,rootId:id,relativePath,objectRootId:id,kind:z.enum(["backup-database","candidate-database","unknown"]),retained:z.literal(true) });
export const retentionResourceRegistrationSchema = z.strictObject({ id,rootId:id,relativePath,kind:z.enum(["run","cache","backup","candidate"]),ownerId:id,group:id,pinned:z.boolean().default(false),recoveryRequired:z.boolean().default(false) });
