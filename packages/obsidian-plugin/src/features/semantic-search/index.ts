/**
 * Public surface of the semantic-search feature. The logic lives in
 * `setup.ts` so a host with no UI (the headless server) can import it
 * without reaching the Svelte settings component re-exported here.
 */
export * from "./setup";
export { default as FeatureSettings } from "./components/SemanticSettingsSection.svelte";
export {
  createModelDownloader,
  type ModelDownloader,
  type ModelState,
} from "./services/modelDownloader";
