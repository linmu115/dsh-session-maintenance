import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MIGRATION_022 } from "../../../packages/session-store/src/migrations/022-extension-data.js";
import { SessionGraphStore } from "../src/session-graph-store.js";
import { presentGraphTitles, presentGraphList } from "../src/session-graph-titles.js";

describe("current session names in saved graphs", () => {
  it("repairs old ID labels and follows renames without changing revisions, positions or stored objects", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(MIGRATION_022);
      db.exec("CREATE TABLE logical_sessions(id TEXT PRIMARY KEY,display_title TEXT)");
      db.prepare("INSERT INTO logical_sessions VALUES (?,?)").run("owner-id", "训练显存讨论");
      db.prepare("INSERT INTO logical_sessions VALUES (?,?)").run("source-id", "梯度检查点");
      const scope = { instanceId: "copy", profileId: "web", namespace: "thoughtdag" }, store = new SessionGraphStore(db);
      const first = store.ensure(scope, "dsh-thoughtdag", "owner-id", "owner-id");
      const doc = store.save(scope, "dsh-thoughtdag", { objectId: first.objectId, expectedRevision: first.revision,
        title: "owner-id", graph: { ...first.graph, nodes: [...first.graph.nodes,
          { id: "source", position: { x: 100, y: 80 }, data: { kind: "session", logicalSessionId: "source-id", label: "source-id" } },
          { id: "material", position: { x: 300, y: 80 }, data: { kind: "material", logicalSessionId: "source-id", sourceVersionId: "version-1", sourceAnchorId: "reply-1", label: "自定义材料标题" } }] } });
      const stored = JSON.stringify(db.prepare("SELECT * FROM extension_objects").all());
      const shown = presentGraphTitles(db, doc);
      expect(shown.title).toBe("训练显存讨论");
      expect(shown.graph.nodes.map(n => n.data.label)).toEqual(["训练显存讨论", "梯度检查点", "自定义材料标题"]);
      expect(shown.graph.nodes.map(n => n.position)).toEqual(doc.graph.nodes.map(n => n.position));
      expect(shown.revision).toBe(doc.revision);
      const query = { ...scope, limit: 30, deleted: "all" as const };
      expect(presentGraphList(db, query, store.store.list(query)).items[0]!.title).toBe("训练显存讨论");
      db.prepare("UPDATE logical_sessions SET display_title=? WHERE id=?").run("训练显存讨论（更新）", "owner-id");
      expect(presentGraphTitles(db, doc).title).toBe("训练显存讨论（更新）");
      expect(presentGraphList(db, query, store.store.list(query)).items[0]!.title).toBe("训练显存讨论（更新）");
      expect(JSON.stringify(db.prepare("SELECT * FROM extension_objects").all())).toBe(stored);
      expect(doc.title).toBe("owner-id");
    } finally { db.close(); }
  });
  it("keeps unbound draft titles and readable fallback labels while hiding machine identifiers", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE logical_sessions(id TEXT PRIMARY KEY,display_title TEXT)");
      const doc = { objectId: "draft", revision: 1, title: "我的整理草稿", graph: { managedSchema: 2 as const, ownerSessionId: null,
        nodes: [{ id: "a", position: { x: 0, y: 0 }, data: { kind: "session" as const, logicalSessionId: "missing", label: "仍可识别的旧名称" } },
          { id: "b", position: { x: 0, y: 80 }, data: { kind: "session" as const, logicalSessionId: "dsh-maintenance-12345", label: "dsh-maintenance-12345" } }], edges: [] } };
      const shown = presentGraphTitles(db, doc);
      expect(shown.title).toBe("我的整理草稿");
      expect(shown.graph.nodes.map(n => n.data.label)).toEqual(["仍可识别的旧名称", "未命名会话"]);
    } finally { db.close(); }
  });
});
