import type { CanonicalEventV1 } from "@linmu/dsh-session-contracts";
import { readDshReaderPresentation } from "./reader-presentation.js";

/** Scalar SQLite projection of this adapter's native message envelope. */
export interface ReaderStoredMetadata {
  id: string; sequence: number; kind: CanonicalEventV1["kind"]; role: CanonicalEventV1["role"];
  platform: string; native_type: string | null; message_role: string | null; source_kind: string | null;
  source_plugin: string | null; source_form: string | null; call_id: string | null; tool_name: string | null;
  result_source_kind: string | null; result_call_id: string | null; has_text: number;
}
export const READER_METADATA_COLUMNS = `id, sequence, kind,
 json_extract(event_json,'$.role') AS role, json_extract(event_json,'$.source.platform') AS platform,
 json_extract(event_json,'$.extensions.dshEventType') AS native_type,
 json_extract(event_json,'$.content.role') AS message_role,
 substr(json_extract(event_json,'$.content.source.kind'),1,128) AS source_kind,
 substr(json_extract(event_json,'$.content.source.plugin'),1,512) AS source_plugin,
 substr(json_extract(event_json,'$.content.source.form'),1,128) AS source_form,
 CASE WHEN length(json_extract(event_json,'$.content.callId'))<=512 THEN json_extract(event_json,'$.content.callId') END AS call_id,
 substr(json_extract(event_json,'$.content.name'),1,160) AS tool_name,
 substr(json_extract(event_json,'$.content.message.source.kind'),1,128) AS result_source_kind,
 CASE WHEN length(json_extract(event_json,'$.content.message.source.callId'))<=512 THEN json_extract(event_json,'$.content.message.source.callId') END AS result_call_id,
 CASE WHEN kind!='assistant-message' THEN 1 ELSE
   (json_type(event_json,'$.content')='text' AND length(json_extract(event_json,'$.content'))>0)
   OR (json_type(event_json,'$.content.text')='text' AND length(json_extract(event_json,'$.content.text'))>0)
   OR EXISTS (SELECT 1 FROM json_each(event_json,'$.content.message.content') WHERE type='object' AND json_extract(value,'$.type') IN ('text','input_text','output_text') AND length(json_extract(value,'$.text'))>0)
   OR EXISTS (SELECT 1 FROM json_each(event_json,'$.content.content') WHERE type='object' AND json_extract(value,'$.type') IN ('text','input_text','output_text') AND length(json_extract(value,'$.text'))>0)
 END AS has_text`;

export function readStoredReaderPresentation(row: ReaderStoredMetadata, sessionId: string) {
  const source = { kind: row.source_kind, plugin: row.source_plugin, ...(row.source_form === null ? {} : { form: row.source_form }) };
  return readDshReaderPresentation({ schemaVersion: 1, id: row.id, logicalSessionId: sessionId, sequence: row.sequence, kind: row.kind, role: row.role,
    content: { role: row.message_role, source, callId: row.call_id, name: row.tool_name,
      message: { source: { kind: row.result_source_kind, callId: row.result_call_id } } },
    source: { platform: row.platform }, extensions: { dshEventType: row.native_type }, rawPayload: null } as unknown as CanonicalEventV1);
}

// Known readable body slots match the adapter's text reader. Source metadata is
// never recursively searched. SQL slices the body before it crosses into JS.
const blocks = (path: string) => `(SELECT group_concat(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.text'),char(10)||char(10))
 FROM json_each(event_json,'${path}') WHERE type='object' AND json_extract(value,'$.type') IN ('text','input_text','output_text'))`;
export const READER_EVENT_TEXT_SQL = `COALESCE(
 CASE WHEN json_type(event_json,'$.content')='text' THEN json_extract(event_json,'$.content') END,
 CASE WHEN json_type(event_json,'$.content.text')='text' THEN json_extract(event_json,'$.content.text') END,
 CASE WHEN json_type(event_json,'$.content.outputText')='text' THEN json_extract(event_json,'$.content.outputText') END,
 ${blocks("$.content.message.content")}, ${blocks("$.content.content")},
 json_extract(event_json,'$.content'), '')`;
