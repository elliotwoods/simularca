import type { AppKernel } from "@/app/kernel";
import { acceptDescriptorHotReload } from "@/core/hotReload/hmr";
import { emptyActorDescriptor } from "@/features/actors/descriptors/emptyActor";
import { environmentActorDescriptor } from "@/features/actors/descriptors/environmentActor";
import { gaussianSplatActorDescriptor } from "@/features/actors/descriptors/gaussianSplatActor";
import { pluginActorDescriptor } from "@/features/actors/descriptors/pluginActor";
import { primitiveActorDescriptor } from "@/features/actors/descriptors/primitiveActor";

export function registerCoreActorDescriptors(kernel: AppKernel): void {
  const descriptors = [
    emptyActorDescriptor,
    environmentActorDescriptor,
    gaussianSplatActorDescriptor,
    primitiveActorDescriptor,
    pluginActorDescriptor
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
    primitiveActorDescriptor,
    pluginActorDescriptor
  ]);
}

