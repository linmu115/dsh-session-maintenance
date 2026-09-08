import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { RegisteredInstance } from "@linmu/dsh-session-contracts";
import { CodexReadAdapter } from "../../../packages/adapter-codex-read/src/index.js";
import { CanonicalSessionEngine } from "../../../packages/canonical-session-engine/src/index.js";
import { SqliteCanonicalSessionEngineStore } from "../../../packages/session-store/src/index.js";
import { MaintenanceClient } from "../../../packages/local-api-client/src/index.js";
import { canonicalCodexEvent } from "../../engine/src/codex-canonical-import.js";
import { createEngineFixture } from "../../engine/test/helpers.js";
import { CanonicalEventView } from "../src/canonical-event-view.js";

const markdown = "## 已保存的回答\n\n- 第一项\n- 第二项\n\n| 项目 | 结果 |\n| --- | --- |\n| 合成 | 正常 |\n\n```ts\nconst total = 2;\n```\n\n![合成图片](https://example.invalid/image.png)\n\n<script>alert('blocked')</script>";

it("renders Codex adapter-imported Markdown through the HTTP read model without rewriting saved history", async () => {
  const fixture = await createEngineFixture("synthetic-codex-dashboard-reading");
  try {
    const path = join(fixture.codexHome, "rollouts/thread-fixture.jsonl");
    fixture.fixturePolicy(path);
    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    for (const line of lines) {
      if (line.type === "response_item" && line.payload.type === "message" && line.payload.role === "assistant") {
        line.payload.content = [{ type: "output_text", text: markdown }];
      }
    }
    await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    const sourceBefore = await readFile(path);
    const instance: RegisteredInstance = { id: "codex-fixture", platform: "codex", root: fixture.codexHome,
      displayName: "Synthetic Codex", platformVersion: "0.146.0" };
    const adapter = new CodexReadAdapter({ fixtureGuard: fixture.fixturePolicy });
    const observed = await adapter.observe(instance, { platform: "codex", instanceId: instance.id, sessionId: "thread-fixture" });
    if (observed.kind !== "stable") throw new Error("Synthetic observation must be stable");
    const normalized = await adapter.normalize(observed);
    const sid = "logical-synthetic-codex-reading" as never;
    const store = new SqliteCanonicalSessionEngineStore(fixture.engine.repository.database, fixture.engine.repository.objectStore);
    const receipt = await new CanonicalSessionEngine(store).observeCodex({ logicalSessionId: sid,
      title: "Synthetic reading", tags: [], archivedAt: null, workspaceId: null,
      events: normalized.events.map((event) => canonicalCodexEvent(sid, event)), sourceCursor: null,
      observedAt: "2026-09-08T00:00:00.000Z" });
    const db = fixture.engine.repository.database;
    const saved = () => ({
      events: db.prepare("SELECT event_json FROM canonical_events WHERE logical_session_id = ? ORDER BY sequence").all(sid),
      versions: db.prepare("SELECT * FROM session_versions WHERE logical_session_id = ? ORDER BY id").all(sid),
      session: db.prepare("SELECT * FROM logical_sessions WHERE id = ?").get(sid),
    });
    const before = saved();
    const versionBefore = await store.getVersion(receipt.versionId!);
    const server = await fixture.startServer();
    const client = new MaintenanceClient({ origin: server.origin, token: server.token });
    const detail = await client.getCanonicalSession(sid);
    const messages = detail.events.filter((event) => event.kind === "user-message" || event.kind === "assistant-message");
    expect(messages.map((event) => event.content)).toEqual([
      { text: "hello from fixture", attachments: [] }, { text: markdown, attachments: [] },
    ]);
    expect(messages.map((event) => event.readableText)).toEqual(["hello from fixture", markdown]);
    const html = renderToStaticMarkup(<>{messages.map((event) => <CanonicalEventView key={event.id} event={event} />)}</>);
    expect(html).toContain("<h2>已保存的回答</h2>");
    expect(html).toContain("<li>第一项</li>");
    expect(html).toContain("<table>");
    expect(html).toContain('<code class="language-ts">const total = 2;');
    expect(html).not.toContain("可显示的文字");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("[图片：合成图片]");
    expect(saved()).toEqual(before);
    expect(await store.getVersion(receipt.versionId!)).toEqual(versionBefore);
    expect(await readFile(path)).toEqual(sourceBefore);
  } finally { await fixture.cleanupAll(); }
});
