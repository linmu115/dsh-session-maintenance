export const directoryVisibilitySql = `NOT (i.canonical_reference_id IS NOT NULL AND EXISTS(SELECT 1 FROM extension_objects canonical
  WHERE canonical.instance_id=o.instance_id AND canonical.profile_id=o.profile_id AND canonical.namespace='annotation-upstream'
  AND canonical.object_id=i.canonical_reference_id AND canonical.deleted=0
  AND json_extract(canonical.content_json,'$.body.targetSessionId')=i.owner_session_id))`;
