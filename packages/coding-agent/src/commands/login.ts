/**
 * Log in to a model provider from the terminal.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { loginHelp as commandHelp } from "../cli/command-help";
import { runLoginCommand } from "../cli/login-cli";

export default class Login extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "OAuth provider id (e.g. anthropic, openai-codex); omit to pick interactively",
			required: false,
		}),
	};
	static flags = {
		token: Flags.string({
			description: "TokenGo system access token (also accepted from TOKENGO_PAT or stdin)",
		}),
	};

	static examples = [
		`# Pick a provider interactively\n  ${APP_NAME} login`,
		`# Log in to a specific provider\n  ${APP_NAME} login anthropic`,
		`# Log in to TokenGo from a secret or a pipe\n  ${APP_NAME} login token-go --token <pat>\n  printenv TOKENGO_PAT | ${APP_NAME} login token-go`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Login);
		await runLoginCommand(args.provider, { token: flags.token });
	}
}
