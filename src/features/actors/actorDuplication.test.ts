import { describe, expect, it } from "vitest";
import type { ActorNode, ComponentNode } from "@/core/types";
import {
  collectSubtreeIds,
  duplicateActorSubtrees,
  filterTopLevelRoots,
  type RefKeyResolver
} from "@/features/actors/actorDuplication";

function mkActor(over: Partial<ActorNode> & { id: string }): ActorNode {
  return {
    id: over.id,
    name: over.name ?? over.id,
    enabled: over.enabled ?? true,
    kind: "actor",
    actorType: over.actorType ?? "empty",
    visibilityMode: over.visibilityMode ?? "visible",
    pluginType: over.pluginType,
    parentActorId: over.parentActorId ?? null,
    childActorIds: over.childActorIds ?? [],
    componentIds: over.componentIds ?? [],
    transform: over.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    params: over.params ?? {}
  };
}

function src(actors: ActorNode[], components: ComponentNode[] = []) {
  return {
    actors: Object.fromEntries(actors.map((a) => [a.id, a])),
    components: Object.fromEntries(components.map((c) => [c.id, c]))
  };
}

const noRefs: RefKeyResolver = () => ({ refKeys: [], refListKeys: [] });
const toRoot = { resolveParentId: () => null };

describe("filterTopLevelRoots", () => {
  it("drops descendants of other selected ids and dedups, preserving order", () => {
    const actors = src([
      mkActor({ id: "p", childActorIds: ["c"] }),
      mkActor({ id: "c", parentActorId: "p" }),
      mkActor({ id: "other" })
    ]).actors;
    expect(filterTopLevelRoots(actors, ["p", "c", "other", "p"])).toEqual(["p", "other"]);
  });

  it("ignores ids that don't exist", () => {
    const actors = src([mkActor({ id: "a" })]).actors;
    expect(filterTopLevelRoots(actors, ["ghost", "a"])).toEqual(["a"]);
  });
});

describe("collectSubtreeIds", () => {
  it("gathers the whole subtree and owned components", () => {
    const result = collectSubtreeIds(
      src([
        mkActor({ id: "p", childActorIds: ["c"], componentIds: ["pc"] }),
        mkActor({ id: "c", parentActorId: "p" })
      ]).actors,
      ["p"]
    );
    expect(result.roots).toEqual(["p"]);
    expect(result.actorIds).toEqual(["p", "c"]);
    expect(result.componentIds).toEqual(["pc"]);
  });
});

