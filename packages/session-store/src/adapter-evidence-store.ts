import type { DatabaseSync } from "node:sqlite";

import {
  adapterEvidenceInputV1Schema,
  adapterEvidenceRecordV1Schema,
  type AdapterEvidenceInputV1,
  type AdapterEvidencePort,
  type AdapterEvidenceRecordV1,
  type AdapterEvidenceRef,
  type AdapterId,
  type ContentObjectStore,
  type JsonValue,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

interface EvidenceRow {
  readonly evidence_ref: string;
  readonly adapter_id: string;
  readonly native_format_id: string;
  readonly source_kind: string;
  readonly object_id: string;
  readonly byte_length: number;
  readonly observed_at: string;
  readonly created_at: string;
}

function recordFromRow(row: EvidenceRow): AdapterEvidenceRecordV1 {
  return adapterEvidenceRecordV1Schema.parse({
    schemaVersion: 1,
    ref: row.evidence_ref,
    adapterId: row.adapter_id,
    nativeFormatId: row.native_format_id,
    sourceKind: row.source_kind,
    objectId: row.object_id,
    byteLength: row.byte_length,
    createdAt: row.created_at,
  }) as unknown as AdapterEvidenceRecordV1;
}

export class SqliteAdapterEvidenceStore implements AdapterEvidencePort {
  readonly database: DatabaseSync;
  readonly objectStore: ContentObjectStore;
  private readonly clock: () => string;

  constructor(
    database: DatabaseSync,
    objectStore: ContentObjectStore,
    options: { readonly clock?: () => string } = {},
  ) {
    this.database = database;
    this.objectStore = objectStore;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  async putEvidence(input: AdapterEvidenceInputV1): Promise<AdapterEvidenceRecordV1> {
    const parsed = adapterEvidenceInputV1Schema.parse(input) as unknown as AdapterEvidenceInputV1;
    const bytes = Buffer.from(canonicalJson(parsed as unknown as JsonValue), "utf8");
    const objectId = await this.objectStore.put(bytes);
    const ref = `evidence:${objectId}` as AdapterEvidenceRef;
    const createdAt = this.clock();
    this.database.prepare(
      `INSERT OR IGNORE INTO adapter_evidence
        (evidence_ref, adapter_id, native_format_id, source_kind, object_id,
         byte_length, observed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ref,
      parsed.adapterId,
      parsed.nativeFormatId,
      parsed.sourceKind,
      objectId,
      bytes.byteLength,
      parsed.observedAt,
      createdAt,
    );
    const row = this.database.prepare(
      `SELECT evidence_ref, adapter_id, native_format_id, source_kind, object_id,
              byte_length, observed_at, created_at
       FROM adapter_evidence WHERE evidence_ref = ?`,
    ).get(ref) as EvidenceRow | undefined;
    if (row === undefined
      || row.adapter_id !== parsed.adapterId
      || row.native_format_id !== parsed.nativeFormatId
      || row.source_kind !== parsed.sourceKind
      || row.object_id !== objectId
      || row.byte_length !== bytes.byteLength
      || row.observed_at !== parsed.observedAt) {
      throw new Error(`Adapter evidence identity collision: ${ref}`);
    }
    return recordFromRow(row);
  }

  async readEvidence(
    ref: AdapterEvidenceRef,
    expectedAdapterId: AdapterId,
  ): Promise<AdapterEvidenceInputV1 | undefined> {
    const row = this.database.prepare(
      `SELECT evidence_ref, adapter_id, native_format_id, source_kind, object_id,
              byte_length, observed_at, created_at
       FROM adapter_evidence
       WHERE evidence_ref = ? AND adapter_id = ?`,
    ).get(ref, expectedAdapterId) as EvidenceRow | undefined;
    if (row === undefined) return undefined;
    const bytes = await this.objectStore.get(row.object_id);
    if (bytes.byteLength !== row.byte_length) {
      throw new Error(`Adapter evidence length mismatch: ${ref}`);
    }
    const evidence = adapterEvidenceInputV1Schema.parse(
      JSON.parse(Buffer.from(bytes).toString("utf8")),
    ) as unknown as AdapterEvidenceInputV1;
    if (evidence.adapterId !== row.adapter_id
      || evidence.nativeFormatId !== row.native_format_id
      || evidence.sourceKind !== row.source_kind
      || evidence.observedAt !== row.observed_at) {
      throw new Error(`Adapter evidence metadata mismatch: ${ref}`);
    }
    return evidence;
  }
}
