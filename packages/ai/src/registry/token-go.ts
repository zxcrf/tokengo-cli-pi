import { tokenGoRootUrl } from "../providers/token-go";
import type { ProviderTransport } from "./build";

/** TokenGo account discovery uses the root API; inference remains on `/v1`. */
export const tokenGoTransport: ProviderTransport = {
	prepareModelDiscovery: config => ({
		...config,
		...(config.baseUrl ? { baseUrl: tokenGoRootUrl(config.baseUrl) } : {}),
		authenticated: Boolean(config.apiKey),
	}),
};