describe("duplicateActorSubtrees", () => {
  it("assigns fresh ids and maps old -> new", () => {
    const result = duplicateActorSubtrees(src([mkActor({ id: "a" })]), ["a"], toRoot, noRefs);
    expect(result.actors).toHaveLength(1);
    expect(result.newTopLevelIds).toHaveLength(1);
    expect(result.actors[0]!.id).not.toBe("a");
    expect(result.idMap.a).toBe(result.actors[0]!.id);
  });

  it("clones a deep subtree with remapped parent/child links", () => {
    const result = duplicateActorSubtrees(
      src([
        mkActor({ id: "p", childActorIds: ["c"] }),
        mkActor({ id: "c", parentActorId: "p", childActorIds: ["g"] }),
        mkActor({ id: "g", parentActorId: "c" })
      ]),
      ["p"],
      toRoot,
      noRefs
    );
    const byOld = (old: string) => result.actors.find((a) => a.id === result.idMap[old])!;
    expect(result.actors).toHaveLength(3);
    expect(byOld("p").parentActorId).toBe(null);
    expect(byOld("p").childActorIds).toEqual([result.idMap.c]);
    expect(byOld("c").parentActorId).toBe(result.idMap.p);
    expect(byOld("c").childActorIds).toEqual([result.idMap.g]);
    expect(byOld("g").parentActorId).toBe(result.idMap.c);
  });

  it("deep-clones params (mutating the clone does not touch the original)", () => {
    const original = mkActor({ id: "a", params: { nested: { values: [1, 2, 3] } } });
    const result = duplicateActorSubtrees(src([original]), ["a"], toRoot, noRefs);
    const cloneParams = result.actors[0]!.params as { nested: { values: number[] } };
    cloneParams.nested.values.push(4);
    expect((original.params as { nested: { values: number[] } }).nested.values).toEqual([1, 2, 3]);
  });

  it("copies the transform verbatim (exact overlap) as a fresh object", () => {
    const original = mkActor({ id: "a", transform: { position: [5, 6, 7], rotation: [0, 1, 0], scale: [2, 2, 2] } });
    const clone = duplicateActorSubtrees(src([original]), ["a"], toRoot, noRefs).actors[0]!;
    expect(clone.transform).toEqual(original.transform);
    expect(clone.transform).not.toBe(original.transform);
  });

  it("uses resolveParentId for roots", () => {
    const clone = duplicateActorSubtrees(src([mkActor({ id: "a" })]), ["a"], { resolveParentId: () => "TARGET" }, noRefs).actors[0]!;
    expect(clone.parentActorId).toBe("TARGET");
  });

  it("remaps actor-ref params that point inside the set and preserves external refs", () => {
    const resolver: RefKeyResolver = () => ({ refKeys: ["ref"], refListKeys: [] });
    const result = duplicateActorSubtrees(
      src([mkActor({ id: "a", params: { ref: "b" } }), mkActor({ id: "b" })]),
      ["a", "b"],
      toRoot,
      resolver
    );
    const dupA = result.actors.find((x) => x.id === result.idMap.a)!;
    expect(dupA.params.ref).toBe(result.idMap.b);

    const external = duplicateActorSubtrees(src([mkActor({ id: "a", params: { ref: "x" } })]), ["a"], toRoot, resolver);
    expect(external.actors[0]!.params.ref).toBe("x");
  });

  it("remaps actor-ref-list entries individually (in-set remapped, out-of-set kept)", () => {
    const resolver: RefKeyResolver = () => ({ refKeys: [], refListKeys: ["list"] });
    const result = duplicateActorSubtrees(
      src([mkActor({ id: "a", params: { list: ["b", "x"] } }), mkActor({ id: "b" })]),
      ["a", "b"],
      toRoot,
      resolver
    );
    const dupA = result.actors.find((x) => x.id === result.idMap.a)!;
    expect(dupA.params.list).toEqual([result.idMap.b, "x"]);
  });

  it("remaps structural (non-schema) ref keys like camera-path curve ids", () => {
    const resolver: RefKeyResolver = (actor) =>
      actor.actorType === "camera-path"
        ? { refKeys: ["positionCurveActorId", "targetCurveActorId"], refListKeys: [] }
        : { refKeys: [], refListKeys: [] };
    const result = duplicateActorSubtrees(
      src([
        mkActor({
          id: "cam",
          actorType: "camera-path",
          childActorIds: ["pos", "tgt"],
          params: { positionCurveActorId: "pos", targetCurveActorId: "tgt" }
        }),
        mkActor({ id: "pos", actorType: "curve", parentActorId: "cam" }),
        mkActor({ id: "tgt", actorType: "curve", parentActorId: "cam" })
      ]),
      ["cam"],
      toRoot,
      resolver
    );
    const dupCam = result.actors.find((x) => x.id === result.idMap.cam)!;
    expect(dupCam.params.positionCurveActorId).toBe(result.idMap.pos);
    expect(dupCam.params.targetCurveActorId).toBe(result.idMap.tgt);
  });

  it("duplicates a parent+child selection exactly once (child not a second root)", () => {
    const result = duplicateActorSubtrees(
      src([mkActor({ id: "p", childActorIds: ["c"] }), mkActor({ id: "c", parentActorId: "p" })]),
      ["p", "c"],
      toRoot,
      noRefs
    );
    expect(result.newTopLevelIds).toHaveLength(1);
    expect(result.actors).toHaveLength(2);
  });

  it("clones owned components with a remapped parentActorId", () => {
    const component: ComponentNode = {
      id: "comp",
      name: "Comp",
      enabled: true,
      kind: "component",
      parentActorId: "a",
      componentType: "demo",
      schemaId: "demo",
      params: { foo: 1 }
    };
    const result = duplicateActorSubtrees(
      src([mkActor({ id: "a", componentIds: ["comp"] })], [component]),
      ["a"],
      toRoot,
      noRefs
    );
    expect(result.components).toHaveLength(1);
    const dupComp = result.components[0]!;
    expect(dupComp.id).toBe(result.idMap.comp);
    expect(dupComp.parentActorId).toBe(result.idMap.a);
    expect(result.actors[0]!.componentIds).toEqual([result.idMap.comp]);
  });

  it("skips root ids that don't exist", () => {
    const result = duplicateActorSubtrees(src([mkActor({ id: "a" })]), ["ghost"], toRoot, noRefs);
    expect(result.actors).toHaveLength(0);
    expect(result.newTopLevelIds).toHaveLength(0);
  });
});
