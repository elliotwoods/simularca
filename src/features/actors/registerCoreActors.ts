import type { AppKernel } from "@/app/kernel";
import { acceptDescriptorHotReload } from "@/core/hotReload/hmr";
import { emptyActorDescriptor } from "@/features/actors/descriptors/emptyActor";
import { environmentActorDescriptor } from "@/features/actors/descriptors/environmentActor";
import { environmentProbeActorDescriptor } from "@/features/actors/descriptors/environmentProbeActor";
import { mistVolumeActorDescriptor } from "@/features/actors/descriptors/mistVolumeActor";
import { meshActorDescriptor } from "@/features/actors/descriptors/meshActor";
import { primitiveActorDescriptor } from "@/features/actors/descriptors/primitiveActor";
import { curveActorDescriptor } from "@/features/actors/descriptors/curveActor";
import { cameraPathActorDescriptor } from "@/features/actors/descriptors/cameraPathActor";
import { crossSectionActorDescriptor } from "@/features/actors/descriptors/crossSectionActor";
import { dimensionActorDescriptor } from "@/features/actors/descriptors/dimensionActor";
import { annotationActorDescriptor } from "@/features/actors/descriptors/annotationActor";

export function registerCoreActorDescriptors(kernel: AppKernel): void {
  const descriptors = [
    emptyActorDescriptor,
    environmentActorDescriptor,
    environmentProbeActorDescriptor,
    mistVolumeActorDescriptor,
    meshActorDescriptor,
    primitiveActorDescriptor,
    curveActorDescriptor,
    cameraPathActorDescriptor,
    crossSectionActorDescriptor,
    dimensionActorDescriptor,
    annotationActorDescriptor
  ];
  for (const descriptor of descriptors) {
    kernel.descriptorRegistry.register(descriptor);
  }
}

export function setupActorHotReload(kernel: AppKernel): void {
  acceptDescriptorHotReload("core-actors", kernel, () => [
    emptyActorDescriptor,
    environmentActorDescriptor,
    environmentProbeActorDescriptor,
    mistVolumeActorDescriptor,
    meshActorDescriptor,
    primitiveActorDescriptor,
    curveActorDescriptor,
    cameraPathActorDescriptor,
    crossSectionActorDescriptor
  ]);
}

