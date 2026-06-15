import type { ActorStatusEntry, ReloadableDescriptor } from "@/core/hotReload/types";
import { ANNOTATION_ACTOR_SCHEMA } from "@/features/actors/actorTypes";
import { describeLandmark, readLandmark } from "@/features/dimensions/model";

interface AnnotationRuntime {
  text: string;
  leader: boolean;
}

export const annotationActorDescriptor: ReloadableDescriptor<AnnotationRuntime> = {
  id: "actor.annotation",
  kind: "actor",
  version: 1,
  schema: ANNOTATION_ACTOR_SCHEMA,
  spawn: {
    actorType: "annotation",
    label: "Annotation",
    description: "A text note anchored to a picked landmark point in 3D.",
    iconGlyph: "TXT",
    fileExtensions: []
  },
  createRuntime: ({ params }) => ({
    text: typeof params.text === "string" ? params.text : "Note",
    leader: params.leader !== false
  }),
  updateRuntime(runtime, { params }) {
    runtime.text = typeof params.text === "string" ? params.text : runtime.text;
    runtime.leader = params.leader !== false;
  },
  status: {
    build({ actor, state }) {
      const anchor = readLandmark(actor.params.anchor);
      const rows: ActorStatusEntry[] = [
        { label: "Type", value: "Annotation" },
        { label: "Text", value: typeof actor.params.text === "string" ? actor.params.text : "Note" },
        { label: "Anchor", value: describeLandmark(anchor, state) }
      ];
      return rows;
    }
  }
};
