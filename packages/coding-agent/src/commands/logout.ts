/** Remove stored credentials for a model provider. */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { logoutHelp as commandHelp } from "../cli/command-help";
import { runLogoutCommand } from "../cli/login-cli";

export default class Logout extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "Provider id (defaults to token-go)",
			required: false,
		}),
	};

	static examples = [
		`# Log out of TokenGo\n  ${APP_NAME} logout`,
		`# Log out of a specific provider\n  ${APP_NAME} logout anthropic`,
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Logout);
		await runLogoutCommand(args.provider);
	}
}
