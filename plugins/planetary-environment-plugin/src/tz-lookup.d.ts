declare module "tz-lookup" {
  const tzLookup: (lat: number, lng: number) => string;
  export = tzLookup;
}
