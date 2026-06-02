import type { VoiceProvider } from "../types";
import type { TTSProvider } from "./base";
import { burmeseProductionProvider } from "./burmese-production-provider";
import { voxcpm2Provider } from "./voxcpm2-provider";

const providers: Record<VoiceProvider, TTSProvider> = {
  voxcpm2: voxcpm2Provider,
  burmese_production: burmeseProductionProvider
};

export function getProvider(id: VoiceProvider) {
  return providers[id];
}

export const providerList = Object.values(providers);
