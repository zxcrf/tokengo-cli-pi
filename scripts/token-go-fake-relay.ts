import { startFakeTokenGo } from "./fixtures/token-go-relay.ts";

const relay = startFakeTokenGo();
console.log(`TokenGo fake relay listening at ${relay.url}`);
console.log(`TOKENGO_BASE_URL=${relay.url}`);
console.log(`TOKENGO_PAT=${relay.pat}`);
console.log(`TOKENGO_API_KEY=${relay.relayKey}`);
console.log("Press Ctrl-C to stop.");

const stop = (): void => {
	relay.close();
	process.exit(0);
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
