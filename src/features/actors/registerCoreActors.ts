import type { AppKernel } from "@/app/kernel";
import { acceptDescriptorHotReload } from "@/core/hotReload/hmr";
import { emptyActorDescriptor } from "@/features/actors/descriptors/emptyActor";
import { environmentActorDescriptor } from "@/features/actors/descriptors/environmentActor";
import { gaussianSplatActorDescriptor } from "@/features/actors/descriptors/gaussianSplatActor";
import { gaussianSplatSparkActorDescriptor } from "@/features/actors/descriptors/gaussianSplatSparkActor";
import { meshActorDescriptor } from "@/features/actors/descriptors/meshActor";
import { primitiveActorDescriptor } from "@/features/actors/descriptors/primitiveActor";
import { curveActorDescriptor } from "@/features/actors/descriptors/curveActor";

export function registerCoreActorDescriptors(kernel: AppKernel): void {
  const descriptors = [
    emptyActorDescriptor,
    environmentActorDescriptor,
    gaussianSplatActorDescriptor,
    gaussianSplatSparkActorDescriptor,
    meshActorDescriptor,
    primitiveActorDescriptor,
    curveActorDescriptor
  ];
  for (const descriptor of descriptors) {
    kernel.descriptorRegistry.register(descriptor);
  }
}

export function setupActorHotReload(kernel: AppKernel): void {
  acceptDescriptorHotReload("core-actors", kernel, () => [
    emptyActorDescriptor,
    environmentActorDescriptor,
    gaussianSplatActorDescriptor,
    gaussianSplatSparkActorDescriptor,
    meshActorDescriptor,
    primitiveActorDescriptor,
    curveActorDescriptor
  ]);
}

