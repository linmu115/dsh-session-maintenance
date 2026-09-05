import type { DatabaseSync } from "node:sqlite";

import {
  adapterManifestV1Schema,
  type AdapterManifestV1,
  type AdapterRegistrationRecord,
  type AdapterRegistryRepository,
  type AdapterVerificationRunRecord,
  type AdapterVerificationStatus,
  type JsonValue,
} from "@linmu/dsh-session-contracts";
import { canonicalJson } from "@linmu/dsh-session-domain";

interface RegistrationRow {
  readonly manifest_json: string;
  readonly package_location: string;
  readonly enabled: number;
  readonly registered_at: string;
  readonly updated_at: string;
}

interface VerificationRow {
  readonly id: string;
  readonly adapter_id: string;
  readonly dsh_version: string;
  readonly status: AdapterVerificationStatus;
  readonly result_json: string;
  readonly started_at: string;
  readonly completed_at: string | null;
}

function registrationFromRow(row: RegistrationRow): AdapterRegistrationRecord {
  return {
    manifest: adapterManifestV1Schema.parse(JSON.parse(row.manifest_json)) as unknown as AdapterManifestV1,
    packageLocation: row.package_location,
    enabled: row.enabled === 1,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteAdapterRegistryRepository implements AdapterRegistryRepository {
  readonly database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.database = database;
  }

  async upsertRegistration(input: AdapterRegistrationRecord): Promise<void> {
    adapterManifestV1Schema.parse(input.manifest);
    if (input.packageLocation.length === 0) {
      throw new TypeError("Adapter registration requires a package location");
    }
    this.database
      .prepare(
        `INSERT INTO adapter_registrations
          (adapter_id, manifest_json, package_location, enabled, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(adapter_id) DO UPDATE SET
           manifest_json = excluded.manifest_json,
           package_location = excluded.package_location,
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.manifest.id,
        canonicalJson(input.manifest as unknown as JsonValue),
        input.packageLocation,
        input.enabled ? 1 : 0,
        input.registeredAt,
        input.updatedAt,
      );
  }

  async getRegistration(
    adapterId: AdapterManifestV1["id"],
  ): Promise<AdapterRegistrationRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT manifest_json, package_location, enabled, registered_at, updated_at
         FROM adapter_registrations WHERE adapter_id = ?`,
      )
      .get(adapterId) as RegistrationRow | undefined;
    return row === undefined ? undefined : registrationFromRow(row);
  }

  async saveVerificationRun(input: AdapterVerificationRunRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO adapter_verification_runs
          (id, adapter_id, dsh_version, status, result_json, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           result_json = excluded.result_json,
           completed_at = excluded.completed_at`,
      )
      .run(
        input.id,
        input.adapterId,
        input.dshVersion,
        input.status,
        canonicalJson(input.result),
        input.startedAt,
        input.completedAt,
      );
  }

  async getVerificationRun(id: string): Promise<AdapterVerificationRunRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT id, adapter_id, dsh_version, status, result_json, started_at, completed_at
         FROM adapter_verification_runs WHERE id = ?`,
      )
      .get(id) as VerificationRow | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          adapterId: row.adapter_id as AdapterManifestV1["id"],
          dshVersion: row.dsh_version,
          status: row.status,
          result: JSON.parse(row.result_json) as JsonValue,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        };
  }
}
