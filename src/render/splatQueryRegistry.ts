export interface SplatQueryBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface VisibleSplatSample {
  actorId: string;
  splatIndex: number;
  position: [number, number, number];
  opacity: number;
}

export interface SplatQueryArgs {
  actorIds?: string[];
  bounds?: SplatQueryBounds;
  maxResults?: number;
}

type QueryVisibleSplats = (args?: SplatQueryArgs) => VisibleSplatSample[];

let queryVisibleSplatsImpl: QueryVisibleSplats | null = null;

export function registerSplatQueryProvider(provider: QueryVisibleSplats): void {
  queryVisibleSplatsImpl = provider;
}

export function clearSplatQueryProvider(provider: QueryVisibleSplats): void {
  if (queryVisibleSplatsImpl === provider) {
    queryVisibleSplatsImpl = null;
  }
}

export function queryVisibleSplats(args?: SplatQueryArgs): VisibleSplatSample[] {
  if (!queryVisibleSplatsImpl) {
    return [];
  }
  return queryVisibleSplatsImpl(args);
}

