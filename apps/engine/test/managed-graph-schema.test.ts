import { describe, expect, it } from "vitest";
import { thoughtDagAdapter } from "../src/extensions/adapters.js";

const graph = () => ({ managedSchema: 1, nodes: [
  { id: "a", position: { x: 0, y: 0 }, data: { kind: "session", label: "A", logicalSessionId: "logical-a" } },
  { id: "b", position: { x: 10, y: 10 }, data: { kind: "material", label: "B", logicalSessionId: "logical-b",
    namespace: "annotation-upstream", objectId: "upstream-1", excerpt: "重点", sourceVersionId: "v1", sourceAnchorId: "reply-one" } },
], edges: [{ id: "ab", source: "a", target: "b", data: { kind: "upstream", relationId: "upstream-1", namespace: "annotation-upstream" } }],
viewport: { x: 0, y: 0, zoom: 1 } });
const content = (body: unknown) => ({ schemaVersion: 1, title: "Canvas", body: body as any, references: [] });
describe("managed graph schema", () => {
  it("accepts stable presentation references and existing legacy canvases", () => {
    expect(thoughtDagAdapter.pluginVersions).toContain("0.4.14-rc2.1");
    expect(() => thoughtDagAdapter.validate(content(graph()))).not.toThrow();
    const unsentMaterial = graph();
    delete (unsentMaterial.nodes[1]!.data as any).namespace;
    delete (unsentMaterial.nodes[1]!.data as any).objectId;
    expect(() => thoughtDagAdapter.validate(content(unsentMaterial))).not.toThrow();
    expect(() => thoughtDagAdapter.validate(content({ nodes: [{ id: "a", position: { x: 0, y: 0 }, data: { question: "legacy" } }], edges: [] }))).not.toThrow();
  });
  it("rejects transcript duplication, fabricated context permissions, duplicate nodes and dangling endpoints", () => {
    const raw = graph(); (raw.nodes[0]!.data as any).raw = "full transcript";
    expect(() => thoughtDagAdapter.validate(content(raw))).toThrow();
    const anonymous = graph(); delete (anonymous.edges[0]!.data as any).relationId;
    expect(() => thoughtDagAdapter.validate(content(anonymous))).toThrow();
    const foreign = graph(); foreign.edges[0]!.data.namespace = "thoughtdag";
    expect(() => thoughtDagAdapter.validate(content(foreign))).toThrow();
    const duplicate = graph(); duplicate.nodes[1]!.id = "a";
    expect(() => thoughtDagAdapter.validate(content(duplicate))).toThrow();
    const dangling = graph(); dangling.edges[0]!.target = "missing";
    expect(() => thoughtDagAdapter.validate(content(dangling))).toThrow();
  });
});
